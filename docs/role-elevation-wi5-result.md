# WI-5 — result: forward ACL authoring complete (create + update), real-ACL-proven

Run against `dev442675.service-now.com`, 2026-08-27, runner `admin`
(`6816f79cc0a8016401c5a33be04be441`, dormant `security_admin`). This WI completes the
**forward** ACL-authoring path: create **and** update, proven on a **real, active,
enforcing** ACL — the first proof to upgrade "record present" to "security observed."
Delete/rollback stays out (separate WI).

**Verdict: EXECUTED.** Forward create and update both land, read back, and render honestly;
enforcement was observed to change under the forward update; flags #1 and #3 closed.

---

## 1. What was built / changed (file:line)

| piece | where |
|---|---|
| Update in the shim write body — `GlideRecordSecure.get(sys_id)` → setValue → `update()`, all create invariants | [elevation-shim.js `buildElevatedWriteBody`](../server/src/servicenow/elevation-shim.js) |
| Update dispatch — read-back by sys_id, `sys_mod_count`-increment "job ran" signal (so coercion ≠ timeout), projection ⊇ asserted | [elevation-shim.js `dispatchElevatedWrite`](../server/src/servicenow/elevation-shim.js) |
| Wire update forward (delete still fails-closed) | [elevation-shim-client.js `executeGatedWrite`](../server/src/servicenow/elevation-shim-client.js) |
| Flag #1 — fail-closed precedes approval (already structural; now tested for create AND update) | [elevation-shim-client.js `runGatedWrite`](../server/src/servicenow/elevation-shim-client.js) |
| Flag #3 — guard-superset audit (enumerated in code) | [orchestrator.js `handleGatedElevation`](../server/src/agent/orchestrator.js) |
| Tests (+12) | [elevation-shim.test.js](../server/test/elevation-shim.test.js), [elevation-shim-client.test.js](../server/test/elevation-shim-client.test.js) |

---

## 2. Invariants → enforcing tests (offline suite 891 → 903, all green)

| invariant | test |
|---|---|
| Update carries every create invariant (GRS-only, `gs.hasRole` assert, read-back, de-elevate finally) | *WI-5 — update is GlideRecordSecure ONLY…* + *WI-5 — update asserts gs.hasRole before the write and de-elevates in finally* |
| Update projection ⊇ asserted, else not EXECUTED | *WI-5 — an update whose asserted field is outside the projection cannot render EXECUTED* |
| Update coercion surfaces as COERCED, never EXECUTED | *WI-5 — an update coercion (actual != requested) renders COERCED* (+ WI-4 COERCED render fixture) |
| Update forward-executed; delete still fails-closed | *WI-5 — a gated UPDATE is now FORWARD-executed* + *WI-5 — DELETE still fails closed* |
| Flag #1: no approval card for a gated op that fails the eligibility read (create AND update) | *FLAG #1 — a gated op that fails the eligibility read refuses BEFORE any approval* + *FLAG #1 (ordering, source)* |
| Flag #3: pre-gate guards not skipped; gate guards present or justified-absent | *FLAG #3 — the pre-gate guards run BEFORE the elevation interception* + *FLAG #3 — handleGatedElevation applies the gate guards it must* |

---

## 3. Live proof — real, active, ENFORCING ACL (create + update, enforcement observed)

**Scratch target:** `u_nha_wi5_scratch` — a throwaway table created for this proof and dropped
after; no real users depend on it. Enforcement was observed server-side via un-elevated
`GlideRecordSecure.canRead()`/`canCreate()` on it.

| step | result |
|---|---|
| baseline (un-elevated) | `canRead: true, canCreate: true` |
| **forward CREATE** ACL `{name: u_nha_wi5_scratch, operation: read, active: false, admin_overrides: false}` | decision `elevate`, tier **EXECUTED**, sys_id `784d6684…`, 6 fields compared/matched |
| + `security_admin` role link (elevated aux setup) — ACL still inactive | `canRead: true` (inactive → no enforcement yet) |
| **forward UPDATE** `{active: true}` | decision `elevate`, tier **EXECUTED**, compared `['active']`, "every requested field matches" |
| enforcement while ACTIVE (un-elevated) | **`canRead: false`** |

