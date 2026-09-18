# Health Checker — Phase 6A discovery: connections / cross-domain

Date: 2026-09-17.

- **Baseline:** Phase 5 as closed in `../itsm/PHASE5-REPORT.md`. Uncommitted; HEAD
  `1e82a55`.
- **Method:** read-only inspection of the repository, the stored scans in
  `server/data/nowhelpassist.db` and the rule workbooks. No code changed, no instance
  contacted.
- **Status of claims:** marked **verified** where re-checked against the code or data in
  this session, **reported** where they come from a code reading not re-run.

## 1. Summary

**Cross-domain health is specified, but only as links.**
- Three rule catalogues (CMDB 143, ITSM 139, ITOM 156) name causal links to other
  domains: "Joins CMDB-058", "Caused by ITOM-004".
- The workbook schema defines the field as "Causal connection to other domains … The
  input to root-cause clustering". It also defines a severity modifier, "Traced cause of
  downstream findings in another domain".
- **None of this is executed.**
  - CMDB's `crossDomainLink` is display-only.
  - ITSM's structured `dependencies.external` is loaded and never read.
  - The CMDB escalator `cross_domain_cause` is always NOT_EVALUATED: "Cross-domain causal
    clustering is not built yet".
  - The ITOM catalogue, where the only fully written cross-domain rules live
    (ITOM-147…156), is in the workbook outside the repo and was never imported.

**What does execute across domains is reading, not connecting.**
- CMDB rules read ITSM, ITOM and Platform tables.
- ITSM catalogue rules read bounded CMDB data (DECISION 11) and `em_alert`.
- `synthesize()` borrows the CMDB graph for priority.
- Every result stays inside its own module. **No code joins a finding, or a rule result,
  from one domain to another.** No module's result or reuse depends on another module's
  findings.

**The gap for Phase 6** is therefore a deterministic layer that evaluates a specified link
between two rules' results, with explicit status, population, evidence, identity and
invalidation. §8 recommends its first use case: **ITSM-130 ⋈ CMDB-058**. §9 lists the
decisions it does not need and the ones later links do.

## 2. Existing domains

The Health Checker has **four modules**: `scopes.js SCOPES` = cmdb, itom, itsm, platform,
plus the `all` view. SLA, Data Quality, CSDM and Connections are not modules.
- **CSDM** is a CMDB agent/domain.
- **SLA** exists as ITSM catalogue rules (003, 012, 013, 033–035, 137) and as spreadsheet
  titles (PLT-001…032).
- **Data Quality** exists only as a cross-reference: `cmdb.json` `dq` → DQ-001…083, and
  "Data Quality Q2" in ITSM links. Spreadsheet titles only.

