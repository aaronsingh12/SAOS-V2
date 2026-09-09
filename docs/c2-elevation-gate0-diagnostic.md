# Gate 0 — C2 elevation feasibility diagnostic (READ-ONLY + one reverted mutation)

Go/no-go for the proposed C2 architecture: a server-side shim that elevates
`security_admin`, performs a `security_admin`-gated mutation, and reads it back in one
instance-side execution.

Run on `dev442675.service-now.com` (`Australia`, `06-12-2026_1106`), 2026-08-26, as the
integration user `admin` (`6816f79cc0a8016401c5a33be04be441`). Every probe classified.
Instance-side facts cite the exact returned values; NHA-side facts cite `file:line`.

**VERDICT: C2 is VIABLE.** H0, H2, H3, H5 all ESTABLISHED. One qualification the design
must absorb as WI-1's first assertion — see §4.

---

## 1. Verdict table

| probe | verdict | evidence |
|---|---|---|
| **A0** channel inventory | ESTABLISHED | NHA's only arbitrary-server-script channel is the one-shot `sysauto_script` job — [execution-harness.js:242](server/src/servicenow/execution-harness.js#L242), created at [:265](server/src/servicenow/execution-harness.js#L265), validated + sentinel-confirmed via [script-liveness.js:314](server/src/servicenow/script-liveness.js#L314). It is **not** a Scripted REST resource. See §4. |
| **A1** integration user role | ESTABLISHED | user `admin`; `sys_user_has_role` server-side shows `security_admin` present, `inherited=0`; `gs.hasRole('security_admin')` = `false` at rest (dormant, as expected) |
| **A2** GlideSecurityManager reach | ESTABLISHED | `typeof GlideSecurityManager` = `function`; `.get()` = `com.glide.sys.security.ContextualSecurityManager@…`; scope `73cd8416…` (global) |
| **A3** activation seam | ESTABLISHED | before: `gs.hasRole`=`false`, `gs.getUser().hasRole`=`false`. After `enableElevatedRole`: `gs.hasRole`=**`true`**, `gs.getUser().hasRole`=**`false`**. After `disableElevatedRole`: `gs.hasRole`=`false`. Session-local, self-reverted, no record touched. |
| **A4** un-elevated read walls | ESTABLISHED (nuanced) | `GET sys_security_acl` limit=1 → **200, 1 row** (readable un-elevated); a specific ACL by sys_id → **visible**; `GET sys_user_role name=security_admin` → **200, 0 rows** (the role record is invisible over REST) |
| **A5** elevated-privilege flag | ESTABLISHED | `sys_dictionary` boolean fields on `sys_user_role`: `can_delegate`, `scoped_admin`, `elevated_privilege`, `grantable`. The flag is **`elevated_privilege`** (label "Elevated privilege"); on `security_admin` its value is `1` |
| **B1a** un-elev, plain `GlideRecord` | ESTABLISHED | `canCreate()`=`false` yet `insert()`=`960e2273…`, **persisted, read back**. Plain GR bypasses ACL enforcement. |
| **B1b** un-elev, `GlideRecordSecure` | ESTABLISHED | `canCreate()`=`false`, `insert()`=**`"null"`**, **not persisted**. A silent no-op — no throw, no row. |
| **B2** elevated, `GlideRecordSecure` | ESTABLISHED | `hasRole`=`true`, `canCreate()`=`true`, `insert()`=`520e2273…`, **persisted, read back**; deleted, absence confirmed on two transports |

All probe records reverted: cleanup deleted both persisted rows (`left: 0`), REST `GET` on
both sys_ids returns 404, and the two `sys_update_xml` rows the ACL inserts left behind
(trap I) were swept server-side (`left_after: 0`). No session left elevated
(`has_security_admin: false` on the shared worker afterward).

---

## 2. Hypothesis roll-up

