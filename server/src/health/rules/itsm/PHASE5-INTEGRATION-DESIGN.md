# ITSM Health Checker — Phase 5 integration design (Stage 5A)

Date: 2026-09-17. Authority: `DECISIONS.md` (unchanged) and `catalogue.json` (139
rules, identities unchanged). This document is written **before** any execution
code changes. It describes the Health Checker as it is, where the Phase 4 runner
connects, how results flow and who receives them, and the constraints the
integration must respect. Nothing in it chooses a scoring model (see
`SCORING-OPTIONS.md`, Stage 5E).

---

## 1. The Health Checker today

```
POST /api/health/runs                         routes/health.js executeRun()
  │  reads: accepted risks (finding states), cmdbMeasureHistory(), moduleBaselines(), tableSettings()
  ▼
runHealthCheck({ modules, reuse, baselines, … })   health/index.js
  │
  ├─ engineKeys()                               incremental.js — one key per module
  │    itsm key already folds itsmEngineKey() (DECISION 8, Phase 4)
  ├─ planScan()                                 incremental.js — per module: reuse (verified) or read
  │    stamps = count + max(sys_updated_on) per input table (TABLES registry only);
  │    CMDB also re-stamps its governance "meta sources"
  ├─ extractEstate(requested tables)            extract.js — whole allow-listed tables, fixed fields,
  │                                              coverage per table (complete | limited | truncated | …)
  ├─ extractCmdbMeta()                          only when CMDB is read
  ├─ new EstateRules(estate, coverage, …).analyze({ modules })     rules.js
  │    family cmdb      → 20 timed CMDB stages
  │    family platform+itom, itom
  │    family itsm      → itsmRules(): the 11 hard-coded rules
  │    findings filtered by scopeOf(), skips by scopeOfRule()
  │    synthesize()     → priority, priority_score, impact on EVERY finding (mutates in place)
  ├─ explainFindings()                          explain.js — sets ai_summary in place (optional)
  ├─ scoreCmdbQuality() / cmdbScoreTrend()      CMDB only
  ├─ summariseScopes(coverage, all)             scopes.js — per scope: score, basis, drivers,
  │                                              severity_counts, domains, checks, gate
  └─ manifest { coverage, skipped_checks, scopes, dependencies, stamps, meta_stamps, phases, … }
  ▼
completeRun(runId, { status, findings, manifest })  store.js — health_findings rows + manifest_json
recordScanOutcome()                                  baselines for the next change check
  ▼
GET /api/health/modules, /modules/findings, /runs/:id, /runs/:id/findings/:fp, exports
  ▼
client/src/pages/HealthAssist.jsx
```

### 1.1 Where ITSM executes today

- **Rules:** `EstateRules.itsmRules()` → `incidentRules()` (5), `changeRules()` (4),
  `problemRules()` (2) — the **11 hard-coded rules** `ITSM-INC-UNASSIGNED`,
  `ITSM-INC-P1-AGED`, `ITSM-INC-STALE`, `ITSM-INC-NO-CI`, `ITSM-INC-REOPENED`,
  `ITSM-CHG-STALE`, `ITSM-CHG-NO-CI`, `ITSM-CHG-OVERDUE`, `ITSM-CHG-FAILED`,
  `ITSM-PRB-UNASSIGNED`, `ITSM-PRB-STALE`. Agents `incident_agent`, `change_agent`,
  `problem_agent`; domains `INCIDENT`, `CHANGE`, `PROBLEM`.
- **Data:** `incident`, `change_request`, `problem` through `extract.js`, sliced
  "active, or updated in the last 90 days" (`ITSM_SLICE`).
- **Score:** `scopes.js itsmScore()` — share of the sliced incident / change /
  problem records no finding in `ITSM_DOMAINS` touches (currently 0.6 on dev424910).
- **The 139-rule runner** (`health/itsm/runner.js runITSMRules`) is called by
  nothing in the scan. Its only connection is the engine key (DECISION 8).

### 1.2 The Phase 4 runner, as the integration receives it

```
createEvaluationContext({ client, now, timezone, signal, parameters, runtimeParameters, measureHistory })
runITSMRules(ctx, { ruleIds }) → { order, results: Map(id → result), summary, verdicts, timing, elapsed_ms, cached_reads }
```

