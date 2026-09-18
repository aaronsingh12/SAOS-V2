# ITSM Health Checker — Phase 5 report (closure)

Date: 2026-09-17.

- **Authority, unchanged:** `DECISIONS.md` and `catalogue.json` (139 rules), plus
  `parameters.json`, `architecture-map.json` and all 139 rule configurations
  (`health/itsm/rules/*.json`).
- **Design:** `PHASE5-INTEGRATION-DESIGN.md`.
- **Scoring options:** `SCORING-OPTIONS.md`, no model chosen.
- **Matrix:** `phase5-status-matrix.md`.
- **Empty-population audit:** `phase5-empty-population-audit.md`.
- **Instance evidence:** `phase5-instance-validation.json`, from dev424910, read-only,
  anchor 2026-09-17T10:12:46Z.

## 1. Executive Summary

**PHASE 5 COMPLETE.**

**The catalogue runs inside the Health Checker.**
- The teammate's 139-rule ITSM catalogue runs inside every Health Checker scan that reads
  ITSM. Every result reaches the manifest, the store, the API and the page with its rule
  id, status, verdict, blocker, evidence, confidence, finding count and population.
- On dev424910 the integrated run matches the standalone runner rule for rule:
  **139 / 139 compared, Matching 137, Different 2, Explained 2, Unexpected 0.**
- A repeat scan with nothing changed is **reused in 18 s**. A live incident update
  **prevents reuse, naming the table**.

**The closure fixed the one critical defect found during integration.** With no data,
55 rules answered PASS.
- Every engine now declares the population it judged, and the runner decides in one
  place: nothing judged → `inconclusive`, never `pass`, with the reason.
- On the empty fixture 55 passes became 0. On dev424910 four false passes became
  inconclusive; no FAIL, status or finding changed.
- The ITSM score is unchanged.
- Full `npm test` has no new failures.

| Acceptance criterion | State | Evidence |
|---|---|---|
| Live validation: runtime, ITSM runtime, requests, row reads, count / aggregate queries, capability probes, cache hits / misses, statuses, findings, errors | ✓ | §3, §9; `phase5-instance-validation.json` |
| Standalone vs integrated, all 139: IDs, state, verdict, findings, blocker, confidence, evidence, configuration, dependencies | ✓ Unexpected 0 (final run) | §4 |
| Repeat scan reuses unchanged inputs; an ITSM-relevant change prevents reuse; engine-key contract unchanged | ✓ live and in tests | §5 |
| Empty population → not PASS: generic, centralised, evidenced; no automatic FAIL; empty ≠ UNAVAILABLE ≠ UNCONFIGURED | ✓ | §6 |
| All 139 rules audited for empty-population semantics | ✓ | §6.5 |
| Performance vs the Phase 4 baseline; regression analysed; safe optimisation applied, the rest documented | ✓ no integration regression; 426 → 406 requests | §9 |
| Legacy 11: behavioural comparison, factual, nothing deleted | ✓ record-level on dev424910 | §7 |
| Final 139-row matrix | ✓ | §11 |
| API / page / store flow keeps rule ID, verdict, status, blocker, evidence, confidence, finding count | ✓ test through HTTP | §2, §10 |
| Scoring unchanged, score test kept | ✓ | §13 |
| `npm test` and ITSM suites: no new failures, no weakened tests | ✓ | §10 |
| Final read-only PDI validation after the fixes | ✓ run 3, after every code change | §3–§5 |

## 2. What Was Integrated

The catalogue engine now runs inside the Health Checker whenever ITSM is read:
- 139 rules;
- ten engines;
- declarative rule configurations;
- a runner with object / table / field gates, parameter precedence and composite ordering.

Nothing in the catalogue, the rule configurations or DECISIONS.md was changed.

```
POST /runs ─► executeRun: stored overrides → buildParameterRegistry → runHealthCheck({ itsm: { parameters, runtime, rejected } })
runHealthCheck
  engineKeys({ itsmParameters })            ITSM key: declarations + instance overrides + engine versions + itsm source hash
  planScan                                  itsm: table stamps + catalogue read stamps (itsm_stamps) compared
  extractEstate                             incident / change / problem slice for the eleven legacy rules
  [itsm read] countingClient → stampingClient → createEvaluationContext (count memo · read cache · probe cache) → runITSMRules (139)
              normalizeITSMRun → findings (plain copies, fingerprint-deduped), rules[139], skipped, aggregation, degraded
  EstateRules.analyze({ external: { itsm } })  itsm family: legacy 11 + catalogue findings / skips → scopeOf → synthesize
  summariseScopes                           ITSM score from ITSM_SCORED_DOMAINS (the eleven rules) only
  manifest.itsm / itsm_stamps / degraded.itsm
completeRun → health_findings (+ scoring_json kind / detail / itsm) → GET /runs/:id · /modules/findings · finding detail · CSV
```

**Phase 5 build (before the closure)**

- **New:** `health/itsm/integration.js`, `test/health-itsm-integration.test.js`,
  `scripts/itsm-phase5-matrix.mjs`, `PHASE5-INTEGRATION-DESIGN.md`, `SCORING-OPTIONS.md`.
- **Modified:**
  - `health/index.js`: runs the catalogue; `manifest.itsm`; stamps; degraded; facade.
  - `health/rules.js`: `analyze({ external })`; `AGENTS.itsm_agent`.
  - `health/scopes.js`: `RULE_PREFIXES`; the SQL `scopeFilter` mirrors `scopeOf`; `ITSM_SCORED_DOMAINS`.
  - `health/store.js`: `kind` / `detail` / `itsm` in `scoring_json`; parameter overrides; ITSM baseline stamps.
  - `health/incremental.js`: registry-aware engine keys; `stampingClient`; catalogue stamps compared.
  - `health/extract.js`: `FAILED_READ_STATUSES`.
  - `health/cmdb-history.js`: comment only.
  - `routes/health.js`: `/api/health/itsm/parameters`; `itsmParameters` on `POST /runs`.
  - `memory/db.js`: migration 29 `health_itsm_parameters`.
  - The two ITSM READMEs.
