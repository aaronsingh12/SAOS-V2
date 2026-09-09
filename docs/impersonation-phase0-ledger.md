# Impersonation — Phase 0 probe pack: verdict report and Instance Knowledge Ledger

DISCOVERY ONLY. No product code was written or changed. Every claim below was
measured on the live instance during this run; nothing is quoted from documentation
except the "expected" column, which exists only to locate discrepancies.

---

## 1. Fingerprint (P0.0)

| field | value |
|---|---|
| `TARGET_INSTANCE` | `dev442675` (`https://dev442675.service-now.com`) |
| `SCOPED_APP` | `x_2196302_nwforge` — "NowForge Flows", `sys_scope` `c44f3c6c37c24793be9f8b759c7818e4`, active, v0.0.1 |
| `glide.buildname` | `Australia` |
| `glide.builddate` | `06-12-2026_1106` |
| build tag (`glide.war`) | `glide-australia-02-11-2026__patch3-05-25-2026_06-12-2026_1106.zip` |
| run window (UTC) | 2026-08-25 07:57:18 → 08:45 |
| `ADMIN_SYS_ID` (executor) | `6816f79cc0a8016401c5a33be04be441` |
| executor `user_name` | `admin` ("System Administrator"), `gs.hasRole('admin')` = `true` |
| harness scope | global — `gs.getCurrentApplicationId()` = `73cd84168376c750b939cc65eeaad3ff` |
| execution session | `gs.getSessionID()` = `glide.scheduler.worker.<N>`, N observed 0–7 |

Executor is admin, so the pack's STOP condition did not trigger.

`glide.buildname.full` is **null** on this instance (the property does not exist);
`glide.buildname` + `glide.war` are the readable build identity.

---

## 2. DISCREPANCIES — read these first

Five documented behaviours were contradicted by the instance. Three of them are the
same underlying fact: **inside the global `sysauto_script` harness the session is
already `system` impersonating `admin`, and the platform's impersonation *predicates*
are constants.**

### D-1 — `isImpersonating()` is hardwired `true`, and never flips (P0.0, P0.2, P0.4)

| observation | value |
|---|---|
| at rest, before any impersonation | `true` |
| while impersonating a target | `true` |
| after reverting to admin | `true` |
| `gs.getImpersonatingUserName()` | `"system"` — in all three states, including while impersonating a user |

Expected: `false` at baseline, `true` during, `false` after.

The Rule 2 defensive preamble therefore **fires on every single execution** and is a
no-op: it called `impersonate(ADMIN_SYS_ID)`, which correctly returned
`6816f79cc0a8016401c5a33be04be441`, and `isImpersonating()` stayed `true` afterwards.
Its documented meaning — "if the preamble fires, that is a finding about revert
integrity" — is void here. It fires unconditionally, regardless of leakage.

**The only trustworthy identity signal in this execution context is `gs.getUserID()`**
(corroborated by `gs.hasRole()`, which does follow the impersonated identity).

### D-2 — `canImpersonate()` returns `true` for everything, including a user that does not exist (P0.3)

Every target was resolved by live query in the same execution. `missing_user_name` had
zero candidates on this instance and was not forced.

| case | target `sys_id` | resolved by | `canImpersonate` | expected |
|---|---|---|---|---|
| `active_non_admin` | `555a640583fe0f10b939cc65eeaad3a2` (`aagamya.tanwar`) | active, not in the 19 admin-role holders | **`true`** | true |
| `inactive` | `443193dcd7011200f2d224837e61037d` (`aqib.mushtaq`, `active=0`) | `active=false^user_nameISNOTEMPTY`, 1 row | **`true`** | **false** |
| `self` | `6816f79cc0a8016401c5a33be04be441` | executor | **`true`** | discovery |
| `another_admin` | `353cce0653e7321040e22e1e90f7b435` (`prism-service-user`) | admin-role holder ≠ executor | **`true`** | discovery |
| `nonexistent` | `56b701a783ba4390b939cc65eeaad3b2` | `gs.generateGUID()`, proven `sys_user` rowCount **0** | **`true`** | **false** |
| `missing_user_name` | — | `user_nameISEMPTY` → 0 rows | UNTESTABLE | false |