Per rule result (`engines/result.js` + `runner.js finish()`):
`rule_id, engine, status, findings[], kpis[], skipped[], coverage[], measures{},
parameters, capability, blocker, scope, verdict, explanation, variants?,
evidence_missing?, error?`.

The runner reads through **its own** per-run read cache and capability probes
(`data-access.js`, `capability.js`) — not through `extract.js`. It never assumes
a table: DECISION 5 pipeline, field gate, `$choice` resolution, parameters
(DECISION 3/4), composite ordering and confidence = min (DECISION 7) all happen
inside it.

---

## 2. Two status layers — kept apart, never collapsed

The brief's ladder (`Catalogue → Implemented → Executable → Configured →
Evaluated → Finding / Pass / Inconclusive`) is represented by two orthogonal
fields on every normalized rule row.

**Design-time classification** (from the configuration, identical on every
instance; the Phase 4 status-matrix vocabulary):

| `classification` | Meaning |
|---|---|
| `UNAVAILABLE` | needs an object / dependency neither the workbook nor DECISIONS.md defines |
| `UNCONFIGURED` | executable, but a referenced parameter has no value (or a declared specification gap) |
| `EXECUTABLE` | executable with the resolved parameters (the matrix calls these TESTED once asserted) |

**Run-time outcome** (from this run, on this instance — the runner's own words, kept verbatim):

| `status` | `verdict` | Meaning |
|---|---|---|
| `evaluated` | `fail` | at least one finding |
| `evaluated` | `pass` | no finding, full detection scope |
| `evaluated` | `inconclusive` | no finding, but a declared detection gap or a blocked variant |
| `unconfigured` | `null` | parameter / specification gap — `blocker.kind` says which |
| `unavailable` | `null` | object, table, field, choice value, capability or read — `blocker.kind` + pipeline `step` |
| `skipped` | `null` | a composite whose input was not evaluated — `blocker.kind = input` |
| `not_configured` | `null` | an input rule has no configuration (build gap) |
| `error` | `null` | an engine fault — never a pass |

`classification` answers "can this rule ever run here without a decision?";
`status` answers "what happened on this run?". A rule classified `EXECUTABLE`
can still be `unavailable` on an instance (a field the release lacks). No field
maps any of these to `pass`, `fail` or `skipped` of the legacy vocabulary.

---

## 3. Where `runITSMRules` connects

**In `runHealthCheck`, when `itsm` is among the modules being read**, after
extraction and before `EstateRules.analyze()`:

```
readModules includes 'itsm'
  ▼
ctx = createEvaluationContext({ client: reader, now, signal, parameters: <registry with instance overrides>,
                                runtimeParameters: options.itsmParameters ?? {} })
itsmRun = await runITSMRules(ctx)                  ← all 139 slots; the runner decides each state
  ▼
normalizeITSMRun(itsmRun)  → { findings[], rules[139], skipped[], aggregation, reads }   (new: health/itsm/integration.js)
  ▼
rules.analyze({ modules, external: { itsm: findings } })
     family itsm → itsmRules() (the 11, unchanged) + push the normalized catalogue findings
     → the same scopeOf filter, the same synthesize() (priority, impact) as every other finding