- **Tests adjusted:**
  - `health-scopes`, `health-itsm-foundation`, `health-incremental`;
  - the eleven schema-version pins 28 → 29, following the migration-28 precedent.

**This closure (ITSM module only)**

| File | Change |
|---|---|
| `itsm/engines/result.js` | the population contract: `notePopulation`, `withhold`, `UNDETERMINED`, `undeterminedOf` |
| `itsm/runner.js` | `verdictOf` reads the population; `mergeVariants` combines variant populations; an evaluated rule that established nothing carries `undetermined` and a skipped-check entry; `explanation` carries the population |
| `itsm/engines/` aggregate, record-predicate, linkage, reference-integrity, relationship-graph, temporal-correlation, text-analysis, audit-history, configuration, composite | each declares its population (§6.3); engine versions 1.1.0 → 1.2.0, so stored ITSM results are invalidated through the unchanged engine-key contract |
| `itsm/comparators.js` | every comparator declares its population; the `choice_usage` and `all_breach` empty-data cases (§6.3) |
| `itsm/data-access.js` | `countMemo`: one COUNT per (table, query) per run; read-cache hit / miss statistics |
| `itsm/capability.js` | probe-cache hit / miss statistics (behaviour unchanged) |
| `itsm/context.js` | reads and probes share the count memo; `cacheStats()` |
| `itsm/integration.js` | rows carry `population`, `population_empty`, `undetermined`; aggregation `undetermined_by_kind`, `population_empty`, `passes_over_empty_population` (cross-check, must be empty), `passes_determinate_when_empty`; `reconcileStandalone`; `itsm.occurrences` on stored findings; `performance.cache` |
| `health/index.js` | one line: `ctx.cacheStats()` into the performance summary |
| `test/health-itsm-empty-population.test.js` | new, 12 tests (§6.6) |
| `test/health-itsm-phase5-closure.test.js` | new, 7 tests: reconciliation ×3, the store → HTTP API flow, score, reuse, count memo |
| `test/health-itsm-integration.test.js` | the todo and the informational-flag test replaced by one real empty-data test through the scan |
| `test/health-itsm-closure.test.js` | the ITSM-088 assertion — mandated change (§6.6) |
| `scripts/itsm-empty-population-audit.mjs`, `scripts/itsm-phase5-validation.mjs` | new: the audit, and the read-only instance validation |
| `scripts/itsm-phase5-matrix.mjs` | the brief's columns plus population |
| `PHASE5-INTEGRATION-DESIGN.md`, both ITSM READMEs | the contract, the new row / aggregation fields, the cache statistics |

**API additions (additive).**
- **Catalogue rows:** `manifest.itsm.rules[]` gains `population`, `population_empty` and
  `undetermined`.
- **Skipped checks:** `manifest.skipped_checks[]` gains a row for each evaluated rule that
  established nothing (`status: 'evaluated'`, `undetermined: <kind>`).
- **Stored findings:** gain `itsm.occurrences`.
- **Performance:** `manifest.itsm.performance.cache` = `{ reads, probes, counts }`, each
  with its hit / miss counts.

The flow is held by `health-itsm-phase5-closure` FLOW. A real scan is stored, then read
back over HTTP (`GET /runs/:id`, `GET /modules/findings?scope=itsm`,
`GET /runs/:id/findings?rule=…`, `GET /runs/:id/findings/:fp`). The test checks rule id,
status, verdict, classification, blocker, confidence, finding count, population and
`undetermined` for all 139 rows, every catalogue finding per rule, and every finding's
evidence.

## 3. Rule Execution

**The ladder** (design-time classification reproduces Phase 4 exactly: EXECUTABLE 76 ·
UNCONFIGURED 30 · UNAVAILABLE 33 · NOT_IMPLEMENTED 0):

| Catalogue | Implemented | Executable | Configured | Evaluated (estate fixture) | Evaluated (dev424910) |
|---:|---:|---:|---:|---:|---:|
| 139 | 139 | 106 | 76 | 74 | 69 |

**dev424910, final run** (read-only, 10:12–10:34 UTC, 0 stored parameter overrides)

| Measure | Standalone runner | Integrated scan (ITSM module) |
|---|---|---|
| Runtime | 529 s | 710 s wall: extraction 155 s · catalogue 554 s · analyse 32 ms |
| Status | evaluated 69 · unavailable 41 · unconfigured 28 · skipped (input) 1 · error 0 | identical |
| Verdicts | pass 20 · fail 38 · inconclusive 11 | identical |
| Findings | 75 | 73 stored (ITSM-100 and ITSM-103 each had two variants flag the same record — §4) |
| Requests | 406: 246 row queries · 119 counts · 41 aggregates | 406 identical + 30 change stamps |
| Caches | reads 202 declared / 180 distinct (22 hits) · probes 686 asked / 271 distinct (415 hits) · counts 139 asked / 119 distinct (20 hits) | identical |
| Degraded reads / errors | — | none / 0 |

- **Blockers of the 70 non-evaluated rules:** undefined_object 28 · unconfigured_parameter
  27 · capability 6 · undefined_dependency 5 · specification_gap 1 · instance_value 1 ·
  undefined_table 1 · input 1.
- **Severity of the 73 stored findings:** SYSTEMIC 25 · CRITICAL 36 · HIGH 11 · MEDIUM 1.
- **Inconclusive 11:**
  - **no population:** ITSM-014, 088, 139 (empty_population); ITSM-041
    (insufficient_history);
  - **partial detection declared in Phase 4:** ITSM-019, 028, 043, 082, 083, 095, 136.
