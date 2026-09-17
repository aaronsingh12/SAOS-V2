# ITSM rule engines — Phase 2 requirements

What the 139 catalogued ITSM rules need in order to execute, grouped by the
reusable engine that would run them. Derived from
[`architecture-map.json`](./architecture-map.json); the rule lists below are
held to that file by `test/health-itsm-architecture.test.js`.

**Status: analysis only.** Nothing in this document is built. The health engine
still runs the eleven hard-coded ITSM rules in `health/rules.js`, scores ITSM in
`health/scopes.js`, and reads neither the catalogue nor the map.

The principle: **build one engine, configure many rules.** A rule is a row of
parameters (table, fields, predicate, threshold, window) handed to an engine;
it is not a function of its own. Every engine below therefore states its
**input contract** (what a rule row must supply) and its **output contract**
(what it hands to the finding pipeline), so that a rule can be added by editing
data rather than code once the engine exists.

## How the current architecture works — the parts each engine reuses

| Component | Where | What it does today | Reused by |
|---|---|---|---|
| Extraction allow-list + slice | `health/tables.js` `TABLES`, `sliceWhere`, `ITSM_WINDOW_DAYS` | Only allow-listed tables are read; ITSM tables read `active OR updated ≤ 90 d`; per-spec field list | every engine that reads rows |
| Keyset walk + coverage | `health/extract.js` `fetchTable`, `extractEstate`; `servicenow/dba-metadata.js` `pageAll` | 500/page keyset paging, `reported_total`, `rows_complete`, `missing_fields`, ≤ 100 000 rows | every engine that reads rows |
| Aggregate primitives | `servicenow/client.js` `table.count`, `table.countBy` (one group-by), `table.changeStamp` (count + max) | Row counts and single-field group-bys over an encoded query | Aggregate, Linkage, Reference Integrity |
| Rule context | `health/rules.js` `EstateRules.rows()` (coverage-gated rows), `add()` (finding + per-field evidence + fingerprint), `addCatalogued()` (catalogue-driven severity), `skipped[]`, `kpis[]`, `measures{}` | The finding pipeline every rule feeds | all engines |
| Severity arithmetic | `health/cmdb-quality.js` `effectiveBand(base, {escalators, deEscalators})`, `catalogueRule()` | base band ± modifiers, clamped Low…Systemic; catalogue lookup (CMDB only) | all engines (needs an ITSM catalogue adapter) |
| Context signals | `health/cmdb-signals.js` `buildSignals`, `modifiersFor`, `materialityFor`, `DQ_INACTIVE_INSTALL_STATUS` | Business-Critical support traversal, production, shared infra, retiring, approved exception; retired-CI statuses | Reference Integrity, Relationship Graph, severity modifiers |
| Relationship graph | `health/rules.js` `synthesize()` (undirected adjacency from `cmdb_rel_ci`, BFS depth 3) | Reachability per finding | Relationship Graph, Temporal Correlation |
| Bounded configuration reads | `health/extract.js` `extractCmdbMeta`, `cmdbMetaSources` | Small targeted reads (class hierarchy, `sys_choice`, `sys_audit` counts, `sys_trigger`) each with its own status, stamped for the change check | Configuration |
| Schema / choices / dictionary | `servicenow/schema.js` `getSchema`, `getTableHierarchy`; `servicenow/dba-schema.js` `listFields`, `getField`, `listChoices`, `getReferences` | Field lists, `mandatory`, choice lists per field, reference targets | Configuration |
| SLA definitions and schedules | `servicenow/sla.js` `listSlas`, `getSla`, `slaMeta` (schedules, `schedule_source`) | Reads `contract_sla` and `cmn_schedule` | Configuration, Linkage (SLA scope), Temporal Correlation (blackouts) |
| Per-record history readers | `servicenow/diagnostics.js` `auditFor`, `journalFor`, `slasFor`, `ciRelationshipsFor` | `sys_audit`, `sys_journal_field`, `task_sla` for ONE record, bounded by `LIMITS` | Audit & Journal (as a bridge for small populations only) |
| Run-to-run measures | `EstateRules.measures` → `manifest.cmdb_quality.measures` → `store.cmdbMeasureHistory()` → `measureHistory` | A rule records a measure; later runs receive earlier values (CMDB-038 trend) | Aggregate (trends) |
| Incremental change check | `health/incremental.js` `planScan`, `engineKeys`, `stampSources` | Per-module reuse when every input table's count + newest update is unchanged | all — every new table an engine reads must be declared as a module input |
| Remediation catalogue | `health/remediation.js` `REMEDIATION`, `fromCatalogue()`; `health/proposal.js` `FIX_FIELD` | Per-rule manual steps, effort, agent prompt; field-fix proposals | Phase 4+; note `fromCatalogue()` reads camelCase CMDB keys, not the snake_case ITSM catalogue |
| Storage | `health/store.js` `completeRun` → `health_findings` (`evidence_json`, `impact_json`, `scoring_json`) | One row per finding; fingerprint = sha256(rule|table|sorted sys_ids) | all — see "Output contract gaps" |