| H | statement | verdict |
|---|---|---|
| **H0** | NHA can execute arbitrary server-side script in one instance-side execution | **ESTABLISHED** — via `sysauto_script`, not Scripted REST (§4) |
| **H1** | integration user has `security_admin` assigned | **ESTABLISHED** — present on `sys_user_has_role`, direct |
| **H2** | `GlideSecurityManager` reachable from NHA's context | **ESTABLISHED** — global scope, resolves |
| **H3** | after elevation `gs.hasRole` flips true; record the `getUser().hasRole` behavior | **ESTABLISHED** — `gs.hasRole` flips, `gs.getUser().hasRole` does not. Seam identified. |
| **H4** | un-elevated, the user cannot *effectively* create an ACL | **ESTABLISHED, and it depends on the API**: `GlideRecordSecure` no-ops (null); plain `GlideRecord` persists. This is the whole guard story — §5. |
| **H5** | elevated, server-side, the user CAN create an ACL that reads back persisted | **ESTABLISHED** — B2 |
| **H6** | un-elevated read access to ACLs and to the role record | **ESTABLISHED, nuanced**: ACL table readable over REST un-elevated; the `security_admin` role *record* is invisible over REST (0 rows), readable server-side |
| **H7** | the elevated-privilege designator column | **ESTABLISHED** — `elevated_privilege` (discovered from `sys_dictionary`, not assumed) |

---

## 3. C2 decision

**Decision rule: C2 viable ⟺ H0 ∧ H2 ∧ H3 ∧ H5.** All four ESTABLISHED. **C2 is viable.**

The mechanism it depends on is real end to end: NHA can run server-side script in one
execution (H0), reach `GlideSecurityManager` there (H2), flip `security_admin` active and
observe it via `gs.hasRole` (H3), and use that elevation to author an ACL through the
secure API that genuinely persists (H5). The un-elevated secure baseline (B1b) fails
exactly as the design needs it to, which is what makes the elevation load-bearing rather
than decorative.

---

## 4. Residual UNVERIFIED — the one the design must carry