`canImpersonate` is **not an eligibility gate on this build**. It answered `true` for a
GUID that matches no user at all. Any pre-flight the build performs must be NHA's own
query against `sys_user` (`active`, `user_name` non-empty, role checks) — never this API.

Consequence for **D2**: the admin-target gate is **pure NHA policy**. The platform
permits impersonating admins (`another_admin` → true, `self` → true), so the gate is not
moot, and it is also not enforced by anything but us.

### D-3 — no 'Impersonate Begin' / 'Impersonate End' events are logged (P0.7)

Across every impersonation this run (P0.4, P0.5, P0.5b, P0.6, P0.7, P0.9, P0.10, P0.12 —
dozens of `impersonate()` calls):

- `syslog` where `messageLIKEmpersonat` — **0 rows** in the run window. Searching all
  history returns only Performance Analytics noise, verbatim:
  `Storing collected results for indicator source SC.Impersonation`,
  `Stored 'Value when nil': 0.0 as score for indicator: Impersonations` (source
  `DataCollector`, 2026-08-24) — unrelated to `GlideImpersonate`.
- `sysevent` where `nameLIKEmpersonat` — **0 rows**, ever.
- `sysevent_register` where `nameLIKEmpersonat` — **0 rows**: no such event is even registered.

Expected: both events logged in the system log.

Not proven, but consistent with the evidence: those events are probably emitted by the
*interactive UI* impersonation path only, not by the `GlideImpersonate` API. Either way,
**syslog is not an audit source for API-driven impersonation here.**

### D-4 — `glide.audit.track_impersonation = true` does NOT produce dual identity in `sys_audit` (P0.9)

The property **did not exist** on this instance before the run. It was created with
`value=true`, read back as `true`, and the script confirmed
`gs.getProperty('glide.audit.track_impersonation')` = `"true"` at execution time.

A/B — the same audited insert+update, once as admin and once while impersonating:

| | `sys_audit.user` | `sys_audit.sys_created_by` |
|---|---|---|
| A — as admin, no impersonation | `dfcac12f83ba4390b939cc65eeaad3df` | `admin` |
| B — impersonating `aagamya.tanwar` | `dfcac12f83ba4390b939cc65eeaad3df` (**identical**) | `aagamya.tanwar` |

`sys_audit.user` is declared as `internal_type=string` with an **empty `reference`** — it
is not a user reference. Its value is the same in both arms, does not resolve to any
`sys_user` row, and equals the audit session identifier (it also appears as the
`newvalue` of the `*insert*` audit row).

So the audit trail records **only the impersonated user**, via `sys_created_by`. The
actual performer (`admin`) is **recorded nowhere**. Expected: both identities.

Per §4 of the pack, since the behaviour did not function, the property was **restored to
its prior state (absent)** — read back, 0 rows. **This pack left nothing behind.**

### D-5 — `sys_user_impersonation` does not exist; the table that does exist is empty (P0.8)

- `sys_db_object` where `name=sys_user_impersonation` → **0 rows**. The community-named
  table is absent.
- **`sys_user_impersonation_history`** exists (scope `global`), discovered fields:
  `impersonated_by` (reference), `impersonated_to` (reference),
  `impersonation_start_time` (glide_date_time), `impersonation_end_time` (glide_date_time),
  `session_id` (string), plus `sys_id`/`sys_created_on`/`sys_created_by`/`sys_updated_on`/
  `sys_updated_by`/`sys_mod_count`.
- It contains **0 rows, ever**, and captured **none** of this run's impersonations.
- `sn_vsc_impersonation_event` also exists (Virtual-Agent-scoped) and is not a general log.

Verdict: STRUCTURAL. There is **no structured impersonation audit source on this instance**.
The only durable evidence an impersonated action happened is the attribution on the
record itself — which is exactly the evidence that *hides* the real actor.

---

## 3. Verdict table

