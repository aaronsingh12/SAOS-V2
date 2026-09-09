# WI-2 — result: the deterministic required-role classifier + eligibility precheck

Run read-only against `dev442675.service-now.com` (`Australia`), 2026-08-26, runner `admin`
(`6816f79cc0a8016401c5a33be04be441`). No mutation. The gate is fully deterministic and
non-LLM: the classifier is pure and import-free; the eligibility verdict logic is pure; the
one instance touch is a **read** (`sys_user_has_role` / `sys_user_role`, server-side).

**Verdict: the gate decides correctly, EXECUTED for the admin runner.** It answers, before
any shim is invoked: *does this op need elevation, and is the runner allowed to elevate to
the role it needs?* Not-eligible ⇒ a structured refusal, never a downgraded plain path.

---

## 1. What was built

| piece | file:line |
|---|---|
| required-role classifier (pure, zero imports) | [required-role-classifier.js `classifyRequiredRole`](../server/src/servicenow/required-role-classifier.js) |
| gated seed map — `sys_security_acl` × {create, update, **delete**} → `security_admin` | [required-role-classifier.js `GATED`](../server/src/servicenow/required-role-classifier.js) |
| `[A-hss]` inert follow-up | [required-role-classifier.js `UNVERIFIED_FOLLOWUPS`](../server/src/servicenow/required-role-classifier.js) |
| eligibility read (server-side, H6-safe) | [elevation-gate.js `buildEligibilitySource`](../server/src/servicenow/elevation-gate.js) |
| eligibility verdict (pure branch logic) | [elevation-gate.js `assessEligibilityVerdict`](../server/src/servicenow/elevation-gate.js) |
| Check A end to end | [elevation-gate.js `eligibilityPrecheck`](../server/src/servicenow/elevation-gate.js) |
| combined pre-decision (WI-3 consumes) | [elevation-gate.js `preDecision`](../server/src/servicenow/elevation-gate.js) |
| offline tests (+13) | [elevation-gate.test.js](../server/test/elevation-gate.test.js) |

---

## 2. Invariants → enforcing tests (offline suite 858 → 871, all green)

| invariant | test |
|---|---|
| No LLM in classify/eligibility (classifier import-free) | *INVARIANT — no LLM in the classify or eligibility path* |
| Delete is gated (WI-1 finding) | *INVARIANT — sys_security_acl delete classifies as requiring security_admin* |
| Assignment read is server-side; REST-0-rows ≠ not-assigned | *INVARIANT — the assignment read is server-side, and REST-0-rows is never "not assigned"* |
| assigned ≠ elevated (never reads `gs.hasRole`) | *INVARIANT — eligibility uses the assignment read, NEVER gs.hasRole* |
| Not-eligible ⇒ hard stop, structured, no shim, no fallback | *INVARIANT — an ineligible verdict produces a structured REFUSAL…* + *WI-2 imports no shim and no LLM* |
| `[A-hss]` inert until enumerated | *[A-hss] — sys_properties writes are NOT classified as gated on a guessed list* |

---

## 3. Live proof (EXECUTED for admin runner)

**Positive** — `precheck(admin, security_admin)`, `liveness: CONFIRMED`:
```json
{ "eligible": true, "branch": "eligible", "runner_assigned": true,
  "role_is_elevated_privilege": true, "via_direct": true, "via_group": false, "reason": null }
```

**H6 guard, load-bearing** — the same role record over the two transports:
- plain REST `sys_user_role name=security_admin` → **0 rows**
- server-side read → `role_found: true, assigned: true`

⇒ a REST-based "not assigned" here would be a **false negative**. The precheck reads
server-side precisely so it never draws that wrong conclusion. This is the guard the design
turns on, demonstrated rather than asserted.

**Negative A** — `precheck(synthetic-nonexistent-user, security_admin)`:
```json
{ "eligible": false, "branch": "not_assigned", "runner_assigned": false,
  "role_is_elevated_privilege": true, "reason": "runner is not assigned security_admin (…Gate 0 H6)" }
```

**Negative B** — `precheck(admin, itil)` (a bonus: proves *assigned ≠ elevatable* live):
```json
{ "eligible": false, "branch": "not_elevated_privilege", "runner_assigned": true,
  "role_is_elevated_privilege": false, "reason": "itil is not an elevated-privilege role (elevated_privilege != 1)…" }
```
Admin **holds** `itil`, but `itil` is not elevated-privilege, so it lands in the distinct
`not_elevated_privilege` branch — not conflated with "not assigned".

**Pre-decision, end to end:**
| op | runner | decision |
|---|---|---|
| `sys_security_acl.delete` | admin | **`elevate`** (gated, eligible) |
| `sys_security_acl.delete` | synthetic | **`refuse`** (not assigned) |
| `incident.update` | admin | **`no_elevation_needed`** (no instance read even attempted) |

---

## 4. `[A-hss]` — left inert / UNVERIFIED

`classifyRequiredRole` returns **ungated** for `sys_properties` writes. The suspected
`security_admin` requirement on some High Security Settings writes is recorded in
`UNVERIFIED_FOLLOWUPS` with `inert: true, tier: UNVERIFIED`. **Needs:** enumerate which
`sys_properties`/HSS writes actually require `security_admin` on a live PDI (probe each
candidate un-elevated vs elevated, read-back) before promoting any into `GATED` with an
EXECUTED tier. Classifying property writes as gated on a guessed list is a defect (stop
rule) — kept inert here.

## 5. Residual UNVERIFIED carried forward

- **`[A-runner]`** — the eligibility positive used `admin`'s dormant `security_admin`. A
  dedicated non-admin `security_admin` integration user (the production runner shape) does
  not exist on this PDI; the precheck is proven for the runner NHA uses today. The negative
  cases (synthetic user, non-elevatable role) prove the gate refuses, but a real production
  runner remains unexercised.

## 6. Confirmations

- Clean tree, single work-item commit.
- **No shim invocation** — `elevation-gate.js` does not import `elevation-shim.js` (test-
  enforced). WI-2 decides; WI-3 acts.
- **No LLM in the gate path** — no provider import, no model call in either module; the
  classifier is import-free (test-enforced).