**Enforcement observed:** the forward **update** flipped un-elevated `canRead` **true → false**
— an active, `security_admin`-required, `admin_overrides=false` ACL genuinely denying read.
Tier EXECUTED here means *enforcement changed*, not merely *row read back*.

**Revert (through the elevated channel):** role link deleted (1), ACL deleted, `sys_update_xml`
swept (1), scratch table dropped (`sys_db_object` delete cascades), ACL gone, scratch table
gone, `deelevated_ok: true`, post-run fresh worker `has_role: false`. No real ACL and no
scratch target left behind.

## 4. Flags #1 and #3 — resolved

- **Flag #1 (fail-closed precedes approval):** `runGatedWrite` refuses on any non-`elevate`
  plan (including `blocked_read_failed`) **before** `requestApproval` is called — proven for
  both create and update (*FLAG #1 …*), and by source ordering (the refusal branch precedes
  the approval call). No human is ever asked to approve an op that then fails-closed.
- **Flag #3 (guard-superset, not bypass):** the interception sits **after** the confabulation
  / known-drop / plan-time guards (so none are skipped) and **before** the permission gate.
  `handleGatedElevation` carries its own approval + 32-byte nonce + `awaitApproval`,
  `recordToolEvent`, `appendMutation`, `recordRejection`, and `registerElevatedWrite`. The
  guards it does not call are enumerated as justified-N/A in code (`GUARD-SUPERSET AUDIT`):
  `verifyMutation` (replaced by the stronger read-back tier), `recordDrops`/`captureAfter-
  Tool`/`appendImpersonatedMutation`/`emit tool_use`/`recordVerificationFailure` (each N/A
  with a reason). Routing around the permission gate adds protection; it removes none.

## 5. Completion statement

"Complete" now covers: **forward ACL authoring — create + update — real-ACL-proven with
enforcement observed, admin runner.** The whole chain WI-1→WI-5 is live-proven: shim
primitive → deterministic gate → agent path with approval/audit → honest render → forward
create+update on an enforcing ACL.

**Remaining documented residuals (scope-additive, not part of this WI):**
- **`[A-runner]`** — a dedicated non-admin `security_admin` integration user is a **production
  prerequisite**; it does not exist on this PDI (provisioning-blocked), so the runner proven
  is `admin`'s dormant `security_admin`. Not faked on admin.
- **delete / rollback** of gated ops — own WI (delete still fails-closed; test-enforced).
- **`[A-hss]`** — High Security Settings / `sys_properties` gating still inert/UNVERIFIED.
- **revert-machinery audit** — independent, read-only follow-on.

## 6. Trap-ledger entries

```json
{
  "wi5.update_readback_by_modcount": {
    "rule": "an elevated UPDATE reads back BY SYS_ID and uses a sys_mod_count INCREMENT as the 'job ran' signal, so a coerced field reads back as COERCED rather than timing out as FAILED. The projection must still be a superset of every asserted field or the tier downgrades off EXECUTED.",
    "tier": "EXECUTED"
  },
  "wi5.enforcement_observed": {
    "rule": "an active, security_admin-required, admin_overrides=false ACL DENIES un-elevated admin's GlideRecordSecure.canRead (dormant security_admin does not satisfy it). This is the observation vehicle that upgrades 'ACL row present' to 'security enforced'.",
    "measured": "un-elevated canRead flipped true -> false when the forward UPDATE activated the ACL; reverted to accessible on teardown",
    "tier": "EXECUTED"
  },
  "wi5.no_coercion_on_this_update": {
    "note": "the active-flag update landed exactly (EXECUTED, no coercion). Coercion remains likelier on update in general (calculated/coerced fields), which is why the requested-vs-actual compare and projection-superset guard matter more here — proven by fixture."
  }
}
```

## 7. Confirmations

- Clean tree, single work-item commit.
- Delete/rollback still deferred (delete fails-closed, test-enforced).
- Real ACL and scratch table both reverted, read-back-confirmed; no session left elevated.