| probe | result | tier | key evidence |
|---|---|---|---|
| P0.0 fingerprint | captured; executor is admin | **EXECUTED** | build `Australia` / `06-12-2026_1106`; executor `6816f79c…` = `admin`; baseline `isImpersonating` = `true` (see D-1) |
| P0.1 version gate | Australia ⇒ `AUDIT_FEATURES_EXPECTED = true` | **STRUCTURAL** | derived from `glide.buildname` |
| P0.2 clean baseline | baseline is NOT clean-readable; preamble fires always and clears nothing | **DISCREPANCY** | pre `true` → preamble fired, returned `6816f79c…` → post still `true` |
| P0.3 `canImpersonate` truth table | constant `true`, incl. inactive and nonexistent | **DISCREPANCY** | table in D-2; `missing_user_name` UNTESTABLE (0 rows) |
| P0.4 identity triplet | switch + revert work exactly as documented; the flag does not | **EXECUTED** (mechanism) + **DISCREPANCY** (flag) | before `admin` → during `555a6405…`/`aagamya.tanwar`, `hasRole('admin')` **false** → after `admin`; `impersonate()` returned `6816f79c…` |
| P0.5 GR vs GRSecure | divergence confirmed, large | **EXECUTED** | see §4 |
| P0.6 denied-write shape | silent; no exception in any form | **EXECUTED** | see §5 |
| P0.7 attribution | record shows the impersonated user only | **EXECUTED** | `sys_created_by`/`sys_updated_by` = `aagamya.tanwar`; `opened_by`/`caller_id` = "Aagamya Tanwar" |
| P0.7 Begin/End events | absent | **DISCREPANCY** | D-3 |
| P0.8 structured audit table | `sys_user_impersonation` absent; `…_history` exists, empty | **STRUCTURAL** | D-5 |
| P0.9 `track_impersonation` | enabled and active, dual identity did NOT appear | **DISCREPANCY** | D-4; property restored to absent |
| P0.10 crash-path revert | **no leak past the execution boundary** | **EXECUTED** | see §6 |
| P0.11 scoped-table reach | `SCOPED_APP` owns **zero tables** | **UNTESTABLE** | see §7 |
| P0.12 denial decision table | built, but by predicates — **there are no denial strings** | **EXECUTED** (partial) | see §8; Layer-1-with-data UNTESTABLE |
| P0.13 `sys_db_object` flags | field names + values read | **EXECUTED** (readability) / **STRUCTURAL** (meaning) | see §9; `SCOPED_APP` row UNTESTABLE |
| P0.14 scoped Script Include | not enabled; also moot (`SCOPED_APP` has no Script Includes) | **NOT RUN** | — |

---

## 4. P0.5 — `GlideRecord` vs `GlideRecordSecure` under impersonation

Target `aagamya.tanwar` (`555a640583fe0f10b939cc65eeaad3a2`), verified **0 rows** in
`sys_user_has_role` — a genuinely role-less user. Counts are by **iteration**, capped at 200.

| table | admin plain | admin secure | target plain | **target secure** |
|---|---|---|---|---|
| `sys_properties` | 200 | 200 | 200 | **6** |
| `sys_user_has_role` | 200 | 200 | 200 | **0** |
| `incident` | 73 | 73 | 73 | **0** |
| `sys_audit` | 200 | 200 | 200 | **0** |

Plain `GlideRecord` returns the **admin-equivalent row set** while impersonating.
`GlideRecordSecure` enforces the impersonated user's ACLs. The divergence is exactly as
documented, and it is large. `GlideRecordSecure` is **mandatory** on every impersonated path.

### Trap found here: `GlideRecordSecure.getRowCount()` is unreliable in both directions

On `sys_properties` as the impersonated target, `getRowCount()` returned **0** while
iteration actually yielded **6 readable rows**. Called *before* iterating, it returned the
**unfiltered** count (`73` for `incident`, `3801` for `sys_properties`).

The first run of this probe used `getRowCount()` and reported **"no divergence" — a clean
false pass** on all four tables. Only re-measuring by iteration exposed the truth.

**The build must count impersonated reads by iterating. Never by `getRowCount()`.**

---

## 5. P0.6 — the shape of a denied operation

Fixture: an `incident` created by admin, deleted by admin afterwards (read back: gone).

| operation, as the impersonated role-less user | observed |
|---|---|
| `GlideRecordSecure.get(sys_id)` | returns boolean **`false`** — no exception |
| `GlideRecordSecure` query + `.next()` | **`false`** — the row is simply absent; the update was never reachable |
| persisted change after revert | **none** — `short_description` still the admin value |
| `GlideRecordSecure.insert()` | **SUCCEEDED** — returned `6959056b…`, read back as a real row |
| plain `GlideRecord.get(sys_id)` (same impersonation) | **`true`** — the row came back |
| …while `canRead()` on that same object | **`false`** |
| …and `canWrite()` | **`false`** |

