# WI-1 — EXECUTED result: the elevation shim, and the verdict it returns by nonce

Run on `dev442675.service-now.com` (`Australia`), 2026-08-26, as the integration user
`admin` (`6816f79cc0a8016401c5a33be04be441`), which holds `security_admin` **dormantly**
(Gate 0 A1). The shim was invoked through NHA's real trigger path — a one-shot
`sysauto_script` job via `runConfirmedScript` — against a throwaway `sys_security_acl`
probe. The role name was **discovered live** (`discoverElevatableRoles`, 5 elevatable roles
found), never hardcoded.

**Verdict: the primitive is proven, EXECUTED.** In one server-side execution the runner
precondition passed, `GlideSecurityManager` resolved, `gs.hasRole` flipped true, a
`GlideRecordSecure` ACL write landed, it re-read back by sys_id, the structured verdict came
back to NHA keyed by a correlation nonce that matched, and the session de-elevated. The
whole probe was then reverted and its provenance swept, both proven by read-back.

---

## 1. The observed verdict (bound by nonce, CONFIRMED)

```json
{
  "correlation_id": "acdf3bd9085046d0bb66f213e23f1c4b",
  "runner_user": "6816f79cc0a8016401c5a33be04be441",
  "runner_user_name": "admin",
  "runner_has_security_admin": true,
  "reachability_ok": true,
  "elevation_confirmed": true,
  "gr_secure_used": true,
  "target": { "table": "sys_security_acl", "operation": "create" },
  "candidate_sys_id": "1df73e37833a0790b939cc65eeaad3a9",
  "insert_return": "1df73e37833a0790b939cc65eeaad3a9",
  "can_create": true,
  "readback_confirmed": true,
  "before": { "existing_by_marker": 0 },
  "after": {
    "sys_id": "1df73e37833a0790b939cc65eeaad3a9",
    "name": "x_nha_wi1_probe", "operation": "read", "active": "0",
    "description": "WI-1 elevation-shim probe wi1_acdf3bd90850 — throwaway, safe to delete",
    "sys_created_by": "admin"
  },
  "coerced": false,
  "de_elevated": true,
  "error": null
}
```

`liveness: CONFIRMED`, `bound (nonce): true`, `assessment.passed: true`. The
`correlation_id` embedded in the verdict equals the nonce NHA minted for the run — the
second of two independent bindings (the first being the harness sink row keyed by its
token). A verdict whose nonce did not match would be `bound: false` and is never reported
as success (WI-1 stop rule; enforced offline).

**Second transport.** The `candidate_sys_id` re-read over the REST Table API from Node:
present, `name=x_nha_wi1_probe`, `active=false`, `created_by=admin`. Success rested on this
read-back — never on `insert()` (which returns the string `"null"` on a denied secure
write) nor on `canCreate()` (false in both un-elevated attempts in Gate 0, including the one
that persisted).

---

## 2. The chain, link by link

| seam | signal | value |
|---|---|---|
| runner precondition | server-side `sys_user_has_role` (NOT REST — role record is 0 rows over REST) | `runner_has_security_admin: true` |
| reachability guard | `GlideSecurityManager.get()` resolves (Gate 0 A2, re-asserted) | `reachability_ok: true` |
| elevation | `gs.hasRole` after `enableElevatedRole` (the true seam, Gate 0 A3) | `elevation_confirmed: true` |
| gated write | `GlideRecordSecure` **only** | `gr_secure_used: true` |
| persistence | read back by sys_id + REST second transport | `readback_confirmed: true` |
| de-elevation | `gs.hasRole` false after `disableElevatedRole`, in `finally` | `de_elevated: true` |

---

## 3. Revert attestation (withRevert)