- **Determinate pass:** ITSM-029, over an empty configuration population the workbook makes
  determinate (§6.2).
- **Passes over nothing judged: none.**

**The integrated scan is `partial`** by the Health Checker's own definition (skipped checks
exist: the non-evaluated catalogue rules). It was `partial` for the same reason before the
closure.

**What the closure changed on dev424910.** Pre-closure run at 07:34 UTC: pass 24 · fail 38
· inconclusive 7. Four verdicts moved, all pass → inconclusive:

| Rule | Population (final run) | Why nothing was established |
|---|---|---|
| ITSM-014: incident custom fields unpopulated | 0 fields with prefix `u_` on incident | empty_population |
| ITSM-041: first-call resolution declining | 27 resolved incidents; 0 recorded windows | insufficient_history (needs 3) |
| ITSM-088: delegation to inactive users | 0 active delegation records | empty_population |
| ITSM-139: KB links to retired articles | 0 incident knowledge links | empty_population |

No FAIL, status, blocker or finding count moved.

## 4. Standalone vs Integrated

`integration.js reconcileStandalone` compares both paths for every catalogue rule:
- presence, status, verdict, blocker;
- finding count and stored findings;
- fingerprints and evidence rows (field by field);
- confidence, population and `undetermined`;
- parameters used (value / source / status);
- every dependency's status and verdict.

A difference is **explained** only by a named mechanism with its evidence; anything else is
**unexpected**. The mechanisms:
- `fingerprint_merge`: two findings of one rule share a fingerprint and are stored once,
  detail and evidence merged, `itsm.occurrences = 2`.
- `population_moved`: live only; the rule's own population total differs between the runs.
- `records_updated`: live only; a change stamp shows a table the rule read was updated after
  the standalone run started and not in the future.

The last two explain data-derived fields only, never status, blocker, parameters or
dependencies.

**Final run (run 3): 139 / 139 compared, Matching 137, Different 2, Explained 2, Unexpected 0.**

| Rule | Difference | Explanation |
|---|---|---|
| ITSM-100: planned dates absent at approval | stored findings 2 → 1 | fingerprint_merge: variants "start_date empty" and "end_date empty" flag the same records; `occurrences: 2` |
| ITSM-103: closure information missing | stored findings 2 → 1 | fingerprint_merge: variants "close_code empty" and "close_notes empty" flag the same records; `occurrences: 2` |

**Live change check.** After both runs, a change stamp was taken on every table the
standalone run read (24 tables). None had records updated since the standalone run started.

**All three closure runs, reported in full:**

| Run (UTC) | Result | Note |
|---|---|---|
| 1 (09:15) | Matching 137 · Different 2 · Explained 2 · Unexpected 0 | the same two merges |
| 2 (09:37) | Matching 136 · Different 3 · Explained 2 · **Unexpected 1** | see below |
| 3 (10:12) | Matching 137 · Different 2 · Explained 2 · Unexpected 0 | final, with the change check |

**Run 2's unexpected difference** was ITSM-037 (backlog ageing): the same 190 evidence rows
on both sides, with different content.
- **Why:** incident records on dev424910 were updated at **09:55:37**, after the standalone
  run had read `incident` (09:37–09:46) and before the integrated scan did (09:46–09:58).
  ITSM-037's evidence includes `sys_updated_on`.
- **Proof it was the instance:** the same run's repeat scan re-read ITSM, naming exactly
  that change ("incident: records updated since the last read (newest change 2026-09-17
  09:55:37)").
- **The response:**
  - reconciliation now reports which evidence fields differ (names only);
  - it explains a record update only with change-stamp evidence on a table the rule read,
    dated after the standalone start and not in the future (future-dated demo values are
    not evidence);
  - offline, or without that evidence, the difference stays unexpected (tested).
- Run 3 then ran on the final code.

**Earlier evidence.** The pre-closure run (07:34) showed 0 differences in status / verdict
/ finding count / blocker.

## 5. Repeat Scan / Cache

**The engine-key contract is unchanged** (DECISION 8). The ITSM key covers:
- rule definitions and configurations;
- the parameter registry (declarations + instance overrides);
- every engine's version and the source of `health/itsm/`;
- dependency edges.

The closure bumped engine versions, and its source changes move the hash, so every stored
ITSM result is re-read once. That is the contract working, not a change to it.

**Reuse on dev424910 (live)**

| Run | Attempt | Plan | Change check | Why |
|---|---|---|---|---|
| 1 | 1 | **verification**, ITSM reused, catalogue not re-run | 13.8 s | nothing changed |
| 2 | 1 | **re-read** (scan, 746 s) | 13.6 s | `incident: records updated since the last read (newest change 2026-09-17 09:55:37)`, for the legacy slice and for the catalogue |
| 2 | 2 | **verification**, baseline = attempt 1 | 16.4 s | nothing changed since |
| 3 | 1 | **verification** | 17.8 s | nothing changed |

- **Unchanged inputs:** reused in 14–18 s, against about 12 minutes to re-read.
- **An ITSM-relevant change:** prevents reuse and names the table. This was observed live,
  on a real incident update the validation did not make. The instance was only read.
- **Observed pattern:** incident records were updated at 07:55:36 (pre-closure run) and
  09:55:37. This looks like a recurring job on the PDI, so a run spanning it cannot be
  reused. That is the correct outcome.

**Tests** (`health-itsm-phase5-closure` REUSE, `health-itsm-integration` CACHING,
`health-incremental`):
- **reused:** an unchanged repeat is a verification and the catalogue is not re-run;
- **re-read, with the reason:**
  - a parameter override ("the rules, settings or accepted risks changed");
  - an incident update;
  - a new change_request;
  - a new row in `task_sla`, a table only the catalogue reads ("task_sla (read by the ITSM
    catalogue): row count moved from 2 to 3").