Two things the build must absorb:

1. **A denied write is indistinguishable from "no such row."** There is no exception and
   no falsy update return to key on — the row just isn't in the result set. Only
   **read-back-and-count after reverting to admin** proves what happened. This is the
   WI-1 recurrence shape.
2. **Denied read does not imply denied write.** A role-less user could not *read* an
   incident but could freely *create* one (`canCreate` = `true`, confirmed twice). Do not
   infer write eligibility from read eligibility in either direction.

---

## 6. P0.10 — crash-path revert integrity

The execution session is a **pooled, named scheduler worker** (`glide.scheduler.worker.N`,
N observed 0–7), not a per-execution session — so a leak would land on whatever job ran next
on that worker. That made this probe worth proving rather than assuming.

- **Variant A** (impersonate → `throw` → revert in `finally`): the `finally` ran, identity
  returned to admin.
- **Variant B** (impersonate → `throw` → **no revert**), run last: leaked deliberately on
  `glide.scheduler.worker.1`, having switched to `555a640583fe0f10b939cc65eeaad3a2`.
- Follow-up executions were then run repeatedly until one **landed on that same worker
  session**. On attempt 7, `glide.scheduler.worker.1` reported
  `user = 6816f79cc0a8016401c5a33be04be441`, `name = admin`, `has_admin = true`.

**Verdict: the execution boundary reverts impersonation reliably.** An uncaught throw with
no `finally` did **not** leak into the next execution on the same pooled worker. Crash
safety rests on the **execution boundary**, not on the `finally` — the `finally` is
defence-in-depth for the remainder of the *same* execution, which is still worth keeping.

(An earlier round of follow-ups never landed on the leaking worker and proved nothing; the
verdict above rests only on the run where the session ids match.)

---

## 7. P0.11 — scoped reach: UNTESTABLE

`SCOPED_APP` = `x_2196302_nwforge` contains **20 `sys_hub_flow` records and their flow
metadata — and nothing else**:

- `sys_db_object` where `sys_scope = c44f3c6c…` → **0 tables**
- `sys_script_include` → **0**
- `sys_ws_operation` → **0**, `sys_app_module` → **0**

There is no scoped table to read or write, so M1's scoped reach **cannot be proven or
disproven on this instance today**. This is not a failure — it is a statement that the
capability has no surface here yet. It becomes testable the moment the app owns a table.

P0.14 is moot for the same reason: the app has no Script Includes.

---

## 8. P0.12 — Layer-1 vs Layer-2 decision table

**The pack's central assumption for this probe is wrong: there are no denial strings.**
Every one of the ten operations attempted across both runs returned **without throwing**.
Nothing to capture verbatim, because nothing was ever said.

Measured matrix (iteration-based, cap 20; `aw_record_type_selector` is scoped to
"ITSM Workspace" and holds 9 rows):

| who | API | table | iterated | `canRead` | `canWrite` | `canCreate` | `canDelete` | exception |
|---|---|---|---|---|---|---|---|---|
| admin | plain `GlideRecord` | `aw_record_type_selector` (scoped) | 9 | `true` | `true` | `true` | `true` | none |
| admin | `GlideRecordSecure` | `incident` | 20 | `true` | `true` | `true` | `true` | none |
| target | `GlideRecordSecure` | `incident` | **0** | **`false`** | `false` | **`true`** | `false` | none |
| target | `GlideRecordSecure` | `aw_record_type_selector` | **0** | **`false`** | `false` | `false` | `false` | none |
| target | **plain `GlideRecord`** | `aw_record_type_selector` | **9** | **`false`** | `false` | `false` | `false` | none |
| admin | plain `GlideRecord` | `account_subscription_entitlement` (`caller_access=2`) | 0 | `true` | **`false`** | **`false`** | **`false`** | none |

The decision rule the renderer can actually use — **predicates, not strings**:

| signal | meaning |
|---|---|
| `canRead=true`, `canWrite`/`canCreate`/`canDelete`=`false`, from the global harness | **Layer-1** cross-scope policy: the *table* refuses the operation |
| `canRead=false` while impersonating | **Layer-2** user ACL: *this user* cannot see it |
| `canRead=true` and `canWrite=true` | allowed |