| | CMDB | ITSM (legacy 11) | ITSM (catalogue 139) | ITOM | Platform |
|---|---|---|---|---|---|
| **Rule source** | `catalogue/cmdb.json` (143 rules from `SAOS_Health_Rules_Tracker_v3.xlsx`); thresholds in each pack's `*_DEFAULTS` | hard-coded, `rules.js incidentRules / changeRules / problemRules` | `rules/itsm/catalogue.json` + `itsm/rules/*.json` + `parameters.json`; DECISIONS.md lock | hard-coded, `rules.js midRules / discoveryRules / credentialRules / serviceMappingRules / availabilityRules` (18 rules), plus MID-DOWN, EVENT-UNBOUND, PERF-ECC-AGE raised by `platformRules` | hard-coded, `rules.js platformRules` (CUSTOM-BEFORE-UPDATE, INT-HTTP, PERF-JOB-ERROR, UPGRADE-SKIPPED, SEC-INACTIVE-ROLE) |
| **Execution** | `EstateRules.analyze` family `cmdb`: 14 packs `cmdb-*.js` over the extracted estate + bounded meta reads (`extract.js extractCmdbMeta`) | `analyze` family `itsm`, over the extracted slice (active or updated in 90 days) | `itsm/runner.js runITSMRules` before `analyze`, its own read cache / probes / count memo; handed in through `analyze({ external })` | `analyze` family `itom` + `platform` | `analyze` family `platform` |
| **Result contract** | findings + KPIs `{rule_id, pass_pct, numerator, denominator, basis}` + skips `{rule, table, reason}` + `manifest.cmdb_quality` (dimensions, gate, measures). **No per-rule status / verdict / population row.** | findings + skips | **per-rule rows**: status, verdict, blocker, population, `undetermined`, confidence, dependencies (`manifest.itsm.rules[139]`) | findings + skips + `ITOM_CHECKS` pass / fail / not_applicable | findings + skips |
| **Findings** | `add()` / `addCatalogued()`: fingerprint `sha256(rule\|table\|sorted ids)`; modifiers, gate, posture, materiality, pattern findings (`sha256(pattern\|rule\|class)`) | `add()` | `itsm/findings.js`: kinds record / aggregate / configuration / historical / relationship / **cross_domain**; kind-specific fingerprints; `itsm{…, occurrences}` | `add()` | `add()` |
| **Scope routing** | `RULE_PREFIXES` CMDB- REL- CSDM- | exact `ITSM` + domain | prefix `ITSM-` | MID- DISC- CRED- SM- EVENT- OUTAGE- + `RULE_SCOPE['PERF-ECC-AGE']` | fallback |
| **Storage** | `health_findings` (+ `scoring_json`), `manifest_json` | same | same + `kind` / `detail` / `itsm` in `scoring_json`; overrides in `health_itsm_parameters` | same | same |
| **API** | `/runs/:id`, `/modules`, `/modules/findings`, finding detail, CSV | same | same + `/itsm/parameters` | same | same |
| **UI** (`HealthAssist.jsx`) | score, gate, dimensions, trust variants, catalogue articulation incl. the "Cross-domain link" text row | findings | findings only; `kind`, `detail`, `related_domain`, rule states **not rendered** | checks list | "No score" |
| **Scoring** | `cmdb-quality.js scoreCmdbQuality`: gate + 10 weighted dimensions; comparability key `scoringComparability()` | `scopes.js itsmScore`: record pass rate over `ITSM_SCORED_DOMAINS` (0.6 on dev424910) | none (Phase 5 decision 7) | `itomScore`: checks passing / applicable (60 on dev424910) | none |
| **Cross-module inputs today** | reads change_request, incident, problem (084, 117, 118, 121, 141), discovery_* (070–073, 125), svc_ci_assoc, alm_asset, sys_trigger, sys_audit, `em_alert` coverage status (013, 141) | — | bounded `cmdb_ci` / `cmdb_rel_ci` / `cmdb_ci_service` (017, 019, 095, 105, 123, 126, 130, 131, 136); `em_alert` (038) | platform family shares ecc_agent / em_alert / ecc_queue | — |

**Latest stored full scan** (dev424910, 2026-09-17 06:33Z, taken before the Phase 5
integration, so ITSM holds only the legacy 11):

| Module | Findings | Score |
|---|---:|---|
| CMDB | 21,814 | 76.9, "Provisional — 80 of 100 weight measured", gate "Score not trustworthy" |
| ITSM | 341 | 0.6 |
| ITOM | 2 | 60, "3 of 5 applicable checks pass; 4 not applicable here" |
| Platform | 52 | none |

## 3. Existing cross-domain infrastructure

### 3.1 Specification layer (declared, not executed)

