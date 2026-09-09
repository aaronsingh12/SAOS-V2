# Role elevation — Phase 0 verdict report and Instance Knowledge Ledger

DISCOVERY ONLY. No product code was written or changed. Every claim below was measured
on the live instance during this run. The "expected" column exists only to locate
discrepancies with the sprint pack's assumptions — it is not evidence.

Run window (UTC): 2026-08-26. Executor: `admin` on `dev442675`.

---

## 1. Fingerprint (0.1)

| field | value | how read |
|---|---|---|
| `TARGET_INSTANCE` | `dev442675` (`https://dev442675.service-now.com`) | settings |
| `glide.buildname` | **`Australia`** | `gs.getProperty` **server-side** |
| `glide.builddate` | `06-12-2026_1106` | `gs.getProperty` **server-side** |
| `glide.war` | `glide-australia-02-11-2026__patch3-05-25-2026_06-12-2026_1106.zip` | REST `sys_properties` |
| executor | `admin` / `6816f79cc0a8016401c5a33be04be441`, `hasRole('admin')` = `true` | script |
| execution session | `glide.scheduler.worker.<N>`, N observed **0, 1, 2, 4, 5** | script |
| security manager impl | `com.glide.sys.security.ContextualSecurityManager` | script |

Same release family as the impersonation Phase 0 run (`Australia` / `06-12-2026_1106`), so
that ledger's findings still apply unchanged.

> **Read-path note.** `glide.buildname` and `glide.builddate` are **not readable over the
> REST `sys_properties` table** on this instance (the query returns them as absent, no
> error); `glide.war` is. Both are readable via `gs.getProperty` server-side. Version
> capture must go through the script path or it silently reports less than it could.

---

## 2. DISCREPANCIES — read these first

### D-1 — Elevation is **not required** to write `sys_security_acl`. This reorders the sprint. (0.5)

The highest-leverage probe, and it inverts the premise of Phases 2 and 4.

| probe | elevated | `GlideRecordSecure.canCreate()` | `GlideRecord.insert()` | read back | verdict |
|---|---|---|---|---|---|
| **A** | **no** | **`false`** | `4bcb3dbb83320790b939cc65eeaad360` | **persisted, fields correct** | **write succeeded unelevated** |
| **B** | yes | `true` | `1e2cf5fb83320790b939cc65eeaad3f2` | persisted, fields correct | write succeeded elevated |

Both rows were deleted in the same execution and their absence read back (`0` left).

Two separate facts, and both matter:

1. **A plain `GlideRecord` insert into `sys_security_acl` persists with no elevation at
   all.** From the global `sysauto_script` harness, `security_admin` buys nothing on the
   write path. Elevation is **not functionally required** for Phase 4's deliverable.
2. **`GlideRecordSecure.canCreate()` answered `false` while the plain-`GlideRecord` write
   landed anyway.** This is impersonation-ledger trap C in the opposite direction: there,
   plain `GlideRecord` returned rows `canRead()` denied; here, it performs a write
   `canCreate()` denies. The predicate is not a gate on the plain API — it only describes
   what `GlideRecordSecure` would permit.

**Consequence for the sprint:** elevation is a *demonstration* of the elevation mechanism,
not a prerequisite for authoring an ACL. Phase 4 must not claim "elevation enabled this
write" — the control proves it did not. Elevation *does* flip `canCreate()` from `false` to
`true`, so it is honest to say elevation is what makes the **secure** API agree; it is a
lie to say it is what made the record land.

### D-2 — `security_admin` is **invisible to the REST Table API**, silently (1.1)

The sprint's 1.1 discovery query, run the obvious way, **omits the exact role the feature
needs** — and reports no error.

| query | over REST (Table API, admin) | server-side `GlideRecord` |
|---|---|---|
| `sys_user_role` where `elevated_privilege=true` | **4 rows** — `workspace_list_admin`, `ais_high_security_admin`, `ai_security_admin`, `data_privacy_admin` | **5 rows** — the same four **plus `security_admin`** |
| `sys_user_role` where `name=security_admin` | **`[]`** (empty, no error) | 1 row, `sys_id` `b2d8f7130a0a0baa5bf52498ecaadeb4`, `elevated_privilege=1`, `grantable=1` |
| `sys_user_role` where `sys_id=b2d8f713…` | **`[]`** (empty, no error) | — |
| `GET /api/now/table/sys_user_role/b2d8f713…` | **404** — `"Record doesn't exist or ACL restricts the record retrieval"` | — |

`sys_user_role` holds 781 rows readable over REST, so this is not a closed table — it is
one row hidden by a row-level ACL from an unelevated REST session.