`canRead` is the discriminator: a Layer-1 write-denial leaves `canRead` **true**, whereas a
Layer-2 denial drops it to **false**. So the build can label denials honestly — but it must
read `canRead`/`canWrite`/`canCreate`/`canDelete` **before** the operation, because the
operation itself will never complain.

**Limits of this result, stated plainly:** every `caller_access=2` table on this PDI is
empty (12 scanned, all 0 rows — they are subscription/licensing tables). So Layer-1 was
characterised by its **predicates only**; a Layer-1 denial *against real data* remains
**UNTESTABLE** here. And a global-scope caller is privileged, so Layer-1 read access was
never actually refused — only writes were.

The most dangerous row is the fifth: as the impersonated user, plain `GlideRecord`
**handed back all 9 rows** while `canRead()` on that very object answered `false`.

---

## 9. P0.13 — `sys_db_object` access flags

Discovered field names (verbatim, from `sys_dictionary` where `name=sys_db_object`):

`access` (string, "Accessible from") · `caller_access` (string, "Caller Access") ·
`read_access` (boolean, "Can read") · `create_access` (boolean, "Can create") ·
`update_access` (boolean, "Can update") · `delete_access` (boolean, "Can delete") ·
`configuration_access` (boolean, "Allow configuration") · `alter_access` (boolean,
"Allow new fields") · `actions_access` (boolean, "Allow UI actions") ·
`client_scripts_access` (boolean, "Allow client scripts") · `ws_access` (boolean,
"Allow access to this table via web services") · `create_access_controls` (boolean)

Sample values:

| table | scope | `access` | `caller_access` | read | create | update | delete | config |
|---|---|---|---|---|---|---|---|---|
| `incident` | global | `""` | `""` | `true` | `true` | `true` | **`false`** | `false` |
| `sys_user` | global | `""` | `""` | `true` | `true` | `true` | **`false`** | `false` |
| `account_subscription_entitlement` | (licensing app) | `""` | **`2`** | `true` | — | — | — | — |

**Meaning map — and one correction worth recording:** `incident.delete_access = false`, yet
this pack deleted `incident` records repeatedly, both from the global harness and over REST.
These flags govern **other scopes' code reaching in**; they do not constrain a global-scope
caller or the admin REST session. Reading them as "nobody may delete" would be wrong.

Pre-flight readability is confirmed: the flags are cheap to read over the Table API before
an impersonated operation. Interpretation stays STRUCTURAL — only the `caller_access=2`
write-denial was corroborated behaviourally, and only via predicates.

---

## 10. Verbatim captures

Everything the instance actually said, exactly:

- **Layer-1 denial string:** *none exists.* No exception was thrown in any of the ten
  cross-scope / restricted-table operations attempted.
- **Layer-2 denial string:** *none exists.* Denial shape is:
  `GlideRecordSecure.get(...)` → `false` (boolean); query + `.next()` → `false`;
  iterated row count `0`; `canRead()` → `"false"`. No message, no exception.
- **`sys_audit` performer field:** field name `user`, `internal_type` `string`,
  `reference` empty. Sample value `dfcac12f83ba4390b939cc65eeaad3df` — **identical**
  whether impersonating or not. The impersonated identity appears in `sys_created_by`
  (`aagamya.tanwar`); the real performer appears nowhere.
- **syslog Begin/End format:** *no such messages exist.* The only `impersonat` matches in
  all of syslog: `Storing collected results for indicator source SC.Impersonation` and
  `Stored 'Value when nil': 0.0 as score for indicator: Impersonations`, source
  `DataCollector` — Performance Analytics, unrelated.
- **`gs.getImpersonatingUserName()`** → `"system"` (constant, in every state).
- **`gs.getSessionID()`** → `"glide.scheduler.worker.6"`, `".1"`, `".3"`, `".7"` … (pooled).
- **`sys_user_impersonation_history` fields:** `impersonated_by`, `impersonated_to`,
  `impersonation_start_time`, `impersonation_end_time`, `session_id`.
