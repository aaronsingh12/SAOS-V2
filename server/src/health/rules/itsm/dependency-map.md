# ITSM rule dependency map — Phase 2

Derived from [`architecture-map.json`](./architecture-map.json). Analysis only;
nothing here executes. Rule-to-rule edges come from `dependencies.*` in the
map: **consumes** (needs the other rule's result), **interpret with** (the
workbook says report alongside / conditional on / precondition), **related**
(the workbook's causal cross-links). A dependency never merges two rules.

## 1. The pipeline, by layer

```
RULES (139, ITSM-001 … ITSM-139; one slot each)
  │
  ├─ record predicates ............ 21    ├─ reference integrity ........ 11
  ├─ aggregate / distribution ..... 19    ├─ cross-record linkage ....... 22
  ├─ configuration inspection ..... 24    ├─ relationship graph .........  4
  ├─ audit / journal history ......  8    ├─ temporal correlation ....... 10
  ├─ text analysis ................ 11    └─ composite ..................  9
  ▼
DATA SOURCES
  │  task tables (sliced)      incident · change_request · problem
  │  CMDB                      cmdb_ci · cmdb_rel_ci · cmdb_ci_service · service_offering
  │  SLA                       task_sla · contract_sla · cmn_schedule (+ spans)
  │  people                    sys_user · sys_user_grmember · (sys_user_group · sys_user_has_role · sys_user_delegate)
  │  configuration             sys_choice · (sys_dictionary · sys_properties · UI/data policies · sysrule_assignment ·
  │                            sysevent_email_action · chg_model · std_change templates · cab_* · conflict · dl_u_priority)
  │  history                   sys_audit · (sys_journal_field) · sys_attachment
  │  knowledge                 kb_knowledge · (m2m_kb_task)
  │  approvals / tasks         (sysapproval_approver · change_task · problem_task · task_ci · task_rel_task)
  │  ITOM                      (em_alert · discovery_status · discovery_log)
  │  UNDEFINED objects         MIM comm plans / PIRs / criteria · approval routing config · change calendar · risk questionnaire
  ▼
EXECUTION ENGINES
  │  Record Predicate ─┐
  │  Aggregate ────────┤   ← shared by 70 rules as primary or supporting
  │  Configuration ────┤
  │  Reference Integrity ─┤
  │  Linkage ──────────┤─→ finding pipeline (EstateRules.add / addCatalogued → kpis · measures · skipped)
  │  Relationship Graph ┤
  │  Audit & Journal ───┤
  │  Text Analysis ─────┤
  │  Temporal Correlation ┤
  │  Composite ─────────┘   ← consumes other rules' results (6 rules)
  ▼
FINDING TYPES (result.finding_level)
     record 63 · configuration 24 · systemic 22 · aggregate 17 · cross_domain 13
     result.type: count 77 · ratio 22 · boolean 16 · distribution 14 · percentage 8 · threshold 1 · composite_metric 1
```

(Parenthesised tables are inferred candidates or plugin-dependent; see
`candidate_tables` / `tables_undefined` in the map.)

## 2. Rules → data sources (which rules touch which source)

Generated from `tables` / `candidate_tables` in the map. A rule appears in every row that applies; rule numbers are the `ITSM-` suffix.

| Source | Rules |
|---|---|
| Task table: `incident` (alone among the three) | 001, 002, 003, 004, 005, 006, 007, 008, 009, 013, 014, 016, 017, 018, 019, 020, 021, 022, 023, 024, 025, 026, 027, 028, 029, 030, 031, 032, 033, 034, 035, 036, 037, 038, 041, 042, 043, 044, 045, 046, 047, 049, 050, 051, 130, 132, 135, 136, 139 |
| Task table: `change_request` (alone) | 080, 081, 082, 083, 084, 085, 086, 087, 090, 091, 092, 094, 095, 096, 097, 098, 099, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 116, 117, 119, 120, 122, 126, 127, 131 |
| Task table: `problem` (alone) | 056, 062, 065, 066, 067, 068, 070, 072, 075, 079 |
| `incident` × `problem` | 039, 040, 048, 053, 054, 055, 057, 058, 059, 060, 061, 063, 069, 073, 074, 076, 077, 133 |
| `problem` × `change_request` | 064, 071, 078 |
| `incident` × `change_request` | 115, 123, 124, 128, 138 |
| all three task tables | 125, 129, 134 |
| no task table in `tables` (configuration-only, or the object is UNDEFINED) | 010, 011, 012, 015, 052, 088, 089, 093, 118, 121, 137 |
| + `cmdb_ci` | 017, 019, 049, 084, 095, 105, 106, 123, 124, 125, 126, 130, 131, 132, 135, 138 |
| + `cmdb_rel_ci` (graph) | 017, 049, 084, 105, 115, 123, 124, 125, 126, 130, 131, 138 |
| + `cmdb_ci_service` / `service_offering` | 017, 049, 126, 133, 136, 137 |
| + `task_sla` / `contract_sla` | 003, 012, 013, 033, 034, 035, 137 |
| + `cmn_schedule` (named or candidate) | 012, 085, 112, 127 |
| + `sys_user` / `sys_user_grmember` | 011, 018, 022, 065, 088, 101, 134 |
| + `sys_audit` | 005, 010, 030, 032, 034, 043, 056, 061, 072, 106, 108, 120 |
| + `sys_journal_field` (candidate) | 026, 028, 050 |
| + `sys_choice` / `sys_dictionary` | 002, 006, 008, 009, 013, 014, 090, 091 |
| + `kb_knowledge` | 015, 064, 066, 076, 139 |
| + `sys_attachment` | 027 |
| + approvals (`sysapproval_approver`, candidate) | 081, 086, 088, 100, 107, 108, 109, 110, 116, 121 |
| + ITOM tables (`em_alert`, `discovery_*`, candidates) | 038, 132 |

## 3. Rule → rule dependencies

### 3a. Consumes another rule's result (hard ordering; acyclic)

```
ITSM-054 (incident clusters) ──► ITSM-077 (cluster→problem lag)
                              └─► ITSM-132 (recurring incidents on stale CIs)
ITSM-123 (P1 preceded by change) ──► ITSM-124 (rate by group/type/class)
                                  └─► ITSM-125 (repeated change→incident per CI)
ITSM-016 (incident CI/service rate) ─┐
ITSM-094 (change CI/service rate)  ──┴─► ITSM-129 (three processes blind)
ITSM-018 ─┐
ITSM-065 ─┼─► ITSM-134 (empty groups across all three processes)
ITSM-101 ─┘
```

### 3b. Interpret with / precondition (the workbook says report alongside)

| Rule | Interpret with | Why (workbook) |
|---|---|---|
| ITSM-007 | ITSM-030 | correlated against reopen rate |
| ITSM-033 | ITSM-003, ITSM-012 | only valid once SLA configuration findings are resolved |
| ITSM-034 | ITSM-043 | uninterpretable without hold reasons |
| ITSM-054 | ITSM-002 | category taxonomy quality gates clustering |
| ITSM-058 | ITSM-023 | clusters diluted by template pasting |
| ITSM-071 | ITSM-106 | evidence: unauthorised change on the related CI |
| ITSM-106 | ITSM-094 | understates where changes lack CI references |
| ITSM-108 | ITSM-100 | second case of 100 feeds 108 |
| ITSM-112, ITSM-127 | ITSM-085 | require blackout / freeze windows to be defined |
| ITSM-113 | ITSM-103, ITSM-115 | close-code reliability and corrected success rate |
| ITSM-123 | ITSM-094 | denominator unreliable where 094 is high |
| ITSM-128 | ITSM-123 | evidence uses the correlation kernel |
| ITSM-138 | ITSM-084 | 138 is 084's second case |

### 3c. Causal cross-links (from the workbook's Cross-Domain Link column; not ordering)

```
ITSM-004 assignment rules absent ──root cause of──► ITSM-032 ping-pong
ITSM-002 taxonomy ──blocks──► ITSM-054 pattern detection
ITSM-007 auto-close, ITSM-031 auto-close primary ──suppress──► ITSM-030 reopen rate
ITSM-015 suggestion off ──joins──► ITSM-076 unread known errors
ITSM-039, ITSM-048 ──joins──► ITSM-055 (P1 + MI with no Problem)
ITSM-060 no-incident problems ──understates──► ITSM-057 attributable volume
ITSM-078 no validation ──precursor──► ITSM-074 fix ineffective
ITSM-090 risk fields optional ──root cause of──► ITSM-083 risk always same
ITSM-086 emergency path heavy ──drives──► ITSM-106 unauthorised change
ITSM-094 changes without CI ──makes impossible──► ITSM-084, ITSM-138; ──understates──► ITSM-106, ITSM-123
ITSM-092 no PIR step ◄──► ITSM-122 closed without PIR
ITSM-103 no close code ──corrupts──► ITSM-113 success rate ◄──corrects── ITSM-115
ITSM-115 ──feeds──► ITSM-124
ITSM-116 rubber-stamp ◄──pairs──► ITSM-121 approver concentration
ITSM-123 ──► ITSM-124, ITSM-125, ITSM-128
ITSM-137 SLA on offering-less service ──shares condition parsing──► ITSM-003
ITSM-016, ITSM-067 ──feed──► ITSM-129
```

## 4. Cross-domain dependencies

| ITSM rule | Depends on | Kind |
|---|---|---|
| ITSM-017, ITSM-049, ITSM-126 | CMDB-057 (service reachability) | needs the CMDB relationship graph and a CI→service path |
| ITSM-019, ITSM-095 | CMDB-080, CMDB-084 (retired / non-existent CIs) | same CI lifecycle facts; the CMDB rules find the CI, these find the task pointing at it |
| ITSM-018, ITSM-101, ITSM-134, ITSM-065 | CMDB-102, "Data Quality Q2" | group / owner activity — the framework reference is external and UNDEFINED in this repo |
| ITSM-029 | CMDB-020, ITOM-004 | location chain |
| ITSM-038 | ITOM-116 | alert-to-incident detection lag; needs `em_alert` (ITOM module) |
| ITSM-130, ITSM-131, ITSM-138 | CMDB-058 (CIs with no relationships) | the existing CMDB-UNRELATED / relationship rules |
| ITSM-132 | ITOM-147, CMDB-072, existing `DISC-*` findings | recurring incidents traced to a Discovery failure — consumes ITOM module output |
| ITSM-135 | CMDB-106 (ownership) | CI ownership contradicted by assignment behaviour |
| ITSM-129 | CMDB Trust Score (context) | `manifest.cmdb_quality` exists today |
| ITSM-013, ITSM-091 | OOB state / type baselines | data that must be supplied; not on the instance |
| ITSM-110 | customer authority / delegation matrix | external input; the rule reports its absence otherwise |

Consequence for scan planning: 22 rules need CMDB tables (`cmdb_ci`,
`cmdb_rel_ci`, `cmdb_ci_service`) and 2 need ITOM tables. Today every scan
reads `cmdb_ci` and `cmdb_rel_ci` regardless (they are `required: true`); these
rules give ITSM a genuine reason to, but only to the extent of the CIs the task
records reference — a fact a later phase can use to scope the read.

## 5. Engines → what each needs that does not exist

| Engine | Missing capability (summary) |
|---|---|
| Record Predicate | rule-as-data predicate DSL; per-rule field selection; encoded-query pushdown; threshold registry |
| Aggregate | multi-field group-by / avg / sum wrappers; measure + threshold evaluator; `metric` on a finding; two-tier thresholds; expected-distribution test (UNDEFINED) |
| Configuration | source registry with ~17 readers (most absent); `dependent_value`; schedule spans; plugin probes; OOB baselines |
| Reference Integrity | batched `sys_idIN` resolver with per-run cache; new specs; service-account classifier (UNDEFINED) |
| Linkage | join/anti-join utility; approval reader; plugin-object probes; per-instance link discovery |
| Relationship Graph | shared directed graph built once; path-to-service; dependents(depth); `task_ci` |
| Audit & Journal | bulk `sys_audit` / `sys_journal_field` readers; transition reconstruction; audit-off skip |
| Text Analysis | everything: normalisation, similarity metric (UNDEFINED), blocked clustering, pattern+checksum scan, redaction-safe evidence |
| Temporal Correlation | CI×time index; window join; interval×schedule intersection; per-record before/after counts |
| Composite | rule DAG execution; result cache; confidence propagation |

## 6. Where the risk concentrates

**VERY_HIGH volume (10):** ITSM-010, 026, 028, 034, 043, 054, 058, 077, 106, 132 —
bulk audit/journal or whole-slice text clustering.

**HIGH volume with scale risk (25):** ITSM-004, 007, 019, 020, 021, 023, 025,
030, 032, 033, 035, 036, 040, 084, 095, 096, 097, 104, 115, 120, 124, 125, 126,
130, 138 — row-level reads of large text or a full CMDB table, or cross-table
window joins.

**Very-high complexity (13):** ITSM-010, 025, 054, 058, 077, 081, 084, 086, 091,
106, 117, 132, 138 — approval-routing semantics, semantic text checks, or three
engines chained.

**Objects the workbook names only as concepts (52 rules flagged
`tables_undefined`):** these cannot be built until the platform object is
identified on a real instance — see the UNDEFINED list at the end of
`engine-requirements.md`.
