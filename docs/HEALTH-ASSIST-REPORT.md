# Health Assist — Technical Report

**Scope.** This report covers the Health Assist feature end to end: what it reads, how its rules are defined, registered, checked and scored, how each module (CMDB, ITOM, ITSM, Platform) computes its number, how the overall health score is derived, and how findings are stored, triaged, classified and remediated.

**Source of truth.** Everything below was read from the code in `server/src/health/`, `server/src/routes/health*.js` and `client/src/pages/HealthAssist.jsx` (Sep 2026, `RULE_VERSION 3.0.2`, manifest `5.0.0`, schema `user_version 31`). File references are relative to `server/src/health/` unless stated otherwise.

---

## Contents

1. [What Health Assist is](#1-what-health-assist-is)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [The scan pipeline, step by step](#3-the-scan-pipeline-step-by-step)
4. [Extraction — what is read, and coverage](#4-extraction--what-is-read-and-coverage)
5. [Incremental scanning — when a module is reused](#5-incremental-scanning--when-a-module-is-reused)
6. [The finding — one shape for everything](#6-the-finding--one-shape-for-everything)
7. [Severity, modifiers and effective band](#7-severity-modifiers-and-effective-band)
8. [The three rule families](#8-the-three-rule-families)
9. [CMDB — rule catalogue and rule packs](#9-cmdb--rule-catalogue-and-rule-packs)
10. [ITOM rules](#10-itom-rules)
11. [ITSM — legacy rules and the 139-rule catalogue engine](#11-itsm--legacy-rules-and-the-139-rule-catalogue-engine)
12. [Platform rules](#12-platform-rules)
13. [Priority and blast radius (`synthesize`)](#13-priority-and-blast-radius-synthesize)
14. [Scoring — module by module](#14-scoring--module-by-module)
15. [Overall health (the full system score)](#15-overall-health-the-full-system-score)
16. [Scopes — how findings are routed to modules](#16-scopes--how-findings-are-routed-to-modules)
17. [Parameters — every tunable, per module](#17-parameters--every-tunable-per-module)
18. [How to add a rule](#18-how-to-add-a-rule)
19. [Persistence, runs and history](#19-persistence-runs-and-history)
20. [Finding lifecycle (open / acknowledged / muted / accepted)](#20-finding-lifecycle)
21. [Remediation — from finding to approved write](#21-remediation--from-finding-to-approved-write)
22. [LLM explanation](#22-llm-explanation)
23. [Cross-domain links](#23-cross-domain-links)
24. [Finding Dimensions (classification layer)](#24-finding-dimensions-classification-layer)
25. [API surface](#25-api-surface)
26. [The UI](#26-the-ui)
27. [Design principles that recur everywhere](#27-design-principles-that-recur-everywhere)
28. [Observations, inconsistencies and risks](#28-observations-inconsistencies-and-risks)
29. [Quick-reference numbers](#29-quick-reference-numbers)

---

## 1. What Health Assist is

Health Assist is a **read-only, deterministic health checker** for a connected ServiceNow instance. It:

- reads an allow-listed set of tables through the one ServiceNow client;
- runs rules against what it read and produces **findings**, each with evidence;
- computes a **score per module** (CMDB, ITOM, ITSM; Platform deliberately unscored) plus an **Overall Health** score;
- writes a **manifest** that says what it could *not* see (coverage, skipped checks, degraded reads);
- lets a team triage findings (acknowledge, mute, accept risk) and optionally turn a finding into an **approved remediation**. The remediation goes through the app's existing plan → approve → execute pipeline.

The LLM is optional and only writes prose. **It can never add, remove or change a finding or a score.**

---

## 2. Architecture at a glance

```
                    ┌─────────────────────── routes/health.js (39 endpoints) ─────────────────────┐
 Client  ─ /api ─►  │  POST /runs ─► runHealthCheck()  (index.js)                                  │
 HealthAssist.jsx   │                                                                              │
                    │   planScan (incremental.js) ──► reuse / read per module                      │
                    │   extractEstate (extract.js) ◄── TABLES allow-list (tables.js, 66 specs)     │
                    │   extractCmdbMeta (extract.js)  ── governance/metadata reads, stamped         │
                    │   runITSMRules (itsm/runner.js) ── 139-rule catalogue via 10 engines          │
                    │            └─ normalizeITSMRun (itsm/integration.js)                         │
                    │   new EstateRules(...).analyze()   (rules.js)                                │
                    │      ├─ CMDB packs  cmdb-gate / completeness / correctness / uniqueness /    │
                    │      │   identification / relationships / freshness / lifecycle / governance │
                    │      │   / csdm / consumption / scale / ownership / drift  + legacy rules    │
                    │      ├─ platformRules · itomRules · itsmRules (legacy)                       │
                    │      ├─ + external ITSM catalogue findings                                   │
                    │      ├─ applyMateriality · scopeOf filter                                     │
                    │      └─ synthesize()  (priority, blast radius)                               │
                    │   evaluateLinks (cross-domain/links.js)       — report only                  │
                    │   explainFindings (explain.js)                — optional LLM prose           │
                    │   scoreCmdbQuality (cmdb-quality.js) + cmdbScoreTrend (cmdb-drift.js)        │
                    │   summariseScopes (scopes.js)                                                │
                    │      ├─ CMDB  → cmdb-quality composite                                       │
                    │      ├─ ITOM  → capability checks                                            │
                    │      ├─ ITSM  → scoreItsmQuality (itsm-quality.js)                          │
                    │      ├─ Platform → none                                                      │
                    │      └─ All   → scoreOverall (overall-health.js)                             │
                    │   completeRun (store.js) → SQLite (health_runs / health_findings …)          │
                    └──────────────────────────────────────────────────────────────────────────────┘
      Side layers:  finding-state.js (triage) · remediation.js / proposal*.js / remediate.js / bulk.js
                    finding-dimensions.js + routes/health-dimensions.js (classification)
```

Almost every scoring and rule module has a comment reading **PURE**. It means no socket, no DB and no model: data goes in and data comes out. As a result, the same scoring functions run at the end of a scan *and* against a stored run. Older runs can be re-read under new views without being re-extracted.

---

## 3. The scan pipeline, step by step

`runHealthCheck()` in `index.js` (MANIFEST_VERSION `5.0.0`):

| # | Step | Module | What happens |
|---|---|---|---|
| 1 | **Plan** | `incremental.js planScan` | For each requested module, decide `reuse` or `read` (see §5). |
| 2 | **Extract** | `extract.js extractEstate` | Read each needed table: keyset paging, 500 rows a page, 100 000 rows max per table. Each table is stamped just before its read. The result is `estate` (rows) and `coverage` (one status per table). |
| 3 | **CMDB meta** | `extract.js extractCmdbMeta` | If CMDB is read: the class hierarchy, virtual computers, `used_for` per class, choice lists, audit/collection flags and more. Each read is recorded as `meta.reads[key] = {status, ms, error}` and stamped via `stampSources`. |
| 4 | **ITSM catalogue** | `itsm/runner.js runITSMRules` → `itsm/integration.js normalizeITSMRun` | If ITSM is read, all 139 catalogue rules are evaluated (see §11). Their findings, rule rows and skips are normalised. |
| 5 | **Rules** | `rules.js new EstateRules(estate, coverage, staleDays=90, now, {meta, acceptedFingerprints, history}).analyze({modules, external:{itsm}})` | All rules run and the ITSM catalogue findings are merged in. Then materiality, scope filter and `synthesize()`. |
| 6 | **Cross-domain links** | `cross-domain/links.js evaluateLinks` | Report-only joins between rule results. |
| 7 | **Explain** | `explain.js explainFindings` | Optional. The LLM writes prose for up to 20 top findings and is validated against known fingerprints. |
| 8 | **CMDB score** | `cmdb-quality.js scoreCmdbQuality` then `cmdb-drift.js cmdbScoreTrend` (CMDB-137) | Two-layer score (trust gate plus composite). The trend rule runs *after* scoring because it reads the score. |
| 9 | **ITSM score input** | — | `{rules, population}` is prepared for the ITSM Quality model. |
| 10 | **Summaries** | `scopes.js summariseScopes` | One summary per scope (all, cmdb, itom, itsm, platform), including the module contract and the Overall. |
| 11 | **Status** | — | The run is **`partial`** if any coverage is not `complete`, any rule was skipped, or the LLM was unavailable. `degraded` per module lists failed reads, and a degraded module result is never reused. |
| 12 | **Persist** | `store.js completeRun` | Manifest plus **all** findings are stored. There is no storage cap any more, and older runs' findings are pruned (§19). |

Progress is streamed over SSE (`GET /runs/:runId/stream`) through `emit(phase, pct)`. Runs can be cancelled via an `AbortSignal`.

**Manifest fields:** `coverage`, `skipped_checks`, `catalogue_warnings` (`intentMisTags`, `trackMisroutes`), `cmdb_quality`, `itsm` (rules, measures, performance, aggregation), `links`, `severity_counts`, `priority_counts`, `scopes`, `phases` (timings), `metrics`, `findings_detected/stored/truncated`, the module plan and dependencies.

---

## 4. Extraction — what is read, and coverage

### 4.1 The allow-list (`tables.js`)

- There are **66 table specs**. Health Assist may read these and **no others**, which is a closed vocabulary rather than a gate.
- Each spec is `spec(key, fields, required, {filter, filterLabel, optIn})`. `sys_id` and `sys_updated_on` are implicit on every spec.
- **Required:** `cmdb_ci` and `cmdb_rel_ci`.
- **Opt-in:** `sys_audit` and one other audit/history table are only read when a caller names them. They change on every run and would otherwise stop scan results being reused.
- **ITSM slice:** `incident`, `change_request` and `problem` are read as `active=true ^OR sys_updated_on >= now − 90 days` (`ITSM_WINDOW_DAYS = 90`). The date is a literal, not `javascript:gs.daysAgoStart()`.
- `sliceWhere(table, cutoff)` gives the full encoded query: the cutoff (`sys_updated_on <= cutoff`) AND the slice. `specHash` fingerprints fields plus slice so that a changed read invalidates reuse.

Tables by module (from `scopes.js`):

| Module | Tables |
|---|---|
| **CMDB** | cmdb_ci, cmdb_rel_ci, cmdb_ci_service, service_offering, cmdb_health_config/metric/metric_pref, cmdb_class_info, cmdb_recommended_fields, cmdb_data_management_policy/task, cmdb_policy_scheduled_job, sysauto_script, cmn_location, core_company, cmdb_identifier(_entry), life_cycle_stage_status/mapping/control, cmdb_reconciliation_definition, cmdb_datasource_* (attribute_value, precedence, last_update, staleness), reconcile_duplicate_task, duplicate_audit_result, sys_object_source, cmdb_ire_output_aggregate_stats, cmdb_metadata_hosting/containment, cmdb_rel_type, discovery_schedule, discovery_device_history, discovery_range_item, alm_asset, cert_audit(_result), cert_filter, cert_follow_on_task, sys_archive(_destroy), sys_user_grmember, sys_table_rotation, svc_ci_assoc, change_request (+ `sys_audit` opt-in) |
| **ITOM** | ecc_agent, ecc_agent_capability, ecc_agent_issue, ecc_queue, discovery_status, discovery_device_history, discovery_log, discovery_credentials, svc_ci_assoc, cmdb_ci_service_discovered, em_alert, cmdb_ci_outage |
| **ITSM** | incident, change_request, problem (plus whatever the ITSM catalogue reads through its own capability pipeline) |
| **Platform** | sys_script, sys_rest_message, sys_trigger, sysauto, sys_upgrade_history_log, sys_user_has_role |

### 4.2 Coverage statuses (`extract.js`)

Every table gets a coverage row: `{table, status, records, reported_total, pages, missing_fields, cutoff, filter}`.

- **Usable:** `complete`, `limited`, `truncated`.
- **Failed:** `forbidden`, `unauthorized`, `rate_limited`, `upstream_error`, `invalid_query`, `truncated`.
- **Not read:** `not_requested` ("we did not look") and `unavailable` (not on this instance).

`sysparm_fields` silently drops fields a table lacks. The extractor therefore compares what came back against what was asked for, and puts the difference in `missing_fields`.

**`isComplete(coverage, table, fields)`** (`rules.js`) is the single completeness answer the whole system uses. It returns true when `rows_complete` holds and none of `fields` is missing.

---

## 5. Incremental scanning — when a module is reused

The unit of reuse is the **module**, not the row, because the rules judge whole tables (duplicates, class sizes, graph walks).

**Before any reading, a module is re-read if any of these hold:**

- a full re-read was requested (`reuse=false`);
- the module has no earlier result on this instance;
- the **engine key** changed;
- a different ServiceNow account is connected;
- the last result is older than **`maxReuseHours = 24`**, because time alone changes findings;
- the last result predates change stamps;
- the last result was **degraded** (a read failed).

The **engine key** per module (`engineKeys`) is `sha256({source, staleDays, accepted-risk fingerprints for that module, [itsm key]})`, where:

- `source` hashes the engine files (`rules|scopes|tables|extract|index|incremental|cmdb-*.js`) plus `catalogue/*.json`;
- the ITSM key (DECISION 8) also covers catalogue definitions, parameters with instance overrides, engine versions and configuration.

**Then stamps are compared.** Every input table's `(row count, newest sys_updated_on)` is compared with the stamps of the run that produced the module's current result. Deletions are detected on tables that keep a deletion log. Any change leads to `read`; otherwise `reuse`.

A reused module's findings and summary come from its source run. The **composed view** (`store.composedView`) shows each module's latest result side by side.

Users can switch incremental checking off per table (`PATCH /scan-state/:table`).

---

## 6. The finding — one shape for everything

`EstateRules.add()` builds the base shape:

```
fingerprint   sha256(rule | table | sorted sys_ids)        ← identity across runs
agent_id, domain, rule_id, table, target_ids[], title, description
severity, confidence (0–1), recommendation
evidence[]    one row per (record, field): {source, sn_table, sn_sys_id, field_name, field_value, reason, collected_at}
estate_wide   true when the finding names no records (it is about an ABSENCE)
→ after synthesize():  affected_ci_ids, affected_service_ids, impact{}, priority_score, priority_factors, priority (P1/P2/P3)
```

`addCatalogued()` is used for CMDB catalogue rules. It adds:

- `base_severity` and the effective `severity` (reporting band);
- **`deduction_severity`** (the charge band) and `dimension`;
- `modifiers {escalators, de_escalators, not_evaluated}`;
- `escalated_to_systemic`, `gate` and `posture`;
- `false_positive_guard`, and optionally `dedupe_key`, `deduction_multiplier(_by_record)`, `unscored_reason` and `systemic_kind_override`.

If the fingerprint is an **accepted risk**, the finding gets the `approved_exception` de-escalator.

ITSM catalogue findings (`itsm/findings.js`) extend the same base with a **`kind`**: `record | aggregate | configuration | historical | relationship | cross_domain`. Each kind has its own `detail` block and fingerprint recipe:

- record: `rule|table|ids`
- aggregate: `rule|table|measure|group`
- configuration: `rule|object|ids|'absent'`
- historical: `…|field`
- relationship: `src tbl|src id|tgt tbl|tgt id`
- cross_domain: `rule|domain|ids`

Sensitive evidence values are redacted **when the finding is constructed**.

---

## 7. Severity, modifiers and effective band

### 7.1 Bands

| Key | Label | Rank | Deduction weight (`BAND_WEIGHT`) |
|---|---|---|---|
| SYSTEMIC | Systemic | 6 | 100 |
| CRITICAL | Critical | 5 | 40 |
| HIGH | High | 4 | 15 |
| MEDIUM | **Moderate** | 3 | 5 |
| LOW | Low | 2 | 1 |
| INFO | Info | 1 | 0 |

The vocabulary is served by the server; the UI never coins labels. The ITSM workbook word "Moderate" maps to `MEDIUM` (DECISION 6, `itsm/adapter.js`).

### 7.2 Effective band (CMDB catalogue rules)

```
effective_band = clamp(base + #escalators − #de-escalators, LOW, SYSTEMIC)
```

Modifiers stack. Unknown modifier keys are refused, so a typo cannot move a band.

**Escalators:**

- `business_critical_service`
- `production`
- `cross_domain_cause`
- `duration_over_30_days`
- `shared_infrastructure`
- `silent_failure`
- `recurred`
- `class_defect_rate`
- `control`
- `rule_threshold`

**De-escalators:**

- `non_production`
- `not_consumed`
- `approved_exception`
- `below_materiality`
- `compensating_control`
- `retiring`

**Two families** (`MODIFIER_FAMILY`):

- **per_ci**: a fact about *this* record. It changes what the record is **charged**.
- **population**: `class_defect_rate` and `below_materiality`, facts about the record's *class*. They change only where a finding is **reported**, never the charge.

So every record finding carries two bands: `severity` (reporting) and `deduction_severity` (cost).

### 7.3 Where modifiers come from (`cmdb-signals.js`)

`buildSignals(ctx)` computes the following once per scan:

- **bcSupported**: CIs reachable downstream, to depth 6, from a service whose `busines_criticality` matches `/^1\b/`, plus `svc_ci_assoc` members. This needs a complete relationship read.
- **serviceBound**: CIs that should resolve to a service. It is the denominator for CMDB-141.
- **productionOf(r)**:
  - `explicit` when `used_for = Production` is explicitly set, not merely the class default;
  - `inferred` via configured production CIDRs or Discovery sources, or support of a production service.
- **shared_infrastructure**: the class lineage contains netgear, router, switch, firewall, load balancer, directory, LDAP or DB instance.
- **retiring**: the lifecycle stage status matches `/retir/i`.

`modifiersFor(records)` then applies them. It **escalates if ANY record** meets an escalator and **de-escalates only if ALL** do. Anything it could not evaluate is listed in `not_evaluated` rather than silently assumed.

### 7.4 Materiality (`applyMateriality` + `materialityFor`)

Materiality is computed per rule and per CI class after all rules have run:

- **Escalate (pattern):** affected ≥ 20% of the class **and** ≥ 10 CIs. One *pattern finding* is emitted at base+1 for reporting. It **deducts nothing**; the records are charged by their own findings.
- **De-escalate:** affected < max(5, 1% of class) → `below_materiality`, which affects reporting only.
- `deduction_band_override` can only *downgrade*.

### 7.5 Consequence scoping

`consequenceOf(ci)` decides whether a defect has operational consequence:

- `full`: business-critical support, infrastructure, host, application or service.
- `reduced`: a leaf endpoint, or explicitly non-production. Such defects are charged at `CONSEQUENCE_REDUCED_BAND = LOW`.

An *unset* environment is never treated as non-production.

---

## 8. The three rule families

| Family | Where | Count | Shape |
|---|---|---|---|
| **CMDB catalogue** | `catalogue/cmdb.json` (143 rules) + 14 `cmdb-*.js` packs | 143 catalogued; all implemented (`IMPLEMENTED_CATALOGUE_RULES` = union of pack lists) | Rich metadata: base, dimension, kind, track, systemicKind, guards. `addCatalogued()`. |
| **ITSM catalogue** | `rules/itsm/catalogue.json` (139) + `itsm/rules/<engine>.json` configs + `rules/itsm/parameters.json` | 139 configured; ~106 executable, 33 unavailable by declaration | Rules are **data handed to 10 generic engines**. |
| **Legacy hard-coded** | methods in `rules.js` | 43 (tagged `LEGACY_RULE_ORIGIN` in `rule-catalogue.js`) | Plain `add()`. Severity is asserted in code. |

`rule-catalogue.js` unifies all three into one read-only catalogue of **325 rules** for the UI, remediation and dimensions. ITSM rules are injected via `registerItsmCatalogueRules` from `index.js`, which avoids an import boundary violation.

---

## 9. CMDB — rule catalogue and rule packs

### 9.1 Catalogue schema (`catalogue/cmdb.json`)

The source is `SAOS_Health_Rules_Tracker_v3.xlsx` (CMDB and data quality tabs). Each rule carries:

`id, group, groupName, title, base, dimension, kind, track, principalScoped, systemicKind, intent, dq, lane, whatItMeans, whyItMatters, sourceTables, detectionLogic, threshold, confidenceBasis, evidenceToShow, falsePositiveGuard, remediationLane, crossDomainLink`

Distribution:

| Attribute | Values |
|---|---|
| **base** | SYSTEMIC 17 · CRITICAL 44 · HIGH 45 · MEDIUM 30 · LOW 7 |
| **kind** | `record` 110 (deducts per record) · `kpi` 17 (a percentage; its pass % is a dimension sub-score) · `trend` 11 (shown; gates only if base Systemic) · `context` 5 (shown, never scored) |
| **track** | `dimension` 94 (scored) · `gate-config` 12 · `governance` 11 · `trend` 8 · `platform` 7 · `context` 5 · `posture` 3 · `csdm-maturity` 3 — only `dimension` moves the composite |
| **systemicKind** | `config_absence` 4 (gate only) · `measured_kpi` 6 (gate on breach **and** scores) · `posture` 6 (neither) · `derived` 1 (CMDB-116, shown) |
| **intent** | `quality` 115 · `contradiction` 28 (judges records the quality rules skip, e.g. a retired CI with conflicting status) |

### 9.2 The ten dimensions and their weights (sum = 100)

| Dim | Label | Weight | Blend kind (record / KPI) | Rules |
|---|---|---|---|---|
| D1 | Completeness | 12 | record 70/30 | 12 |
| D2 | Correctness | 12 | record 70/30 | 10 |
| D3 | Uniqueness | 14 | record 70/30 | 10 |
| D4 | Identification integrity | 12 | mixed 60/40 | 7 |
| D5 | Reconciliation integrity | 8 | mixed 60/40 | 5 |
| D6 | Relationship integrity | 16 | mixed 60/40 | 14 |
| D7 | Freshness | 10 | mixed 60/40 | 12 |
| D8 | Lifecycle integrity | 6 | record 70/30 | 11 |
| D9 | Ownership | 6 | record 70/30 | 7 |
| D10 | Consumption and trust | 4 | **estate 30/70** | 12 |

43 rules have no dimension: gate, governance, platform, trend, posture and context tracks.

### 9.3 The 14 packs — the order `analyze()` runs them

| Order | Pack (file) | Group | Rules | Scores into |
|---|---|---|---|---|
| 1 | `cmdb-signals.js buildSignals` | — | — | modifiers |
| 2 | `cmdb-gate.js` | G1 Health configuration meta | CMDB-001…011, 139 | trust gate (config_absence / measured_kpi) |
| 3 | `cmdb-completeness.js` | G2 | CMDB-012…022, 140, 141 | D1 (+ CMDB-141 → D10 KPI) |
| 4 | `cmdb-correctness.js` | G3 | CMDB-023…032 | D2 |
| 5 | `cmdb-uniqueness.js` | G4 | CMDB-033…043 | D3 |
| 6 | `cmdb-identification.js` | G5 | CMDB-044…055 | D4 / D5 (9 are **config-only**: reported, may gate, deduct nothing) |
| 7 | `cmdb-relationships.js` | G6 | CMDB-056…069 | D6 |
| 8 | `cmdb-freshness.js` | G7 | CMDB-070…079, 142, 143 | D7 |
| 9 | `cmdb-lifecycle.js` | G8 | CMDB-080…090 | D8 |
| 10 | `cmdb-governance.js` | G9 | CMDB-091…101 | governance track (posture, not scored) |
| 11 | `cmdb-csdm.js` | G11 | CMDB-109…115 | 109/110/113/114 → D10; others csdm-maturity |
| 12 | `cmdb-consumption.js` | G12 | CMDB-116…123 | 117/118/121/123/141 → D10; 116/119/120/122 unscored |
| 13 | `cmdb-scale.js` | G13 | CMDB-124…130 | platform track (not scored) |
| 14 | `cmdb-ownership.js` | G10 | CMDB-102…108 | D9 |
| 15 | recurrence pass (`cmdbRecurrencePass`) | — | — | adds `recurred` escalator from history |
| 16 | materiality | — | — | patterns / below_materiality |
| 17 | legacy cmdb / relationship / service rules | — | CMDB-OWNER, CMDB-STALE, CMDB-DUPLICATE, REL-*, CMDB-UNRELATED, CSDM-* | legacy (REL-* skipped when Group 6 is built: "subsumed") |
| 18 | `cmdb-drift.js` | G14 | CMDB-131…138 | trend track (not scored); CMDB-137 runs *after* scoring |

### 9.4 How a CMDB pack checks a rule (the common pattern)

Every pack function is `cmdbXxxRules(ctx, options)`, where `ctx` carries `estate`, `coverage`, `meta`, `signals`, `now`, `skipped`, `complete()` and `addCatalogued()`. Each rule follows the same template:

1. **Precondition gates.**
   - `needCis(rule, fields)` requires `ctx.complete('cmdb_ci', fields)`. Otherwise the rule is skipped, with a reason naming the missing fields.
   - `needHierarchy(rule)` requires the class hierarchy read.
   - Rule-specific reads are checked with `readOk(metaKey)`.
   - A rule that cannot run **skips with a reason**, and the skip is shown in the manifest.
2. **Population.**
   - `dqActive()` removes install_status 7 (Retired), 8 (Stolen) and 100 (Absent) from data-quality dimensions. Lifecycle (D8) still sees them.
   - Class filters use lineage (`lineageOf(meta, class)`).
3. **Detection.**
   - The literal detection logic from the catalogue, narrowed by the rule's **false-positive guard**. Examples:
     - CMDB-020 is scoped to physical classes.
     - CMDB-021 skips when the table isn't audited.
     - CMDB-022 skips when no CI carries a cost centre.
   - Placeholder values ("unknown", "n/a", "tbd", "0.0.0.0", "to be filled by o.e.m." …) count as missing.
4. **Emit.**
   - `perRecord(rule, ci, fields, description, extra)` → `modifiersFor([ci], signals)` → `ctx.addCatalogued(...)`, carrying the escalators and de-escalators, a confidence and a `guard: {evaluated, note}`.
   - KPI rules push `{rule_id, pass_pct, numerator, denominator, basis}` into `kpis` instead.

### 9.5 The in-scope population (`cmdbInScope`, `cmdb-gate.js`)

- If `cmdb_health_config` has inclusion rules and the hierarchy is readable, the in-scope population is **CIs whose class lineage hits an inclusion rule's `applies_to`**.
- Otherwise it is **all CIs read**, and the basis says why: no inclusion rule (CMDB-001), or the hierarchy is unreadable.
- `dimensionScope` narrows D1–D5 further to exclude install_status 7/8/100.

---

## 10. ITOM rules

These are legacy hard-coded rules in `rules.js` (`itomRules()`), grouped by agent. **Absence** findings are `estate_wide` and use `whenEmpty(table, rule, fn)`, which fires only on a **complete** read of an empty table.

| Area | Rule | Fires when | Severity |
|---|---|---|---|
| Discovery | DISC-NEVER-RAN | discovery_status read completely and empty | CRITICAL |
| | DISC-FAILED | run state error / cancelled | CRITICAL / MEDIUM |
| | DISC-STALE | completion older than `staleDays` (90) | CRITICAL |
| | DISC-DEVICE-ISSUE | device history `issues > 0` | HIGH |
| | DISC-LOG-ERROR | discovery_log level = error | MEDIUM |
| Credentials | CRED-NONE | credentials table empty | CRITICAL |
| | CRED-INACTIVE | a credential inactive | CRITICAL |
| | CRED-ALL-INACTIVE | every credential inactive (complete read) | CRITICAL |
| MID | MID-NONE | ecc_agent empty | CRITICAL |
| | MID-DOWN *(in platformRules)* | status = Down | CRITICAL |
| | MID-NOT-VALIDATED | up but not validated | CRITICAL |
| | MID-NO-CAPABILITY | no capability row (complete read required) | HIGH |
| | MID-ISSUE | unresolved ecc_agent_issue | HIGH |
| Service Mapping | SM-NOT-IN-USE | discovered services exist, svc_ci_assoc empty | CRITICAL |
| | SM-UNMAPPED | a discovered service with no association | HIGH |
| Availability | OUTAGE-OPEN | outage open ≥ 24 h with no end | MEDIUM |
| Events | EVENT-UNBOUND *(in platformRules)* | open alert with empty cmdb_ci | CRITICAL |
| Queue | PERF-ECC-AGE *(Performance domain, routed to ITOM)* | ready ECC item older than 1 h | default |

When a "none exists" rule fires, the dependent rules return early. One clear finding is shown rather than six skip lines.

---

## 11. ITSM — legacy rules and the 139-rule catalogue engine

### 11.1 The eleven legacy ITSM rules (`rules.js`)

These rules work on OPEN records, apart from reopen and failed-change outcomes. They key off `active`, never off numeric state codes, which vary by instance. `ITSM_STALE_DAYS = 30`.

| Rule | Condition | Severity |
|---|---|---|
| ITSM-INC-UNASSIGNED | open incident, empty assignment_group | HIGH for P1/P2, else MEDIUM |
| ITSM-INC-P1-AGED | P1 open > 1 day | HIGH |
| ITSM-INC-STALE | open, not updated > 30 d | default |
| ITSM-INC-NO-CI | no cmdb_ci and no business_service | LOW |
| ITSM-INC-REOPENED | reopen_count ≥ 2 | default |
| ITSM-CHG-STALE | open change idle > 30 d | default |
| ITSM-CHG-NO-CI | open change, no CI | MEDIUM |
| ITSM-CHG-OVERDUE | ≥ 1 day past end_date and still open | MEDIUM |
| ITSM-CHG-FAILED | close_code = unsuccessful | MEDIUM |
| ITSM-PRB-UNASSIGNED | open problem, no group | MEDIUM |
| ITSM-PRB-STALE | open problem idle > 30 d | LOW |

### 11.2 The ITSM catalogue engine (`itsm/`)

**Rules are data, not functions.**

```
rules/itsm/catalogue.json   ─► catalogue.js      (139 rules, validated at load: slot n = ITSM-nnn = Excel row n+1; 16 required fields)
rules/itsm/architecture-map ─► catalogue.js      (one classification per rule; must be built from the same workbook sha)
rules/itsm/parameters.json  ─► parameters.js     (typed declarations; default → instance → runtime)
itsm/rules/<engine>.json    ─► rules/index.js    (validated at load) ─► rule-config.js ($param/$window/$clause/$choice → values)
run-context.js / context.js ─► runner.js ─► registry.js ─► engines/*.evaluate(rule, ctx)
```

**The catalogue:**

- 12 groups:
  - 1A–1D Incident (config, data quality, process, major incident)
  - 2A–2C Problem
  - 3A–3D Change (including change–incident correlation)
  - Cross-process
- Base severities: Systemic 33 · Critical 51 · High 41 · Moderate 14.

**The ten engines, with configured rules per engine:**

| Engine | Rules | Mechanism |
|---|---|---|
| `record_predicate` | 23 | predicate DSL with encoded-query pushdown (`length_lt`, `same_as`, …) |
| `aggregate` | 20 | count / share / ratio / percentage / distribution / joint_share, thresholds with `escalate_at`, `minimum_volume`, trends |
| `linkage` | 22 | join / anti-join / existence over reference and m2m links |
| `configuration` | 24 | named readers plus comparators (`absent`, `rows_where`, `choice_usage`, `sla_per_band` …) |
| `reference_integrity` | 9 | batched resolver: exists / active / members-active |
| `relationship_graph` | 4 | bounded per-run CMDB edge store (only CIs referenced by tasks) |
| `temporal_correlation` | 9 | key×time window joins, schedule intersection, before/after |
| `audit_history` | 7 | audit / journal / task_sla transitions; state order from `sys_choice.sequence` |
| `text_analysis` | 11 | TF-IDF cosine similarity, clustering, pattern scan (Luhn / Verhoeff for card/ID leakage) |
| `composite` | 10 | DAG over other rules' results; confidence = min |

Example config (ITSM-020): table `incident`, scope `resolved_atISNOTEMPTY`, predicate `close_notes length_lt {$param: min_length}`, `report_ratio: true`.

Example config (ITSM-001): aggregate `share` of incidents grouped by `priority` over `{$param: window}`, threshold `gt {$param: dominance_share}`, plus a declared `partial` evidence gap.

**How the runner checks a rule** (`runner.js`). It works in dependency order and **stops at the first gate that fails**:

1. Declared **undefined dependency** → `unavailable`.
2. **Object pipeline** (DECISION 5: candidate → table_discovery → schema_verification → capability_confirmation) → `unavailable` with the step reached.
3. Workbook-named **tables** present?
4. **Parameters** resolved? If not → `unconfigured`, naming the keys and the workbook sentence. **No invented defaults** (DECISION 3).
5. **Instance choice values** exist (`$choice`)?
6. **Field gate:** every field the detection reads must exist on the table. Otherwise the rule is `unavailable` (kind `capability`). This prevents a missing-field query silently matching every row.
7. The **engine** runs. An exception gives `error`; one broken rule never kills a run and never passes.

**Result statuses:** `evaluated | unconfigured | unavailable | not_configured | skipped | error`.

**Verdicts** (for evaluated rules only): `fail | pass | inconclusive`. Every evaluated result declares its `population`. An empty population, a withheld judgement (below minimum volume, insufficient history) or no declared population gives **inconclusive, never pass**. The one exception is `determinate_when_empty`.

**Normalisation** (`integration.js normalizeITSMRun`) produces:

- findings (domain `ITSM`, agent `itsm_agent`);
- **139 rule rows**, each with `status`, `verdict`, `blocker{kind}`, `undetermined`, `population`, `base_severity`, `engine`, `classification` and `implemented`;
- skipped checks;
- an aggregation (by status, severity, blocker kind);
- performance metrics.

The findings join `EstateRules` through `analyze({external:{itsm}})`, so they share the same scope filter, `synthesize()` and counts as every other finding.

**Measure history** (`measure-history.js`): trend rules compare readings across scans **only under the same comparability key** (rule config + resolved parameters + engine version). ITSM-041 stays inconclusive until three comparable scans exist.

---

## 12. Platform rules

`platformRules()` in `rules.js`:

| Rule | Detection | Severity |
|---|---|---|
| CUSTOM-BEFORE-UPDATE | active *before* business rule containing `current.update(` | HIGH (conf 0.85) |
| INT-HTTP | REST message endpoint starts `http://` | HIGH |
| PERF-JOB-ERROR | sys_trigger state = 3 (error) | default |
| PERF-ECC-AGE | ready ECC item > 1 h (routed to ITOM) | default |
| UPGRADE-SKIPPED | upgrade history disposition = skipped | default (conf 0.85) |
| SEC-INACTIVE-ROLE | inactive user still holds a role | HIGH for admin, else MEDIUM |
| MID-DOWN / EVENT-UNBOUND | (live here, routed to ITOM by prefix) | CRITICAL |

Platform has **no score** by design (§14.4).

---

## 13. Priority and blast radius (`synthesize`)

`synthesize()` runs on every finding after scoping:

1. It builds an **undirected graph** from `cmdb_rel_ci`.
2. It seeds from the finding's CI/service targets, plus both ends of a relationship finding, and walks **BFS to depth 3**.
3. It sets `affected_ci_ids` and `affected_service_ids`, plus `impact = {reachable_nodes, max_depth: 3, direction, interpretation: "Topology reachability for review, not proven outage propagation"}`.
4. It computes the priority score:

```
severity    = SEVERITY_RANK (SYSTEMIC 6 … INFO 1)
business    = estate_wide ? 5 : 1 + min(#affected services, 4)
dependency  = estate_wide ? 2 : 1 + min(#reachable nodes, 20) / 20
priority_score = severity × business × dependency × confidence
priority    = ≥ 20 → P1 · ≥ 8 → P2 · else P3
```

`remediation_value` and `effort` are recorded as 1 ("pending human assessment"). Findings are sorted by priority_score desc, then by fingerprint.

Estate-wide findings take the maximum proxies. "No MID server" is upstream of everything, not smaller than everything.

---

## 14. Scoring — module by module

Every score obeys one rule: **a score only describes what was read.**

- A table not read completely is excluded from the denominator, and the `basis` names it.
- If nothing usable is left, the score is **withheld** with the specific reason.
- Missing data is never 0 and never 100.

### 14.1 CMDB Quality (`cmdb-quality.js`, model `cmdb-quality/1`)

**Inputs:** findings, kpis, `inScope`, `implemented`, `measures`, `dimensionScope`, `skippedRules`, `configRules`.

#### Layer 1 — the Trust Gate

- A catalogued finding whose **base** is SYSTEMIC **never deducts**.
- **Blockers** are base-Systemic findings whose `systemicKind` is `config_absence` or `measured_kpi` (`GATING_KINDS`).
- A rule may **downgrade** itself to posture via `systemic_kind_override` (e.g. the capability being measured is absent). It can never promote itself.
- Any live blocker gives `gate.trustworthy = false` and the label **"Score not trustworthy"**.
- **Posture:** base-Systemic findings of kind `posture`/`derived` are surfaced, never gating, never scored.
- **Escalated:** a non-Systemic record finding escalated to SYSTEMIC by its own CI's context charges w = 100 (zeroes the record). It is listed separately with its escalation chain.
- **Patterns** (class-wide) are listed and never charged.

#### Layer 2 — dimensions, then composite

For each catalogued finding with `track = 'dimension'`, `kind = 'record'`, non-Systemic base, not a pattern, not `unscored_reason`, and with targets:

```
for each target record r in the dimension's scope:
    w = BAND_WEIGHT[deduction band for r] × multiplier(r)          (CMDB-033 charges the empty duplicate twin ×5)
    charges[r][dedupe_key or fingerprint] = max(existing, w)       ← ONE DEFECT, ONE CHARGE

record_score(r, d) = max(0, 100 − Σ charges[r])                    (cap: a record can lose at most 100)
record_part(d)     = 100 − Σ_r min(100, Σ charges[r]) / |scope(d)|  (= mean record score, clean records count as 100)
kpi_part(d)        = mean pass_pct of the dimension's measured KPI rules
dimension_score(d) = blend.record × record_part + blend.kpi × kpi_part   (either part alone if the other is absent)
composite          = Σ weight_d × score_d ÷ Σ weight_d                over MEASURED dimensions only
```

**Blends** by `DIMENSION_KIND`:

| Kind | Dimensions | record / KPI |
|---|---|---|
| record | D1, D2, D3, D8, D9 | 70 / 30 |
| mixed | D4, D5, D6, D7 | 60 / 40 |
| estate | D10 | 30 / 70 |

**Dimension scope.** The scope is `dimensionScope[d]` when given (D1–D5 exclude retired, stolen and absent), else the in-scope CIs. It also includes **records charged by a `contradiction` rule** in that dimension, so their charges aren't dropped.

**A dimension is "measured"** only if a chargeable record rule ran (built, not config-only, not skipped) over a non-empty scope, **or** a KPI measured. Otherwise it reports `measured: false` and names the reason.

**Caveats** are attached to the dimension for these cases:

- only one KPI measured;
- the KPI half absent (so the blend was not applied);
- the record half absent;
- the KPI is also a gate blocker ("the same signal twice");
- no principal classes (CMDB-139);
- config-only rules present.

**Two provisional states, never merged:**

- `gate_provisional`: a blocker is live.
- `coverage_provisional`: measured weight < 100. The label reads "Provisional — x of 100 weight measured".

**Three published variants (CMDB-116)** of the same number:

- `raw`: the arithmetic.
- `coverage`: weight measured.
- `gate`: value `null` while the gate is open. **This variant is the dominant one.**

**Also reported:**

- `density`: defects per 100 records and weighted per 100, a secondary trend metric;
- `tracks`: counts of non-dimension findings;
- `unscored_findings` with reasons;
- `weights_caveat`: the weights are SAOS defaults, not customer-reviewed.

**Legacy fallback.** For runs recorded before CMDB Quality, `scopes.js cmdbScore` gives `% of CIs with no CMDB-domain finding`. It is withheld unless `cmdb_ci` and `cmdb_rel_ci(parent, child)` were read completely.

### 14.2 ITSM Quality (`itsm-quality.js`, model `itsm-quality/1`)

```
population      = extracted slice (open or updated in 90 d) of incident, change_request, problem — only tables read COMPLETELY
record_score(r) = max(0, 100 − Σ w(band))  over DISTINCT charges on r   (w = BAND_WEIGHT: 40/15/5/1, effective Systemic 100)
record_part     = 100 − Σ_r min(100, Σ charges[r]) / N
rule_part       = 100 × passes / (passes + fails)   over ESTATE-level catalogue rules
score           = 0.6 × record_part + 0.4 × rule_part                    (one part alone if the other is absent)
```

**Who charges a record:**

- the 11 legacy rules;
- catalogue findings of kind `record`, `historical` or `relationship` whose table is in the usable population.

A finding naming a record *outside* the slice is counted as `outside_population` and not charged. If the run did not keep its slice, catalogue record findings are `unbounded` and not charged.

**What does not charge:**

- **Base Systemic** findings. In ITSM they are all **posture**, surfaced beside the score, never a gate. The ITSM catalogue has no `systemicKind`.
- Aggregate, configuration and composite findings. They enter through the **rule part**.

**Rule part inclusion:**

- Only `status = evaluated` with a determinate verdict counts.
- Base-Systemic rows are excluded.
- Non-estate engines are excluded, because their records carry the verdict.
- **Vacuous passes** are excluded: a pass over an empty population not declared determinate.

**Defect families** (one charge per family per record, the heavier wins):

- `incident_backlog_ageing` = ITSM-INC-P1-AGED + ITSM-037
- `problem_not_progressing` = ITSM-PRB-STALE + ITSM-056 + ITSM-061
- `incident_unassigned` = ITSM-INC-UNASSIGNED + ITSM-042

**Outputs:** `score`, `basis`, `definition`, `withheld`, the top 8 `drivers` (rule, distinct records, share), plus `quality.{record_part, rule_part, population, records, rules counts, coverage, systemic, families}`. The scoring key hashes model, weights, blend, kinds, engines, families, legacy list and tables.

### 14.3 ITOM (`scopes.js`, model `itom-checks/1`)

ITOM findings are mostly about **absence**, which is not a percentage of rows. The score is therefore **the share of applicable capability checks that pass**:

| Check | Table | Needs rows | Fails on |
|---|---|---|---|
| mid_present | ecc_agent | no | MID-NONE |
| mid_healthy | ecc_agent | yes | MID-DOWN, MID-NOT-VALIDATED, MID-ISSUE, MID-NO-CAPABILITY |
| discovery_ran | discovery_status | no | DISC-NEVER-RAN |
| discovery_clean | discovery_status | yes | DISC-FAILED, DISC-STALE, DISC-DEVICE-ISSUE, DISC-LOG-ERROR |
| credentials | discovery_credentials | no | CRED-NONE, CRED-ALL-INACTIVE |
| service_mapping | cmdb_ci_service_discovered | yes | SM-NOT-IN-USE, SM-UNMAPPED |
| ecc_flowing | ecc_queue | yes | PERF-ECC-AGE |
| events_bound | em_alert | yes | EVENT-UNBOUND |
| outages_closed | cmdb_ci_outage | yes | OUTAGE-OPEN |

A check is `not_applicable` in these cases:

- the table was not requested;
- the table is unavailable;
- the table was not read completely (gap `read_failed`);
- `needsRows` is set and the table is empty. A vacuous truth is not health.

`score = 100 × passed / applicable`. It is withheld if nothing is applicable. Severity does **not** affect the ITOM score: one failing HIGH rule fails its check just as a CRITICAL one does.

### 14.4 Platform

There is **no score**. The stated reason: tens of thousands of role assignments and a handful of integrations share no denominator, so a percentage would be decided by the largest table. Its summary shows findings, severities and table coverage only.

---

## 15. Overall health (the full system score)

`overall-health.js` (model `overall-health/1`, coverage `instance-actionable/1`, status rules `area-precedence/1`).

### 15.1 Module contract

`moduleContract(key, summary)` turns each area summary into:

```
{ score, score_kind, coverage (share), assessment: {state, blockers, reasons}, systemic: {blockers, posture, escalated_inside_score}, scoring }
```

**Assessment state:**

- `not_scanned`: no result.
- `not_scored`: Platform.
- `withheld`: score null.
- `incomplete`: CMDB gate open with a score.
- `assessed`.

### 15.2 The formula

```
overall = Σ w_i × S_i ÷ Σ w_i      over areas that have a score and weight > 0
DEFAULT_WEIGHTS = { cmdb: 1/3, itom: 1/3, itsm: 1/3, platform: 0 }
```

- A missing area is **dropped and the rest renormalised**. It never counts as 0 or 100.
- The overall is only computed on the All scope when **the scan covered CMDB, ITOM and ITSM**. A module-limited scan carries no overall, so the trend never joins a partial scan to a full one.
- The **composed view** computes it from each module's latest result via the same `overallScope()`.

### 15.3 Health bands (shared with the area cards)

| Band | Min score | Word | Tone |
|---|---|---|---|
| healthy | 90 | Healthy | ok |
| mostly_healthy | 75 | Mostly healthy | ok |
| needs_attention | 50 | Needs attention | warn |
| needs_work | 0 | Needs work | bad |

### 15.4 Status (health vs assessment kept apart)

- **not_scanned:** no area has a result.
- **not_scored:** no scorable area has a result.
- **incomplete:** any scorable area is `incomplete`, `withheld` or `not_scanned`. The word "**Assessment incomplete**" *replaces* the health word, and the reason lists blockers per area (e.g. "3 CMDB blockers · ITSM score withheld").
- **assessed:** the band word.

When the estate is assessed, **attribution** names the scored area in the worst band below the estate's band (e.g. "ITSM needs work").

**Coverage** is the weighted mean of per-area coverage shares. It is **never in the score**:

| Area | Coverage |
|---|---|
| CMDB | measured dimension weight ÷ measurable weight. Dimensions with no built rule are excluded. |
| ITOM | applicable checks ÷ (applicable + read-failed). |
| ITSM | rules with a verdict ÷ (those + rules the instance could have let run: unconfigured params, failed reads, missing capability, thin data). Product gaps are excluded. |
| Platform | tables read in full ÷ (those + tables not read in full). |

**Systemic counts** are summed across areas, and each is counted once:

- blockers = CMDB gate;
- posture = CMDB posture + ITSM Systemic;
- escalated-inside-score = CMDB escalated.

**Scoring key** is a hash of the model, effective weights, coverage definition, status rules, participants and each module's scoring key. A change starts a **new trend series** rather than repainting history.

---

## 16. Scopes — how findings are routed to modules

`scopes.js` holds five scopes: `all` (a view), plus the four **modules** `cmdb`, `itom`, `itsm` and `platform`.

**Routing order** (`scopeOf`), with the same order in SQL (`scopeFilter`) so stored and in-memory results agree:

1. **Rule override** (`RULE_SCOPE`: `PERF-ECC-AGE → itom`).
2. **Rule-id prefix** (`RULE_PREFIXES`):
   - cmdb: `CMDB-`, `REL-`, `CSDM-` (exact `CSDM`)
   - itom: `MID-`, `DISC-`, `CRED-`, `SM-`, `EVENT-`, `OUTAGE-` (exact `SM`)
   - itsm: `ITSM-` (exact `ITSM`)
3. **Domain**:
   - CMDB: CMDB, CMDB_GOVERNANCE, RELATIONSHIP, FRESHNESS, LIFECYCLE, ATTESTATION, OWNERSHIP, CSDM
   - ITOM: DISCOVERY, CREDENTIALS, MID_SERVER, SERVICE_MAPPING, EVENT_MANAGEMENT, AVAILABILITY
   - ITSM: INCIDENT, CHANGE, PROBLEM, ITSM
   - Platform: CUSTOMIZATION, INTEGRATION, PERFORMANCE, UPGRADE, SECURITY
4. **Platform** as the fallback, so a finding never vanishes.

Prefix beats domain. For example, CMDB-124…130 report via `performance_agent` (Platform domain) but belong to CMDB. Skips are routed by `scopeOfRule` so that a rule's findings and its skips always land in the same module.

Each scope summary carries:

- `score`, `score_kind`, `score_basis`, `score_definition`, `score_withheld_because`;
- `checks` (ITOM) and `score_drivers` (top 8 rules by distinct records);
- `findings`, `severity_counts`, `gate` (CMDB and All), `cmdb_quality`, `itsm_quality`, `scoring`;
- `domains` (per agent with counts) and `tables`;
- `assessment`, `coverage_share`, `coverage_detail`, `systemic`;
- on All only: the overall block.

---

## 17. Parameters — every tunable, per module

**Global:**

| Parameter | Value | Where |
|---|---|---|
| staleDays (CMDB-STALE, DISC-STALE) | 90 | `index.js DEFAULT_STALE_DAYS` (part of the engine key) |
| ITSM window | 90 days | `tables.js ITSM_WINDOW_DAYS` |
| ITSM legacy stale | 30 days | `EstateRules.ITSM_STALE_DAYS` |
| Page size / max rows per table | 500 / 100 000 | `extract.js` |
| Reuse max age | 24 h | `incremental.js` |
| Kept runs with findings | 5 | `store.js KEEP_FINDINGS_FOR_RUNS` |
| Abandon an in-flight run | 30 min | `store.js ABANDON_AFTER_MS` |
| Explain limit | 20 findings | `explain.js` |
| Bulk remediation max | 25 | `bulk.js BULK_MAX` |
| Priority thresholds | P1 ≥ 20, P2 ≥ 8 | `rules.js synthesize` |
| Blast radius depth | 3 | `rules.js synthesize` |
| Band weights | 100 / 40 / 15 / 5 / 1 | `cmdb-quality.js BAND_WEIGHT` (shared by ITSM) |
| Overall weights | 1/3 each (Platform 0) | `overall-health.js` |

**CMDB pack defaults.** Every pack takes `options` that override its `*_DEFAULTS`:

| Pack | Key defaults |
|---|---|
| Signals | bcDepth 6 · bcCriticality `/^1\b/` · sharedInfrastructure classes · nonProduction words (development, test, qa, staging, lab, training, demonstration, uat, sandbox) · productionCidrs [] · productionDiscoverySources [] · materiality {escalateRatePct 20, escalateMinCount 10, floorCount 5, floorRatePct 1} · DQ-inactive install_status 7/8/100 |
| Gate (G1) | coverageFloorPct 60 · coverageEscalatePct 40 · staleUpdatedPct 10 · jobTolerance 1.5× interval · healthJobName "CMDB Health" |
| Completeness (G2) | placeholders (12 values + "to be filled" prefix) · networkClasses netgear/computer/appl · physical & financial classes hardware · locationMinDepth 3 · defaultChoiceRatio 80 · impactThresholdPct 90 (CMDB-141) |
| Correctness (G3) | 8 dependency rel types · liveStages Operational · deadStages End of Life/Missing · sourceLagHours 24 · churnChanges 3 / 90 d · signature class min 20, margin 2, best ≥ 0.5, current ≤ 0.25 · numeric ranges (ram ≤ 64 TB, cpu ≤ 4096, cores ≤ 65 536, disk ≤ 1 PB) · nameMinClass 10 · nameDominantPct 60 |
| Uniqueness (G4) | serialMaxFrequency 10 · nameMaxFrequency 5 · genericNames [localhost] · excludedCidrs loopback/link-local/0.0.0.0 · vipCidrs [] · shared-identity classes |
| Identification (G5) | identity attrs (serial, correlation_id, asset_tag, uuid, bios_uuid, object_id) · network attrs · structuralComposite 2 · ireBypassThresholdPct 20 (escalate 40) · creationWindowDays 90 · deadSourceDays 30 · ireErrorPerCreatePct 5 · minTrendRuns 3 |
| Relationships (G6) | collapseDropPct 15 / 30 d · traversalDepth 8 · reachThresholdPct 60 · minServiceMapSize 5 · endpointOrphanBand LOW · hosting types · edgeStaleDays 30 · depth benchmark p75, pass 60% · outlierSigma 3 · minClassPopulation 30 |
| Freshness (G7) | discoveryCoveragePct 85 · scheduleTolerance 2 · untouchedDays 180 · singleSourcePct 60 · manualOnlyPct 25 · importOnlyPct 25 · scriptOnlyDays 180 · bulk-touch 20% / 25% / 25 CIs · activeDiscoveryDays 30 |
| Lifecycle (G8) | retirementBacklogDays 180 · lifecycleAgeDays 365 · retentionDays null · freshnessUnverifiablePct 25 · dead/live/transitional/maintenance stage regexes |
| Governance (G9) | governanceCoveragePct 50 · growthDecile 0.1 · minGrowthCis 25 · certTaskAgeDays 60 · attestationWindowDays 365 · failed/certified result regexes |
| Ownership (G10) | fields owned_by/managed_by/support_group · inferable assigned_to · concentrationPct 20 · serviceDivergenceMinCis 3 · ownershipAgeDays 365 · selfDiscloseAbovePct 80 |
| CSDM (G11) | business/application/capability class lists · traversalDepth 8 · capabilityReachPct 40 |
| Consumption (G12) | incidentServicePct 60 · incidentCiPct 50 · consumptionWindowDays 90 · minConsumptionVolume 30 · taskWindowDays 365 · sparseClassMax 5 · customFieldPopulatedPct 5 · classOverlapPct 70 |
| Scale (G13) | edgesPerCi by tier (hub 6, host 3, app 3, infra 2, endpoint 0, software 0, other 1) · ratioTolerance 0.5 · minCisForRatio 50 · slowTransactionMs 2000 @ p95 · largeClassRows 10 000 |
| Drift (G14) | minRecurrenceSnapshots 2 · minTrendPoints 3 · scoreNoisePoints 1 · bypassNoisePoints 2 · relationshipDeclinePct 5 · attestationCycles 3 |

**ITSM parameters** (`rules/itsm/parameters.json`):

- **108 typed parameters** across the 139 rules. Types: number, percent, duration (with unit), string, list, boolean.
- **61 have a workbook default** and **47 have none**. A rule referencing one of those 47 is **UNCONFIGURED** until someone supplies an instance override.
- Precedence: **workbook default → instance override** (persisted per instance, `PUT /api/health/itsm/parameters/:ruleId/:key`) → **runtime override** (per run, recorded but not part of the engine key).
- Changing a default or override moves the ITSM engine key, which forces a re-read.

---

## 18. How to add a rule

### 18.1 A CMDB catalogue rule

1. **Catalogue:** add an entry to `catalogue/cmdb.json` with `id`, `group`, `base`, `dimension`, `kind`, `track`, `systemicKind` and `intent`, plus the prose fields. This decides severity, scoring route and gate membership. **Code cannot override those.**
2. **Pack:** add the id to the pack's `*_RULES` list (e.g. `COMPLETENESS_RULES`). `IMPLEMENTED_CATALOGUE_RULES` is the union of these lists; that is what makes a dimension count the rule as "built".
3. **Detection:** implement it inside the pack function:
   - gate on `ctx.complete(...)` / `readOk(...)`, and `skip()` with a reason otherwise;
   - apply the false-positive guard;
   - emit via `ctx.addCatalogued(ruleId, table, records, fields, description, {agent, escalators, deEscalators, notEvaluated, confidence, guard, dedupe_key?, …})`, or push a KPI `{rule_id, pass_pct, numerator, denominator, basis}`.
4. If the rule needs a new table or field, add it to `tables.js` (the allow-list) and to the module's `tables` in `scopes.js`. If it needs metadata, add it to `extractCmdbMeta`.
5. **Remediation:** add an entry in `remediation.js REMEDIATION` (headline, problem, why, decision, aiAction, manualSteps, verify, effort). Add `FIX_FIELD` if a field fix is possible.
6. **Dimensions:** map the rule to one or more finding dimensions in `finding-dimensions.js RULE_THEMES`. Otherwise it falls into *Unclassified*.
7. **Tests.** The engine-source hash changes automatically, so every CMDB baseline is re-read on the next scan.

### 18.2 An ITSM catalogue rule

The catalogue is fixed at exactly 139 slots and validated at boot. "Adding" usually means **configuring** an existing slot:

1. Declare its parameters in `rules/itsm/parameters.json`. Use `default: null` / `UNDEFINED` when the workbook states none.
2. Add a config in the right `itsm/rules/<engine>.json`, using `$param`, `$window`, `$clause`, `$choice`, `requires_objects`, `requires_tables`, `variants` and `partial`. It is validated at load: every `$param` must be declared, and every object must be a known placeholder.
3. Declare the `population` semantics (`determinate_when_empty` only when the workbook says an empty population is a pass).
4. A genuinely new rule (ITSM-140) requires changing `ITSM_RULE_COUNT`, the catalogue, the architecture map (same workbook sha) and the status matrix. That is a deliberate, heavy change.

### 18.3 A legacy-style rule (ITOM, Platform, ITSM hygiene)

1. Add a method or block in `rules.js` that calls `this.add(agent, RULE_ID, table, records, evidenceFields, title, description, {severity, confidence, recommendation})`. Read rows with `this.rows(table, requiredFields, {rule})`, which skips automatically on unusable coverage. Use `whenEmpty()` for absence rules.
2. Make sure the rule-id **prefix** routes it to the right module (`RULE_PREFIXES`). For ITOM, add it to an `ITOM_CHECKS` entry's `fails` list, or it will not affect the ITOM score.
3. Add the remediation entry, the dimension mapping and the `LEGACY_RULE_ORIGIN` entry in `rule-catalogue.js`.

---

## 19. Persistence, runs and history

Storage is SQLite (`memory/db.js`). The main tables are `health_runs` (manifest JSON, status, instance key), `health_findings` (one row per finding, evidence as JSON), finding state, proposals, ITSM parameter overrides, table scan settings, and the `health_dimensions` / `health_dimension_rules` pair.

- `openRun` → `completeRun` / `failRun` / `cancelRun`. There is **one run in flight** at a time. Orphans (server restarted mid-run) are marked interrupted after 30 min.
- **All findings of a run are stored.** The earlier 1 000 and 25 000 caps were removed because counted-but-unstored findings could not be listed, muted or exported.
- **Pruning:** findings are kept for the latest **5** runs per instance. Manifests (and therefore trend points) remain.
- `trend()` returns score points per scope. The UI **breaks the line** when the scoring key changes.
- `cmdbMeasureHistory()` / `cmdbHistoryFromRuns()` feed the drift, recurrence and trend rules (G14, D6 collapse, G9 growth), using only comparable snapshots (`MEASURE_COMPARABILITY`).
- `itsmHistoryRuns()` feeds ITSM measure history.
- `moduleResults()` / `composedView()` hold the latest result per module, possibly from different runs, which is how module-limited scans compose into one page.
- Export: CSV for a run or for the composed modules.

Everything is keyed by the **bound instance**. Switching instance switches the data set.

---

## 20. Finding lifecycle

`finding-state.js` stores the states `open`, `acknowledged`, `muted` and `accepted`.

- **Keyed on the fingerprint.** State carries across runs for the same problem on the same records. A new affected record means a new fingerprint, which arrives as a new finding, so muting cannot hide future defects.
- `muted` and `accepted` **require a reason**. An optional `expires_at` snooze reverts to `open` **at read time**; there is no background job.
- **Muting is presentation, not deletion.** Muted findings are still detected, stored, counted and listed. `QUIET_STATES` only affects whether a finding demands attention.
- **Accepted** fingerprints feed back into the rules engine as the `approved_exception` de-escalator, and into the engine key. Accepting a finding therefore changes its reporting band and invalidates reuse, **for that module only**.

---

## 21. Remediation — from finding to approved write

1. **Guidance** (`remediation.js`): `REMEDIATION[ruleId]` holds the headline, problem, why, `decision` (human / auto), `aiAction` (fix / investigate), manual steps, a verify step and an effort estimate (`estimateEffort`, which scales with record count). For ITSM, the guidance comes from the catalogue workbook text via `registerItsmCatalogue`. `buildAgentPrompt` builds the chat prompt for "ask the agent".
2. **Proposal** (`proposal.js`, `proposal-store.js`): `POST /runs/:runId/findings/:fp/proposal` drafts concrete changes, one field value per record, only for rules with a field fix. A human may edit the proposal (`PATCH /proposals/:id`) or reject it.
3. **Approval** (`routes/health.js` + `remediate.js`):
   - Approval is bound to the **proposal fingerprint** that was presented.
   - `prepareRemediation` converts the proposal into a plan through the app's **existing** agent plan pipeline (`generatePlan → savePlan → buildReview`).
   - `runRemediation` executes it (`executePlan`).
   - Every write goes through the mutation pipeline, which reads the record back, and lands in `agent_tasks` for audit. Health Assist has **no executor of its own**.
4. **Validation:** `observeTargets` / `validateRemediation` re-read the target records afterwards and record the outcome.
5. **Bulk** (`bulk.js`): up to 25 findings per bulk proposal/approval. Per-item statuses record what was skipped and why.

---

## 22. LLM explanation

`explain.js explainFindings(findings, {limit: 20})`:

- sends the top findings to the configured model;
- requires a JSON reply;
- `validateReply` drops any entry whose fingerprint is not one of the known findings.

The LLM **cannot create findings or change scores**. If the model is unavailable, the run is marked `partial`, and all deterministic output is unaffected.

---

## 23. Cross-domain links

`cross-domain/links.js` + `links.json` (v1.0.0). Links come only from joins the catalogues already state, and the only effect is `report`. The one link today is **`LINK-ITSM-130-CMDB-058`**: relationship-less CIs that incidents reference, ranked by incident volume, max 200 rows. It joins the relationship-graph engine's `answers_by_ci` with CMDB-058 findings.

A link **never changes** either rule's verdict, severity, priority or any score. It only reports what both rules judged.

---

## 24. Finding Dimensions (classification layer)

This is a presentation layer over findings, added recently:

- **15 built-in dimensions** are defined in code and synced to `health_dimensions`. **Custom dimensions** are global CRUD.
- The mapping is **rule-level** (`RULE_THEMES`: 282 of 325 rules mapped, 83 multi-label). There is no column on `health_findings`; dimension is resolved at read time by SQL subquery (`dimensionClause`). Unmapped rules go to **Unclassified**.
- `matchRules` (catalogue metadata matchers, including `qualityDimension`) and **AI assist** (`dimension-assist.js`) help build custom dimensions. The AI assist sends **catalogue metadata only**, never records, evidence or instance data.
- The layer does not affect scoring, fixes or lifecycle.
- API: `/api/health/dimensions` (canonical) and `/api/health/categories` (deprecated alias). Findings lists accept `?dimension=` (alias `?category=`).
- UI: a page-level **Severity / Dimension / Both** switcher. The Severity view is the original Health Assist UI, unchanged.

---

## 25. API surface

`routes/health.js`, mounted at `/api/health`:

| Area | Endpoints |
|---|---|
| Vocabulary | `GET /meta` (severities, scopes, states, catalogue…) |
| Runs | `POST /runs` (modules, reuse, explain, tables) · `GET /runs` · `GET /runs/active` · `GET /runs/latest` · `GET /runs/:id` · `GET /runs/:id/stream` (SSE) · `POST /runs/:id/cancel` · `DELETE /runs/:id` |
| Findings | `GET /runs/:id/findings` · `GET /runs/:id/findings/:fp` · `GET /runs/:id/findings/:fp/prompt` · `GET /modules` · `GET /modules/findings` |
| Lifecycle | `PATCH /findings/:fp/state` · `DELETE /findings/:fp/state` · `GET /states` |
| Remediation | `POST /runs/:id/findings/:fp/proposal` · `GET /runs/:id/findings/:fp/proposals` · `GET/PATCH /proposals/:id` · `POST /proposals/:id/reject` · `POST /proposals/:id/approve` · `POST /bulk/proposals` · `POST /bulk/approve` |
| Incremental | `GET /scan-state` · `PATCH /scan-state/:table` |
| ITSM params | `GET /itsm/parameters` · `PUT/DELETE /itsm/parameters/:ruleId/:key` |
| Trend & export | `GET /trend` · `GET /modules/export.csv` · `GET /runs/:id/export.csv` |

`routes/health-dimensions.js` (`/api/health/dimensions`): `GET /`, `/rules`, `POST /match`, `/preview`, `/suggest`, and GET / POST / PATCH / DELETE for individual dimensions.

---

## 26. The UI

`client/src/pages/HealthAssist.jsx` (≈2 900 lines) plus `HealthItsm.jsx`, `healthRun.js`, `SeverityDonut.jsx` and the Dimension components.

- **Header:**
  - a Run-scan menu with module checkboxes and a "reuse unchanged modules" toggle (preferences stored in `localStorage` as `nha.healthScan`);
  - a progress stream;
  - the **ScopeSwitch** (All / CMDB / ITOM / ITSM / Platform);
  - the **Severity / Dimension / Both** switcher.
- **Dashboard:**
  - **Overall/area cards** with the band word, or "Assessment incomplete", reason, coverage and Systemic counts;
  - **AreaBars**;
  - the **severity donut** and bars;
  - **Top findings** (TOP_N 10);
  - score drivers;
  - a **Trend** chart (line broken on scoring-key change);
  - **ModuleTimes** (when each module was last read or reused);
  - a **ScanStateCard** (per-table incremental toggles and coverage).
- **CMDB panels:**
  - **TrustVariants** (raw / coverage / gate);
  - **Dimensions** (D1–D10 with record part, KPI part, blend, caveats);
  - **PosturePanel**;
  - **EscalatedBand** (escalated plus patterns);
  - track labels.
- **ITSM tab** (`HealthItsm.jsx`): every catalogue rule's outcome, what it judged and why, its parameters (with inline override editing) and its dependencies, plus cross-domain links.
- **Findings view:**
  - filterable by severity, priority, domain, rule, text search (debounced 300 ms), dimension and muted;
  - paged at 200;
  - per-finding **StateControl** (triage), evidence, remediation guidance, "ask the agent", and proposal / approve / bulk actions.

Every label and threshold (severity words, band words, scopes, states) comes from the server. The client never coins vocabulary.

---

## 27. Design principles that recur everywhere

1. **We did not look ≠ there is nothing there.** `not_requested` and `unavailable` are not zero rows. Absence rules need a complete read.
2. **A score describes only what was read.** Partial tables are excluded and named. If nothing usable is left, the score is withheld with a reason.
3. **Missing data is never unhealthy, and nothing judged is never healthy.** A vacuous pass is inconclusive, and a check with an empty table is not applicable.
4. **Skip, don't guess.** Every rule that can't run records *why*. No invented defaults (ITSM DECISION 3). Placeholder and guard logic prevents floods.
5. **One defect, one charge.** `dedupe_key` for CMDB and defect families for ITSM.
6. **Trust is separate from arithmetic.** The CMDB gate is published as a separate variant, and "Assessment incomplete" replaces the health word.
7. **Comparability keys** on every model. A changed model starts a new series.
8. **Deterministic core, LLM at the edge.** The LLM only writes prose, and its output is validated against known fingerprints.
9. **Read-only by default.** Writes only happen through the approved plan pipeline, bound to a fingerprint.
10. **Pure scoring functions**, reused for live runs and stored runs.

---

## 28. Observations, inconsistencies and risks

These came up while reading the code. None were changed.

1. **Stale comments about the ITSM score.**
   - The `itsm_agent` comment in `rules.js AGENTS` says catalogue findings "do not count toward the ITSM score".
   - `itsm/README.md` says "the eleven hard-coded ITSM rules still produce the ITSM score".
   - Since ITSM Quality (21 Sep 2026), catalogue record/historical/relationship findings **do** charge records, and estate-level rules form the 40% rule part. Only the code is authoritative.
2. **CMDB score drivers use the legacy definition.** `cmdbQualityScore` reports `drivers` from `cmdbScore()` (CMDB-domain findings on `cmdb_ci`, by distinct records), not from the dimension deductions. The drivers list can therefore disagree with what actually moves the composite: it ignores deduction weight, dimension scope and dedupe.
3. **ITOM ignores severity.** A failing check counts the same whether its failing rule is CRITICAL or MEDIUM. For example, `ecc_flowing` failing on a PERF-ECC-AGE item has the same weight as `mid_present` failing. This is by design, but it makes ITOM coarse: nine checks means the score moves in steps of about 11 points.
4. **Equal overall weights.** They are declared as a v1 default with no evidence behind them, but they give a 9-check ITOM score the same pull as the whole CMDB model.
5. **Platform is never in the overall.** That is intended, but an estate with severe security findings (e.g. SEC-INACTIVE-ROLE on admins) can still show "Healthy".
6. **Legacy vs catalogue overlap in CMDB.** CMDB-OWNER, CMDB-STALE and CMDB-DUPLICATE still run beside D9/D7/D3 catalogue rules. They don't deduct in the quality model because they aren't catalogued, but they appear in the list and in the legacy drivers. REL-* rules are correctly skipped as subsumed.
7. **Time-sensitive findings and reuse.** Rules like DISC-STALE, CMDB-STALE and the ITSM age rules change with time alone. The 24 h reuse cap bounds this, but a reused module can be up to 24 h behind a threshold crossing.
8. **`materialityFor` class attribution.** A multi-record finding is attributed to its dominant class only, so records of other classes in the same finding do not count toward their own class's rate.
9. **Single-instance, single-run concurrency.** Only one run can be in flight. Long ITSM catalogue runs block CMDB-only rescans.

---

## 29. Quick-reference numbers

| Item | Value |
|---|---|
| Rule catalogue (unified) | **325** (143 CMDB + 139 ITSM + 43 legacy) |
| CMDB dimensions / weights | 10 · 12/12/14/12/8/16/10/6/6/4 |
| CMDB gating Systemic kinds | config_absence (4 rules), measured_kpi (6) |
| ITSM engines | 10 |
| ITSM parameters | 108 (47 without a default) |
| Allow-listed tables | 66 (2 opt-in) |
| Band weights | Systemic 100 · Critical 40 · High 15 · Moderate 5 · Low 1 |
| CMDB blends | record 70/30 · mixed 60/40 · estate 30/70 |
| ITSM blend | 60/40 (record / estate rules) |
| ITOM checks | 9 |
| Overall weights | CMDB ⅓ · ITOM ⅓ · ITSM ⅓ · Platform 0 |
| Health bands | ≥90 Healthy · ≥75 Mostly healthy · ≥50 Needs attention · <50 Needs work |
| Priority | score = sev × business × dependency × confidence; P1 ≥ 20, P2 ≥ 8 |
| Reuse window | 24 h · stale days 90 · ITSM window 90 d · ITSM stale 30 d |
| Retention | findings for last 5 runs; manifests kept |