- **`sys_db_object` access fields:** listed verbatim in §9.
- **NHA harness timeout message** (misleading — see §11):
  `The scheduled job never reported within 120s. It was created and then deleted; nothing
  ran that this harness can account for. On this instance a one-shot job starts within a
  few seconds, so a timeout here means the scheduler is not claiming the job at all.`

---

## 11. New traps found while probing (not anticipated by the pack)

These cost real debugging time this run and belong in `docs/fluent-research.md` §16.

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| A | **A reserved word as an unquoted object key silently prevents the whole job from running** | `sysauto_script` inserts fine, stores byte-identical, `active=true` — and never executes. No syslog row, no error, no partial output | The engine is ES3-era: `{ case: x }` is a syntax error, `{ 'case': x }` is fine. Confirmed by A/B. Quote every reserved word; treat "job never reported" as *suspect the script*, not the scheduler |
| B | **`GlideRecordSecure.getRowCount()` never matches what you can actually read** | before iterating it returns the *unfiltered* count; after iterating it returned `0` where 6 rows were genuinely readable | Count impersonated reads by iterating. This produced a clean false "no divergence" pass in §4 |
| C | **Plain `GlideRecord` hands back rows that `canRead()` denies** | `.get()` → `true` and 9 rows iterate, while `canRead()` on the same object → `false` | Under impersonation, plain `GlideRecord` is a false permission picture. `canRead`/`canWrite`/`canCreate`/`canDelete` are truthful; the data is not |
| D | **The harness's own timeout message misdiagnoses a syntax error** | it blames the scheduler ("not claiming the job at all") for what is a compile failure in the generated script | Trap A is the far likelier cause. The harness cannot currently tell them apart — worth a build-phase fix |
| E | **A killed runner leaks its `sysauto_script`** | the harness deletes the job in a `finally`; if the *Node process* is killed mid-poll, that never runs and the job row survives | Sweep `sysauto_script` by name prefix at the end of a session. One straggler was found and removed this run |

---

## 12. Ledger entries (`imp.*`)