**Execution model today:** `runHealthCheck` → `planScan` (change check) →
`extractEstate` (every table, sequentially, whole slice into memory) →
`EstateRules.analyze` (pure, per-family) → `summariseScopes` (ITSM = share of
slice records with no finding) → `completeRun`. Findings are per-(rule, record);
severity is a literal per rule; ITSM has no catalogue, no thresholds, no
configuration reads, no history, no text analysis, no correlation.

---

## 1. Record Predicate Engine (`record_predicate`)

**Purpose.** Evaluate a per-record predicate over the fields of one task table
(incident, change_request, problem) and emit one finding per offending record,
with an optional ratio over the slice.

**Primary rules (21):** ITSM-005, ITSM-020, ITSM-036, ITSM-037, ITSM-042, ITSM-049, ITSM-052, ITSM-062, ITSM-067, ITSM-068, ITSM-089, ITSM-096, ITSM-097, ITSM-098, ITSM-099, ITSM-100, ITSM-102, ITSM-103, ITSM-111, ITSM-118, ITSM-119

**Supporting (10):** ITSM-009, ITSM-027, ITSM-029, ITSM-038, ITSM-043, ITSM-044, ITSM-051, ITSM-056, ITSM-070, ITSM-108

**Existing support:** FULL 13 · PARTIAL 5 · NONE 3 (the NONE cases are trivial
predicates on UNDEFINED plugin tables: ITSM-052 PIR actions, ITSM-089 template
review dates, ITSM-118 conflict overrides).

**Input contract (per rule).** `table`, `scope` (open / resolved / closed /
approved-or-closed — expressed as an encoded query, never a state number),
`fields[]` to extract, `predicate` (field-state test, trimmed-length test, or
timestamp arithmetic between two fields with a tolerance), `threshold`
parameters (e.g. 20 chars, 60 s, 1 h, per-priority days), `evidence_fields[]`,
`report_ratio` (bool).

**Required ServiceNow data.** Table API over the ITSM slice with the fields
added to the spec: incident `close_notes, closed_at, closed_by, impact,
urgency, business_service, problem_id, rfc, caller_id, resolved_by,
reassignment_count`; change_request `implementation_plan, backout_plan,
test_plan, justification, reason, risk, impact, approval, work_start,
work_end, business_service, close_notes, parent`; problem `cause_notes,
workaround, rfc, known_error, business_service, closed_at, fix_notes`.

**Output contract.** Record findings (`table`, `target_ids: [sys_id]`,
evidence per field) plus, when `report_ratio`, a `kpis[]` entry
`{rule_id, numerator, denominator, pass_pct, basis}`.

**Performance.** Field-state predicates can be pushed server-side as encoded
queries (`implementation_planISEMPTY`), which is the difference between reading
100 000 rows and reading only the offenders. Field-to-field timestamp
arithmetic (ITSM-036, ITSM-111) cannot be expressed in an encoded query and
stays row-level. Large text fields (`close_notes`, the three change plans) are
the volume risk: request them only for rules that need them, or use ISEMPTY
pushdown and never retrieve the body.

**Existing code reused.** `EstateRules.rows()` / `add()` unchanged; the current
`ITSM-INC-P1-AGED` and `ITSM-CHG-NO-CI` are this engine's shape.

**New functionality.** (a) Rule rows as data (predicate DSL: `empty`, `length_lt`,
`interval_lt/gt` between fields, `date_before now±N`); (b) per-rule field
selection so the extraction spec is the union of what active rules need;
(c) encoded-query pushdown for field-state predicates as an alternative to the
whole-slice read; (d) a threshold registry with the workbook defaults.

---

## 2. Aggregate & Distribution Engine (`aggregate`)

**Purpose.** Compute counts, ratios, shares, distributions, dominance and
run-to-run trends over a slice — optionally grouped — and judge them against a
threshold, producing an estate-level finding that carries the metric.

**Primary rules (19):** ITSM-001, ITSM-008, ITSM-016, ITSM-017, ITSM-024, ITSM-030, ITSM-031, ITSM-032, ITSM-033, ITSM-041, ITSM-053, ITSM-059, ITSM-079, ITSM-083, ITSM-094, ITSM-107, ITSM-113, ITSM-121, ITSM-135

**Supporting (51):** ITSM-002, ITSM-003, ITSM-004, ITSM-006, ITSM-007, ITSM-009, ITSM-012, ITSM-013, ITSM-014, ITSM-015, ITSM-020, ITSM-022, ITSM-023, ITSM-025, ITSM-026, ITSM-034, ITSM-035, ITSM-036, ITSM-037, ITSM-039, ITSM-042, ITSM-045, ITSM-057, ITSM-058, ITSM-062, ITSM-073, ITSM-074, ITSM-077, ITSM-080, ITSM-081, ITSM-082, ITSM-085, ITSM-086, ITSM-087, ITSM-089, ITSM-090, ITSM-091, ITSM-092, ITSM-097, ITSM-098, ITSM-103, ITSM-104, ITSM-116, ITSM-123, ITSM-124, ITSM-125, ITSM-129, ITSM-130, ITSM-131, ITSM-132, ITSM-133

