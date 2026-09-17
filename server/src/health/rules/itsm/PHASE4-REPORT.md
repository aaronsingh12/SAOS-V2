# ITSM Health Checker — Phase 4 report

Date: 2026-09-17. Scope: Goal A (align the Phase 3 code with every decision in
`DECISIONS.md`) and Goal B (connect the 139 catalogue rules to the reusable
engines declaratively). Phase 5 was not started. `DECISIONS.md` was not modified.

## 1. Decision compliance

| # | Decision | Status | Implementation | Evidence |
|---|---|---|---|---|
| 1 | TF-IDF cosine similarity | **Compliant** | `engines/text-analysis.js createTfidfProvider` — normalise (case, whitespace, punctuation, digit runs → `#`), tokenise, smoothed idf, cosine. Workbook thresholds (0.9 / 0.85 / 0.8) applied by the rule config, never chosen by the engine; `similar()` / `clusterBy()` throw without a threshold. `UNRESOLVED_SIMILARITY` remains the refusing default for a caller that fitted nothing. | `test/health-itsm-engines-3.test.js` (identical 1.0, similar, unrelated 0, empty 0, normalised equal, boundary at/above threshold); rules 021, 070, 075 in `health-itsm-rules.test.js` |
| 2 | Empirical distribution, no ideal model | **Compliant** | `aggregate.js EXPECTED_DISTRIBUTION = { method: 'empirical' }` (the old `expectedDistribution()` is gone); `joint_share` measure = share of each close code within its category, with `minimum_group_volume` withholding small categories; ITSM-024 configured on it with both thresholds UNDEFINED (stays UNCONFIGURED, as §2 allows) | AGGREGATE boundary test (024 with runtime thresholds; guard withholds) |
| 3 | Undefined thresholds → UNCONFIGURED | **Compliant** | `parameters.js` status vocabulary `RESOLVED / UNCONFIGURED` (+ internal reason `undefined_default` / `undeclared`); `rules/itsm/parameters.json` gives a default only where the workbook sentence contains it — a test asserts every DEFINED default is literally in the sentence | `health-itsm-phase4.test.js` PARAMETERS |
| 4 | Typed parameters, precedence, key invalidation | **Compliant** | 108 declarations over 139 rules (61 DEFINED, 47 UNDEFINED, 58 parameterless); precedence workbook → instance override → runtime override; `$param` references compiled by `rule-config.js`; registry fingerprint is an input of the engine key | PARAMETERS + ENGINE KEY tests |
| 5 | Undefined objects: candidate → discovery → schema → capability | **Compliant** | `capability.js configurationObject` runs the four steps and stops at the first unmet one (`step` recorded); `runner.js` gates `requires_objects` / `requires_tables` through it; `$choice` takes state / status values from the instance's `sys_choice` by label (no hard-coded values); a verified object with no reader is still UNAVAILABLE | OBJECT PIPELINE test; CONFIGURATION test in engines-2 |
| 6 | Severity map, Moderate → MEDIUM, no score change | **Compliant** (unchanged from Phase 3) | `adapter.js`; no scoring code touched | `health-itsm-foundation.test.js` |
| 7 | Composite confidence = min | **Compliant** (unchanged) | `composite.js propagateConfidence`; combinators return findings the engine clamps to the min | COMPOSITE tests; rule 134 |
| 8 | ITSM engine key over every result-affecting input, ITSM-only invalidation | **Compliant** | `engine-key.js` inputs: catalogue version, workbook sha, map version, parameter fingerprint, registry version, every engine version, rule-configuration fingerprint, dependency edges, source hash of `health/itsm/**` (js + json). `health/incremental.js engineKeys` folds it in for `m === 'itsm'` only. | ENGINE KEY tests (parameter override / config change / engine version each move the key; cmdb = itom = platform keys, itsm differs) |
| 9 | Recurring schedules expanded or unavailable | **Compliant** | `schedules.js` expands once / daily / weekly / weekdays in the schedule's IANA zone (DST-aware) clipped to the window; monthly / yearly / bad zone / floating → `unavailable`; a schedule with one unexpandable span is wholly unavailable; `intervalIntersections` answers `unavailable` (no hits) if any span is not concrete; ITSM-112 / 127 use `mode: schedule_intersection` | SCHEDULES test; TEMPORAL tests (112 with a monthly span → unavailable; no schedules → unavailable pointing at 085) |
| 10 | ITSM-072 order from instance metadata | **Compliant** | `audit-history.js deriveStateOrder` from `sys_choice.sequence` (non-empty, numeric, distinct sequences and values, else unavailable); a literal `order` in configuration throws; `backwardTransitions([])` throws | AUDIT tests (instance order, reversed order flips the verdict, tied / blank / missing → unavailable) |
| 11 | CMDB reads scoped to referenced CIs | **Compliant** | `relationship-graph.js createGraphStore` / `boundedGraph`: `parentIN…` / `childIN…` reads of the seeds only, expanded to the rule's depth, cached per run; a rule with no CI triggers no CMDB read (not even a probe); incomplete per-node reads → unverifiable → UNAVAILABLE when nothing is verifiable; the temporal engine's dependent-CI expander is built on the same store. The old whole-table `sharedGraph` is removed. | GRAPH tests (every `cmdb_rel_ci` read carries a bounded clause; zero reads without a CI; truncated read → unavailable) |