**Cache layers**, each measured on the final run:
1. **Change stamps:** the 30 tables the catalogue read, stamped before first read, compared
   on the next change check.
2. **Engine key:** as above.
3. **Degraded:** a result built on a FAILED read is never reused (none on dev424910).
4. **Per-run read cache:** 202 declared, 180 distinct, 22 hits.
5. **Capability-probe cache:** 686 asked, 271 distinct, 415 hits.
6. **Count memo (new):** 139 asked, 119 distinct, 20 hits.

## 6. Empty-Data Fix

### 6.1 The defect

With no incidents, problems or changes, the Phase 4 runner answered `pass` for **55
rules**. Examples: an aggregate over 0 / 0, a predicate whose scope matched nothing, a
linkage with no source records, a composite over inputs that had judged nothing. On
dev424910 four rules passed with nothing judged: ITSM-014, 041, 088, 139.

**Root cause.** It sat in one place with two halves:
- **The verdict:** `runner.js verdictOf` returned `pass` for every evaluated result with no
  finding.
- **The populations:** engines did not report what they judged uniformly.
  - Record predicates counted the population only when a ratio was configured.
  - Several engines recorded a kpi only when the denominator was above 0.
  - Minimum-volume and trend guards returned "no finding" and nothing more.

### 6.2 The fix: one contract, one decision point

**The contract** (`engines/result.js`). Every evaluated result declares:
- `population { total, judged, unit, basis }`, via `notePopulation`;
- `undetermined { kind, reason }`, via `withhold`, when an engine withheld its judgement over
  a population that was there.

**The decision** (`runner.js verdictOf` → `undeterminedOf`). An evaluated result with no
finding is `inconclusive`, never `pass`, when:

| kind | when |
|---|---|
| `empty_population` | nothing in scope |
| `nothing_judgeable` | records in scope, none the detection could answer for (hidden fields, unverifiable references, windows not elapsed) |
| `below_minimum_volume` | DECISION 2's small-population guard withheld the judgement |
| `insufficient_history` | a trend without its minimum windows |
| `input_inconclusive` | a composite over an input that established nothing |
| `population_unknown` | the population count itself failed |
| `population_undeclared` | an engine path declared nothing: a fail-safe, reached on neither fixture (contract test) |

**What an empty rule carries.** Through the result, the normalised row, `manifest.itsm`,
the store and the API:
- `population`;
- `population_empty: true`;
- `undetermined { kind, reason, health: 'not established', verdict: 'inconclusive' }`;
- a skipped-check row the page already renders, whose reason ends "…health could not be
  established, so the verdict is inconclusive, not pass".

**What did not change:**
- A finding is still a FAIL. Non-empty meaning is unchanged: the only verdicts that moved
  were passes over nothing judged.
- No automatic FAIL, no fake records, no zero-as-healthy, no invented threshold.
- Empty data stays `evaluated` / `inconclusive`. It is not UNAVAILABLE (the instance could
  not answer) and not UNCONFIGURED (a parameter has no value); a test holds the three apart.

**The one declared exception: ITSM-029** (`rules_referencing_fields`). The workbook's
threshold is "Fires only where routing rules reference the fields".
- **Determinate:** when no active assignment rule references location or department, that
  empty configuration population is the answer (`determinate_when_empty`), so the rule can
  pass.
  - On dev424910 the assignment-rule read returned no such rule; ITSM-029 passes on this
    reading.
  - It is listed separately (`aggregation.passes_determinate_when_empty`), never inside a
    clean total.
- **Not determinate:** once a rule references a field, the records in scope are the
  population again, and empty → inconclusive.

### 6.3 Where each engine declares its population

| Engine / shape | Population (`judged`) | Withheld |
|---|---|---|
| aggregate: measure (share, ratio, %, count, sum, distribution, joint share) | the measure's population (for `average`: records with a value; joint share: primaries at the group minimum) | `insufficient_volume` → below_minimum_volume; every primary below the group minimum |
| aggregate: count ratio | Σ denominators, less groups below `minimum_volume` | every group below the minimum |
| aggregate: trend | this run's denominator | fewer windows than `min_windows` → insufficient_history |
| record_predicate | the rule's SCOPE (`population_query ?? scope`); judged = scope − unevaluable | — |
| linkage | source rows | `minimum_volume` |
| reference_integrity | rows the check could answer for (the kpi denominator) | — |
| relationship_graph | records referencing a CI (the workbook denominator); judged = those whose relationships were read | `minimum_volume` |
| temporal: correlation / before-after / schedule intersection | left rows with key and time / anchors whose after-window elapsed / records with both bounds | — |
| text: similarity / cluster / frequency / pattern scan | rows in scope, including rows refused by the character budget; judged = rows compared | — |
| audit_history | records in scope | — |
| configuration | declared by each comparator (see below) | — |
| composite | the input rules; judged = inputs with a pass / fail verdict | any input inconclusive and no composite finding → input_inconclusive |

**How record predicates count their scope.** They reuse the ratio's count when one is
configured, or use the rows themselves when nothing was pushed down. A separate count
happens only when no offender was found.

**Configuration comparators**, by what each judges:
- **usage records:** `choice_usage`, `dependent_choice_pairs`, `sla_per_band`,
  `lookup_mismatch`, `states_absent_from_sla_conditions`;
- **fields:** `custom_field_population` (a mandatory field counts as judged when the rule
  requires non-mandatory fields);
- **notifications:** `recipients_resolve`;
- **configuration rows:** `rows_where`;
- **a presence check:** `absent`, and `absent_despite_volume` when the object is present;
  when it is absent, the change volume is the population.

**Two narrow changes inside Phase 4 modules** were required so that empty data is never a
FAIL or UNAVAILABLE:
- **`choice_usage` (ITSM-002, 009).** With zero records in the window, every configured
  choice read as "unused": a FAIL built on nothing. Unused choices are now judged only when
  there is usage. On dev424910 both still FAIL over real usage.