**The channel used was `sysauto_script`, NOT a Scripted REST resource.** NHA has no
Scripted REST resource today (grep of `server/src` finds no `sys_ws_operation` /
`sys_ws_definition` authoring; the only server-script paths are the `sysauto_script`
harness and deferred `sys_script` business-rule creation at
[flows.js:388](server/src/servicenow/flows.js#L388), which is triggered, not
single-request).

Every ESTABLISHED result above was measured inside a `sysauto_script` scheduled-job
execution running as `system`-impersonating-`admin` on a pooled
`glide.scheduler.worker.N`. **Whether `enableElevatedRole` behaves identically inside a
Scripted REST *resource* request — a different execution context, different session
lifecycle, potentially different impersonation posture — is UNVERIFIED.** The C2 design
names a Scripted REST shim specifically, so this is not a footnote:

> **This generalization becomes WI-1's first assertion.** Before building WI-1..WI-5 on a
> Scripted REST resource, WI-1 must re-run A2/A3/B2 from *inside* an actual Scripted REST
> resource and confirm the seam and the persisted write hold there. If C2 is instead built
> on the `sysauto_script` channel already proven here, that step is already green and WI-1
> asserts the channel choice explicitly rather than re-proving it.

Two lesser UNVERIFIED items, neither blocking:

- H1/A1 were measured for `admin`, which holds `security_admin` dormantly. A *dedicated*
  integration user with `security_admin` assigned but no `admin` is the production shape;
  it was not exercised (this PDI has only the admin login). The role-assignment precondition
  is proven for the account NHA actually uses today.
- Elevation persistence across executions is already known FALSE from prior Phase 0 (0.4):
  the role dies at the execution boundary. Re-confirmed here incidentally — the shared
  worker read `has_security_admin: false` after the runs.

---

## 5. Guard implications — what the shim's fail-loud check must catch

The decisive, slightly counter-intuitive result: **un-elevated write behavior is not one
behavior, it is two, and they diverge by API.**

| un-elevated attempt | `canCreate()` | `insert()` | persisted | how a naive shim is fooled |
|---|---|---|---|---|
| `GlideRecordSecure` | `false` | `"null"` | **no** | returns null with no throw — looks like "no row", not "denied" |
| plain `GlideRecord` | `false` | 32-hex sys_id | **yes** | ACL enforcement bypassed entirely — the row lands unelevated |

So the shim must, without exception:

1. **Author only through `GlideRecordSecure`.** Plain `GlideRecord` persists un-elevated
   (B1a), so a shim that used it would author ACLs with elevation contributing nothing, and
   any "elevation worked" claim would be false. Never fall back to plain GR to force a
   green result.
2. **Never trust the `insert()` return, or `canCreate()`, alone.** `canCreate()` was `false`
   in *both* un-elevated attempts including the one that persisted; `insert()` returned
   `"null"` on the secure denial with no exception. Success = **read the row back by sys_id
   on a confirming transport, then confirm cleanup deletes it.** This is the same discipline
   already shipped in [acl-authoring.js `verifyAclLive`](server/src/servicenow/acl-authoring.js)
   and [write-verify.js](server/src/servicenow/write-verify.js).
3. **Assert the seam with `gs.hasRole`, not `gs.getUser().hasRole`.** A3 shows the latter
   never flips — a shim checking it would conclude elevation failed every time and either
   abort a working write or (worse) proceed while reporting the wrong state.
4. **Treat a `GlideRecordSecure.insert()` of `"null"` as a hard DENIAL signal**, distinct
   from a thrown error and from a genuine empty result. It is the shape a blocked secure
   write takes here, and it is silent.

---

## 6. Trap-ledger entries

```json
{
  "gate0.sys_security_acl.write_shapes": {
    "unelevated_GlideRecordSecure": { "canCreate": false, "insert": "null", "persisted": false, "shape": "silent no-op, no throw" },
    "unelevated_GlideRecord_plain":  { "canCreate": false, "insert": "32-hex", "persisted": true,  "shape": "ACL enforcement bypassed" },
    "elevated_GlideRecordSecure":    { "canCreate": true,  "insert": "32-hex", "persisted": true },
    "lesson": "success must be read-back-confirmed; canCreate and insert-return both lie in at least one direction",
    "tier": "EXECUTED"
  },
  "gate0.activation_seam": {
    "gs_hasRole": "flips false->true->false across enable/disable (session-active)",
    "gs_getUser_hasRole": "stays false throughout (user-record roles)",
    "return_values_unusable": "enableElevatedRole undefined, disableElevatedRole 'true'",
    "tier": "EXECUTED"
  },
  "gate0.elevated_privilege_field": {
    "table": "sys_user_role", "field": "elevated_privilege", "label": "Elevated privilege",
    "security_admin_value": "1", "role_record_sys_id": "b2d8f7130a0a0baa5bf52498ecaadeb4",
    "note": "role record invisible over REST (A4b: 0 rows) but readable server-side",
    "tier": "EXECUTED"
  },
  "gate0.trapI_reconfirmed": {
    "fact": "deleting a sys_security_acl leaves its sys_update_xml row; a bare delete does not cascade",
    "remedy_proven_elsewhere": "Phase 4 set-level teardown clears children; here they were swept server-side",
    "tier": "EXECUTED"
  }
}
```

---

## 7. Reversion attestation

- Phase A: zero durable mutation. A3's elevation was session-local and self-reverted
  (`disableElevatedRole` called; `gs.hasRole` read back `false`).
- Phase B: three insert attempts. Two persisted (B1a plain, B2 elevated-secure); B1b never
  persisted. **All reverted** — cleanup deleted both (`left: 0`), REST `GET` on both sys_ids
  returns `404`, and the two `sys_update_xml` residue rows were swept (`left_after: 0`).
- No session left elevated on the shared pool (`has_security_admin: false` post-run).
- No probe record left behind.

Parsing note honored: every script result was read from its own sentinel-confirmed payload
via `runConfirmedScript`, never a whole-string `JSON.parse` over concatenated documents —
the `fix/sysid-provenance` severity-1 shape was not reintroduced.