| Source | What it holds | Executed? |
|---|---|---|
| Workbook schema (`SAOS_Health_Rules_Tracker_v3.xlsx`, sheet Schema) | Cross-Domain Link = "Causal connection to other domains. Which domain causes this, or which this causes. The input to root-cause clustering." Severity modifier: "traced cause of downstream findings in another domain" raises one band | — |
| `catalogue/cmdb.json` `crossDomainLink` (143 rules, prose) | e.g. CMDB-058 "Direct cause of impact analysis returning empty"; CMDB-020 "Caused by ITOM-004"; CMDB-071 "ITOM-001 is the same finding from the ITOM side"; CMDB-141 "Caused by D6 relationship gaps, CSDM linkage (Group 11) and event binding (ITOM); causes ITSM change-risk and Event Management impact failures" | display only: `remediation.js fromCatalogue`, `HealthAssist.jsx` "Cross-domain link" row (**reported**) |
| `rules/itsm/catalogue.json` `cross_domain_link` (139, prose) | e.g. ITSM-130 "Joins CMDB-058; prioritises relationship remediation by incident volume"; ITSM-019 / 095 "Joins CMDB-080 and CMDB-084"; ITSM-018 / 101 "Cross-links to CMDB-102 and Data Quality Q2" | not rendered |
| `rules/itsm/architecture-map.json` | `semantic_class: cross_domain` (11), `finding_level: cross_domain` (13), `data_requirements.requires_cross_domain_data` (22), `dependencies.external` on **20 rules** with structured ids (CMDB-020 / 057 / 058 / 072 / 080 / 084 / 102 / 106, ITOM-004 / 116 / 147, "Data Quality Q2", baselines). Convention: *"external = other domains' rules, baseline data or customer inputs. A dependency never merges two rules."* (**verified**) | `itsm/catalogue.js:124` loads `external`; **no code reads it** (**verified**) |
| `rules/itsm/dependency-map.md` §4 | the cross-domain table with kinds, e.g. *"ITSM-019, ITSM-095 → CMDB-080, CMDB-084 — same CI lifecycle facts; the CMDB rules find the CI, these find the task pointing at it"*; *"ITSM-130, 131, 138 → CMDB-058 — the existing CMDB-UNRELATED / relationship rules"*; *"ITSM-132 → ITOM-147, CMDB-072, existing DISC-* findings — consumes ITOM module output"* | documentation |
| **ITOM sheet, 156 rules** (workbook, **not in repo**) | fully specified (detection, threshold, confidence basis, evidence, false-positive guard, link). Group **"Cross-Domain ITOM", ITOM-147…156**: e.g. 147 credential failure → CI staleness ("Joins ITOM-017 to CMDB-072"), 150 alert bound to a relationship-less duplicate CI, 152 Business Critical service impact traced to an ITOM cause, 156 schedule missing location → N CIs → M routing rules ("Joins ITOM-004 to CMDB-020 and to ITSM routing failures") (**verified**, read from the workbook) | not imported; `origin/nav_ITOM` only maps 17 legacy ITOM rules to workbook ids |
| data quality sheet (DQ-001…139) | titles / model / dimension only. "Data Quality Q2" = Q2 Validity, DQ-095…102 | — |
| platform sheet (PLT-001…183) | titles only; SLA rules PLT-001…032 | — |
| `cmdb-quality.js ESCALATORS.cross_domain_cause` (:160, :179) | "Traced cause of downstream findings in another domain" (per-CI escalator) | `cmdb-signals.js:103` NOT_EVALUATED: "Cross-domain causal clustering is not built yet." (**verified**) |

### 3.2 Executable cross-domain behaviour (inside one module)

- **CMDB reads other domains' tables** and keeps the result in CMDB:
  - CMDB-084 retired CI with open incidents / changes;
  - CMDB-117 / 118 incident service / CI reference KPIs;
  - CMDB-121 CIs never referenced by tasks;
  - CMDB-141 change impact KPI, where the alert half is not implemented;
  - CMDB-070…073 and 125 discovery; CMDB-015 / 057 / 081 / 106 `svc_ci_assoc`;
  - CMDB-007 `sys_trigger`; several rules on `sys_audit` (**reported**).
- **The ITSM catalogue reads other domains' data under DECISION 11:**
  - the relationship-graph engine traverses a bounded `cmdb_rel_ci` from referenced CIs
    (105, 126, 130, 131);
  - the temporal-correlation engine emits `crossDomainFinding` with
    `detail.related_domain` (ITSM-038 → ITOM, 106 → CMDB);
  - the composite engine consumes other ITSM rules (124 / 125 / 129 / 134), with
    `manifest.itsm.rules[].dependencies`.
- **`synthesize()`** (`rules.js`) walks the CMDB graph from each finding's CI / service
  targets to set `affected_*`, `impact`, `priority`.
  - Seeds are only CI / service target ids, so tasks that *reference* a CI get no
    business proxy.
  - The result is charged to CMDB only, and `affected_*` / `priority_factors` are not
    stored (**reported**).