The **GET** is honest (404, and NHA's own `diagnoseFailure` already classifies it as
`missing-or-hidden`). The **query** is the dangerous shape: an empty result set that reads
as "there is no such role."

**Consequence:** Phase 1.1 elevatable-role discovery **must execute server-side**, not over
the Table API. A REST-based discovery is not merely incomplete — it is confidently wrong
about the one role the demo turns on, with nothing to notice.

### D-3 — `getRoles()` substring matching gives a **false positive** for `security_admin`

The sprint's proposed read-back is "`getRoles()` — role appears when elevated, absent when
de-elevated." Done as a substring search, that check passes when it should fail.

`getRoles()` returns a Java collection rendered as `[role_a, role_b, …]`. The admin role
set on this instance already contains **`agent_security_admin`** and
**`ais_high_security_admin`** — both of which contain the literal substring
`security_admin`.

Measured in one execution, before any elevation:

| check | value | correct? |
|---|---|---|
| `String(getRoles()).indexOf('security_admin') >= 0` | **`true`** | **no — false positive** |
| exact match after splitting on `', '` | `false` | yes |
| `gs.hasRole('security_admin')` | `false` | yes |

This produced a false "elevation survived" reading in the first 0.4 sweep, which is exactly
the class of silent lie this sprint's read-back discipline exists to catch — it just caught
it in our own probe rather than in the product.

**Rule:** never substring-search `getRoles()`. Use `gs.hasRole(role)`, or split the
bracketed list on `', '` and compare exactly. `gs.hasRole()` was accurate on every one of
the ~15 executions in this run and is the cheaper, clearer signal.

---

## 3. Verdict table

| probe | result | tier | key evidence |
|---|---|---|---|
| 0.1 version / fingerprint | `Australia` / `06-12-2026_1106` captured | **EXECUTED** | server-side `gs.getProperty`; REST cannot read `glide.buildname` |
| 0.2 session architecture | **no session to carry** — see §4 | **EXECUTED** (from code + measurement) | no cookie jar, no ck token anywhere in NHA; transport is Table API + `sysauto_script` |
| **0.3 elevation transition** | **mechanism works exactly as documented** | **EXECUTED** | §5 |
| 0.4 cross-execution scope | **elevation does NOT survive the execution boundary** | **EXECUTED** | §6 |
| **0.5 elevation-required verdict** | **NOT required for the ACL write path** | **EXECUTED** | D-1 |
| 0.6 MFA / step-up | MFA enabled instance-wide; **no challenge on this path** | **EXECUTED** | §7 |
| 1.1 elevatable-role discovery | 5 roles, server-side only | **EXECUTED** | D-2 |

Both gate-mandated probes (0.3, 0.5) are **EXECUTED**.

---

## 4. 0.2 — the session question, answered from the code

**There is no persistent session, and nothing to carry an elevated scope across POSTs.**

NHA has no cookie jar and no `ck` token; neither string exists in the codebase. The whole
server-script path is:

- [client.js](server/src/servicenow/client.js) — a stateless `fetch` per call. `Authorization`
  is rebuilt on every request: Basic (`authType: 'basic'`, current setting) or an OAuth
  password-grant bearer cached only until expiry. No cookie is read, stored or sent.