- **`all_breach` (ITSM-129).** An input with no rate *because its population was empty*
  made the composite UNAVAILABLE. It is now evaluated / inconclusive. A missing rate for any
  other reason stays UNAVAILABLE.

### 6.4 Verdicts that moved

**Empty fixture** (incident, problem and change_request emptied):
- **55 passes → 0.**
- ITSM-002 and 009 no longer FAIL over zero usage.
- The seven remaining FAILs all judge populations those tables do not hold (ITSM-011, 012,
  033, 085, 088, 121, 139).

**Populated fixture:** 5 passes → inconclusive; nothing else moved. Verdicts went from pass
13 · fail 59 · inconclusive 2 to pass 8 · fail 59 · inconclusive 7:
- ITSM-017: empty_population;
- ITSM-018: nothing_judgeable (the open incident has no group);
- ITSM-041: insufficient_history;
- ITSM-101: empty_population;
- ITSM-134: input_inconclusive (inputs 018 and 101).

**dev424910:** 4 passes → inconclusive (§3).

### 6.5 Audit of all 139 rules

`phase5-empty-population-audit.md` / `.json` is regenerated by
`node scripts/itsm-empty-population-audit.mjs`. The script throws on any pass over nothing
judged, and on any undeclared population.

Every rule was run three ways:
- the populated fixture;
- the same fixture with incident, problem, change_request, task_sla, kb_knowledge,
  m2m_kb_task, sys_user_delegate and sysapproval_approver emptied;
- that emptied fixture with a PLACEHOLDER value for each undefined parameter.

The placeholders exist only in the audit: never a default, never stored, never used by a
scan. They let the UNCONFIGURED rules exercise their engine path too.

| Reading | Rules | Meaning |
|---|---:|---|
| REQUIRES_POPULATION | 95 | empty → inconclusive, with the reason; includes 26 UNCONFIGURED rules exercised with placeholders |
| NOT_EVALUABLE_OFFLINE | 39 | UNAVAILABLE by declaration / undefined object, or still unconfigured: no verdict at all |
| JUDGED_OVER_WHAT_REMAINS | 4 | ITSM-011, 012, 085, 133: FAIL over configuration the emptied tables do not hold |
| DETERMINATE_WHEN_EMPTY | 1 | ITSM-029 (§6.2) |