- **`clusterByRule`** (`index.js`) → `manifest.root_cause_clusters`: grouping by
  `rule_id`, explicitly *"not root-cause analysis"*, read by nothing (**reported**).

### 3.3 Composition, invalidation, remediation

- **`store.composedView()`** sums each module's own latest run. It has no cross-module
  roll-up and never recomputes, so priorities from runs of different ages are ranked
  together.
- **`incremental.planScan`** reuses per module.
  - Shared *tables* invalidate each declaring module.
  - Engine source hashes span modules.
  - **No module result depends on another module's result.**
- **Remediation / proposals** are per rule, per finding, single table and field. There is
  no multi-finding or cause-first remediation (**reported**).

## 4. Reusable components

| Need | Existing component |
|---|---|
| Per-rule result with status / verdict / population / blocker / confidence / dependencies | ITSM `engines/result.js` contract (population, `undeterminedOf`), `runner.js verdictOf`, `integration.js normalizeITSMRun` rows |
| Dependency ordering, cycle detection, confidence = min | `itsm/engines/composite.js` (`buildDag`, `topologicalOrder`, `propagateConfidence`, `runOrdered`) — DECISION 7 |
| Finding kinds and identity for cross-domain facts | `itsm/findings.js` (`crossDomainFinding`, `relationshipFinding`, `fingerprintFor`), `itsm.occurrences` dedup (Phase 5 decision 6) |
| Bounded reads, counts, probes, capability / schema checks | `itsm/data-access.js` (read cache, `countMemo`), `itsm/capability.js`, the runner's field gate; DECISION 11 bounded graph (`relationship-graph.js boundedGraph`) |
| Run-to-run measures with comparability per measure | `cmdb-history.js` (`MEASURE_COMPARABILITY` raw / derived, `comparableHistory`), `store.cmdbMeasureHistory` — CMDB only; ITSM's context accepts `measureHistory` but `index.js` passes none |
| Change stamps and reuse | `incremental.js` (`stampingClient`, `planScan`, per-module baselines, `itsm_stamps`) |
| Routing, storage, API, composition | `scopes.js` (`RULE_PREFIXES`, `scopeOf`, `scopeFilter`), `store.js` (`scoring_json`, `composedView`), `routes/health.js` |
| Reconciliation of two evaluation paths | `integration.js reconcileStandalone` |

## 5. Gaps

1. **No executable link registry.** Links are prose (CMDB, ITSM) or partly structured
   (ITSM `external`). Several targets do not exist in code:
   - `ITOM-###` ids (ITOM rules use `MID-`, `DISC-`…);
   - "Data Quality Q2", which is undefined in the repo.
2. **No join key per link.** The workbook names rules, not the shared entity (CI, group,
   service, change). The key is determinable only where both rules' detection logic
   judges the same entity type.
3. **No per-rule result outside the ITSM catalogue.**
   - CMDB / ITOM / Platform expose findings, KPIs and skips, but no status / verdict /
     population row per rule.
   - A cross-domain result consuming a CMDB rule therefore cannot tell "evaluated, nothing
     found" from "evaluated over an empty population" without a CMDB-side population
     declaration. The Phase 5 empty-population contract covers ITSM only.
4. **Results of two modules are never combined.**
   - No place in the pipeline runs after both modules' rules and before synthesis / store
     to evaluate a link.
   - No manifest / store / API / UI shape for a link result.
5. **Invalidation.** A link result depends on two modules' results. Reuse is per module,
   and the All view mixes runs of different ages. No contract says when a link is stale.
6. **Identity.** No fingerprint strategy for a link result (Phase 5 decision 6 asks for one
   designed, not ad hoc).
7. **No ITOM catalogue** (156 specified rules in the workbook, 21 legacy rules in code).
   The fully specified cross-domain rules ITOM-147…156 depend on it, and on data dev424910
   does not have (Discovery never ran, no MID, no Event Management).
8. **No ITSM measure history.** Only needed for temporal cross-domain rules (onset / window
   attribution such as ITOM-147 / 148 / 153); not needed for the recommended first use case.
9. **UI.** `kind`, `detail`, `related_domain`, rule states and priority are not rendered.

## 6. Defects found during discovery (not fixed; outside Phase 6 unless approved)