```

Why **before** `analyze()` and **inside** the itsm family:

- `synthesize()` sets `priority` / `priority_score` — both `NOT NULL` in
  `health_findings`. A finding that skipped it would fail the insert and roll the
  whole run back.
- Every count (`findings_detected`, `severity_counts`, `priority_counts`, scope
  summaries, root-cause clusters) is taken from `all`; findings outside
  `rules.findings` would be invisible to all of them.
- The runner is async and `analyze()` is synchronous, so the runner must finish
  first and hand its results in.

Why a **copy**: `findings.js` freezes every finding; `synthesize()` and
`explainFindings()` assign to findings in place, which throws on a frozen
object in strict mode. Normalization produces plain objects.

The ITSM-only scan, the full scan and the explicit-tables legacy API all take
this path when ITSM is read; a verified (reused) ITSM module runs nothing, as
today.

---

## 4. Result normalization (Stage 5C)

### 4.1 Findings

The finding contract every consumer reads is kept; the ITSM fields are added.

| Field | Source | Note |
|---|---|---|
| `fingerprint`, `rule_id`, `table`, `target_ids`, `title`, `description`, `severity`, `base_severity`, `confidence`, `evidence`, `recommendation`, `estate_wide` | `findings.js` | unchanged |
| `agent_id` = `itsm_agent`, `domain` = `ITSM` | `findings.js` | `itsm_agent` is **registered** in `AGENTS` (label "ITSM catalogue") |
| `kind`, `detail` | `findings.js` | aggregate observed / expected / population / window; configuration object; historical transitions; relationship path; cross-domain provenance |
| `itsm` = `{ engine, slot, verdict, classification, scope, parameters_used, blocker: null, catalogue_group }` | rule result | the trace finding → rule → catalogue → engine |
| `priority`, `priority_score`, `impact` | `synthesize()` | same computation as every finding |

**Persistence.** `health_findings` has no `kind` / `detail` columns and drops
unknown fields silently. `store.scoringOf()` already serialises catalogue
fields into the nullable `scoring_json` column; it is extended to carry `kind`,
`detail` and `itsm` when present (additive; no migration). `listFindings` spreads
`scoring_json` back, so the finding detail API returns them. A finding with
`itsm` set reads back with `catalogued: true` and no `dimension` — the page's
"Group null" label for that case is corrected to the ITSM catalogue group.

### 4.2 Rule rows

Every one of the 139 slots becomes exactly one row in `manifest.itsm.rules`:

```
{ rule_id, slot, title, group, engine, base_severity,
  classification,            // EXECUTABLE | UNCONFIGURED | UNAVAILABLE   (design time)
  status, verdict,           // run time, verbatim
  executable, configured,    // the ladder, explicit
  blocker,                   // kind, step, object/table/fields, parameters, workbook_text …
  scope,                     // { partial, kind, not_covered }
  confidence,                // min over findings; composites: min over inputs (DECISION 7)
  findings,                  // count
  kpis,                      // observed values: numerator / denominator / pass_pct / basis
  parameters,                // key → { value, unit, source, status }  (expected / configured values)
  dependencies,              // inputs consumed, with their status
  evidence_missing,          // evidence-only fields absent on the instance
  population,                // closure: { total, judged, unit, basis[, determinate_when_empty] } — what the verdict rests on
  population_empty,          // closure: true when nothing was in scope
  undetermined,              // closure: { kind, reason, health: 'not established', verdict } — evaluated, no finding, nothing established
  empty_population_evidence, // independent cross-check from kpis / reads (a pass it flags is a defect)
  reason,                    // the human sentence
  ms }                       // time in this run
```

Stored findings add `itsm.occurrences` (closure): how many runner findings the
stored one stands for — above 1 only where two variants shared a fingerprint.

### 4.3 Skipped checks

Every non-evaluated catalogue rule also appears in `manifest.skipped_checks`
(the list the page already renders) with `rule`, `table`, `reason` as **strings**
(an object there crashes the page) plus additive `status`, `blocker_kind`,
`source: 'itsm_catalogue'`. So does every EVALUATED rule that established
nothing (closure): `status: 'evaluated'`, `undetermined: <kind>`, and a reason
ending "health could not be established, so the verdict is inconclusive, not pass". Its state therefore survives into the existing UI
and the composed All view (`composedView` keeps skips whose `scopeOfRule` is the
module — `ITSM-###` routes to itsm).

---

## 5. Aggregation (Stage 5D) — informational, no score

`manifest.itsm.aggregation`:

```
rules: 139
by_classification: { EXECUTABLE, UNCONFIGURED, UNAVAILABLE }
by_status:  { evaluated, unconfigured, unavailable, skipped, not_configured, error }
by_verdict: { pass, fail, inconclusive }
findings_by_severity: { SYSTEMIC, CRITICAL, HIGH, MEDIUM, LOW }
rules_with_findings: [ids]
blocked: { by_blocker_kind: { kind → [ids] } }
unconfigured_parameters: [{ rule_id, keys, workbook_text }]
reconciliation: { total, sums_to_139, duplicates: [], missing: [] }
undetermined_by_kind: { kind → [ids] }        // closure
population_empty: [ids]                       // closure
passes_over_empty_population: [ids]           // closure: must be []
```