```json
{
  "imp.env.fingerprint": {
    "target_instance": "dev442675",
    "scoped_app": "x_2196302_nwforge",
    "scoped_app_sys_id": "c44f3c6c37c24793be9f8b759c7818e4",
    "buildname": "Australia",
    "builddate": "06-12-2026_1106",
    "build_tag": "glide-australia-02-11-2026__patch3-05-25-2026_06-12-2026_1106.zip",
    "run_datetime_utc": "2026-08-25T07:57:18Z/08:45Z",
    "executor_sys_id": "6816f79cc0a8016401c5a33be04be441",
    "executor_name": "admin",
    "execution_context": "global sysauto_script on pooled glide.scheduler.worker.N",
    "tier": "EXECUTED"
  },
  "imp.env.audit_features_expected": { "value": true, "basis": "buildname=Australia", "tier": "STRUCTURAL" },

  "imp.baseline.clean": {
    "isImpersonating_at_rest": true,
    "expected": false,
    "preamble_fires_every_execution": true,
    "preamble_clears_flag": false,
    "impersonatingUserName_at_rest": "system",
    "reliable_identity_signal": "gs.getUserID()",
    "tier": "DISCREPANCY"
  },

  "imp.eligibility.truth_table": {
    "rows": [
      { "case": "active_non_admin",  "target_sys_id": "555a640583fe0f10b939cc65eeaad3a2", "canImpersonate": true, "tier": "EXECUTED" },
      { "case": "inactive",          "target_sys_id": "443193dcd7011200f2d224837e61037d", "canImpersonate": true, "expected": false, "tier": "DISCREPANCY" },
      { "case": "self",              "target_sys_id": "6816f79cc0a8016401c5a33be04be441", "canImpersonate": true, "tier": "EXECUTED" },
      { "case": "another_admin",     "target_sys_id": "353cce0653e7321040e22e1e90f7b435", "canImpersonate": true, "tier": "EXECUTED" },
      { "case": "nonexistent",       "target_sys_id": "56b701a783ba4390b939cc65eeaad3b2", "sys_user_rowCount": 0, "canImpersonate": true, "expected": false, "tier": "DISCREPANCY" },
      { "case": "missing_user_name", "target_sys_id": null, "reason": "0 rows for user_nameISEMPTY; not forced", "tier": "UNTESTABLE" }
    ],
    "conclusion": "canImpersonate is a constant true and is NOT an eligibility gate. D2's admin gate is pure NHA policy; platform permits admin targets.",
    "tier": "DISCREPANCY"
  },

  "imp.transaction.triplet": {
    "before": { "user": "6816f79cc0a8016401c5a33be04be441", "has_admin": true },
    "during": { "user": "555a640583fe0f10b939cc65eeaad3a2", "name": "aagamya.tanwar", "has_admin": false, "returnedOriginal": "6816f79cc0a8016401c5a33be04be441" },
    "after":  { "user": "6816f79cc0a8016401c5a33be04be441", "has_admin": true },
    "identity_switch_and_revert": "EXECUTED — works exactly as documented",
    "isImpersonating_flag": "DISCREPANCY — true in all three states",
    "tier": "EXECUTED+DISCREPANCY"
  },

  "imp.acl.gr_vs_grsecure": {
    "target": "555a640583fe0f10b939cc65eeaad3a2",
    "target_role_count": 0,
    "measured_by": "iteration, cap 200",
    "tables": [
      { "table": "sys_properties",    "adminCount": 200, "plainCount": 200, "secureCount": 6 },
      { "table": "sys_user_has_role", "adminCount": 200, "plainCount": 200, "secureCount": 0 },
      { "table": "incident",          "adminCount": 73,  "plainCount": 73,  "secureCount": 0 },
      { "table": "sys_audit",         "adminCount": 200, "plainCount": 200, "secureCount": 0 }
    ],
    "getRowCount_unreliable": true,
    "verdict": "divergence confirmed; GlideRecordSecure mandatory; count by iteration only",
    "tier": "EXECUTED"
  },

  "imp.acl.secure_denied_write_shape": {
    "secure_get_return": false,
    "secure_query_next": false,
    "exception_verbatim": null,
    "persisted_boolean": false,
    "secure_insert_on_incident": "SUCCEEDED — role-less user can create",
    "plain_get_return_while_canRead_false": true,
    "verdict": "denial is silent and indistinguishable from 'no such row'; only read-back-as-admin proves outcome",
    "tier": "EXECUTED"
  },

  "imp.attribution.created_by": {
    "sys_created_by": "aagamya.tanwar",
    "sys_updated_by": "aagamya.tanwar",
    "opened_by": "Aagamya Tanwar",
    "caller_id": "Aagamya Tanwar",
    "admin_trace_present": false,
    "tier": "EXECUTED"
  },

  "imp.audit.begin_end_events": {
    "syslog_rows": 0, "sysevent_rows": 0, "sysevent_register_rows": 0,
    "expected": "'Impersonate Begin' and 'Impersonate End' logged",
    "verbatim_unrelated_matches": ["Storing collected results for indicator source SC.Impersonation", "Stored 'Value when nil': 0.0 as score for indicator: Impersonations"],
    "tier": "DISCREPANCY"
  },

  "imp.audit.structured_table": {
    "sys_user_impersonation_exists": false,
    "sys_user_impersonation_history_exists": true,
    "fields": ["impersonated_by", "impersonated_to", "impersonation_start_time", "impersonation_end_time", "session_id"],
    "populated_by_run": false,
    "total_rows_ever": 0,
    "conclusion": "no structured impersonation audit source on this instance",
    "tier": "STRUCTURAL"
  },

  "imp.audit.track_impersonation_verified": {
    "prior_value": "ABSENT — property did not exist",
    "set_to_true": true,
    "seen_by_script": "true",
    "dual_identity_confirmed": false,
    "performer_field_name": "sys_audit.user",
    "performer_field_type": "string, reference empty",
    "sample_verbatim": "dfcac12f83ba4390b939cc65eeaad3df",
    "sample_identical_with_and_without_impersonation": true,
    "restored_to_prior_state": true,
    "tier": "DISCREPANCY"
  },

  "imp.crash.revert_integrity": {
    "session_model": "pooled named worker glide.scheduler.worker.N",
    "variantA_clean": true,
    "variantB_leaked_session": "glide.scheduler.worker.1",
    "followup_landed_on_same_session": true,
    "variantB_clean": true,
    "preamble_fired_after_B": "true, but fires unconditionally — carries no information",
    "conclusion": "execution boundary reverts reliably; finally is defence-in-depth within the same execution",
    "tier": "EXECUTED"
  },

  "imp.scope.scoped_table_reach": {
    "scoped_app": "x_2196302_nwforge",
    "tables_owned": 0,
    "flows_owned": 20,
    "script_includes_owned": 0,
    "reason": "no scoped table exists to operate on",
    "tier": "UNTESTABLE"
  },

  "imp.scope.denial_decision_table": {
    "denial_strings_exist": false,
    "all_operations_returned_without_exception": true,
    "discriminator": "canRead",
    "layer1_signature": { "canRead": true, "canWrite": false, "canCreate": false, "canDelete": false, "exception": null },
    "layer2_signature": { "canRead": false, "canWrite": false, "iterated": 0, "exception": null },
    "allowed_signature": { "canRead": true, "canWrite": true, "iterated": ">0" },
    "plain_gr_under_impersonation": { "iterated": 9, "canRead": false, "note": "returns data it says you may not read" },
    "layer1_against_real_data": "UNTESTABLE — all 12 caller_access=2 tables on this PDI are empty",
    "tier": "EXECUTED (partial)"
  },

  "imp.scope.sys_db_object_flags": {
    "field_names": ["access", "caller_access", "read_access", "create_access", "update_access", "delete_access", "configuration_access", "alter_access", "actions_access", "client_scripts_access", "ws_access", "create_access_controls"],
    "sample_values": {
      "incident": { "sys_scope": "global", "access": "", "caller_access": "", "read_access": true, "create_access": true, "update_access": true, "delete_access": false, "configuration_access": false },
      "account_subscription_entitlement": { "caller_access": "2", "read_access": true }
    },
    "meaning_map": "these govern OTHER scopes' code reaching in; they do not constrain a global-scope caller or the admin REST session — incident.delete_access=false while this pack deleted incidents freely",
    "preflight_readable": true,
    "tier": "EXECUTED (readability) / STRUCTURAL (interpretation)"
  }
}
```