This is the most-shared engine: 70 of 139 rules use it as primary or support.

**Input contract.** `table`, `slice` (encoded query), `measure`
(`count` | `ratio(numerator_query, denominator_query)` | `share_by(field)` |
`distribution(field)` | `histogram(expression, buckets)` | `trend(measure, windows)`),
`group_by[]` (0–2 fields), `threshold` (`{op, value, escalate_at?}` — e.g.
8 % escalate 15 %, 70 % in one band), `minimum_volume` (UNDEFINED for most
rules — must be supplied), `window`.

**Required ServiceNow data.** Aggregate API: `sysparm_count`,
`sysparm_group_by` (multi-field), `sysparm_avg_fields` / `sysparm_sum_fields`
for effort (ITSM-057, ITSM-058); Table API only when a distribution needs a
derived expression the API cannot group on (resolution-to-target intervals).
Tables: incident, change_request, problem, task_sla, sys_choice (list to
compare against), sysapproval_approver (candidate, ITSM-107/121).

**Output contract.** One estate-level finding per breached threshold with
`target_ids: []` (`estate_wide: true`) and a `metric` block:
`{measure, observed, threshold, breached, groups: [{key, observed, n}], window, basis}`;
always a `kpis[]` entry whether or not the threshold is breached; a
`measures[]` snapshot for trended rules. **Drill-down** (the workbook's
"Evidence to Show" is almost always a breakdown by group/category/code) is the
grouped metric, not per-record evidence rows.

**Performance.** With Aggregate API pushdown every primary rule here is O(groups),
independent of table size — this engine is how the ITSM check stops scaling
with the incident table. Without pushdown (in-memory over the extracted slice)
it inherits the 100 000-row cap and the score is withheld on any real estate.
Trends across windows are N counts, not N reads.

**Existing code reused.** `table.count`, `table.countBy` (one group-by),
`ctx.kpis` shape, `ctx.measures` + `measureHistory` for trends, the
`estate_wide` finding path in `add()` and its max-impact priority handling.