| # | Defect | Evidence | Status |
|---|---|---|---|
| D1 | `tables.js` defines `discovery_device_history` twice (:114 with `issues`, :199 with `issue`). The second object key wins, so **ITOM DISC-DEVICE-ISSUE can never fire**: `rows()` drops every row missing `issues`, and ITOM check `discovery_clean` cannot fail through it | code read in this session (`tables.js:114/199`, `rules.js:982`) | **verified** by reading; not reproduced at runtime |
| D2 | Family skip ids `'SM'` (`rules.js:1136`) and `'CSDM'` (`:804`) match no `RULE_PREFIXES` entry, so those skips route to Platform and drop from ITOM-only / CMDB-only scans (the defect the `exact: ['ITSM']` entry fixed for ITSM) | `scopes.js:173-187` | **verified** by reading |
| D3 | CMDB-013 / 141 say "Event Management is not active on this instance" when `em_alert` was simply not requested by a CMDB-only scan | `extract.js` not_requested + message at `cmdb-completeness.js:386-388` | reported |
| D4 | Single-module scans charge every table a shared family touched to that module (e.g. `sys_script` as an ITOM input), adding false reuse inputs | `rules.js:469-470` | reported (inference) |
| D5 | The module tab's skipped-checks table shows the whole run's skips, not the scope's | `HealthAssist.jsx:896` | reported |
| D6 | `index.js priorInputs` may re-read opt-in `sys_audit` in full when it was recorded as a CMDB dependency | `index.js:199` vs `incremental.js:284` | reported (possible) |
| — | Stale docs: `ARCHITECTURE.md` says 139 CMDB rules, the "70/30" blend, the old CMDB score definition; `cmdb-signals.js` `not_consumed` note predates CMDB-121 | — | reported |

## 7. Candidate cross-domain relationships

**Criteria.** Specification support (quoted), both sides executable on main, data on
dev424910, join key determinable from the rules' own detection logic, specified effect, and
risk.

| # | Relationship | Specification | Both sides on main | dev424910 data | Join key | Specified effect | Assessment |
|---|---|---|---|---|---|---|---|
| **C1** | **ITSM-130 ⋈ CMDB-058** (CIs with no relationships) | ITSM-130: "Joins CMDB-058; prioritises relationship remediation by incident volume"; evidence: "the CIs involved ranked by incident volume, their edge counts". Dependency map: "ITSM-130 … → CMDB-058". CMDB-058: "Principal class CI with no upstream and no downstream edge … Direct cause of impact analysis returning empty" | yes: ITSM-130 relationship_graph (evaluated, fail, 16 findings, 26 / 26 judged, final Phase 5 run); CMDB-058 implemented (838 per-CI findings in the stored scan) | yes, both populated | **CI sys_id**: CMDB-058 judges CIs; ITSM-130 judges incidents by `cmdb_ci`, degree 0 | **ordering / attribution**: incident volume per relationship-less CI. No pass / fail threshold | **Recommended first.** Specified on both sides, deterministic, no invented threshold (report-only, as Phase 5 decision 5), bounded, live-validatable |
| C2 | ITSM-018 / 101 ⋈ CMDB-102 (groups with zero active members) | ITSM: "Cross-links to CMDB-102 and Data Quality Q2"; CMDB-102: "Support group has zero active members … Cross-links to Data Quality Q2" | yes | CMDB-102 2 findings; ITSM-101 fail 1 | sys_user_group sys_id | none stated ("cross-links"); third party "Data Quality Q2" undefined | good second; effect unspecified |
| C3 | ITSM-019 / 095 ⋈ CMDB-080 / 084 (retired / missing CIs) | "Joins CMDB-080 and CMDB-084"; "the CMDB rules find the CI, these find the task pointing at it" | yes; CMDB-084 *also* reads open tasks (the same fact reported in two domains) | no retired CIs on dev424910 (PDI trap) | CI sys_id | same-fact identity / de-duplication across domains | needs an identity decision (one fact, two domains); not live-validatable here |
| C4 | ITSM-135 ⋈ CMDB-106 (ownership vs assignment) | "Joins CMDB-106; ownership data contradicted by behaviour" | ITSM-135 UNCONFIGURED | — | CI | contradiction | blocked by parameters |
| C5 | ITSM-129 ↔ CMDB Trust Score | dependency map "CMDB Trust Score (context)" | 129 UNCONFIGURED | — | estate | context | scoring-adjacent; not now |
| C6 | CMDB-141 ↔ ITOM event binding / ITSM change risk | CMDB-141 link text | alert half unbuilt; no ITOM catalogue | no Event Management | change / alert | causal | blocked |
| C7 | ITOM-147…156 (Cross-Domain ITOM) | fully specified in the workbook | no ITOM catalogue in the repo | Discovery / MID / Event Management absent | per rule | pass / fail with thresholds | the real long-term home of cross-domain rules; needs an ITOM catalogue import first (a phase in its own right) and instance data dev424910 lacks |
| C8 | `cross_domain_cause` escalator (+1 severity band) | workbook severity modifier; CMDB `ESCALATORS` | declared | — | per CI | changes effective severity, therefore CMDB deductions and score | needs explicit approval (Phase 6 decision 7: no scoring change) |

