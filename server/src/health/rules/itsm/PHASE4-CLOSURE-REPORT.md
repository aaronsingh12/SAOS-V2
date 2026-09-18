# ITSM Health Checker — Phase 4 closure report

Date: 2026-09-17. Authority: `DECISIONS.md` (unchanged) and `catalogue.json` (139
rules, unchanged identities). This report closes Phase 4; Phase 5 (wiring
`runITSMRules` into the Health Checker scan and the score) was not started.

## 1. Executive summary

**Phase 4: COMPLETE.**

- 139 / 139 rule slots accounted for, identities unchanged: **TESTED 76 · UNCONFIGURED 30 · UNAVAILABLE 33 · ERROR 0** (= 139; NOT_STARTED 0, IN_PROGRESS 0). Executable: 106. Every rule has an assertion appropriate to its state (139 / 139 test coverage).
- All 11 decisions are implemented and proven by tests; none was reconsidered, replaced or modified.
- ITSM-024 and ITSM-129 have deterministic, documented behaviour (§3, §4).
- Every non-evaluated result carries a machine-readable blocker; every evaluated result carries a verdict (`pass` / `fail` / `inconclusive`) and an explanation; a rule whose configuration covers only part of the workbook's detection never reports a pass.
- Real-instance validation (read-only, `dev442675.service-now.com`) was run twice and drove concrete corrections: a **genuine defect** (the platform silently matches every row when an encoded query names a field the instance lacks — five linkage rules produced false FAILs; now a field gate makes them UNAVAILABLE), the schedule-span timestamp format the instance actually returns, the recurrence fields the span reader was not fetching, and the verification of ten objects the Phase 4 report had left UNAVAILABLE.
- Full suite: **3,468 tests, 3,460 pass, 8 fail — the same 8 pre-existing, environment-specific failures** as before Phase 4 (SDK workspace not installed; layout). ITSM suites: 142 / 142.
- Nothing outside `health/itsm/` changed except `health/incremental.js` (+5 lines, DECISION 8, unchanged since the Phase 4 report) and the Phase 3 `servicenow/client.js` addition. `rules.js`, `index.js`, `scopes.js`, routes, the 11 hard-coded rules and the ITSM score model are untouched.

Remaining blockers (§12) are all specification or instance gaps that cannot be resolved without a new decision or external information; none is a defect.

## 2. Decision compliance

| # | Decision | Final status | Where | Proof |
|---|---|---|---|---|
| 1 | TF-IDF cosine | Compliant | `engines/text-analysis.js createTfidfProvider`; thresholds only from rule configs | engines-3 (identical / similar / unrelated / empty / normalised / boundary); rules 021, 070, 075 |
| 2 | Empirical distributions, ITSM-024 on the observed relationship | Compliant | `aggregate.js EXPECTED_DISTRIBUTION`, `joint_share`; 024 blocked by a declared specification gap (no statistic chosen) | rules (024, joint_share measure proven; no false PASS) |
| 3 | Undefined thresholds → UNCONFIGURED | Compliant | `parameters.json` (108: 61 workbook defaults, 47 UNDEFINED); a test asserts every DEFINED default is literally in the workbook sentence | phase4 PARAMETERS |
| 4 | Typed parameters, precedence, invalidation | Compliant | `parameters.js`, `rule-config.js`, `engine-key.js` | phase4 PARAMETERS / ENGINE KEY, closure ENGINE KEY |
| 5 | Object resolution pipeline | Compliant, extended | `capability.js configurationObject`; `configuration.js` VERIFIED readers (pipeline at read time); `runner.js objectGate / tableGate / fieldGate`; `$choice` values from the instance (walking the super-class chain) | phase4 OBJECT PIPELINE, closure VERIFIED OBJECTS / FIELD GATE |
| 6 | Severity map, no score change | Compliant | `adapter.js`; no scoring code touched | foundation |
| 7 | Composite confidence = min | Compliant | `composite.js propagateConfidence` | closure COMPOSITE CONFIDENCE (all high, one low, two levels, unavailable / missing input) |
| 8 | ITSM engine key, ITSM-only invalidation | Compliant | `engine-key.js` (catalogue, workbook sha, map, parameters, registry + engine versions, configuration fingerprint, dependency edges, source); `incremental.js engineKeys` for `itsm` only | closure ENGINE KEY (equal inputs reuse; dependency change; CMDB acceptance does not move ITSM) |
| 9 | Recurring schedules expanded or unavailable | Compliant, corrected | `schedules.js`: instance span format (`YYYYMMDDTHHMMSS[Z]`), day convention verified on the instance, once / daily / weekly / weekdays, DST both ways; monthly / yearly / floating → unavailable | phase4 SCHEDULES, closure SCHEDULES (month, leap, DST fall-back, edges), rules 112 |
| 10 | ITSM-072 order from instance metadata | Compliant | `audit-history.js deriveStateOrder` (sequence), literal order refused, cached per run | engines-3, rules 072, closure 072 caching |
| 11 | Bounded CMDB reads | Compliant | `relationship-graph.js createGraphStore / boundedGraph`; no CI → no read, not even a probe | engines-2 GRAPH, rules GRAPH |