Not required by any decision and therefore not done: severity weights, group
weights, changes to the ITSM score, UI, routes, the 11 hard-coded rules.

## 2. Rule counts (139)

| Status | Count | Meaning |
|---|---:|---|
| TESTED | 66 | executable with workbook defaults, asserted end-to-end through the runner |
| IMPLEMENTED (untested) | 0 | — |
| UNCONFIGURED | 30 | executable; at least one referenced threshold has no workbook default. Each was also exercised with a runtime override to prove the mechanics (008, 013, 023, 024, 031, 038, 054, 058, 071, 074, 098, 106, 114, 115, 126, 127, 128, 077 via 054) |
| UNAVAILABLE | 43 | needs an object / dependency that neither the workbook nor DECISIONS.md defines; the runner answers UNAVAILABLE with the pipeline step reached |
| NOT_STARTED / IN_PROGRESS | 0 | — |

Executable rules: **96**. Test coverage (an assertion naming the rule): **139 / 139**.

Per engine (rules / tested / unconfigured / unavailable): record_predicate 24 / 17 / 2 / 5 · aggregate 19 / 13 / 5 / 1 · configuration 23 / 8 / 1 / 14 · linkage 22 / 6 / 4 / 12 · reference_integrity 10 / 6 / 1 / 3 · audit_history 7 / 5 / 0 / 2 · text_analysis 11 / 4 / 7 / 0 · relationship_graph 4 / 1 / 3 / 0 · temporal_correlation 9 / 2 / 6 / 1 · composite 10 / 4 / 1 / 5.

Engine overrides (allowed by the map's `also_requires` / `consumes_output_of`): ITSM-108 → record_predicate (the workbook's own fallback: actual-start field), ITSM-134 → composite (union of 018 / 065 / 101).

The full per-rule table is `status-matrix.md` (regenerate with `node scripts/itsm-status-matrix.mjs`).

## 3. Engines used and what was added

All ten Phase 3 engines are used; versions bumped to 1.1.0 (behaviour changed
under the decisions, and the version is an engine-key input). Additions:
count-ratio path with per-group judgement and cross-table counts, `window`,
`trend` over `ctx.measureHistory` (aggregate); `same_as` / `differs_from`
(record predicate); estate-level `threshold` (linkage, graph); named
comparators, combinators and key expanders (`comparators.js`); real
`similarity` / `cluster` / `frequency` / `pattern_scan` evaluation with the
text budget (text); `schedule_intersection` and `before_after` modes,
`pairs` on the result (temporal); `order_source` and journal-completeness
gating (audit); `service_criticality`, `dependents_count`, all-unverifiable →
UNAVAILABLE (graph); `unavailable` from a combinator (composite). New
foundation modules: `rule-config.js`, `runner.js`, `comparators.js`,
`schedules.js`, `rules/index.js`. `STATUS.ERROR` added for a caught engine
fault (reported, never a pass).

## 4. Parameters

`rules/itsm/parameters.json`: 108 declarations, 61 with the workbook's
default, 47 UNDEFINED, 58 parameterless rules. Rules UNCONFIGURED by their
own declared gap: 008 generic_values · 013 custom_state_values · 022
service_account_pattern, volume_threshold · 023 volume_share · 024
minimum_volume_per_category, anomaly_share · 025 consistency_rules · 027
timing_window · 031 autoclose_closed_by · 037 p4_age, p5_age (P1–P3 run) ·
038 manual_creation_query · 040 similarity, repeat_count · 054 similarity,
cluster_volume · 058 similarity · 059 concentration_ratio · 071
root_cause_classification · 073 alignment_matrix · 074 decline_threshold ·
098 risk_bands · 104 volume_share · 105 scope_depth · 106 object_classes,
correlation_window · 114 backout_task_type · 115 dependency_depth · 126
depth, critical_values · 127 freeze_schedule_type · 128 close_codes · 129
problem_reference_threshold · 131 depth_threshold · 133 volume_threshold ·
135 minimum_volume_per_ci, dominance_share.

Declared but unused by the current config (the rule is blocked or partial):
007 minimum_autoclose_days, 009 deadend_age, 010 field_stage_mapping, 028
identifier_patterns, 034 multiple_of_mean, 035 spike_multiple/interval, 045
p1_volume_threshold, 050 gap_threshold, 052 age_threshold, 076 window, 082
window, 086 burden_ratio, 089 review_period, 092/122 risk_bands, 093
access_threshold, 110 authority_matrix, 116 threshold, 121 share.

## 5. ServiceNow dependencies that remain UNDEFINED (DECISION 5)

Placeholder objects and the rules waiting on them (candidate table in
brackets; `null` = no candidate at all):