**New functionality.** (a) Multi-field group-by and avg/sum wrappers in
`client.js`; (b) the measure/threshold evaluator; (c) the `metric` block on a
finding and its storage (`scoring_json` or a new column); (d) two-tier
thresholds (`escalate_at`); (e) an "expected distribution" evaluator for
ITSM-024 and ITSM-035 (UNDEFINED statistical test — a decision, not code);
(f) minimum-volume guards (ITSM-124's FPG).

---

## 3. Configuration Inspection Engine (`configuration`)

**Purpose.** Read platform configuration objects, compare them with actual
usage, and report configuration findings ("configured but unused", "used but
not configured", "absent").

**Primary rules (24):** ITSM-002, ITSM-003, ITSM-004, ITSM-006, ITSM-009, ITSM-010, ITSM-011, ITSM-012, ITSM-013, ITSM-014, ITSM-015, ITSM-029, ITSM-045, ITSM-051, ITSM-080, ITSM-081, ITSM-082, ITSM-085, ITSM-086, ITSM-087, ITSM-090, ITSM-091, ITSM-092, ITSM-093

**Supporting (15):** ITSM-001, ITSM-005, ITSM-007, ITSM-008, ITSM-031, ITSM-083, ITSM-084, ITSM-110, ITSM-112, ITSM-117, ITSM-122, ITSM-127, ITSM-131, ITSM-137, ITSM-138

**Existing support:** PARTIAL 9 · NONE 15. The split is by object: what
`schema.js`, `dba-schema.js` and `sla.js` already read (choices, dictionary,
SLA definitions, schedules) is PARTIAL; approval workflows, assignment rules,
notifications, UI/data policies, change models, MIM, CAB, conflict detection
and the change calendar have no reader.

**Input contract.** `object` (a named configuration source with its own read
strategy), `comparison` (`unused_in_window` | `used_but_absent` | `absent_where_volume` |
`mandatory_at_state` | `covers_bands`), the usage `measure` (delegated to the
Aggregate engine), `baseline` where the rule compares with an OOB set
(ITSM-013, ITSM-091 — UNDEFINED, must be supplied as data).

**Required ServiceNow data — by object.**

| Object (rules) | Source | Reader today |
|---|---|---|
| Choice lists incl. `dependent_value` (002, 006, 008, 009, 013, 091) | `sys_choice` | `getSchema` (no `dependent_value`), `listChoices` |
| Dictionary: custom fields, `mandatory` (014, 090) | `sys_dictionary` (+ `sys_update_xml` for creating set) | `listFields`, `getField` |
| SLA definitions, conditions, schedules (003, 012, 013, 137) | `contract_sla`, `cmn_schedule` | `listSlas`, `getSla`, `slaMeta` |
| Blackout / maintenance / freeze windows (085, 112, 127) | `cmn_schedule` by type, `cmn_schedule_span` (candidate) | `slaMeta` reads schedules; no type filter, no span expansion |
| Priority matrix (001, 005) | candidate `dl_u_priority` | none |
| Assignment rules (004, 029) | candidate `sysrule_assignment` | none |
| Notification rules (011) | candidate `sysevent_email_action` | none |
| UI / data policies (010, 087, 090) | candidates `sys_ui_policy(_action)`, `sys_data_policy2(_rule)` | none (`servicenow/catalogPolicy.js` handles catalog UI policies only) |
| Auto-close duration (007, 031) | candidate `sys_properties glide.ui.autoclose.time` | none |
| Knowledge suggestion (015) | UNDEFINED (candidate `cxs_table_config`) | none |
| Approval routing / workflow by type (081, 086, 091) | UNDEFINED — flows, workflows, approval rules | `servicenow/flows.js` reads `sys_hub_flow` for authoring, not for routing semantics |
| Change models, closure requirements, PIR steps (087, 092, 122) | candidates `chg_model`, `chg_model_state` | none |
| Standard change templates (080, 089, 117) | candidates `std_change_producer_version`, `std_change_proposal` | none |
| CAB (082) | candidates `cab_meeting`, `cab_agenda_item` | none |
| Conflict detection config (084, 138, 118) | UNDEFINED (candidate `conflict`) | none |
| Major-incident configuration, candidate criteria (045, 051) | UNDEFINED (MIM plugin) | none |
| Change calendar, access logs (093) | UNDEFINED | none |
| Approval delegation (088) | candidate `sys_user_delegate` | none |

**Output contract.** Configuration findings: `target_ids` are configuration
record sys_ids (a choice, a definition, a rule) or empty for an absence;
`finding_level: configuration`; `evidence` names the configuration record and
the usage figure beside it. Every read carries its own status (as
`extractCmdbMeta` does) and is stamped for the change check.

**Performance.** LOW for almost every rule — configuration tables are small.
The cost is in the usage half, delegated to the Aggregate engine. ITSM-010 is
the exception (audit-based population timing: VERY_HIGH).

**Existing code reused.** `extractCmdbMeta` / `cmdbMetaSources` pattern (bounded
reads with status, stamped); `schema.js`, `dba-schema.js`, `sla.js` readers;
`servicenow/acl.js` for the field-ACL evidence on ITSM-028.

**New functionality.** (a) A configuration-source registry: each object above
as a named reader returning rows + status; (b) `dependent_value` in the choice
read; (c) schedule-type filter and span expansion; (d) plugin-presence probing
(`tableExists` exists in `schema.js`) so a MIM/CAB/conflict rule reports
"not installed" rather than a false absence; (e) OOB baselines as data for
013/091; (f) the "used but not configured" comparison against Aggregate output.

---

## 4. Reference Integrity Engine (`reference_integrity`)

**Purpose.** Resolve a reference field to its target and judge the target's
existence, activity or lifecycle state — in batches, never per record.

**Primary rules (11):** ITSM-018, ITSM-019, ITSM-022, ITSM-044, ITSM-065, ITSM-088, ITSM-095, ITSM-101, ITSM-134, ITSM-136, ITSM-139

**Supporting (1):** ITSM-011

**Input contract.** `table`, `reference_field`, `scope` (open records),
`target` (`sys_user_group` → active membership | `sys_user` → active |
`cmdb_ci` → exists ∧ not retired | `cmdb_ci_service` → exists | `kb_knowledge`
→ published), `report_cases[]` (ITSM-019/095 report "missing" and "retired"
separately).

**Required ServiceNow data.** Distinct referenced sys_ids from the extracted
slice, then batched `sys_idIN…` reads of: `sys_user_grmember` (group→user) +
`sys_user.active`; `cmdb_ci` (already extracted — the join is in memory, but
see the cap caveat); `cmdb_ci_service` (extracted); `kb_knowledge`
(`workflow_state`, `retired`); `sys_user_has_role` (extracted for Platform).
Candidates: `sys_user_group`, `sys_user_delegate`, `m2m_kb_task`.

**Output contract.** Record findings on the REFERRING record, grouped in
evidence by target (the empty group, the retired CI), with the target's state
and — where available — its last change date.

**Performance.** MEDIUM: distinct targets are orders of magnitude fewer than
records. The one HIGH/scale-risk case is CI existence (019, 095): a dangling
reference is only provable if `cmdb_ci` was read to the end, and the 100 000-row
cap means it often is not — those two rules must gate on
`isComplete(coverage, 'cmdb_ci')` exactly as the CMDB absence rules do.

**Existing code reused.** `referenceLookup` (name → sys_id, wrong direction but
the display-field logic is reusable), the extracted `cmdb_ci` / `cmdb_ci_service`,
`DQ_INACTIVE_INSTALL_STATUS` for "retired", `isComplete` gating.

**New functionality.** (a) A batched resolver (`sys_idIN` chunks of ~50, the
size `extractCmdbMeta` already uses) with per-target caching across rules —
ITSM-018, 065, 101 and 134 must resolve group membership ONCE per run; (b) new
allow-list entries with their own specs; (c) a service-account classifier for
ITSM-022 (UNDEFINED patterns — data, not code).

---

## 5. Cross-Record Linkage Engine (`linkage`)

**Purpose.** Answer "does a related record exist, and in what state?" across
ITSM tables: incident↔problem, problem↔change, known error↔article,
change↔approval, change↔task, SLA↔service.

**Primary rules (22):** ITSM-039, ITSM-046, ITSM-047, ITSM-048, ITSM-055, ITSM-057, ITSM-060, ITSM-063, ITSM-064, ITSM-066, ITSM-069, ITSM-073, ITSM-076, ITSM-078, ITSM-109, ITSM-110, ITSM-114, ITSM-116, ITSM-122, ITSM-128, ITSM-133, ITSM-137

**Supporting (26):** ITSM-033, ITSM-035, ITSM-040, ITSM-054, ITSM-058, ITSM-061, ITSM-067, ITSM-071, ITSM-074, ITSM-075, ITSM-077, ITSM-081, ITSM-086, ITSM-088, ITSM-096, ITSM-100, ITSM-102, ITSM-106, ITSM-107, ITSM-108, ITSM-115, ITSM-117, ITSM-119, ITSM-125, ITSM-127, ITSM-138

**Existing support:** PARTIAL 14 · NONE 8. Links that are reference fields on
already-extracted tables (`incident.problem_id`, `problem.rfc`, `incident.rfc`)
are in-memory joins once the field is in the spec; links through plugin tables
(approvals, MIM communication/PIR, KB m2m, change tasks) have no reader.

**Input contract.** `from` (table, scope), `link` (`reference_field` on either
side | `m2m table` with both columns), `to` (table, scope/state filter),
`expect` (`exists` | `absent` | `count ≥ n` | `all_in_state`), `report_ratio`.

**Required ServiceNow data.** Reference fields: incident `problem_id, rfc`;
problem `rfc, known_error`; change_request `parent`. Tables to add or probe:
`sysapproval_approver` (approver, state, timestamps — ITSM-109, 110, 116, and
ITSM-100/107/108 evidence), `change_task` (backout tasks, ITSM-114),
`problem_task`, `m2m_kb_task` / `kb_knowledge` (ITSM-066, 076, 139),
`task_rel_task` (ITSM-119, if the instance links that way), MIM
communication/PIR objects (UNDEFINED — ITSM-046, 047, 052, 092, 122),
`service_offering` (extracted) for ITSM-137.

**Output contract.** Record findings on the primary record with the related
record's identity and state in evidence; for ratio forms, a `kpis[]` entry.

**Performance.** MEDIUM. Joins are between the extracted ITSM slice and a
second table restricted to the referenced ids. Two cautions: (1) the incident
slice is 90 days, so "problems with zero linked incidents" (ITSM-060) must count
via the Aggregate API over ALL incidents or it is wrong for older links;
(2) approval rows are several per change — read by `document_id IN` batches.

**Existing code reused.** The in-memory join pattern in `cmdb-correctness.js`
(change_request × cmdb_ci), `countBy` for link counts, the extracted problem and
change tables.

**New functionality.** (a) A join utility (index the target table by key once
per run; anti-join and count forms); (b) the approval-record reader and spec;
(c) plugin-object probes for MIM/PIR/CAB; (d) linkage-field discovery per
instance for the UNDEFINED links (KB, "accepted risk", "validation entry").

---

## 6. Relationship Graph Engine (`relationship_graph`)

**Purpose.** Answer graph questions over `cmdb_rel_ci` for CIs referenced by
ITSM records: edge count, dependents to depth N, directed path to a service,
support of a Business Critical service.

**Primary rules (4):** ITSM-105, ITSM-126, ITSM-130, ITSM-131

**Supporting (7):** ITSM-017, ITSM-049, ITSM-084, ITSM-115, ITSM-123, ITSM-132, ITSM-138

**Input contract.** `seed_cis[]` (from a task table's `cmdb_ci` / affected-CI
list), `question` (`degree` | `dependents(depth)` | `path_to_service` |
`supports_business_critical`), `depth` (UNDEFINED default on most rules; 2 on
ITSM-123).

**Required ServiceNow data.** `cmdb_rel_ci` (extracted, required),
`cmdb_ci_service` with `busines_criticality` (extracted), `task_ci` (candidate —
affected-CI lists for 105/126/131).

**Output contract.** Per seed CI: degree, reachable set, resolved service(s),
criticality flag — consumed by the calling rule; for ITSM-130 an aggregate
percentage; for ITSM-126 a record finding with the traversal path as evidence
(and a Lane 1 field fix via `FIX_FIELD` on `change_request.business_service`).

**Performance.** HIGH and inherently coupled to `cmdb_rel_ci` completeness:
every absence claim ("zero edges", "no path to a service") is only sound on a
complete read, so these rules gate on `isComplete(coverage, 'cmdb_rel_ci')` as
CMDB-UNRELATED does. Above the 100 000-relationship cap they cannot run.

**Existing code reused.** `synthesize()`'s adjacency map and BFS,
`cmdb-signals.buildSignals` (Business-Critical service support), the existing
CMDB-UNRELATED / REL-* rules for degree.

**New functionality.** (a) Lift the graph out of `synthesize()` into a shared,
built-once-per-run structure with directed edges (parent→child with `type`);
(b) `path_to_service` (directed, typed) and `dependents(depth)`; (c) `task_ci`
in the allow-list.

---

## 7. Audit & Journal History Engine (`audit_history`)

**Purpose.** Reconstruct events — state transitions, field changes, journal
entries, SLA pause/cancel — for a population of records, in bulk, and derive
counts, timings and gaps.

**Primary rules (8):** ITSM-026, ITSM-034, ITSM-043, ITSM-050, ITSM-056, ITSM-061, ITSM-072, ITSM-120

**Supporting (12):** ITSM-004, ITSM-005, ITSM-007, ITSM-010, ITSM-028, ITSM-030, ITSM-032, ITSM-099, ITSM-100, ITSM-106, ITSM-108, ITSM-111

**Existing support:** NONE 6 · PARTIAL 2 (the PARTIAL two are problem rules,
where the population is small enough that the per-record `auditFor()` bridge is
viable).

**Input contract.** `table`, `population` (sys_ids or an encoded query),
`source` (`sys_audit` | `sys_journal_field` | `task_sla stages`), `fields[]`
(e.g. `state`, `assignment_group`, `start_date`), `derive`
(`transition_count` | `last_change_at` | `first_set_at` | `entries_count` |
`gap_max` | `backward_transitions(order)`).

**Required ServiceNow data.** `sys_audit` (`tablename, documentkey, fieldname,
oldvalue, newvalue, sys_created_on, user`) scoped by `documentkeyIN` batches or
`tablename=incident^fieldname=state^sys_created_on>=…`; `sys_journal_field`
(`name, element, element_id, sys_created_on`) — group-by `element_id` via the
Aggregate API for counts; `task_sla` rows (`stage, pause_duration,
business_pause_duration, planned_end_time, has_breached`) for ITSM-034/035.
A state ORDER model for "backward" (ITSM-072) — UNDEFINED.

**Output contract.** Per record: the derived quantity with the audit rows that
produced it as evidence; then a record finding or an aggregate (ITSM-034's
rates) as the calling rule specifies.

**Performance.** VERY_HIGH is the norm. `sys_audit` and `sys_journal_field` are
the largest tables on most instances and are not in the allow-list. Two
disciplines make this survivable: (1) Aggregate API group-by counts where the
rule only needs a count (ITSM-026 entries, ITSM-120 reschedules); (2) restrict
row reads to the population the rule is about (major incidents for ITSM-050,
tail incidents for ITSM-032, problems for 056/061/072). Note the measured fact
in ARCHITECTURE §16.8: `cmdb_ci` is not audited on dev424910 — audit-based
rules must check `sys_dictionary.audit` / `glide.ui.audit_deleted_tables`
(`deletionLoggedTables` in `incremental.js` already does this) and skip with a
reason where auditing is off.

**Existing code reused.** `diagnostics.auditFor / journalFor / slasFor`
(per-record bridge), `deletionLoggedTables` (audit-enabled probe), `parseDate`.

**New functionality.** (a) Bulk audit/journal readers with keyset walks and
population scoping; (b) transition reconstruction; (c) `sys_audit`,
`sys_journal_field`, `task_sla` allow-list specs with slices; (d) the audit-off
skip path.

---

## 8. Text Analysis Engine (`text_analysis`)

**Purpose.** Normalise, compare, cluster and pattern-scan free text.

**Primary rules (11):** ITSM-021, ITSM-023, ITSM-025, ITSM-028, ITSM-040, ITSM-054, ITSM-058, ITSM-070, ITSM-071, ITSM-075, ITSM-104

**Supporting (6):** ITSM-060, ITSM-077, ITSM-080, ITSM-105, ITSM-117, ITSM-132

**Existing support:** NONE 11. Nothing in the codebase does this
(`detectDegenerateRepetition` in `acl.js` is the closest thing and is about
model output, not records).

**Input contract.** `table`, `fields[]`, `operation`
(`similarity(a, b, threshold)` | `normalised_frequency(field, min_volume)` |
`cluster(field, similarity_threshold, min_size, blocking_key?)` |
`pattern_scan(pattern_set, checksum)` | `classify(field, patterns)` |
`consistency(code_field, text_field, expected_patterns)`).

**Required ServiceNow data.** Full text of `short_description`, `description`,
`close_notes`, `cause_notes`, `backout_plan`, and for ITSM-028 journal entries
(`sys_journal_field.value`) — over the relevant slice. This is the heaviest
data the ITSM check would ever pull.

**Output contract.** Per record (similarity, classification, pattern hit
count) or per cluster (`members[], representative, volume, effort,
similarity_score`); for ITSM-028 **counts and locations only — never the
matched value** (the finding/evidence shape must have a mode that omits
`field_value`).

**Performance.** VERY_HIGH for clustering (ITSM-054, 058, 077, 132): pairwise
similarity is quadratic unless blocked (by category, by caller); HIGH for the
per-record similarity and frequency rules. Text must be read once and shared
across rules; the engine needs a memory budget and an explicit "sampled"
coverage status if it cannot process the whole slice. Every similarity
threshold is stated by the workbook (0.9, 0.85, 0.8) but the **metric is
UNDEFINED** — choosing it is a decision to record before Phase 3 implements it.

**Existing code reused.** None for the analysis. Extraction and the finding
pipeline as for other engines.

**New functionality.** (a) Normalisation (case, whitespace, punctuation,
placeholder numbers); (b) a similarity metric; (c) blocked clustering;
(d) pattern set with checksum validators and a redaction-safe evidence mode;
(e) a text-read budget and coverage status.

---

## 9. Temporal Correlation Engine (`temporal_correlation`)

**Purpose.** Join events across records or tables by shared CI (optionally
expanded through the graph) and a time window; intersect intervals with
schedules.

**Primary rules (10):** ITSM-027, ITSM-035, ITSM-038, ITSM-074, ITSM-106, ITSM-108, ITSM-112, ITSM-115, ITSM-123, ITSM-127

**Supporting (8):** ITSM-071, ITSM-084, ITSM-092, ITSM-111, ITSM-124, ITSM-125, ITSM-128, ITSM-138

**Existing support:** NONE 7 · PARTIAL 3 (the PARTIAL three reuse schedule
reads or change fields; the correlation itself is new everywhere).

**Input contract.** `left` (table, scope, time field, CI field), `right`
(table, scope, time field, CI field), `window` (`before(72h)` | `after(72h)` |
`overlap` | `around(30min)`), `ci_match` (`same` | `dependents(depth)`),
`aggregate` (pairs | ratio | count per CI | before/after rate); or for
schedules: `intervals` (table, start/end fields) × `schedule` (blackout /
freeze spans) → intersections.

**Required ServiceNow data.** incident (`cmdb_ci, sys_created_on, priority,
resolved_at`), change_request (`cmdb_ci, work_start, work_end, start_date,
end_date, close_code, sys_created_on, approval`), problem (`closed_at`),
`sys_audit` (ITSM-106, 108 corroboration), `task_sla.planned_end_time`
(ITSM-035), `em_alert` (ITSM-038; extracted for ITOM), `sys_attachment`
(ITSM-027), `cmn_schedule` + spans (112, 127), `cmdb_rel_ci` for expansion.

**Output contract.** Correlated pairs `{left_id, right_id, ci, delta, path?}`
with the window and depth stated on the finding (the workbook requires this
for ITSM-123); record findings on the flagged side; ratios via `kpis[]`.
ITSM-124/125 consume the pair set.

**Performance.** HIGH to VERY_HIGH. The kernel is a time-bucketed index on CI:
build once per run (changes by CI and window; incidents by CI and time), then
each rule is a probe, not a scan. ITSM-106 is the outlier — `sys_audit` over
change-controlled objects — and may be impossible where auditing is off.

**Existing code reused.** `synthesize()` graph for dependent-CI expansion,
`sla.js` schedule reads, `parseDate`, the extracted incident/change tables.

**New functionality.** (a) The CI×time index and window join; (b) interval ×
schedule-span intersection; (c) before/after windows anchored per record
(ITSM-074) — these exceed the 90-day slice and need per-record Aggregate
counts or a wider read; (d) a shared pair set consumable by composite rules.

---

## 10. Composite / Rule-Dependency Engine (`composite`)

**Purpose.** Run rules that consume other rules' outputs, or that need three or
more engines in sequence, in dependency order — passing results, not
recomputing them.

**Primary rules (9):** ITSM-007, ITSM-077, ITSM-084, ITSM-117, ITSM-124, ITSM-125, ITSM-129, ITSM-132, ITSM-138

**Supporting (0):** —

**Input contract.** `stages[]` each naming an engine and its parameters, plus
`inputs_from[]` (rule ids whose result set is consumed — see
`dependencies.consumes_output_of` in the map) and a `combine` step
(`all_breach` for ITSM-129, `re_aggregate(by)` for ITSM-124, `count_per_ci ≥ n`
for ITSM-125).

**Required data.** Whatever the stages need; no data of its own.

**Output contract.** As the final stage dictates; the finding must carry the
provenance chain (which upstream rule's result it consumed and that result's
confidence — ITSM-124/125 "inherit ITSM-123 correlation confidence").

**Performance.** Inherits the heaviest stage. The point of the engine is that
ITSM-123's correlation runs once and feeds 124, 125 and 128's evidence.

**Existing code reused.** The fixed family order in `EstateRules.analyze()` and
the `kpis` / `measures` hand-off are the only precedent; there is no
inter-rule output passing today.

**New functionality.** (a) A rule DAG with topological execution (acyclic — the
map's `consumes_output_of` edges are; `related` edges are not and must not be
used for ordering); (b) a per-run result cache keyed by rule id; (c) confidence
propagation.

---

## Cross-cutting requirements (every engine)

1. **Catalogue adapter.** `catalogueRule()` / `addCatalogued()` read the CMDB
   catalogue's camelCase, derived fields (`base` uppercased, `lane` integer,
   `kind`, `track`). The ITSM catalogue is verbatim snake_case
   (`base_severity: "Systemic"`, `remediation_lane` free text). An adapter must
   map `Systemic/Critical/High/Moderate/Low` → `SYSTEMIC/CRITICAL/HIGH/MEDIUM/LOW`
   explicitly and leave lanes as text until a later phase decides otherwise.
2. **Threshold / parameter registry.** Every workbook threshold is
   "configurable with a default". 40+ rules have defaults; ~30 say
   "configurable" with **no default (UNDEFINED)**. The registry must hold the
   workbook default verbatim, allow an instance override, and feed the engine
   key (a changed threshold must invalidate module reuse — `engineKeys` already
   folds `staleDays` in the same way).
3. **Window manager.** Windows vary (90 d, 180 d, 72 h, 30 min, 12 months,
   "at least 3 windows"); the current single `ITSM_WINDOW_DAYS` slice cannot
   serve them, and the sliding window already defeats incremental reuse for
   ITSM (ARCHITECTURE analysis, Phase 0). Windows must be anchored per run and
   recorded on the finding.
4. **Allow-list extension.** New tables (below) each need a spec with fields
   and a slice, coverage, stamping and — for the big ones — a scoping strategy
   that is not "read it all".
5. **Finding shape extensions.** A `metric` block for aggregate findings; a
   `configuration` target kind; a redaction-safe evidence mode (ITSM-028);
   window/depth/confidence provenance; `kpis` for every ratio rule whether or
   not breached (so a rule that PASSES leaves a trace — the current pipeline
   records only failures).
6. **Plugin / capability probes.** MIM, CAB Workbench, Change Risk Assessment,
   conflict detection, Knowledge suggestion, auditing per table: a rule whose
   object is absent must skip as "not installed", never fire as "absent".
7. **Severity modifiers.** `effectiveBand` + `cmdb-signals` escalators apply;
   the workbook's ITSM-specific escalators ("duration beyond 30 days",
   "recurred after prior remediation", "involves an approval control") have no
   signal today.