`manifest.itsm.performance.cache` (closure) records what the run's caches
saved: `reads` (requirement reads served from the read cache), `probes`
(capability questions served from the probe cache) and `counts` (instance
counts served from the per-run count memo, `data-access.js countMemo`).

Deterministic (sorted ids), computed once, never turned into a number.

---

## 6. Consumers and what changes for them

| Consumer | Today | Change |
|---|---|---|
| `scopes.js ITSM_DOMAINS` | `INCIDENT, CHANGE, PROBLEM` | add `ITSM` (routing and domain rows) |
| `scopes.js itsmScore` | counts `ITSM_DOMAINS` findings | counts an explicit, frozen `ITSM_SCORED_DOMAINS = INCIDENT, CHANGE, PROBLEM` — **the score cannot move** (DECISION 6, brief §7); a test pins it |
| `scopes.js scopeFilter` (SQL) | domain only | **mirrors `scopeOf`**: override → rule-id prefix → domain → platform fallback. Fixes catalogue findings being invisible on the ITSM tab, and an existing defect: CMDB-124…130 report under `PERFORMANCE` and are hidden from the CMDB tab's list today although counted in its summary |
| `scopes.js scopeOfRule` | `/^ITSM-/` | also `ITSM` exactly — the legacy family logs its table skips as rule `ITSM`, which routes to Platform and is dropped from ITSM-only scans (existing defect) |
| `summariseScopes` domains | from `AGENTS` | `itsm_agent` registered → an `ITSM` domain row; findings and domain rows reconcile |
| `manifest.domains` | from `AGENTS` | same |
| `store.scoringOf` | CMDB fields | + `kind`, `detail`, `itsm` |
| `/modules/findings`, `/runs/:id/findings`, CSV exports | domain-filtered | receive catalogue findings through the corrected filter; CSV columns unchanged |
| `/runs/:id/findings/:fp` + `remediationFor` | `REMEDIATION[id]` → CMDB catalogue → fallback | ITSM-### take the fallback (`known: false`, `decision: human`); no crash |
| `buildProposal` | `FIX_FIELD[id]` | no ITSM-### entry → `no_field_fix`; no crash |
| `HealthAssist.jsx` | renders findings, skipped checks, scopes | receives the new rows through existing fields; `detail` / rule rows are available in the API for a later UI phase (no redesign in Phase 5) |
| `health_runs.manifest_json` | unconstrained | `manifest.itsm` adds ~139 rows (bounded; no record contents) |

Known presentation limits recorded, not redesigned: the severity bars exclude
the SYSTEMIC band (it is the CMDB gate band), so ITSM SYSTEMIC findings are
listed but not barred; there is no ITSM trust gate (a scoring decision).

---

## 7. Configuration flow (Stage 5F)

Precedence is unchanged: **workbook default → instance override → runtime override**.

Today the instance layer (`ParameterRegistry.setInstanceOverride`) exists only in
memory and nothing loads it, so the 29 instance-supplied gaps can never be filled
in a real scan. The integration adds:

- a per-instance store of overrides (migration 29, `health_itsm_parameters`:
  instance key, rule, key, typed JSON value, who / when), validated through the
  registry's own `setInstanceOverride` before it is written (an undeclared key or
  a wrong type is refused — an override cannot invent a parameter);
- a registry built per scan from the declarations + that instance's overrides,
  passed to both the evaluation context and `itsmEngineKey()` (so an override
  change invalidates the ITSM result, DECISION 4 / 8);
- read / write API: `GET /api/health/itsm/parameters` (every declared parameter,
  its status, the workbook sentence, the rules blocked by it) and
  `PUT /api/health/itsm/parameters/:rule/:key`;
- runtime overrides via the run request (`itsmParameters`), recorded on the run and
  excluded from the key (Phase 4 contract).

No value is supplied for any UNDEFINED parameter.

---

## 8. Caching (DECISION 8 kept)

- **Engine key:** unchanged — `incremental.engineKeys` already folds
  `itsmEngineKey()` into the ITSM module only; built from the per-scan registry
  so instance overrides count.
