# WI-3 — result: the shim goes live to the agent (gate + approval + audit)

Run against `dev442675.service-now.com` (`Australia`), 2026-08-26, runner `admin`
(`6816f79cc0a8016401c5a33be04be441`, NHA's authenticated identity, holds `security_admin`
dormantly). The shim is now reachable through the agent's mutation path — but only through
the gate. The model has no elevate verb, cannot reach the shim, cannot bypass the gate, and
cannot force an un-elevated fallback.

**Verdict: EXECUTED across all five gated-pipeline paths.** A gated write is reachable only
as: op → mechanical `(table,op)` → WI-2 classifier → WI-2 eligibility → approval → shim →
target read-back by nonce → honest tier. Forward create only; no rollback.

---

## 1. What was built / changed (sub-commits)

**(1/2) Sink removal / outcome-read retrofit** — [elevation-shim.js](../server/src/servicenow/elevation-shim.js)
- Removed the `sys_user_preference` result-capture. `buildElevatedWriteBody` inlines the
  proven lifecycle (runner precond → reachability → enable → assert `gs.hasRole` →
  GlideRecordSecure-only write → finally disable) with no sink. Truth = target read-back by
  nonce (`dispatchElevatedWrite` + `readTargetByNonce` + `assessOutcomeTier`:
  EXECUTED/COERCED/FAILED). Removed `buildShimBody`/`runElevationShim`/`parseShimVerdict`/
  `assessShim`. Tests 18 → 12.

**(2/2) Shim client + gate wiring + approval + audit**
- Client (the ONLY route to elevation) — [elevation-shim-client.js](../server/src/servicenow/elevation-shim-client.js): `deriveElevationOp` (mechanical `insert→create`), `planElevation` (preDecision, **fail-closed** on read error), `buildElevationApprovalPayload` (enrichment), `executeGatedWrite` (create; update/delete fail-closed not-implemented), `runGatedWrite` (owns the order; **no revert**).
- Orchestrator wiring — [orchestrator.js `handleGatedElevation`](../server/src/agent/orchestrator.js) + the interception placed **before** the normal permission gate: a gated descriptor is routed to the client instead of the plain REST `executeTool`.
- Approval enrichment — the amber gate fires **before** any elevation, carrying `{ kind: role_elevation, high_risk, op, target, required_role, will_elevate, eligibility }`, nonce-bound like every mutation.
- Audit/provenance — `tool_events` lifecycle rows (`elev_*` statuses), `appendMutation` tagged `ingestion: elevated-path`, and a new [`registerElevatedWrite`](../server/src/memory/provenance.js) provenance source `elevated_write` (closes the ingestion-tier-provenance backlog item).

---

## 2. Invariants → enforcing tests (offline suite 871 → 880)

| invariant | test |
|---|---|
| No model-exposed elevate verb | *INVARIANT — there is NO model-callable elevate/shim tool* + *WIRING — the shim client is the ONLY importer of the shim executor* |
| Elevation only via op→classifier→eligibility→approval→shim | *WIRING — routes gated descriptors through the elevation gate before the permission gate* |
| Approval before any elevation/write; deny ⇒ nothing | *INVARIANT — deny at the gate ⇒ nothing elevated* + *the shim is dispatched only AFTER approval returns approved* |
| Fail-closed on eligibility-read error | *INVARIANT — a gated op whose eligibility read THROWS is fail-closed* |
| `(table,op)` mechanical, not LLM-massaged | *INVARIANT — the op is derived mechanically (insert → create)* |
| Truth = target read-back; COERCED via compare | *INVARIANT — the tier comes from the target read-back* + shim's *the outcome tier comes from the target read-back* |
| No un-elevated revert on failure | *INVARIANT — a FAILED/COERCED outcome triggers NO revert* |
| Sink removed | *SINK REMOVED — the shim writes no sys_user_preference row* |
| Carry-forward (GRS-only, gs.hasRole assert, de-elevate finally, sys_update_xml provenance) | the shim's INVARIANT tests |

---

## 3. WI-1 re-proof (shim still EXECUTED without the sink)