- `major_incident` (null): 045, 046, 047, 048, 049, 050, 051, 055
- `approval_routing` (null): 081, 086, 091, 109, 110, 116, 121
- `post_incident_review` (null): 047, 052, 078, 092, 122
- `conflict_detection` (`conflict`): 084, 118, 138
- `standard_change_template` (`std_change_producer_version`): 080, 089, 117
- `knowledge_link` (`m2m_kb_task`): 066, 076, 139
- `assignment_rule` (`sysrule_assignment`): 004, 029
- `priority_matrix` (`dl_u_priority`): 005 (also the configuration half of 001)
- `autoclose_configuration` (`sys_properties`, property name UNDEFINED): 007 (and 031's identifier)
- `ui_policy` / `data_policy` (`sys_ui_policy` / `sys_data_policy2`): 010
- `notification` (`sysevent_email_action`): 011
- `knowledge_suggestion` (`cxs_table_config`): 015
- `cab` (`cab_meeting`): 082
- `change_model` (`chg_model`): 087
- `approval_delegation` (`sys_user_delegate`): 088
- `change_calendar` (null): 093
- `communication_plan` (null): 046
- `risk_assessment` (null): the "unconfigured" half of 083 and 131

Declared UNDEFINED dependencies (no object at all): 034 (per-group pause rate
vs estate mean — no engine mode), 035 (density spike before SLA expiry — no
engine mode), 132 (ITOM-147 cause), 137 (SLA-to-service scoping).

Workbook-named tables the map did not verify, gated through the same pipeline
at run time (the rule runs when the instance has them): `problem_task` (068),
`change_task` (114), `em_alert` (038), `sys_attachment` (027).

## 6. Tests

- Before Phase 4: 3,423 tests / 3,415 pass / 8 fail. After: **3,459 / 3,451 / 8** — the same 8 pre-existing failures (layout, sdk-column-types, workspace registry; SDK workspace not installed). No regression outside ITSM. (One of four full runs, executed concurrently with another `npm test`, reported 9; the three isolated runs reported 8.)
- ITSM suites: 133 tests, all passing — 16 Phase 3 tests rewritten to the decided vocabulary (`unavailable` / `unconfigured`, DECISION 10 order source, TF-IDF, bounded graph, empirical distribution), plus `health-itsm-phase4.test.js` (13) and `health-itsm-rules.test.js` (23) with the estate fixture `test/helpers/itsm-estate.js`.
- Required cases covered: positive / negative per rule, threshold boundaries (20 chars, 60 s, 1 h tolerance, 70 %, 30 %, 25 %, 72 h, exactly-at vs just-above), missing fields (capability), forbidden tables, incomplete reads (truncated target, journal, relationships), unconfigured parameters, unavailable objects at each pipeline step, evidence fields and redaction, slot ↔ rule identity, dependency order, variant merging, error capture, ITSM-only key invalidation.

## 7. Performance

Offline estate fixture (4 incidents, 3 problems, 3 changes, full metadata),
all 139 rules: 45–125 ms per run, 341 requests (194 row queries, 105 counts,
42 aggregates), of which 61 are `sys_db_object` and 40 `sys_dictionary`
capability probes (cached per run). Reads are declared and cached per run;
no engine reads a whole `cmdb_rel_ci`; aggregate rules read no rows; text
rules pass through the text budget and flag `sampled`. Not measured against a
real instance in this phase.

## 8. Blockers and items for explicit resolution

1. **UNDEFINED objects** (§5) — 43 rules cannot move until each object is confirmed on an instance and a reader is written against the verified schema.
2. **UNDEFINED thresholds** (§4) — 30 rules run only with instance overrides; the values are the customer's to supply.
3. **Assumptions recorded in code, to verify on a real instance:** `cmn_schedule_span.days_of_week` digit convention (1 = Monday, configurable `dayCodeBase`); blackout / maintenance windows are `cmn_schedule.type = blackout / maintenance` (085, 112); `$choice` labels "Retired", "On Hold", "Cannot Reproduce" must exist on the instance's choice lists (else UNAVAILABLE); custom fields are `u_`-prefixed (014); `approval = approved` and `close_code = successful / unsuccessful`, `type = emergency` as the platform's own values.
4. **Monthly / yearly recurrences** are not expanded (DECISION 9 → unavailable); expanding them needs the platform's month-overflow semantics confirmed.
5. **ITSM-024** — "share below `anomaly_share` within a category" is one reading of "far outside the expected joint distribution"; needs confirmation before the threshold is set.
6. **ITSM-129** — the workbook says "all three breach"; only 016 and 094 exist as rules and the problem-side threshold is UNDEFINED.
7. **Partial scope** recorded per rule as `scope_note` in the matrix (43 rules), e.g. 009 dead-end half, 042 concentration half, 044 fulfiller split, 100 approval-timestamp case, 124 CI-class dimension, 028 account-number patterns.
8. **One-time invalidation:** editing `health/incremental.js` (an `ENGINE_FILES` member) changed the shared source hash, so every module's stored incremental result is re-read once after deployment; thereafter only the ITSM key moves on ITSM changes.
9. **Not wired to a scan** — `runITSMRules` is not called by `health/index.js`; the ITSM score is still the 11 hard-coded rules' pass rate (unchanged by instruction). Phase 5.