## 3. ITSM-024 resolution

Workbook: *"Category and close code pairs occurring far outside the expected joint distribution"*; threshold: *"Expected distribution derived from the estate's own data, minimum volume per category required"*. DECISIONS.md §2: evaluate the observed category × resolution-code relationship; where the workbook does not give enough to determine the anomaly threshold it stays configurable/undefined.

Finding: the workbook defines neither the **statistic** behind "far outside" (share of the code within its category, distance from the expected-under-independence frequency, or another), nor the anomaly threshold, nor the minimum volume per category. The Phase 4 configuration had chosen the within-category share as the statistic while leaving the two numbers UNDEFINED — a hidden assumption.

Resolution: the rule configuration declares a **`specification_gap`** (machine-readable: `blocker.kind = specification_gap`, with `missing`, `workbook`, `decision`, `prepared`, `resolution`). The runner stops the rule before any read and answers **UNCONFIGURED**; supplying the two thresholds does *not* unblock it, because the statistic is not theirs to choose. The empirical measure prepared for it (`joint_share`: observed share of each close code within its category, small categories withheld, no reference model) is kept and tested at engine level. Tests: `health-itsm-rules.test.js` (UNCONFIGURED with and without thresholds, no read, no finding, verdict null; the measure's behaviour), `health-itsm-closure.test.js` EVIDENCE.

What resolves it: an explicit decision naming the statistic and setting `anomaly_share` and `minimum_volume_per_category`.

## 4. ITSM-129 resolution

Workbook: *"CI and service reference rates across incident, problem and change_request"*; detection *"Reference rates below threshold across all three processes simultaneously"*; threshold *"Per-process thresholds; fires only when all three breach"*. The architecture map's `consumes_output_of` lists ITSM-016 (incident, 40 %) and ITSM-094 (change, 30 %) and its support note names "the problem equivalent".

Finding: the workbook's problem-process reference rate is ITSM-067's ratio (*"Problems with both CI and service references empty … report as a ratio"*), for which the workbook gives no threshold.

Resolution: 129 consumes **016, 094 and 067** (no manufactured dependency — 067 is the workbook's own problem reference-rate rule). The `all_breach` combinator judges 016 and 094 by their own findings and 067 by its recorded rate against the declared parameter `problem_reference_threshold` (UNDEFINED). The rule is **UNCONFIGURED** (`blocker.kind = unconfigured_parameter`, naming the key and the workbook sentence) until the instance supplies it; then it fires only when all three breach, with each process's rate side by side as evidence; an input that could not be evaluated blocks it (`blocker.kind = input`). Tests: `health-itsm-closure.test.js` ITSM-129 (unconfigured by default; two of three → no finding; all three → SYSTEMIC finding with the three rates; exactly at the threshold → no finding; forbidden problem table → blocked).

## 5. ServiceNow dependency validation

Read-only validation against `dev442675.service-now.com` (release `glide-australia-02-11-2026`, patch 3), `scripts/itsm-instance-validation.mjs`, results in `instance-validation.json`. Every candidate object was probed through the pipeline; every field the configurations read was checked; the choice lists the rules resolve by label were read.

**Previously UNAVAILABLE, now executable** (object verified: exists, schema carries the required fields, readable; re-verified by the pipeline on every run):

| Rule | Object (table) | Now |
|---|---|---|
| 005 | priority matrix = priority data lookup `dl_u_priority` (impact, urgency, priority) | TESTED — incidents whose priority differs from the lookup for their impact × urgency |
| 011 | notifications `sysevent_email_action` (recipient_users, recipient_groups) | TESTED — recipients resolving to inactive users / empty groups |
| 029 | assignment rules `sysrule_assignment` (condition, table, group, user, active) | TESTED — rules whose condition references location / department, and incidents leaving them empty |
| 080 | the usage half needs no object: standard share of changes < 20 % | TESTED (evidence gap: template count) |
| 082 | CAB meetings `cab_meeting` | TESTED — no meeting in the window despite change volume (detection gap: the CAB configuration half) |
| 088 | delegations `sys_user_delegate` (user, delegate, starts, ends) | TESTED — active delegations to an inactive user |
| 109 | approval records `sysapproval_approver` (approver, state, sysapproval) | TESTED — approver = requested_by |
| 116 | approval records | TESTED — approved within 120 s of request (detection gap: sys_updated_on approximates decision time) |
| 121 | approval records | TESTED — one approver's share of change approvals > 25 % |
| 139 | attached knowledge `m2m_kb_task` + `kb_knowledge.workflow_state` | TESTED — resolved incidents whose attached article is not "Published" |
| 085 / 112 | blackout / maintenance windows are the platform's own classes `cmn_schedule_blackout` / `cmn_schedule_maintenance` (module "Blackout Schedules" → `cmn_schedule_blackout`; "Maintenance Schedules" → `cmn_schedule_maintenance`; both extend `cmn_schedule`) | TESTED — no type value assumed |

**Still UNAVAILABLE (33)** — each reason machine-readable in the matrix:

- No candidate object at all (`stopped at: candidate`): `major_incident` (045–051, 055 — the workbook field `major_incident_state` is absent on the validation instance), `approval_routing` (081, 086, 091, 110 — routing/authority *definitions*, not approval records), `post_incident_review` (047, 052, 078, 092, 122), `change_calendar` (093), `communication_plan` (046), `risk_assessment` (083's and 131's second halves, recorded as scope, not as blockers).
- Candidate present but its required schema is UNDEFINED (`stopped at: schema_verification`): `ui_policy` / `data_policy` (010), `conflict_detection` — `conflict` (084, 118, 138), `change_model` — `chg_model` (087; `type` absent on the instance), `standard_change_template` — `std_change_producer_version` (089, 117; `state` absent on the instance), `autoclose_configuration` — the property name is not in the workbook (007).
- Candidate identified by name only, semantic identity unconfirmed (kept UNAVAILABLE deliberately): `knowledge_suggestion` — `cxs_table_config` (015; the pipeline verifies it, `stopped at: reader`), `knowledge_link` for known errors (066, 076 — how a Known Error links to its article is UNDEFINED; `m2m_kb_task` is verified only for 139's incident ↔ article case).
- Undefined dependency: 004 (an assignment-rule condition evaluator), 034 (per-group SLA pause rate vs estate mean), 035 (resolution-time density spike), 132 (ITOM-147), 137 (SLA-to-service scoping).

**Instance-specific deviations recorded** (`instance-validation.json`): `incident.problem_id` and `incident.rfc` do not exist on this release (039, 054/058's link, 057, 060, 063, 069, 073, 077, 128 are UNAVAILABLE *on this instance* by capability, executable elsewhere); `problem.close_code` does not exist (`resolution_code` does — 079 UNAVAILABLE here); `em_alert` absent (038); `cmdb_ci` not audited (106 would be UNAVAILABLE); one of the two blackout schedules has no time zone (112 UNAVAILABLE here — DECISION 9, floating schedule).

## 6. Configuration resolution

Parameter declarations: 108 over 139 rules — 61 with the workbook's stated default, 47 UNDEFINED, 58 rules parameterless. Precedence workbook → instance override → runtime override, tested. No default invented (a test asserts each DEFINED default appears in the workbook sentence).

The 30 UNCONFIGURED rules and their declared gap (each carries `blocker.kind = unconfigured_parameter` naming the key and the workbook sentence; each was also exercised with a runtime override where the mechanics permit):

008 generic_values · 013 custom_state_values · 022 service_account_pattern, volume_threshold · 023 volume_share · **024 specification gap** · 025 consistency_rules · 027 timing_window · 031 autoclose_closed_by · 037 p4_age, p5_age (P1–P3 evaluate; verdict inconclusive) · 038 manual_creation_query · 040 similarity, repeat_count · 054 similarity, cluster_volume · 058 similarity · 059 concentration_ratio · 071 root_cause_classification · 073 alignment_matrix · 074 decline_threshold · 098 risk_bands · 104 volume_share · 105 scope_depth · 106 object_classes, correlation_window · 114 backout_task_type · 115 dependency_depth · 126 depth, critical_values · 127 freeze_schedule_type (now: the schedule class holding freeze periods) · 128 close_codes · 129 problem_reference_threshold · 131 depth_threshold · 133 volume_threshold · 135 minimum_volume_per_ci, dominance_share.

Every threshold / window the workbook mentions has a typed declaration; declared-but-unused parameters belong to blocked or partial rules (007, 009, 010, 028, 034, 035, 045, 050, 052, 076, 082 window is now used, 086, 089, 092, 093, 110, 122).

## 7. Schedule validation

Supported and tested: once, daily (with `repeat_count`), weekly (`days_of_week`), weekdays, `repeat_until`, all-day, DST spring-forward and fall-back (Europe/London), a UTC-instant span (`…Z`) placed in the schedule's zone, month boundary, leap day (2028-02-29), window edges (touching in, one second past out). Timestamp formats accepted: `YYYYMMDDTHHMMSS`, `YYYYMMDDTHHMMSSZ`, `YYYY-MM-DD HH:MM:SS`.

Verified on the instance: `days_of_week` **1 = Monday … 7 = Sunday** (the platform's "Weekends / Saturday & Sunday" span carries "6"; "Blackout Wednesdays" and a "Wednesdays" span starting on a Wednesday carry "3"). The former assumption is now a recorded verification; `dayCodeBase` remains configurable.

Remaining unavailable semantics: `monthly` and `yearly` recurrences (the span fields `monthly_type`, `float_week`, `float_day`, `month`, `yearly_type` exist on the instance, but the platform's day-of-month overflow and float-week rules are not in the approved contract) — a span with either makes its schedule **unavailable**, never zero occurrences; a floating schedule (no time zone) likewise. ITSM-127 needs the schedule class holding freeze periods (UNDEFINED — the platform defines blackout and maintenance classes, not a freeze class).

## 8. Rule status matrix

`status-matrix.md` / `status-matrix.json` — 139 rows, one per slot, with: engine (and map override), status, executable, configuration required, dependency (object / verified / table / input / UNDEFINED), tested, evidence, blocking reason, scope (full or partial with kind and what is not covered), the estate-fixture outcome and the instance outcome. Regenerate with `node scripts/itsm-status-matrix.mjs`.

Reconciliation: TESTED 76 + UNCONFIGURED 30 + UNAVAILABLE 33 + ERROR 0 = **139**. Partial scope declared on 45 rules: 27 detection gaps (never a pass), 3 false-positive risks, 15 evidence gaps.

## 9. Test results

| Suite | Before closure | After closure |
|---|---|---|
| Full `npm test` | 3,459 / 3,451 pass / 8 fail | **3,468 / 3,460 pass / 8 fail** |
| ITSM suites | 133 / 133 | **142 / 142** (new: `health-itsm-closure.test.js`, 9 tests) |

The 8 failures are the same pre-existing, environment-specific ones (SDK workspace not installed: sdk-column-types ×4, workspace registry ×3; layout ×1). No test was weakened; assertions changed only where the closure changed behaviour deliberately (024 semantics, 085/112 schedule classes, promoted rules, PARTIAL vs UNAVAILABLE capability wording).

Coverage by state: executable rules — positive, negative, boundary, missing field (capability), forbidden table, incomplete read, evidence; UNCONFIGURED — blocked by default and configured through a runtime override; UNAVAILABLE — the pipeline step named, nothing read from task tables, no finding; composites — dependency order, blocked input, missing input, confidence propagation.

## 10. Real instance validation

`dev442675.service-now.com`, read-only, two runs (before and after the closure fixes). Recorded: 39 objects probed (38 present, `em_alert` absent), field availability per configured table, 16 choice lists with sequences (problem.state order 101 < 102 < 103 < 104 < 106 < 107 — the D10 order), audit flags (incident / problem / change_request audited; cmdb_ci and task not), 18 schedules (7 with a time zone) and 36 spans (14 weekly, 2 weekdays, 20 yearly), the day-of-week evidence, incident's own columns (22; no `u_` fields), and table sizes (incident 82, problem 25, change_request 105, cmdb_ci 2,785, cmdb_rel_ci 220, sys_audit 78,735).

Final run: 139 rules, **69 evaluated (41 fail, 21 pass, 7 inconclusive), 41 unavailable, 28 unconfigured, 1 skipped, 0 error**; 426 requests (246 row queries, 139 counts, 41 aggregates) in 158 s. Findings on the PDI are consistent with its demo data (e.g. ITSM-033: 11 breach-rate findings across the estate and SLA definitions; ITSM-130: 16 incidents on CIs with no relationships; ITSM-109 / 116: one self-approved change and one approval decided within 120 s; ITSM-107: 3 emergency-share findings; ITSM-113: 7 success-rate findings by dimension).

Corrections the instance forced: the field gate (§1), span timestamp parsing, span recurrence fields (`repeat_count`, `days_of_week`) now fetched, choice lookups walking the super-class chain (`change_request.approval` lives on `task`), the blackout / maintenance classes, and the object promotions of §5.

## 11. Performance

Methodology: per-rule and per-engine wall time from the runner, per-table request counts from a counting client wrapper, on the offline estate (139 rules, 5 runs) and on the PDI (139 rules, 1 run after fixes).

- Offline estate: 45–125 ms per full run, ~480 requests (dominated by capability probes, all cached per run).
- PDI: 158 s for 139 rules, 426 requests, mean ~0.37 s per request (network latency); by engine — configuration 36.6 s (24 rules), record_predicate 30.5 s (23), reference_integrity 26.1 s (9), aggregate 21.3 s (20), audit_history 14.2 s (7), linkage 11.3 s (22), temporal 10.4 s (9), graph 3.7 s (4), text 3.0 s (11), composite 1.4 s (10). Slowest rules: 085 (7.3 s — two schedule classes + spans), 011 (6.0 s — 421 notifications' recipients resolved in batches of 50), 120, 019, 123 (4–6 s — audit / reference / index reads).
- Probes: `sys_db_object` 94 and `sys_dictionary` 28 requests per run. The closure memoised the super-class chain and the whole element set per table, so every field question about a table costs one dictionary read per run (was one per rule per field set: 50 → 28).
- No N+1 patterns: references, group members, choice lists and journal counts are batched (50 ids) and cached; CMDB reads are bounded to referenced CIs (13 `cmdb_rel_ci` requests for two graph rules on 26 CIs); aggregate rules read no rows.
- Bottleneck identified for Phase 5 (not changed here — it would alter read semantics): the per-run read cache keys on (table, query, fields), so twenty-odd rules over `change_request` each issue their own row read (73 requests) although the table has 105 rows; a per-table row cache for small tables, or one wide read per table shared across rules, would remove most of the row traffic.

## 12. Remaining blockers

None is a defect. Each needs a new decision or external information:

| Rules | Blocker | Why it cannot be resolved here |
|---|---|---|
| 024 | The statistic behind "far outside the expected joint distribution", the anomaly threshold, the minimum volume per category | Not in the workbook; DECISIONS.md §2 leaves it configurable/undefined |
| 129 | `problem_reference_threshold` | The workbook gives no problem-process threshold |
| 045–051, 055 | Major-incident identification | No object; `major_incident_state` absent on the validation instance; which value means "major" is undefined |
| 081, 086, 091, 110 | Approval routing / authority definitions | No object named; approval *records* alone do not define routing |
| 047, 052, 078, 092, 122 | Post-incident review object | Not named |
| 084, 118, 138 | Conflict-detection schema / override fields; the overlapping-changes evidence | `conflict` exists; its required fields and semantics are undefined |
| 087, 089, 117 | Change-model state requirements; template expiry / scope fields | `chg_model.type`, `std_change_producer_version.state` absent on the instance; requirements undefined |
| 007, 031 | The auto-close property name / closer identity | Not in the workbook |
| 010 | UI / data policy field-to-stage mapping | Undefined |
| 015 | Whether `cxs_table_config` *is* "knowledge suggestion" | Name-based candidate only |
| 066, 076 | Known Error ↔ article link | Undefined |
| 004 | An assignment-rule condition evaluator | No engine can evaluate platform conditions; no substitute defined |
| 034, 035 | Per-group SLA pause rate vs estate mean; resolution-time density spike | No engine mode; the comparison basis is undefined |
| 132, 137 | ITOM-147; SLA-to-service scoping | Out of scope / undefined |
| 093 | Change calendar object and access log | Not named |
| the 29 UNCONFIGURED parameter gaps of §6 | Instance values | Customer's to supply |
| monthly / yearly recurrences | Platform month-overflow / float-week semantics | Not in the approved contract |

## 13. Phase 5 readiness

All acceptance criteria of the closure brief are met: 139 / 139 accounted for; no identity changed; DECISIONS.md unchanged; no new architectural decision; 024 and 129 deterministic and documented; every UNCONFIGURED and UNAVAILABLE rule carries an explicit, machine-readable reason; assumptions verified on the instance or represented as dependencies; schedules deterministic; 072 instance-derived; CMDB reads bounded; composite confidence = min; invalidation per contract; partial scope reconciled with verdicts; evidence explainable; no false-PASS path (empty dataset, missing table, missing threshold, failed capability, incomplete CMDB, failed expansion are all non-pass); the matrix exists; real-instance validation done; bottlenecks identified; full regression run with no new failures; Phase 5 not started.

**READY FOR PHASE 5.**