8. **Scoring interface.** Out of scope here; but every engine must emit the
   `result.type` the map records (count / ratio / distribution / boolean) in a
   form a later scoring phase can consume without re-running the rule.

## Tables the ITSM rules require — beyond incident, change_request, problem

Named by the workbook: `cmdb_ci`, `cmdb_rel_ci`, `cmdb_ci_service`,
`service_offering`, `task_sla`, `contract_sla`, `cmn_schedule`, `sys_choice`,
`sys_user`, `sys_user_grmember`, `sys_audit`, `sys_attachment`, `kb_knowledge`.

Inferred (verify on the instance before use): `sys_journal_field`,
`sys_dictionary`, `sys_user_group`, `sys_user_has_role`, `sys_user_delegate`,
`sysapproval_approver`, `sysrule_assignment`, `sysevent_email_action`,
`sys_email`, `sys_ui_policy(_action)`, `sys_data_policy2(_rule)`,
`sys_properties`, `sys_update_xml`, `sys_security_acl`, `cmn_schedule_span`,
`task_ci`, `task_rel_task`, `change_task`, `problem_task`, `chg_model(_state)`,
`std_change_producer_version`, `std_change_proposal`, `cab_meeting`,
`cab_agenda_item`, `conflict`, `dl_u_priority`, `cxs_table_config`,
`m2m_kb_task`, `em_alert`, `discovery_status`, `discovery_log`, `sys_hub_flow`,
`wf_workflow`.

UNDEFINED (concept named, table not determinable): MIM communication plans and
tasks, post-incident reviews and PIR actions, MI candidate criteria and trigger
events, approval routing configuration by type, change calendar and its access
logs, risk assessment questionnaire, "accepted risk" and "validation" records on
problems, commitment definitions, freeze-period definitions, the OOB state and
type baselines, the customer authority matrix.