`dispatchElevatedWrite` of the probe ACL: elevated GlideRecordSecure write **landed and
read back by nonce off the TARGET record with NO sink** — tier `EXECUTED`, sys_id
`737bc3fb…`. Reverted via the elevated channel, `sys_update_xml` swept (1), 0 leftover,
de-elevated. (An early run mis-tiered as COERCED because the read-back projection omitted
two requested fields; fixed to fetch exactly the requested keys, re-proven EXECUTED.)

## 4. The five WI-3 live paths (all EXECUTED)

| # | path | observed |
|---|---|---|
| 1 | **HAPPY** | `decision: elevate, approved, wrote: true, tier: EXECUTED`, sys_id `d34e4f33…`, `ingestion: elevated-path`, read back by nonce `319033af…` |
| 2 | **DENY** | `decision: denied, wrote: false, elevated: false` — **0 probes on instance** |
| 3 | **INELIGIBLE** (synthetic runner) | `decision: refuse, refused: true, wrote: false`, reason "not assigned security_admin" — **0 probes**, approval never requested |
| 4 | **FAIL-CLOSED** (eligibility read throws) | `decision: blocked_read_failed, refused: true, wrote: false` — **0 probes**, approval never requested |
| 5 | **NO-UN-ELEVATED-REVERT** | after the happy write, the client performed **no revert** — record left intact (1 on instance); the TEST then reverted via the elevated channel |

Post-run: fresh worker `has_role: false` (no session left elevated). Revert (elevated):
deleted 1 ACL + 1 `sys_update_xml`, 0 leftover, de-elevated.

## 5. The model cannot bypass the gate (enforcing tests)

- No tool in `TOOLS` matches `elev`/`shim` — *INVARIANT — there is NO model-callable elevate/shim tool*.
- The orchestrator imports elevation only through the client, never the raw shim executor — *WIRING — the shim client is the ONLY importer…*.
- The gated interception precedes the permission gate, so a gated op never reaches the plain `executeTool` path — *WIRING — routes gated descriptors… before the permission gate*.
- Ineligible/fail-closed refuse **before** approval; the shim is dispatched **only after** approval returns approved — the ordering tests above.

## 6. Residual UNVERIFIED carried forward

- **`[A-runner]`** — the runner was `admin`'s dormant `security_admin`; a dedicated non-admin `security_admin` integration user does not exist on this PDI.
- **`[A-hss]`** — `sys_properties`/HSS gating still inert/UNVERIFIED (WI-2).
- Update/delete elevated WRITES are fail-closed not-implemented in WI-3 (forward create only); they route through the gate but do not execute an elevated mutation. Rollback/undo is a separate WI.

## 7. Trap-ledger entries

```json
{
  "wi3.outcome_by_target_readback": {
    "rule": "the shim leaves only the target record, nonce-tagged; NHA reads it back over REST and tiers requested-vs-actual EXECUTED/COERCED/FAILED. No sink, no self-report trusted. Absence is FAILED, never green.",
    "readback_projection": "the read-back MUST fetch every field it compares (sys_id + requested keys) or a clean write mis-tiers as COERCED",
    "tier": "EXECUTED"
  },
  "wi3.elevated_path_ingestion_tier": {
    "rule": "a record authored through the elevated path is registered in sysid_provenance with source 'elevated_write' and the mutation ledger with ingestion 'elevated-path' — 'written under elevation' becomes queryable, not merely logged",
    "tier": "EXECUTED"
  },
  "wi3.no_un_elevated_revert": {
    "rule": "on a FAILED or COERCED gated write the client reports the tier and STOPS; it never attempts an un-elevated revert (revert of a gated op is itself gated — WI-1). Rollback is a separate WI.",
    "tier": "EXECUTED"
  }
}
```

## 8. Confirmations

- Clean tree; sub-commits in order (sink removal → wiring+approval+audit).
- Rollback deferred (out of scope; update/delete elevated writes fail-closed).
- Model has no elevate verb and cannot bypass the gate (tests named in §5).
