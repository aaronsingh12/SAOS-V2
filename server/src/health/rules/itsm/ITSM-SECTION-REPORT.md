# Health Assist — the ITSM section (built on Phase 5, with the first Phase 6 link)

Date: 2026-09-17.

- **Baseline:** `PHASE5-REPORT.md`, closed.
- **Discovery:** `../cross-domain/PHASE6-DISCOVERY.md`.
- **Mandate:** "take the decision by our self and complete the ITSM section in health assist
  with all its functionalities and actual results and implementations".
- **Nothing committed.**

## 1. Summary

The ITSM tab of Health Assist now shows the whole ITSM catalogue as the scan ran it.
- **Every rule.** All 139 rules with their outcome, what each judged, why any could not run
  or established nothing, parameters, dependencies, measured values, variants and trend
  history.
- **Settings.** The thresholds the workbook leaves to each instance can be set from the
  page.
- **Findings.** Each ITSM catalogue finding opens with its own workbook guidance and a
  kind-specific account of what was measured.
- **The first cross-domain link.** ITSM-130 ⋈ CMDB-058 is evaluated and shown.
- **Trend history.** Trend rules get persisted, comparable measure history.

**Actual results** are stored in the app's database from a real read-only scan of
dev424910, the same code path as the Run button.

**Unchanged:**
- the ITSM score (legacy 11, 0.6);
- DECISIONS.md, the catalogue, parameters and rule configurations;
- the Phase 5 population contract.

## 2. Decisions taken (delegated)

| Decision | Taken |
|---|---|
| Where cross-domain link results appear | `manifest.links`, shown on the ITSM and CMDB tabs; not counted in any module's findings, severities or score |
| Whether a link may join two different scans | No. Same scan only; otherwise UNAVAILABLE with an `input` blocker that says so |
| First link | ITSM-130 ⋈ CMDB-058 (`ITSM-130: "Joins CMDB-058; prioritises relationship remediation by incident volume"`), report-only |
| ITSM measure history (Phase 5 decision 2) | Built to the stated constraints (§3.4); ITSM-041 still needs 3 comparable scans |
| The ITSM-engine boundary (`health/itsm` reached only through `index.js`) | Kept: guidance is registered by the facade, the link gets `undeterminedOf` injected, the store only reads runs |

## 3. What was built

### 3.1 Server

| Area | Change |
|---|---|
| **Finding guidance** (`remediation.js`) | ITSM catalogue findings used to get the generic fallback. They now get the workbook's own articulation: what it means, why it matters, detection logic, threshold, confidence basis, evidence to show, false-positive guard, remediation lane(s), cross-domain link. The ITSM catalogue is registered by `index.js` (`registerItsmCatalogue`), so remediation and proposals use it without importing the engine. |
| **Skipped checks per tab** (`routes/health.js withScopes`) | Every skipped check carries its `scope` (routed as its findings are), so a module tab lists only its own skips. |
| **Skip routing** (`scopes.js RULE_PREFIXES`) | The family skip ids `CSDM` and `SM` route to CMDB and ITOM instead of Platform. This is discovery defect D2, and it had to be fixed for the per-tab filter to be right. |
| **Per-CI answers** (`itsm/engines/relationship-graph.js`, v1.3.0) | `answers_by_ci`: every CI the evaluated records reference, with record count, sample ids, degree and whether it offends — whatever the threshold decides. Additive: verdicts, findings and KPIs are unchanged. |
| **Cross-domain links** (`health/cross-domain/links.json`, `links.js`) | Registry validated on load (quoted specification, known adapters, `report` effect only, unique ids). Evaluated after `analyze()` over one scan's results; §3.3. |
| **Measure history** (`itsm/measure-history.js`, `store.itsmHistoryRuns`, `index.js`, route) | §3.4 |

### 3.2 The page (`client/src/components/HealthItsm.jsx`, wired into `pages/HealthAssist.jsx`)

- **ITSM catalogue card.**
  - **Summary figures:** in the catalogue · can run · have every parameter · ran on this
    instance · established pass or fail · findings.
  - **Filters:** outcome chips (Fail / Pass / Inconclusive / Needs a parameter / Cannot run
    here / Input did not run / Error), a group filter and a search box.
  - **One row per rule:** outcome, rule and group / engine, judged (x of y unit), findings
    (click → the findings list filters to that rule), and why.
  - **Expanding a row shows:** state and classification, population and basis, why nothing
    was established, the blocker (kind, step, fields / parameters, workbook text), partial
    detection, confidence, unresolved parameters, consumed rules with their status and
    verdict, measured KPIs, variants, trend history (used and set-aside readings), and the
    parameters used.