**Readings recorded, not changed** (§12):
- **ITSM-085** still FAILS when blackout / maintenance schedules are absent, whatever the
  change volume. This is the Phase 4 declared evidence gap ("'Where change volume exists'
  is not gated").
- **ITSM-124 and ITSM-077** are report-only; the workbook gives them no threshold, so they
  cannot FAIL.

### 6.6 Tests

`test/health-itsm-empty-population.test.js`, 12 tests:
- the contract;
- every evaluated result declares a population on both fixtures;
- empty → not pass across all 139, with twenty detection shapes named;
- evidence wording;
- non-empty healthy → pass and unhealthy → fail (predicate, ratio, linkage, reference
  integrity);
- the populated-fixture delta;
- aggregate 0 / 0 and a predicate over zero records on a populated table;
- trend history;
- composites (ITSM-134, and ITSM-129 with its threshold supplied);
- empty ≠ UNAVAILABLE ≠ UNCONFIGURED;
- ITSM-029's determinate reading, including no assignment rule at all;
- catalogue coverage.

Through the scan and the store: `health-itsm-integration` "EMPTY DATA through the scan"
replaces the Phase 5 todo test and the informational-flag test.

**One Phase 4 assertion changed, as the mandated semantic change.**
`health-itsm-closure.test.js` asserted `pass` for ITSM-088 over an empty
`sys_user_delegate`. It now asserts inconclusive / empty_population, and adds a pass over
two healthy delegations and the negative it guards (no false FAIL). No other assertion was
weakened.

## 7. Legacy 11 Comparison

The eleven hard-coded rules keep running unchanged, keep producing the ITSM score, and were
not deleted.

**How it was measured.** Behaviour was compared on dev424910 inside the same integrated
scan (`legacy_comparison` in `phase5-instance-validation.json`):
- **Record-level rules:** the records a legacy rule flagged were compared with the records
  its nearest catalogue rule flagged. Only counts and overlaps are stored.
- **Aggregate rules:** these flag no records, so their measured population and outcome are
  given instead.
- **Stability:** the figures were identical in all three closure runs.
- **Populations differ by construction.** The legacy rules read the extraction slice:
  active, or updated in 90 days (incident 60 · change_request 93 · problem 15). The
  catalogue rules read their own scopes.
- **"Behavior Match":**
  - **Yes:** the same records flagged, or neither flags anything.
  - **Partial:** overlapping records, or the same condition in another unit.
  - **No:** a different outcome.
  - **None:** no catalogue counterpart.

It describes which records each rule flags on this instance, not which rule is better.

| Legacy Rule | New Rule(s) | Behavior Match | Difference | Reason |
|---|---|---|---|---|
| ITSM-INC-UNASSIGNED: open incident, no assignment group (38 records) | ITSM-042: individual assigned, group empty (fail, 11 records); ITSM-018: group with zero active members (pass, 21 of 59 judged) | Partial | ITSM-042's 11 records are all among the legacy 38; the other 27 have no individual either. ITSM-018 flags none of the 38. | ITSM-042 requires `assigned_to` populated; the legacy rule does not. ITSM-018 judges only incidents that have a group (59 − 38 = 21), so an empty group is outside its predicate. |
| ITSM-INC-P1-AGED: open P1 older than 1 day (23) | ITSM-037: backlog ageing per priority (fail; P1 23 · P2 8 · P3 7 records; P4 / P5 UNCONFIGURED) | Yes for P1 on this instance | P1: 23 of 23 identical. ITSM-037 also flags 15 P2 / P3 records the legacy rule does not look at. | Threshold 1 day (legacy) vs the workbook's 2 days (P1); every open P1 here is past both. ITSM-037 covers every priority band. |
| ITSM-INC-STALE: open incident not updated in 30 days (38) | — | None | — | No catalogue rule measures update idleness. |
| ITSM-INC-NO-CI: open incident with neither CI nor service (41 records) | ITSM-016: share of incidents with neither, in 90 days, > 40 % (fail: 19 of 19) | Partial | Legacy: 41 record findings. Catalogue: one estate finding (100 % of 19). Not record-level. | Same predicate; different population (open slice vs incidents created in the 90-day window) and unit (record vs rate). |
| ITSM-INC-REOPENED: reopen_count ≥ 2 (0) | ITSM-030: reopen rate > 8 % by group and close code (pass: 0 of 27 resolved reopened) | Yes (neither flags anything) | — | Per-record repeat reopen vs a rate. |
| ITSM-CHG-STALE: open change not updated in 30 days (89) | — | None | — | No catalogue rule measures update idleness. |
| ITSM-CHG-NO-CI: open change with no CI (17 records) | ITSM-094: share of changes with neither CI nor service > 30 % (pass: 32 of 109 = 29.4 %) | No | Legacy flags 17 records; the catalogue rule passes. | Legacy ignores `business_service` and reads open changes. ITSM-094 counts changes with neither reference across all 109, against the workbook's 30 %. |
| ITSM-CHG-OVERDUE: open change past planned end (68) | ITSM-111: approved change implemented outside its window beyond tolerance (fail, 1 record) | Partial | 1 of 68 overlaps; 67 legacy-only. | Different signal. Legacy: still open after the planned end. ITSM-111: actual work times outside the approved window, only on approved changes with work and planned dates (4 judged). |
| ITSM-CHG-FAILED: closed with close_code `unsuccessful`, in the slice (0) | ITSM-113: success rate < 90 % by type / risk / group (fail: 2 of 15 closed-with-code successful; 7 findings); ITSM-114: failed without backout (UNCONFIGURED: `backout_task_type`) | No | Legacy finds nothing; ITSM-113 fails. | Different predicate and population. Legacy counts the exact value `unsuccessful` in the extraction slice. ITSM-113 measures "Successful" against every closed change with a close code. |
| ITSM-PRB-UNASSIGNED: open problem, no assignment group (12) | ITSM-065: owner empty / inactive / missing, or group with zero active members (pass; owner 15 of 15, group 3 of 15 judged) | No | Legacy flags 12; the catalogue rule passes. | ITSM-065's group variant reports groups with no active members, not empty groups (Phase 4 config `report: ['inactive']`). The 12 problems without a group are exactly the ones it does not judge (15 − 3), and every owner is set and active. |
| ITSM-PRB-STALE: open problem not updated in 30 days (15) | ITSM-061: open > 90 days with no state change (fail, 15); ITSM-056: open > 30 days, never progressed (fail, 15) | Yes on this instance | 15 of 15 identical for both. | Different definitions (update idleness vs no state transition in `sys_audit`, with 90- / 30-day age) that select the same records here. |

**Result on this instance:**
- **Identical:** P1 ageing (ITSM-037, P1 variant) and problem staleness (ITSM-061 / 056).
- **Partial:** unassigned incidents, incidents without a CI, overdue changes.
- **Different outcome:** changes without a CI, failed changes, unassigned problems.
- **No counterpart:** incident and change staleness.
- **Nothing to report on either side:** reopens.

## 8. Configuration

**Precedence (DECISION 4, unchanged).** Workbook default → instance override → runtime
override.
- **Instance overrides:**
  - persisted per bound instance (migration 29);
  - validated against the declaration before storage
    (`PUT /api/health/itsm/parameters/:ruleId/:key`, 422 otherwise);
  - applied to a fresh per-scan registry, and folded into the ITSM engine key only.
- **Runtime overrides:** `POST /runs { itsmParameters }`, validated before the run starts
  (422). They are per run and excluded from the key by design.
- **Refused overrides:** reported as `rejected_overrides`, never applied.
- **Tests:** an instance override makes ITSM-129 EXECUTABLE and evaluated with
  `source: instance`, and moves only the ITSM key.
- **Stored overrides on dev424910:** 0. No value was supplied for any undefined parameter,
  in code, tests or on the instance.

**UNCONFIGURED 30.** A workbook parameter with no default, or a specification gap:
- 008 generic_values · 013 custom_state_values · 022 service_account_pattern + volume_threshold
- 023 volume_share · 024 (specification gap) anomaly_share + minimum_volume_per_category · 025 consistency_rules
- 027 timing_window · 031 autoclose_closed_by · 037 p4_age + p5_age (P1–P3 evaluate)
- 038 manual_creation_query · 040 repeat_count + similarity · 054 cluster_volume + similarity
- 058 similarity · 059 concentration_ratio · 071 root_cause_classification
- 073 alignment_matrix · 074 decline_threshold · 098 risk_bands
- 104 volume_share · 105 scope_depth · 106 correlation_window + object_classes
- 114 backout_task_type · 115 dependency_depth · 126 critical_values + depth
- 127 freeze_schedule_type · 128 close_codes · 129 problem_reference_threshold
- 131 depth_threshold · 133 volume_threshold · 135 dominance_share + minimum_volume_per_ci

**UNAVAILABLE 33.** An object or dependency the workbook and DECISIONS.md leave undefined:
- major_incident: 045–051, 055
- post_incident_review: 047, 052, 078, 092, 122
- approval_routing: 081, 086, 091, 110
- conflict_detection: 084, 118, 138
- standard_change_template: 089, 117
- knowledge_link: 066, 076
- one each: ui_policy / data_policy 010, knowledge_suggestion 015, autoclose_configuration 007, change_model 087, change_calendar 093
- undefined dependencies: 004, 034, 035, 132, 137

**On dev424910** (§3): 28 unconfigured (27 blocked by a parameter, 1 specification gap) and
41 unavailable: the 33 by declaration (undefined object 28, undefined dependency 5), plus
instance capability 6, undefined table 1 and instance value 1. One rule is skipped because
its input did not evaluate.

## 9. Performance

| Run | Instance | Requests | Runtime | Per request |
|---|---|---:|---|---:|
| Phase 4 baseline | dev442675 | 426 | 158 s | ~0.37 s |
| Phase 5, pre-closure (07:34) | dev424910 | 426 (246 query · 139 count · 41 aggregate) | standalone 589 s; integrated 807 s (extraction 218 s, catalogue 589 s) | ~1.38 s |
| Closure run 1 (09:15) | dev424910 | 406 | standalone 515 s; integrated 679 s (130 s + 549 s) | ~1.27 s |
| Closure run 2 (09:37) | dev424910 | 406 | standalone 523 s; integrated 702 s (139 s + 564 s) | ~1.29 s |
| **Closure run 3 (10:12, final)** | dev424910 | **406 (246 query · 119 count · 41 aggregate)** | standalone 529 s; integrated 710 s (155 s + 554 s) | ~1.30 s |

**Is there a regression?** No.
- **Integration adds no rule requests.** The integrated catalogue makes exactly the
  standalone runner's 406 requests.
- **Its only extra cost is 30 change stamps**, about 25–40 s at this latency. They are what
  let a repeat scan take 14–18 s instead of about 12 minutes (§5).
- **Wall-time differences between the Phase 4 baseline and dev424910 are instance latency**
  (0.37 vs ~1.3 s per request) on the same request count, not code. Run-to-run variance
  on dev424910 alone is ±40 s.
- **The empty-data fix added no net requests.** Total requests went 426 → 406. The run
  asked 139 count questions, the same number of counts the pre-closure run issued, and the
  count memo served 20 of them.

**Optimisation applied (safe: shared reads / caching).** `countMemo` asks the instance one
COUNT per (table, query) per run, shared by reads and probes.
- **Why repeats happened:** a rows read counts its query for the total; an `exists` read and
  a capability probe count the same query again under a different key.
- **Saving:** 139 → 119 counts on dev424910 (−20, about 26 s at this latency); 384 → 360
  requests on the fixture.
- **Scope:** only successful counts are kept, and nothing but COUNT is memoised.
- **Cache statistics are now recorded per scan:**
  - reads: 202 / 180 distinct / 22 hits;
  - probes: 686 / 271 / 415;
  - counts: 139 / 119 / 20.

**Profile (final run).**
- **By table:** sys_db_object 94 requests · change_request 67 (was 73) · incident 51
  (was 59) · sys_dictionary 28 · sys_choice 26 · problem 20 · sys_audit 18.
- **Row reads:** change_request 24 reads / 897 rows of a 109-row table; incident 16 reads /
  401 rows of 86.
- **By engine:** configuration 132 s (24 rules) · record_predicate 104 s · reference_integrity
  93 s · aggregate 62 s · audit_history 51 s · temporal 43 s · linkage 42 s · graph 13 s ·
  text 8 s · composite 5 s.
- **Slowest rules:** ITSM-085 27 s · 123 24 s · 120 22 s · 011 22 s · 019 20 s · 056 16 s ·
  109 16 s.

**Documented for the next phase (not safe to change here):**
1. **Batch the capability probes.** `sys_db_object` is 94 requests, asked one table and one
   super-class level at a time. Batching them (`nameIN…`) is estimated to save about 2
   minutes at this latency. It changes Phase 4 `capability.js` semantics, so it needs its
   own tests. Two duplicate `sys_db_object` queries remain on the fixture (the table-chain
   read and a probe use different requirement shapes).
2. **A per-table row cache for small tables** (change_request: 24 reads of 109 rows). It
   needs an in-process encoded-query evaluator with the platform's exact semantics (dates,
   dot-walks, `^OR`, choice values). That cannot be proven equivalent here.