## 8. Recommended next step (6B / 6C), for review before implementation

**The contract (6B), smallest reusable form.** A *cross-domain link* is data, not code: a
JSON entry per link. It declares:
- `id`;
- source domain + rule(s), target domain + rule(s), the `relationship` wording and its
  specification quotes;
- the **join key** (entity table, and the field on each side);
- `required_inputs` (rule results and / or bounded reads);
- population;
- threshold / window: none unless specified;
- effect: `report` (ordering / attribution evidence only), or later `verdict`, only when a
  specification gives a threshold.

It evaluates after both source rules have run, over their results, using the Phase 5
vocabularies:

| Input state | Link result |
|---|---|
| a required rule not run / UNCONFIGURED / UNAVAILABLE / ERROR | link **UNAVAILABLE** with blocker `input` naming the rule and its state (never PASS) |
| a required rule evaluated but inconclusive, or nothing judged | link **evaluated / inconclusive**, `undetermined: input_inconclusive` |
| both evaluated, determinate | link **evaluated**; population = the joined entities judged; evidence = both sides' fingerprints and evidence rows for each joined entity |

- **Confidence** = min(own, inputs) (DECISION 7).
- **Identity:** `sha256('link' | link id | entity table | sorted entity ids)`, with
  occurrences as in Phase 5 decision 6.
- **Effect:** a `report` link never changes either rule's verdict, severity, priority or
  any score (Phase 5 decisions 5 and 7).
