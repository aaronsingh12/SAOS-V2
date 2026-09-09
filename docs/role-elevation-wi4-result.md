# WI-4 — result: renderer truth display for the elevation path

The human-facing honesty layer. Every WI-3 outcome renders to a person truthfully and
distinctly, and **green is structurally reachable only from a read-back-proven EXECUTED
tier** — never re-inferred from HTTP status, a returned sys_id, or "approval was granted."

**Verdict: EXECUTED.** All six states proven by fixture (including a hostile soft-signal
fixture), the projection-superset invariant enforced on both halves, and one live EXECUTED
render end to end shows green + the confirmed field scope.

---

## 1. What was built / changed (file:line)

| piece | where |
|---|---|
| Result-object contract (tier/state/required_role/elevation_occurred/target/`compared_fields`/`compared_detail`/diff) emitted on every path | [orchestrator.js `handleGatedElevation`](../server/src/agent/orchestrator.js) |
| Projection-superset guard (backend half) — EXECUTED unreachable if projection ⊄ asserted; `compared_fields`/`compared_detail`/`unverified` | [elevation-shim.js `assessOutcomeTier`](../server/src/servicenow/elevation-shim.js) + [`dispatchElevatedWrite`](../server/src/servicenow/elevation-shim.js) passes the real projection |
| Pure tier→visual mapping (green ⟺ EXECUTED) | [elevationOutcome.js](../client/src/components/elevationOutcome.js) |
| Elevation bubble + approval elevation context (frontend half) | [AgentChat.jsx](../client/src/pages/AgentChat.jsx) |
| Fixtures + source-assertion tests (+11) | [elevation-render.test.js](../server/test/elevation-render.test.js) + shim projection tests |

---

## 2. Invariants → enforcing tests (offline suite 880 → 891, all green)

| invariant | test |
|---|---|
| Green ⟺ EXECUTED; every other tier/state non-green | *INVARIANT — EXECUTED is green; every other tier/state is NOT green* + *INVARIANT (source) — green: true appears exactly once… inside the EXECUTED branch* |
| Hostile soft-signal (sys_id + 200 + approved, non-EXECUTED) renders non-green | *INVARIANT (hostile) — a non-EXECUTED tier carrying a truthy sys_id and a 200 renders NON-GREEN* |
| COERCED loud + shows diff, never collapsed | *INVARIANT — COERCED is loud (amber), shows the per-field diff…* |
| FAILED honest, reason-free when unknown | *INVARIANT — FAILED never fabricates a reason* |
| Confirmed scope = compared scope (both halves) | backend: *INVARIANT — EXECUTED is unreachable when an asserted field is OUTSIDE the read-back projection*; frontend: *INVARIANT — the renderer confirms ONLY the compared fields* |
| REFUSED/FAIL_CLOSED/DENIED distinct + truthful | *INVARIANT — REFUSED / FAIL_CLOSED / DENIED are distinct…* |
| No blank bubble / prop mismatch | *NO BLANK BUBBLE — the elevation bubble renders its headline… and events push it* |
| Green derives from elevationOutcome only (M3 regression) | *WIRING — AgentChat renders the elevation bubble solely from elevationOutcome* (bubble reads no `m.status`/`isError`) |

---

## 3. Fixture results (all six states + hostile)

| state | green | tone / badge | shows |
|---|---|---|---|
| EXECUTED | **true** | ok | role, target, confirmed field set (= `compared_fields`) |
| COERCED | false | warn / amber | per-field requested→actual diff (mismatch + platform-rewrite + unverified) |
| FAILED | false | bad / red | "did not land"; reason **null** when unknown |
| REFUSED | false | bad / red | required role + why ineligible; "nothing was elevated" |
| FAIL_CLOSED | false | warn / amber | "eligibility could not be verified — blocked (fail-closed)" |
| DENIED | false | neutral | "you declined — nothing elevated, nothing written" |
| **HOSTILE** (FAILED tier + truthy sys_id + 200 + approved) | **false** | bad | proves green comes only from `tier === EXECUTED` |

`green: true` appears **exactly once** in `elevationOutcome.js`, inside the `tier === 'EXECUTED'`
branch; the decision never reads a status/sys_id/approval field.

## 4. Live EXECUTED render (end to end)

Real throwaway gated create through WI-3 (`runGatedWrite`, approved), the real result passed
through `elevationOutcome`:
- WI-3 tier `EXECUTED`, sys_id `7794d77f…`
- rendered: **green: true**, tone ok, label "elevated & verified", role `security_admin`
- `confirmedFields` = the six compared fields, each with `requested` == `actual` (incl. the
  nonce-tagged `description`) — confirmed scope equals compared scope.

Reverted via the elevated channel: deleted 1 ACL + 1 `sys_update_xml`, 0 leftover,
de-elevated; fresh worker `has_role: false`.

## 5. Green reachable only from `tier === EXECUTED`; confirmed = compared

- Green flag: *INVARIANT (source) — green: true appears exactly once… inside the EXECUTED
  branch* + *WIRING — the green dot is reachable only from o.green*.
- Confirmed = compared, both halves: backend guard downgrades EXECUTED when the projection is
  not a superset of the asserted fields (*INVARIANT — EXECUTED is unreachable when an asserted
  field is OUTSIDE the read-back projection*); the renderer's `confirmedFields` is exactly
  `compared_detail`, and an unverified field is surfaced in the diff, never as confirmed.

## 6. Residual UNVERIFIED carried forward

- **`[A-runner]`** — runner is admin's dormant `security_admin`; no dedicated integration user on this PDI.
- **`[A-hss]`** — `sys_properties`/HSS gating still inert/UNVERIFIED.

## 7. Trap-ledger entries

```json
{
  "wi4.projection_superset_invariant": {
    "rule": "EXECUTED is reachable only when the read-back projection is a SUPERSET of every asserted field; a field outside the projection is `unverified` and downgrades the tier. Now tested BOTH halves: backend (assessOutcomeTier) and frontend (elevationOutcome confirms only compared fields).",
    "tier": "EXECUTED"
  },
  "wi4.tier_to_visual_honest_mapping": {
    "rule": "the renderer derives green SOLELY from tier === EXECUTED; a truthy sys_id / HTTP 200 / approval-granted never produces green (proven by a hostile fixture). green:true is settable from exactly one place, inside the EXECUTED branch.",
    "tier": "EXECUTED"
  }
}
```

## 8. Confirmations

- Green reachable only from `tier === EXECUTED` (tests in §5); confirmed-scope = compared-scope enforced on both halves.
- Clean tree, single work-item commit. Client builds cleanly.