3. **Rule-level concurrency.** The runner is sequential and latency dominates, so a small
   pool could cut wall time several-fold at the same request count. It needs concurrency-safe
   shared builders (`ctx.shared.getOrBuild` awaits before storing), deterministic ordering
   and instance rate limits.
4. **Extraction in an ITSM-only scan reads `cmdb_ci` / `cmdb_rel_ci`** (REQUIRED_TABLES used
   by the shared synthesis), most of the 130–218 s extraction. That is outside the ITSM
   module and was not touched. The catalogue's own CMDB reads stay bounded (DECISION 11).

## 10. Test Results

| Suite | Result |
|---|---|
| `npm test` (full, final code) | **3,701 tests · 3,697 pass · 4 fail · 0 todo.** The 4 failures are the pre-existing, unrelated ones present before Phase 5: "a scope resolves by NAME, and a sys_id is no longer an address", "the chat pins itself by scrolling its own column…", "the managed scope list is what the Applications page flags against", "the registry discovers the fluent workspace and reads its claimed scope". Before the closure: 3,683 · 3,678 pass · 4 fail · 1 todo. |
| `health-itsm-empty-population` (new) | 12 / 12 |
| `health-itsm-phase5-closure` (new) | 7 / 7 |
| `health-itsm-integration` | 15 / 15, 0 todo |
| every other `health-itsm-*` suite, `health-incremental`, `health-scopes` | all pass |

**No test was weakened.**
- The one changed Phase 4 assertion is the mandated empty-population change (§6.6), with
  its negative kept and a positive added.
- The Phase 5 todo became real assertions.
- The score tests are unchanged and pass.

## 11. Final Matrix