The **test** reverts, not the shim. Elevated teardown deleted the probe ACL
(`1df73e37833a0790b939cc65eeaad3a9`) and the **1** `sys_update_xml` row it left, then
counted `left_acls: 0`; a REST read-back on `name=x_nha_wi1_probe` returned `0`. The
teardown's own `deelevated_ok` was `true`. A fresh worker read `has_role: false,
in_get_roles: false` afterward — **no session left elevated**.

> **Finding — reverting a `security_admin`-gated create is ITSELF gated.** The first proof
> run reverted over a plain REST `DELETE` as un-elevated admin; it did **not** land
> (`notFound404: false`, `leftoverProbes: 1`). Deleting a `sys_security_acl` requires
> `security_admin`, which admin holds only dormantly. The fixture now reverts through the
> same elevated server-side channel the shim writes through. This is why Gate 0 swept its
> ACL residue "server-side" rather than over REST.

---

## 4. Completion answers

- **`[A-trigger]` — ESTABLISHED.** NHA's programmatic trigger reproduces Gate 0's elevation
  behaviour because it runs Gate 0's exact source (`buildElevationBody`, embedded verbatim
  and asserted so by an offline test) through Gate 0's exact channel (`sysauto_script`).
  `gs.hasRole` flipped true during and false after; `gs.getUser().hasRole` is not consulted.

- **`[A-result]` — STRUCTURAL → EXECUTED.** The result-capture contract read the verdict
  back deterministically: the durable record is a `sys_user_preference` row named
  `x_2196302_nwforge.exec_harness.<harness-token>` (execution-harness.js:136), and the
  embedded `correlation_id` nonce matched on read-back. No polling-on-guesswork; the client
  reads the verdict per field off one already-parsed payload, never whole-string
  `JSON.parse`.

- **`[A-runner]` — UNVERIFIED, carried forward.** The proof used `admin` (dormant
  `security_admin`). A dedicated integration user with `security_admin` and **no** admin —
  the production runner shape — does not exist on this PDI and was not exercised. The runner
  is configurable and fail-loud (`runnerUserSysId` is required and validated; a runner
  lacking the role returns `elevation_confirmed:false, error:"runner lacks security_admin"`
  and performs no write). Production runner shape remains UNVERIFIED until such a user
  exists.

---

## 5. Trap-ledger entries

```json
{
  "wi1.shim_verdict_contract": {
    "shape": ["correlation_id","runner_user","runner_has_security_admin","reachability_ok",
              "elevation_confirmed","gr_secure_used","target{table,operation}","candidate_sys_id",
              "insert_return","can_create","readback_confirmed","before","after","coerced",
              "de_elevated","error"],
    "rule": "success = readback_confirmed ONLY; candidate_sys_id is a 32-hex insert() return AT MOST and never a success signal; insert()=='null' and non-hex are failure; parse PER FIELD off the harness-parsed payload, never whole-string JSON.parse",
    "tier": "EXECUTED"
  },
  "wi1.result_capture_binding": {
    "record": "sys_user_preference name=x_2196302_nwforge.exec_harness.<token>",
    "bindings": ["harness sink token (sentinel-classified)", "embedded correlation_id nonce re-checked on read-back"],
    "rule": "a nonce mismatch is bound:false and is never reported as success",
    "tier": "EXECUTED"
  },
  "wi1.revert_of_gated_create_is_gated": {
    "fact": "deleting a sys_security_acl over plain REST as un-elevated admin does NOT land (notFound404:false, leftover:1); the delete is a security_admin-gated op",
    "remedy": "revert through the same elevated server-side channel; confirm absence over REST afterward",
    "tier": "EXECUTED"
  },
  "wi1.sys_update_xml_provenance_not_deletion": {
    "rule": "the PRODUCTION shim never deletes sys_update_xml — those rows are legitimate provenance and must be recorded (note sys_update_set is not scope-filtered). Only the WI-1 acceptance test reverts its OWN probe's rows.",
    "measured": "the elevated probe create left exactly 1 sys_update_xml row; the test swept it, 0 left",
    "tier": "EXECUTED"
  }
}
```

---

## 6. What was built

| piece | file:line |
|---|---|
| bounded GlideRecordSecure-only op + read-back | [elevation-shim.js buildBoundedAclOpSource](../server/src/servicenow/elevation-shim.js) |
| shim envelope (runner precond → reachability → proven lifecycle → verdict) | [elevation-shim.js buildShimBody](../server/src/servicenow/elevation-shim.js) |
| probe payload (inactive, role-less, nonexistent table) | [elevation-shim.js buildProbeAclPayload](../server/src/servicenow/elevation-shim.js) |
| result-capture runner + nonce binding + assessment | [elevation-shim.js runElevationShim / assessShim / parseShimVerdict](../server/src/servicenow/elevation-shim.js) |
| embedded proven lifecycle | [role-elevation.js buildElevationBody](../server/src/servicenow/role-elevation.js) |
| result-capture record (sink) | [execution-harness.js:136](../server/src/servicenow/execution-harness.js#L136) |
| trigger path | [execution-harness.js:265](../server/src/servicenow/execution-harness.js#L265) via [script-liveness.js:314](../server/src/servicenow/script-liveness.js#L314) |
| offline invariant tests (+18) | [elevation-shim.test.js](../server/test/elevation-shim.test.js) |

Offline suite: **840 → 858**, all green. The shim is **not** registered in
`server/src/agent/tools.js` — it is invoked only by tests and this proof. Wiring it behind
an approval gate is WI-3.