---

## 13. Build implications

1. **`gs.getUserID()` is the only identity authority.** `isImpersonating()` is a constant
   `true` and `gs.getImpersonatingUserName()` a constant `"system"` in the harness context.
   Any guard, assertion, or UI state that reads them is reading a literal. Assert on
   `getUserID()` (and `hasRole`) before and after every impersonated block.
2. **NHA must own eligibility entirely.** `canImpersonate()` approves inactive users and
   GUIDs that match no record. The gate has to be our own query: exists, `active=true`,
   non-empty `user_name`, plus whatever role policy D2 sets. The platform will not stop us.
3. **`GlideRecordSecure` everywhere, and count by iteration.** Plain `GlideRecord` under
   impersonation returns the admin row set — a false permission picture. And
   `getRowCount()` on a secure query lies in both directions; it already produced one false
   pass during this very run.
4. **Writes need read-back-and-count, exactly as WI-1 concluded.** A denied write throws
   nothing, returns nothing falsy, and is shaped identically to "the row does not exist."
   Only re-reading as admin distinguishes them.
5. **Crash safety rests on the execution boundary**, proven against the *same* pooled
   worker session that a deliberate leak ran on. Keep the `finally` for the rest of the
   current execution, but the boundary is the real guarantee.
6. **There is no impersonation audit trail on this instance.** No Begin/End events, no
   structured table, and `track_impersonation` does not add the performer. Every
   impersonated action is attributed *solely* to the impersonated user. If M1 needs an
   audit story, **NHA must write it itself** — the platform will not.
7. **The renderer must label denials from predicates, not messages.** No denial anywhere
   produces a string. Read `canRead`/`canWrite`/`canCreate`/`canDelete` *before* acting;
   `canRead` distinguishes a Layer-1 scope-policy block (stays `true`) from a Layer-2 user
   ACL block (drops to `false`).
8. **Scoped reach is unproven and currently has no surface.** `x_2196302_nwforge` owns 20
   flows and zero tables. Re-run P0.11/P0.14 once the app owns a table.
9. **Fix the harness's silent-syntax-error hole (traps A/D).** A generated script containing
   a reserved word as an object key is stored, marked active, and never runs — and the
   harness blames the scheduler. Since the build generates scripts, this will recur.

---

PHASE 0 COMPLETE — build phases pending human review. No product code changed.