- **Same-run inputs only** in the first version: a link whose inputs come from different
  runs (per-module reuse) is UNAVAILABLE with blocker `input` ("inputs from different
  runs"), so a link can never mix instance states.
- **Placement:** evaluated in `runHealthCheck` after the ITSM catalogue and
  `EstateRules.analyze` rules, before `synthesize` / store. Stored as `manifest.links`
  (rows) + link findings routed to a scope decided in §9.

**First use case (6C): C1, ITSM-130 ⋈ CMDB-058.** The output is the CMDB-058 CIs that
incidents reference, ranked by incident volume, with each CI's edge count (0) and the
incidents as evidence. That is exactly the ITSM-130 "evidence to show" plus the CMDB-058
link wording. No threshold, no verdict change.
- **Data.** It needs no new instance reads when both modules run in the same scan: CMDB-058
  per-CI findings plus ITSM-130's evaluated incidents.
- **One implementation fact to handle.** ITSM-130 emits findings only when its share
  breaches the threshold, so the link must consume ITSM-130's *evaluated* per-incident
  degree answers (its judged population), not its findings. That requires the runner result
  to expose them. It is additive on the result, not a change to ITSM-130's semantics.
- **Validation.** Offline fixture, then read-only on dev424910 (both sides populated).

## 9. Decisions

**Settled by existing decisions** (no question needed for C1):
- report-only when no threshold is specified (Phase 5 decision 5);
- no score / severity / priority change (decision 7);
- occurrences-based identity (decision 6);
- confidence = min (DECISION 7);
- no false PASS from unavailable / inconclusive inputs (DECISIONS 5 and 11, and the Phase 5
  population contract).

**Smallest decisions needed**, each at its boundary:
1. **Where link results are shown.** A new scope tab "Connections", or on the linked
   findings of both existing modules only. Routing a link finding to a module changes that
   module's finding counts; a separate scope does not. *Proposed:* a `connections` result in
   `manifest.links` and on the finding detail of both linked findings, **not** counted in
   any module's findings until a scope is approved.
2. **Cross-run composition.** Whether a link may join results from two different runs
   (per-module reuse) when both are current. *Proposed:* no, same run only, for now.
3. **For C2 onwards (not C1):**
   - the meaning of "Data Quality Q2", which is undefined in the repo;
   - whether "cross-links" (C2) implies any effect beyond report;
   - one-fact-two-domains identity for C3 (CMDB-084 vs ITSM-019 / 095).
4. **For C7 (the Cross-Domain ITOM rules):** importing the ITOM sheet as a catalogue, with
   the same lock discipline as the ITSM DECISIONS.md. A phase in its own right.
5. **For C8:** approving the `cross_domain_cause` severity modifier. This touches CMDB
   severity and therefore the CMDB score.

### Decisions taken (17 Sep 2026, delegated: "take the decision by yourself")

1. **Placement.** Link results live in `manifest.links` and on the ITSM and CMDB tabs
   ("Cross-domain links"). They are not counted in any module's findings, severities or
   score. No new scope tab.
2. **Cross-run composition.** No. A link joins results of the same scan only; a link whose
   module was not read in that scan is UNAVAILABLE with an `input` blocker saying so.
3. **First link implemented:** C1, ITSM-130 ⋈ CMDB-058 (`health/cross-domain/links.json`,
   `links.js`). ITSM-130's graph engine now also exposes its per-CI answers
   (`answers_by_ci`); this is additive, and ITSM-130's verdict, findings and kpi are
   unchanged.
4. **ITSM measure history** (Phase 5 decision 2, design + implementation):
   `health/itsm/measure-history.js`.
   - Per bound instance.
   - Real stored readings only, from scans (never verifications, never degraded runs).
   - A comparability key per rule: configuration + resolved parameter values + engine and
     version.
   - UTC `at`, and the declared window or null.
   - Readings under another key, without a value, or not earlier than the scan are set
     aside and counted.
   - ITSM-041 stays inconclusive until 3 comparable scans exist.
5. **Boundary kept.** `health/itsm` is still reached only through `index.js` and
   `incremental.js`: the link evaluator gets `undeterminedOf` injected; remediation gets
   the ITSM catalogue through `registerItsmCatalogue`; the store only reads runs.

C2–C8 remain as assessed in §7 and §9.

## 10. Files involved

- **Specification:**
  - `server/src/health/catalogue/cmdb.json`
  - `server/src/health/rules/itsm/{catalogue.json, architecture-map.json, dependency-map.md, DECISIONS.md}`
  - `C:\Users\AaronSingh\Downloads\SAOS_Health_Rules_Tracker_v3.xlsx` (outside the repo: ITOM, data quality, platform sheets)
- **Pipeline:** `server/src/health/index.js` (runHealthCheck), `rules.js` (EstateRules.analyze, add, addCatalogued, synthesize), `scopes.js`, `tables.js`, `extract.js`, `incremental.js`, `store.js`, `cmdb-quality.js`, `cmdb-signals.js`, `cmdb-history.js`, `cmdb-relationships.js` (CMDB-058), `cmdb-ownership.js` (CMDB-102), `cmdb-lifecycle.js` (CMDB-080 / 084)
- **ITSM:** `server/src/health/itsm/{runner.js, integration.js, catalogue.js, findings.js, data-access.js, capability.js, context.js}`, `itsm/engines/{result.js, composite.js, relationship-graph.js, temporal-correlation.js}`, `itsm/rules/relationship-graph.json` (ITSM-130)
- **API / UI:** `server/src/routes/health.js`, `client/src/pages/HealthAssist.jsx`, `server/src/health/remediation.js`
- **Storage:** `server/src/memory/db.js` (`health_runs`, `health_findings`, `health_itsm_parameters`)