- **Rule parameters card.**
  - Filters: blocking a rule / set for this instance / all.
  - Each parameter shows its type, unit and workbook text.
  - Set a value, validated by the server against its declaration; errors are shown on the
    row. Clear an instance override.
  - Nothing is written to ServiceNow.
- **Cross-domain links card** (ITSM and CMDB tabs).
  - Each link's state: joined, nothing to join, or cannot join with the reason.
  - Counts: joined CIs, incidents on them, CIs only one side flags, confidence.
  - The ranked table of joined CIs, with a button to open the CMDB-058 finding.
  - The quoted specification.
- **ITSM finding detail.**
  - Catalogue trace: rule, slot, group, engine, finding kind, rule verdict,
    classification, occurrences / variants, partial detection.
  - What the rule measured, by kind:
    - aggregate: measure, observed, threshold, population, window, basis, distribution;
    - configuration: object, observed, expected, absent;
    - historical: field, window, transitions;
    - relationship: question, from, to, path;
    - cross-domain: related domain, provenance;
    - record: count, fields.
  - The parameters it used.
- **Scorecard note.** The ITSM score counts the eleven original rules; catalogue findings
  are counted in "found in ITSM" and do not move it.
- **Skipped checks** on a module tab are the module's own.
- **Styling** reuses the page's classes; the new styles are prefixed `hs-itsm-`, plus
  `.chip.is-on`. `api.js` gains `put`.

### 3.3 The link contract, as implemented

| Input state | Link result |
|---|---|
| a module not read in this scan | UNAVAILABLE, blocker `input` `not_read` ("a link joins the results of one scan only") |
| ITSM-130 not run / UNAVAILABLE / UNCONFIGURED / ERROR | UNAVAILABLE, blocker `input` with its state and reason |
| ITSM-130 evaluated without per-CI answers | UNAVAILABLE, `no_answers` |
| CMDB-058 skipped (e.g. relationships not read completely) | UNAVAILABLE, `skipped` with the skip reason |
| ITSM-130 evaluated but established nothing | evaluated, `undetermined: input_inconclusive` |
| no relationship-less CI | evaluated, `undetermined: empty_population`, no rows |
| both evaluated | evaluated; rows = relationship-less CIs both rules flag, ranked by incident volume |

- **Population:** relationship-less CIs referenced by incidents, each checked against
  CMDB-058.
- **Verdict:** always null (report).
- **Confidence:** min(inputs).
- **Identity:** `sha256(link | id | cmdb_ci | sorted joined CI ids)`.
- **Evidence per row:** CI, incident count and sample incident ids, degree, the CMDB-058
  finding's fingerprint / severity / title.
- **Extra reads:** none. It joins results already in memory.

### 3.4 ITSM measure history, as implemented

- **Stored.** Each scan stores `manifest.itsm.measures`: every measure a rule recorded,
  with `value`, `population`, `at` (run anchor, ISO UTC), `timezone`, `window` (the rule's
  declared window, or null), `basis` and `comparability`.
- **Comparability key.** sha256 of the history version, rule id, engine and engine version,
  the rule's configuration, and its resolved parameter values.
- **Read back.** `store.itsmHistoryRuns()` reads the bound instance's completed / partial
  runs that scanned ITSM. `historyFromRuns` then excludes verifications, degraded ITSM runs
  and runs from before measures were stored.
- **Filtered per scan.** `historyForScan` keeps readings that are strictly earlier, have a
  value, and share the current key. The rest is set aside and counted
  (`manifest.itsm.measure_history`).
- **ITSM-041.** 0–2 comparable readings → inconclusive (`insufficient_history`); 3 → the
  trend is judged (steady → pass, falling → fail).

## 4. Actual results — dev424910

The scan went through `POST /api/health/runs` with `{ modules: ['cmdb','itsm'], reuse: false, explain: false }`:
- **Run:** `6387c248-0a39-4773-8057-7719ac221d85`, status `partial` (skipped checks exist), degraded: none.
- **Wall time: 1,154 s.** Extraction 475 s · CMDB meta 108 s · ITSM catalogue 553 s · analyse 1.3 s.
- **Read-only.** The health router has no instance write.