`phase5-status-matrix.md` / `.json`, regenerated by `node scripts/itsm-phase5-matrix.mjs`
from the Phase 4 closure matrix, the estate fixture and the final dev424910 run.
- **Reconciliation:** 139 rows for 139 rules; 0 duplicates, 0 missing.
- **Columns:**
  - rule ID and engine;
  - execution status and verdict (with judged / total and why nothing was established);
  - executable;
  - configuration (unresolved keys, else the Phase 4 requirement);
  - dependency;
  - finding count (estate / instance);
  - confidence;
  - evidence;
  - blocker (instance kind and step);
  - instance result.

| | Status | Verdicts | Nothing established | Passes over nothing judged |
|---|---|---|---|---|
| Estate fixture | evaluated 74 · unavailable 38 · unconfigured 26 · skipped 1 | pass 8 · fail 59 · inconclusive 7 | empty_population 2 · nothing_judgeable 1 · insufficient_history 1 · input_inconclusive 1 | none |
| dev424910 | evaluated 69 · unavailable 41 · unconfigured 28 · skipped 1 | pass 20 · fail 38 · inconclusive 11 | empty_population 3 · insufficient_history 1 | none (determinate when empty: ITSM-029) |

## 12. Remaining Issues

**Defects**
- None open in the integration or the empty-data fix.
- **Test infrastructure (pre-existing, recorded, not changed).** `test/helpers/itsm-fake-instance.js`
  splits `^OR` with an anchored regex, so an `a^b^ORc` query matches nothing offline.
  Correcting it could change Phase 4 test outcomes; it needs its own review.

**Configuration gaps** (instance values to supply, no code):
- **30 UNCONFIGURED rules** (§8). The keys are listed with their workbook text at
  `GET /api/health/itsm/parameters`.
- **33 UNAVAILABLE rules** wait on objects the workbook and DECISIONS.md leave undefined
  (§8).
- **ITSM-041 (trend)** needs at least 3 recorded windows. The integrated scan passes the
  runner no ITSM measure history, so the rule stays `inconclusive` (insufficient_history).
  Before the closure it passed without judging a trend. Persisting ITSM measures per
  instance, with a comparability key as CMDB does, is a design decision for the next phase.

**Specification gaps** (decisions, not defects):
1. **ITSM-029 determinate reading** (§6.2): pass when no active assignment rule references
   the fields; dev424910 has none. It follows the workbook threshold; confirm or overrule.
2. **An empty configuration population elsewhere:** ITSM-014 with no `u_` fields on
   incident is `inconclusive`. The workbook does not say an absent custom-field population
   is determinate, so none was assumed.
3. **ITSM-085 volume gate:** absence of blackout / maintenance schedules FAILS whatever the
   change volume (Phase 4 declared evidence gap).
4. **ITSM-124 and ITSM-077 are report-only** (no workbook threshold), so they cannot FAIL.
5. **ITSM-024** (declared specification gap, UNCONFIGURED).
6. **Variant identity:** two variants flagging the same record share a fingerprint and are
   stored once (fixture: ITSM-065, 085; dev424910: ITSM-100, 103). `itsm.occurrences` keeps
   the trace. Whether variants deserve distinct identities is a Phase 4 contract question.
7. **The ITSM scoring model:** `SCORING-OPTIONS.md`, 11 decisions.
8. **The legacy 11:** keep, retire or re-express, with §7 as the evidence.

**Future optimisation:** §9 items 1–4 (probe batching, a per-table row cache, rule-level
concurrency, CMDB extraction in ITSM-only scans).

## 13. Scoring

Unchanged:
- The ITSM score is the eleven hard-coded rules' pass rate over the INCIDENT / CHANGE /
  PROBLEM domains (`scopes.js ITSM_SCORED_DOMAINS`).
- On dev424910: **0.6**, basis "1 of 168 records have no ITSM finding (active, or updated
  in the last 90 days)". That is the same as before the closure.
- No new weights, no severity scoring, no consequence scoping.

Catalogue findings join the ITSM scope's findings and severity counts. The scope shows 414
findings: INCIDENT 140 · CHANGE 174 · PROBLEM 27 · ITSM 73. Catalogue verdicts,
populations and `undetermined` enter no number.

Held by tests:
- `health-itsm-integration` SCORE and `health-itsm-phase5-closure` SCORE: the score, basis
  and drivers equal a recomputation from legacy findings alone.

## 14. Exit State

- **Phase 5: complete.** Every criterion in §1 is met.
- **Nothing committed.**
  - HEAD is `1e82a55` (the user's merge of `ag_ITSM_health_addition`).
  - All Phase 5 and closure work is uncommitted in the working tree, for review.
- **Authority untouched:** `DECISIONS.md`, `catalogue.json`, `parameters.json`,
  `architecture-map.json` and all rule configurations are byte-identical to HEAD (checked
  with `git diff`).
- **Scope:**
  - The closure changed only ITSM files (`health/itsm/`, `health/rules/itsm/`, the ITSM
    tests and scripts), plus one line in `health/index.js` for the ITSM performance
    summary.
  - No CMDB, ITOM, Platform, scoring or UI code was touched.
  - Phase 4 was reopened only for the empty-data defect: the engine population points and
    `choice_usage` / `all_breach` (§6.3).
- **dev424910 was only read:**
  - three closure validations, table reads and change stamps;
  - no ServiceNow writes;
  - no parameter overrides stored;
  - `phase5-instance-validation.json` holds metadata, counts and rule states only (no
    record contents, no sys_ids).
- **Regenerable evidence:**
  - `node scripts/itsm-phase5-validation.mjs` (read-only, about 23 minutes);
  - `node scripts/itsm-phase5-matrix.mjs`;
  - `node scripts/itsm-empty-population-audit.mjs`.
- **Next:** the specification decisions in §12 (ITSM-029 reading, measure history for
  trends, scoring model, legacy 11), then Connections / cross-domain work as planned.