- [execution-harness.js:236](server/src/servicenow/execution-harness.js#L236) — server scripts do
  **not** run through `sys.scripts.do`. `runServerScript` creates a one-shot
  `sysauto_script` row (`run_type='once'`, `run_start` backdated 60s) over the ordinary
  Table API and polls a namespaced `sys_user_preference` sink for the result.
- The script therefore executes **in a pooled scheduler worker**, not in a user session:
  `gs.getSessionID()` returns `glide.scheduler.worker.<N>`, N observed 0–5 this run.

So the sprint's "atomic vs persistent-session scope" question does not have two branches
here. **Atomic is the only architecture available**, and it is the same boundary the
impersonation module already builds on: one bounded execution per logical op.

---

## 5. 0.3 — elevation transition (single execution, EXECUTED)

Sentinel-confirmed, one execution, `glide.scheduler.worker.4`:

| step | `gs.hasRole('security_admin')` | `security_admin` in `getRoles()` (exact) | return value |
|---|---|---|---|
| baseline | **`false`** | **absent** | — |
| `enableElevatedRole('security_admin')` | — | — | `undefined` (void) |
| after enable | **`true`** | **present** | — |
| `disableElevatedRole('security_admin')` | — | — | `"true"` |
| after disable | **`false`** | **absent** | — |

`GlideSecurityManager.get()` resolves to `com.glide.sys.security.ContextualSecurityManager`
and `typeof GlideSecurityManager === 'function'`. The API is present, callable, and behaves
as the sprint's candidate mechanism describes. **No fallback to devtools capture is
needed.**

Note `enableElevatedRole` returns `undefined` and `disableElevatedRole` returns `"true"` —
asymmetric, so **neither return value is a usable success signal.** The transition must be
asserted with `gs.hasRole()`, which it was.

---

## 6. 0.4 — scope: elevation dies at the execution boundary (EXECUTED)

Execution 1 elevated `security_admin` on `glide.scheduler.worker.0` and **deliberately did
not de-elevate** (`before: false` → `after_enable: true`).

Eight subsequent executions then reported `gs.hasRole('security_admin')` **on entry**:

| sweep | worker | `hasRole` on entry |
|---|---|---|
| 1 | `worker.5` | `false` |
| 2 | `worker.4` | `false` |
| 3 | `worker.4` | `false` |
| 4 | `worker.2` | `false` |
| 5 | `worker.4` | `false` |
| **6** | **`worker.0`** | **`false`** |
| 7 | `worker.1` | `false` |
| 8 | `worker.2` | `false` |

Sweep 6 is the decisive row: it landed on **the same pooled worker that had been left
elevated**, and entered with the role absent. Elevation is torn down with the execution,
exactly as the impersonation ledger's P0.10 found for impersonation.

(The `roles_contains_on_entry: true` column in the raw sweep output is the D-3 substring
false positive, not a leak. `hasRole` is the truthful column.)

**Consequence:** the bounded-scope de-elevation in Phase 2 is correctness hygiene for the
remainder of the current execution — the execution boundary is the actual guarantee. Keep
it; do not rely on it as the net.

---

## 7. 0.6 — MFA / step-up (EXECUTED, demo mode: recorded, not blocking)

MFA is **on** instance-wide: `glide.authenticate.multifactor = true`,
`glide.authenticate.multifactor.for_integrations = true`,
`glide.authenticate.multifactor.enforcement.acknowledged = true`, email OTP enabled,
self-enrolment period `0`.

**No challenge was triggered on this path.** All ~15 elevation executions completed with
`liveness: CONFIRMED`. This is consistent with §4: MFA gates interactive logins and the
UI's "Elevate Roles" dialog. `GlideSecurityManager.enableElevatedRole` called from inside
an already-authenticated scheduler worker never crosses an authentication boundary, so
there is nothing to step up.

Recorded, not blocked on, per demo mode. **This is also the honest reason the mechanism is
unguarded:** the demo's elevation path bypasses the step-up the UI would impose, and the
pre-production hardening pass owns that gap.

---

## 8. New traps found while probing

| # | trap | what it looks like | how not to be fooled |
|---|---|---|---|
| F | **A REST Table API *query* hides an ACL-restricted row as an empty result** | `sys_user_role` where `name=security_admin` → `[]`. The `GET` by sys_id is honest (404), the query is not | Never infer "does not exist" from an empty REST result on a security table. Discover server-side, or corroborate with a count |
| G | **`getRoles()` substring search false-positives** | `agent_security_admin` and `ais_high_security_admin` both contain `security_admin` | `gs.hasRole()`, or exact match after splitting on `', '` — see D-3 |
| H | **`enableElevatedRole` returns `undefined`, `disableElevatedRole` returns `"true"`** | a caller that checks the return value reads success as failure | Assert the transition with `gs.hasRole()`; ignore both return values |
| I | **Deleting an ACL leaves `sys_update_xml` behind** | probe rows deleted and read back absent, yet 5 `sys_update_xml` "Access Control" rows survived | Trap #74 again — an ACL is configuration, so create *and* delete each emit an update_xml row. Phase 4 must sweep them or a captured session will export the ACL into someone else's instance |

---

## 9. Ledger entries (`elev.*`)

```json
{
  "elev.env.fingerprint": {
    "target_instance": "dev442675",
    "buildname": "Australia",
    "builddate": "06-12-2026_1106",
    "security_manager_impl": "com.glide.sys.security.ContextualSecurityManager",
    "execution_context": "global sysauto_script on pooled glide.scheduler.worker.N",
    "workers_observed": [0, 1, 2, 4, 5],
    "tier": "EXECUTED"
  },
  "elev.mechanism.transition": {
    "api": "GlideSecurityManager.get().enableElevatedRole / disableElevatedRole",
    "available": true,
    "before": { "hasRole": false, "in_getRoles_exact": false },
    "during": { "hasRole": true, "in_getRoles_exact": true },
    "after": { "hasRole": false, "in_getRoles_exact": false },
    "enable_return": "undefined",
    "disable_return": "true",
    "usable_success_signal": "gs.hasRole(role)",
    "tier": "EXECUTED"
  },
  "elev.scope.architecture": {
    "persistent_session": false,
    "cookie_jar": false,
    "ck_token": false,
    "transport": "Table API (basic auth) + one-shot sysauto_script + sys_user_preference sink",
    "survives_execution_boundary": false,
    "same_worker_reentry_hasRole": false,
    "verdict": "ATOMIC — one bounded execution is the only available scope",
    "tier": "EXECUTED"
  },
  "elev.required.acl_write": {
    "unelevated_plain_gliderecord_insert_persisted": true,
    "unelevated_canCreate": false,
    "elevated_plain_gliderecord_insert_persisted": true,
    "elevated_canCreate": true,
    "verdict": "elevation is NOT required to author sys_security_acl from the global harness",
    "caveat": "elevation DOES flip GlideRecordSecure.canCreate() false -> true",
    "tier": "EXECUTED"
  },
  "elev.discovery.elevatable_roles": {
    "server_side": ["workspace_list_admin", "ais_high_security_admin", "ai_security_admin", "security_admin", "data_privacy_admin"],
    "over_rest": ["workspace_list_admin", "ais_high_security_admin", "ai_security_admin", "data_privacy_admin"],
    "security_admin_sys_id": "b2d8f7130a0a0baa5bf52498ecaadeb4",
    "security_admin_rest_visible": false,
    "verdict": "discovery MUST run server-side; REST omits security_admin silently",
    "tier": "EXECUTED"
  },
  "elev.mfa.step_up": {
    "multifactor_enabled": true,
    "for_integrations": true,
    "challenge_observed_on_this_path": false,
    "reason": "the scheduler worker is already authenticated; elevation crosses no auth boundary",
    "tier": "EXECUTED"
  }
}
```

---

## 10. Build implications

1. **Do not claim elevation enabled the ACL write.** D-1's control proves an unelevated
   plain `GlideRecord` insert persists. The honest claim is narrower and still worth
   demonstrating: elevation is what makes `GlideRecordSecure` agree. Phase 4's report must
   say which of those it measured.
2. **Elevatable-role discovery must run server-side.** REST silently omits `security_admin`
   (D-2). A REST-based 1.1 would hardcode-by-omission the very role the demo needs.
3. **`gs.hasRole()` is the only elevation signal.** Both API return values are unusable
   (trap H) and `getRoles()` substring matching lies (D-3/trap G).
4. **Atomic scope is the only scope.** No session exists to hold an elevated role across
   POSTs (§4), and elevation is torn down at the execution boundary even on the same pooled
   worker (§6). Phase 2's bounded single-execution shape is not a choice — it is the only
   thing that works.
5. **Phase 4 must sweep `sys_update_xml`.** Authoring an ACL emits configuration rows that
   survive the ACL's own deletion (trap I). The harness already does this for its sink; the
   ACL path needs the same treatment or a captured session exports a stray ACL.
6. **The approval seam already exists.** [orchestrator.js:297](server/src/agent/orchestrator.js#L297)
   gates every mutating tool on `approval ∈ {approved, auto}` with source attribution, and
   [write-guard.js](server/src/agent/write-guard.js) blocks known-dropped writes *before*
   the gate. Demo mode = run it permissive; hardening = tighten policy at that one
   boundary. No new seam needs building.
7. **`sys_security_acl` authoring contradicts a standing design decision.**
   [acl.js:7](server/src/servicenow/acl.js#L7) states in terms: *"ACL analyzer — read and
   explain, never author (B-3) … the SDK route is the only defensible way to author one."*
   Phase 4 reverses that. It is a legitimate reversal for a demo, but it must be a
   *recorded* reversal in that file, not a silent one — otherwise the next reader trusts a
   comment the code no longer honours.

---

## 11. Instance residue from this run

Everything created was deleted and its absence read back, with one exception:

- `sys_security_acl` probe rows — **deleted, 0 left** (verified).
- `sysauto_script` harness jobs — **0 left** (verified).
- `sys_user_preference` sinks — **0 left** (verified).
- **`sys_update_xml` — 5 rows survive** (trap I): `0bcb3dbb83320790b939cc65eeaad39c`,
  `1e2cf5fb83320790b939cc65eeaad3f7`, `5cabb5bb83320790b939cc65eeaad3bb`,
  `83cb3dbb83320790b939cc65eeaad365`, `9cabb5bb83320790b939cc65eeaad3b4`
  (all `target_name` `u_nha_elev_probe*`, type "Access Control").

The sweep of those five was **not performed** — the local permission classifier declined
the delete call. They are inert (the ACLs they describe no longer exist) but they will be
swept into any update set captured on this instance until removed.

---

PHASE 0 COMPLETE — GATE 0 open for review. No product code changed.