- **Data invalidation (gap in today's design):** the change check stamps only
  tables in the `TABLES` registry and the CMDB meta sources. The catalogue reads
  `task_sla`, `sys_audit`, `sysapproval_approver`, `cmn_schedule*`, `sys_choice`,
  `sys_dictionary`, bounded `cmdb_ci` / `cmdb_rel_ci` and others; a change to any
  of them would today leave a reused ITSM result stale.
  *As built:* a static table list derived from the rule files was tried first and
  missed 10 of the 25 tables one fixture run read (verified readers, the
  dictionary, group members, the journal, the bounded graph). So the catalogue's
  client is wrapped (`incremental.stampingClient`): **every table is stamped the
  first time anything reads it, before that read**, and the set is stored as
  `manifest.itsm_stamps` — the ITSM module's reuse baseline, compared whole on the
  next change check (`plan.meta['itsm:<table>']`). Nothing is listed, so nothing
  can drift. Table-level stamps are conservative: a change anywhere in a table the
  catalogue read re-reads ITSM.
- **Failed reads:** a catalogue read that failed (`FAILED_READ_STATUSES`, shared
  with the CMDB path) or a capability probe that could not answer marks the ITSM
  result degraded — never reused. Stable facts (an absent table, an undefined
  object, a field the release lacks) do not.
- **Time:** window rules drift with the clock; the existing 24 h reuse ceiling
  applies.
- **CMDB isolation:** CMDB, ITOM and Platform keys and stamps do not change.

---

## 9. Performance (Stage 5G)

Baseline to reproduce first, integrated, on the configured instance: total scan
time, ITSM runner time, requests (row / count / aggregate), capability probes,
read-cache hits / misses, time per engine and per rule. Known Phase 4
bottleneck: ~73 `change_request` row reads for ~105 rows (the read cache keys on
table + query + fields). A shared per-table row cache is implemented only if it
provably preserves each rule's query semantics and data-access boundaries.
No unbounded `cmdb_ci` / `cmdb_rel_ci` read is introduced (DECISION 11).

---

## 10. The old 11 rules (brief §18)

They keep running, unchanged, and keep producing the ITSM score. Stage 5H
compares each with its nearest catalogue rule(s) — detection, population, severity,
evidence, false-positive behaviour — on the estate fixture and on the instance,
and documents where a catalogue rule is a replacement, a superset, or not
equivalent. Nothing is deleted.

---

## 11. Decisions this design does not take

| Item | Why it is not taken here |
|---|---|
| A 139-rule ITSM score; weights; treatment of UNAVAILABLE / UNCONFIGURED | Scoring (brief §7, §19; DECISION 6) — `SCORING-OPTIONS.md` |
| An ITSM trust gate for SYSTEMIC rules | A scoring decision |
| Retiring any of the 11 legacy rules | Brief §18 — comparison first, decision later |
| Values for UNDEFINED parameters | DECISION 3 — customer-supplied |
| UI rendering of `detail` and rule rows | No UI redesign in Phase 5 |

## 12. Stage plan and tests

| Stage | Change | Tests through the real pipeline |
|---|---|---|
| 5B | runner in `runHealthCheck`; findings into the itsm family; `AGENTS`; routing / SQL filter fixes | all 139 ids once; ITSM-only and full scans; score unchanged; CMDB-124 visible in the CMDB list |
| 5C | `integration.js` normalization; `scoringOf` extension; skipped checks | evidence, blocker, confidence, kind / detail survive store round-trip |
| 5D | aggregation | reconciliation 139; counts deterministic |
| 5E | `SCORING-OPTIONS.md` | score formula pinned |
| 5F | parameter store + API + per-scan registry; source-table stamps | UNCONFIGURED → configured via instance override; key moves; reuse invalidated by a catalogue table change |
| 5G | profile; shared reads only if semantics proven | request counts before / after |
| 5H | E2E suite; PDI read-only run; legacy comparison; `PHASE5-REPORT.md`; fresh matrix | false-PASS guards (missing field / table / threshold / dependency, incomplete CMDB, failed schedule, empty data, engine error) end to end |