| | Result |
|---|---|
| CMDB | 76.9, "8 of 10 dimensions measured (80 of 100 weight) over 2,784 in-scope CIs"; 21,815 findings |
| ITSM score | **0.6** (legacy 11, unchanged): "1 of 168 records have no ITSM finding"; 414 findings in scope |
| ITSM catalogue | 139 / 139 reconciled · evaluated 69 (fail 38 · pass 20 · inconclusive 11) · unconfigured 28 · unavailable 41 · skipped 1 · **error 0** · 73 findings |
| Nothing established | empty population: ITSM-014, 088, 139 · insufficient history: ITSM-041 ("trend needs 3 windows, 1 recorded") |
| Passes over nothing judged | **none**; determinate by the workbook: ITSM-029 |
| Requests / caches | 406 requests (246 query · 119 count · 41 aggregate) + 30 stamps; reads 202 / 180 distinct · probes 686 / 271 · counts 139 / 119 |
| Measures stored | 57 readings (the first ITSM history this instance has) |
| **Link ITSM-130 ⋈ CMDB-058** | **evaluated** (see below) |
| API as the page reads it | `/modules/findings?scope=itsm` → 414 (73 catalogue) · finding detail for ITSM-016: kind `aggregate`, trace present, guidance `known: true` from the ITSM catalogue · skipped checks: cmdb 86, itsm 78 · `/itsm/parameters`: 108 declared, 38 blocking a rule, 0 overrides |

**The link, in detail:**
- ITSM-130 judged 24 CIs referenced by incidents; 14 of them have no relationships.
- 9 of those 14 are also CMDB-058 findings (all CRITICAL), with 11 incidents on them, ranked
  by incident volume.
- The other 5 are edge-less CIs with no CMDB-058 finding of their own; CMDB-058 judges principal-class CIs only.
- 829 CMDB-058 CIs are referenced by no incident.
- Confidence 1.

## 5. Tests

| Suite | Result |
|---|---|
| `health-cross-domain-links` (new) | 8 / 8: registry validation; joined and ranked with evidence; report-only (inputs unchanged); confidence = min; healthy / empty / input-inconclusive; malformed references; every unavailable path (not read, not run, unavailable, unconfigured, no answers, target skipped); integration through the scan, the store and `GET /runs/:id` |
| `health-itsm-measure-history` (new) | 4 / 4: comparability; eligibility and filtering (verification, degraded, other model, no value, not earlier); ITSM-041 over stored scans (1 and 2 readings inconclusive, the 3rd judged, a changed parameter sets history aside); a falling series fails with the trend as evidence |
| `health-remediation` | + ITSM catalogue guidance (legacy 11 keep their entries; an unknown ITSM-999 still falls back) |
| `health-scopes` | + `CSDM` / `SM` / `ITSM` skip routing |
| `health-client-contract` | + the ITSM section reaches only `/health/itsm/parameters`, and reads the manifest, row and link fields by the names the server writes |
| all `health-*` | pass |
| **full `npm test`** | **3,716 · 3,712 pass · 4 fail · 0 todo**. The 4 are the pre-existing, unrelated failures. |
| client | `vite build` succeeds |

## 6. What the ITSM section still cannot do, and why

| Gap | Kind | What would change it |
|---|---|---|
| 28 rules UNCONFIGURED on dev424910 (38 parameters) | configuration | values entered on the Rule parameters card; the next ITSM check runs them |
| 41 rules UNAVAILABLE: 33 need objects the workbook / DECISIONS.md leave undefined (major incident, approval routing, PIR, conflict detection, …); 8 are instance blockers (capability 6, table 1, choice value 1) | specification / instance | an object definition, or an instance that has the capability |
| 7 rules inconclusive by declared partial detection (019, 028, 043, 082, 083, 095, 136) | specification (Phase 4) | completing their detection |
| ITSM-041 needs 3 comparable scans | history | two more ITSM scans of this instance with the same configuration |
| Links C2–C8 (Discovery §7) | specification | the decisions in PHASE6-DISCOVERY §9 |
| ITSM-085 volume gate; 124 / 077 report-only | decided (Phase 5 decisions 4, 5) | a rule-specification workstream |
| Browser check | verification | the page compiles and its contract tests pass, but it was not opened in a browser in this session; the app server was not running |
| Server restart | operational | start the server (`npm run dev`) to serve the new routes and page |

## 7. Files

- **New:**
  - `server/src/health/cross-domain/{links.json, links.js}`
  - `server/src/health/itsm/measure-history.js`
  - `client/src/components/HealthItsm.jsx`
  - `server/test/{health-cross-domain-links, health-itsm-measure-history}.test.js`
  - `server/src/health/rules/cross-domain/PHASE6-DISCOVERY.md`
  - this report
- **Modified:**
  - `server/src/health/{index.js, remediation.js, scopes.js, store.js}`
  - `server/src/health/itsm/engines/relationship-graph.js`
  - `server/src/routes/health.js`
  - `server/src/health/itsm/README.md`
  - `client/src/{pages/HealthAssist.jsx, api.js, styles.css}`
  - tests: `health-remediation`, `health-scopes`, `health-client-contract`
