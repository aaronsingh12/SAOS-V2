# Gate R — Reachability truth diagnostic (READ-ONLY)

Why can't the live agent write ACLs when WI-1..WI-5 reported forward ACL authoring "complete
end to end"? Read-only; no builds, no writes, no fixes. Every finding cites file:line and is
classified ESTABLISHED / FAILED / UNVERIFIED.

**VERDICT (one line):** The elevation write capability is **NOT reachable from the agent front
door today.** The downstream pipeline is built and wired to intercept a gated descriptor
(orchestrator.js:1829), but (1) no ACL-authoring tool is registered, and (2) system-prompt
rule #15 (prompts.js:76) explicitly tells the model there is no ACL-authoring tool and forbids
the one backdoor — `create_record` on `sys_security_acl`. Every WI "live proof" was
**harness-driven** (code calling `runGatedWrite`/the shim directly with a simulated approval),
never the LLM selecting a registered write tool.

---

## 1. Verdict table

| probe | verdict | one-line evidence |
|---|---|---|
| **R1** tool-surface inventory | **ESTABLISHED** | No ACL-write tool exists. ACL tools are read-only: `acl_report` (tools.js:741), `acl_diff` (tools.js:756), `explain_acls` (tools.js:772). Only the GENERIC `create_record`/`update_record`/`delete_record` (tools.js:202/236/264) can write, and they take any table. |
| **R2** gated-descriptor producers | **ESTABLISHED (nuanced)** | A gated descriptor CAN be produced by an LLM-callable tool — `create_record({table:'sys_security_acl',…})` → `describeWrite` (tools.js:231) → `guardDescriptor` → `isGatedDescriptor` → `handleGatedElevation` (orchestrator.js:1740→1829). `sys_security_acl` is NOT in `UNCREATABLE_TABLES` (tools.js). BUT the model is FORBIDDEN to use it (prompts.js:76), and the path is exercised by no test. Every ACTUAL producer is test/harness code calling `runGatedWrite` directly. |
| **R3** live-proof provenance | **ESTABLISHED** | All WI live proofs were harness-driven: the scratchpad scripts and `elevation-shim-client.test.js` call `runGatedWrite`/`dispatchElevatedWrite` directly with `requestApproval: async()=>({approved:true})` and injected `_preDecision`/`_dispatch`. No proof drove LLM→registered tool→descriptor. `turn-control.test.js` drives `runTurn` but with a SCRIPTED provider (providers/index.js `_setChatTurnForTests`, turn-control.test.js:46) and never on `sys_security_acl`. |
| **R4** branch/instance parity | **code parity ESTABLISHED; running-instance parity UNVERIFIED** | Branch `feat/role-elevation` carries all WI commits (`cd936ca`…`531e767`); `orchestrator.js:37` imports the client and `orchestrator.js:1829` wires the interception — the repo request path is intact. Whether the user's RUNNING server process was restarted onto this branch cannot be settled from code (no runtime probe in a read-only pass). |
| **R5** cause classification | **ESTABLISHED: (b), with a prompt-level fence** | "Built but not exposed to the agent." The pipeline exists and is wired; NO dedicated ACL-write tool was ever registered; and prompt rule #15 (prompts.js:76) actively blocks the only LLM path that would feed it. Not (a) never-built (pipeline exists). (d) is not the primary cause (code is on-branch), though running-instance parity stays UNVERIFIED as a secondary possibility. |

---

## 2. The one-line truth

**Is the elevation write capability reachable from the actual agent front door today? NO.**

The specific missing link: **a registered `create_acl`/`update_acl` tool that emits a gated
`(sys_security_acl, create|update)` descriptor into the pipeline — plus lifting the
system-prompt prohibition.** Today the model is told the opposite:

> **prompts.js:76 (system rule #15):** "Access control is READ-ONLY here. acl_report, acl_diff
> and explain_acls read and explain; **there is no ACL authoring tool and you must not simulate
> one with create_record on sys_security_acl.** If a user asks you to change access, say plainly
> that NowHelpAssist reads ACLs and does not write them…"

So the agent's self-report ("I have no tool for writing ACLs, only the read tools") is **correct
and obedient** — it is doing exactly what its instructions say.

---

## 3. Is the downstream pipeline otherwise intact, and would it work once fed?

**Intact and wired — STRUCTURAL, not EXECUTED for the front-door path.**

- The interception exists: `orchestrator.js:1829` routes any mutating tool whose `describeWrite`
  yields a gated `(table, op)` to `handleGatedElevation`, which calls `runGatedWrite`
  (classifier → eligibility → approval → shim → target read-back → tier). This is BEFORE the
  normal permission gate, and `sys_security_acl` create/update/delete are gated
  (required-role-classifier.js).
- The pipeline's internals are component-proven (WI-1..WI-5): `runGatedWrite` fed a constructed
  descriptor produces the correct EXECUTED/COERCED/FAILED/REFUSED/DENIED behaviour, and a real
  enforcing ACL was authored + updated with enforcement observed (WI-5).
- **What has NEVER been exercised** is the specific edge `real tool call → describeWrite →
  isGatedDescriptor → handleGatedElevation`. No test and no live proof drives it. So "it would
  work once fed through the front door" is a STRUCTURAL claim about wired code, not an EXECUTED
  fact. A real run could still surface a wiring bug at that seam (e.g. descriptor shape,
  runner resolution under the request context, approval-card round-trip).

Concretely, the front door needs BOTH:
1. a way for the LLM to emit the descriptor — either a dedicated `create_acl`/`update_acl` tool,
   or permission to use `create_record`/`update_record` on `sys_security_acl`; AND
2. prompts.js rule #15 changed so the model is allowed to take that path.

Neither exists today, and the interception seam itself is unproven end to end.

---

## 4. Were any WI "live proofs" genuinely LLM-driven end to end?

**No. All were harness-driven, and the WI docs were explicit that the LLM tool-selection and the
human approval were simulated.** Stated plainly:

- **WI-1 / WI-3 create, WI-5 create+update:** the scratchpad proof scripts called
  `runGatedWrite(...)` / `dispatchElevatedWrite(...)` directly, passing
  `requestApproval: async () => ({ approved: true, source: 'user_click' })`. No model chose a
  tool; no human clicked a gate.
- **Offline suites** (`elevation-shim-client.test.js`) inject `_preDecision` / `_dispatch` /
  `requestApproval` mocks — harness-level, not `runTurn`.
- **`turn-control.test.js`** is the only suite that drives `runTurn`, and it uses a scripted
  provider and never targets `sys_security_acl`, so it does not exercise the elevation seam
  either.

The WI results were honest about proving the **pipeline**; they did not — and did not claim to,
once read carefully — prove the **front door**. "Complete end to end for forward ACL authoring"
overstated reachability: it was complete for the pipeline when fed a descriptor, not for the
agent surface that would produce one.

---

## 5. What this pass did NOT do (stop rules honored)

Read-only. No tool registered, no writes, no fixes, no prompt edits. No cause guessed from an
absence — the running-instance parity (R4) is left UNVERIFIED rather than asserted, because code
cannot settle whether the user's live server was restarted onto this branch. The fix (if any) —
a registered ACL-write tool + a prompt change + an end-to-end front-door proof — is a separate WI
to be decided from these results.
