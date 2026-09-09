# Flow authoring — token profile of the golden request (Session 0.3 baseline)

**Measured:** 2026-09-08 17:12–17:24 UTC · **Instance:** dev424910.service-now.com ·
**Model:** ollama / gpt-oss:120b-cloud (a reasoning model; reasoning tokens count
against `max_tokens`) · **Tree:** working tree at `de1fa74` + uncommitted Phases 8–20 ·
**Tier:** VERIFIED FROM REAL MODEL (token counts are the provider's own `usage`
block, read by wrapping `fetch` around the repo's unmodified provider call) ·
**Instance mutations: none** (every approval card was refused; an isolated
temporary SQLite database was used so nothing reached `nowhelpassist.db`).

Golden request, verbatim:

> When an incident is created, run a subflow that adds the work note 'Priority
> checked by onboarding subflow', then add the work note 'Flow completed
> successfully'

The repo captures **no** token usage anywhere (`providers/openaiCompat.js` and
`providers/anthropic.js` both discard `usage`; there is no `llm_calls` table and
no `tokens=` log line — see the Session 0 report). Everything below was
measured from outside the code.

## 1. Which pipeline the request actually runs through

| Route | Who calls it | Model calls for this request |
|---|---|---|
| `POST /api/agent/plan` (planner → validator → review → one approval → executor) | nothing in the client for a chat message; only the domain sub-routes (`/build`, `/lint`, …) are called | exactly **1** (`generatePlan`); `buildReview` is deterministic; there is **no replan loop** in `planner.js` (recovery's REPLAN is manual, max 1, and never re-invokes the planner) |
| `POST /api/agent/chat` (the turn loop; what `AgentChat.jsx` sends a typed request to) | the UI | one call per iteration (≤ 30), plus the inner calls of any tool that itself calls the model (`design_flow_blueprint`; inside `create_flow_live`: intent extraction, codegen ≤ 3 attempts, verification-spec generation ≤ N attempts) |

## 2. Per-call table (real `usage`, one row per HTTP call to the model)

Segment tokens are the provider's `prompt_tokens` split pro rata by character
count of each segment of the outbound request (system message · tool schemas ·
user+assistant history · tool results). "Reason" = characters of the model's
reasoning channel, which the provider bills as completion tokens.

| # | Stage | prompt | completion | system | tool schemas | history | tool results | tools shown | finish | what it did |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | plan (SDK cache **cold** → `flow_authoring` UNKNOWN, absent from prompt) | 2,068 | 1,627 | 2,019 | 0 | 49 | 0 | 0 | stop | VALID plan: `lookup_reference` on table **`sys_flow`** then **`create_record` on `sys_flow`** with an invented payload — a REST write to a non-existent flow table, passed validation |
| 2 | plan (SDK **warm** → `flow_authoring` offered) | 2,293 | 2,048 | 2,245 | 0 | 48 | 0 | 0 | **length** | REFUSED `unparseable`: JSON cut at position 2788 — reasoning 6,385 chars + 2,901 chars of a two-step `create_flow_live` plan did not fit in `maxTokens: 2048` |
| 3 | chat iteration 1 | 9,026 | 566 | 3,941 | 5,053 | 32 | 0 | 35 | tool_calls | `get_table_schema` |
| 4 | chat iteration 2 | 10,015 | 391 | 4,056 | 5,200 | 33 | 726 | 35 | tool_calls | `flow_authoring_capability` |
| 5 | chat iteration 3 | 10,814 | 238 | 4,162 | 5,337 | 34 | 1,281 | 35 | tool_calls | `list_live_flows` (result 8 KB) |
| 6 | chat iteration 4 | 13,415 | 218 | 4,471 | 5,733 | 36 | 3,174 | 35 | tool_calls | `lookup_table` |
| 7 | chat iteration 5 | 13,449 | 146 | 4,483 | 5,747 | 36 | 3,183 | 35 | tool_calls | `get_record` (instance returned an HTML error page) |
| 8 | chat iteration 6 | 15,150 | 104 | 4,623 | 5,927 | 147 | 4,453 | 35 | tool_calls | `get_record` |
| 9 | chat iteration 7 | 15,272 | 178 | 4,641 | 5,951 | 147 | 4,533 | 35 | tool_calls | `lookup_table` |
| 10 | chat iteration 8 | 15,305 | 104 | 4,651 | 5,964 | 148 | 4,543 | 35 | tool_calls | `search_servicenow_docs` |
| 11 | chat iteration 9 | 15,458 | 134 | 4,672 | 5,990 | 148 | 4,648 | 35 | tool_calls | `search_servicenow_docs` |
| 12 | chat iteration 10 | 15,605 | 581 | 4,692 | 6,016 | 149 | 4,748 | 35 | tool_calls | `design_flow_blueprint` |
| 13 | ↳ blueprint (inner call) | 457 | 766 | 406 | 0 | 51 | 0 | 0 | stop | blueprint JSON, 2,302 chars |
| 14 | chat iteration 11 | 16,220 | 396 | 4,717 | 6,049 | 150 | 5,304 | 35 | tool_calls | **`update_record` on `sys_hub_flow` `{active:true}`** — a raw REST write to a flow header; stopped only by the approval gate |
| 15 | chat iteration 12 | 16,306 | 160 | 4,735 | 6,071 | 150 | 5,349 | 35 | stop | prose after the refusal |
| 16 | chat iteration 13 | 16,629 | 669 | 4,734 | 6,070 | 477 | 5,348 | 35 | tool_calls | **`create_flow_live`** (blueprint calling the existing subflow by name) → approval card |
| 17 | chat iteration 14 | 17,135 | 72 | 4,871 | 6,245 | 491 | 5,528 | 35 | stop | wrap-up after the refusal |
| 18 | codegen `generate()` in isolation (real cheatsheet prompt, **empty** live context) | 9,374 | 1,385 | 7,933 | 0 | 1,441 | 0 | 0 | stop | 1,155-char Fluent source importing `./add-priority-check-work-note.now` |

Budget frame the turn loop emitted on iteration 1: model context 131,072 ·
self-imposed cap 60,000 · fixed overhead **13,425** (system 5,693 + 35 tool
schemas 7,732) · history budget 40,431 · not starved.

Context profile the engine chose: capabilities `flow_authoring, incident,
build, deployment, flow_read, record_mutation, record_read, reference_analysis,
schema_read, verification, core` · **35 of 97 tools** · 24 facts · no fallback.

## 3. Stage totals

| Stage | calls | prompt tokens | completion tokens | wall (model only) |
|---|---|---|---|---|
| plan route, cold | 1 | 2,068 | 1,627 | 7.6 s |
| plan route, warm | 1 | 2,293 | 2,048 | 11.0 s |
| chat turn loop (14 iterations) to the `create_flow_live` card and wrap-up | 14 | **199,799** | 3,957 | 33.8 s |
| ↳ inner `design_flow_blueprint` | 1 | 457 | 766 | 3.2 s |
| codegen `generate()` (one attempt, empty live context) | 1 | 9,374 | 1,385 | 7.5 s |
| **measured total** | **18** | **213,991** | **9,783** | ~63 s |

Wall-clock for the chat turn as run was 692 s, because each refused card cost
the full 5-minute approval timeout: the harness (like
`scripts/experience-model-eval.mjs`) calls `resolveApproval()` inside the emit
callback, and the orchestrator registers the pending entry only *after* it emits
the card, so the refusal is a `no-such-approval` and the turn waits. Token
counts are unaffected; the model was told the approval "expired" rather than
"was rejected".

### What a *successful* run would add (not measured — no instance mutation in Session 0)

Per `create_flow_live` attempt, from the code path: intent extraction
(≈ 1.6 k prompt, small), codegen ≈ 9.4 k prompt + the live context
(`buildLiveContext`: ledger trap/mapping/decision facts + incident schema — the
real ledger holds 105 facts / 33 KB against the 48 / 19 KB seeded here) ≈
**14–18 k per attempt, up to 3 attempts**, verification-spec generation (system
prompt + the generated source + effects, ≈ 10 k, up to N attempts), then the
turn loop resumes with the install result (rollback URL, `shipped` list of 33+
artifacts, read-back) for 1–2 more iterations at ≈ 18–20 k each.
**Estimated baseline for one clean end-to-end run: ≈ 260–280 k prompt tokens over
≈ 19–21 model calls.** Historical sessions on this instance (HISTORICAL REPORT,
from `nowhelpassist.db`) ran 11 and 22 loop iterations with 2–4
`create_flow_live` attempts each (all failed at deploy or codegen), i.e. 2–4×
that figure per user request.

## 4. Where the tokens go, and the three findings that matter

1. **The plan route cannot plan this request.** Cold (first ~8 s after boot,
   and every time the 30 s SDK cache expires and is refreshing) the SDK
   capabilities are UNKNOWN, `flow_authoring` is not offered, and the model
   plans a REST `create_record` against a flow table — the "routes to REST"
   symptom, and nothing but the approval gate refuses a `sys_hub_*` write.
   Warm, three of three samples failed on the **2,048-token completion budget**
   (`generatePlan` default `maxTokens`, `routes/plan.js:107` passes none):
   reasoning consumed 6.4 k and 9.3 k characters before or while emitting the
   JSON. Prompt size is not the problem (2.3 k); output room is.
2. **The chat route's cost is the iteration count × a ~13 k fixed prompt plus
   accumulating tool results.** 14 iterations for one request that never
   executed: the model spent 9 iterations reading (schema, capability, managed
   flows, two record reads, two doc searches) before designing. Tool results
   grew from 0 to 5.5 k tokens and stayed in every later call. The context
   engine did its job (35/97 tools, 7.7 k schema tokens instead of 20.8 k).
3. **Codegen is the largest single prompt** (7.9 k system tokens = the 27 KB
   cheatsheet + hard rules), sent once per attempt, up to three times, and it
   is *not* the driver of the 200 k — the loop is.

## 5. Caveats

- One sample per stage for the chat loop; the model is non-deterministic
  (`seed` ignored, measured earlier). The warm planner was sampled three times.
- Codegen was measured with an empty live context; the real call is larger by
  the ledger block and the incident schema block.
- The offline context-profile stage in the harness mis-used
  `toolsForSkills` and is not reported; the live `context_profile` frame from
  the turn is what §2 quotes.
- The instance answered one `get_record` with an HTML "Sorry, an error
  occurred" page during the run; the model carried on.
- Harness: `profile-golden.mjs` and `profile-golden.json` in the session
  scratchpad (not in the repo); rerunnable from `server/` with
  `node <scratchpad>/profile-golden.mjs <out.json>`.

## 6. Session 1 re-profile (2026-09-09) — same request, real refusals

Same harness shape as §2 (isolated DB, real model, real instance, every card
refused through the real gate — and since WI-2 the gate actually accepts the
refusal, so no five-minute timeouts). Two samples, taken after WI-2 … WI-7 and
the prompt follow-up landed.

| Sample | loop iterations | iterations to the `create_flow_live` card | prompt tokens to the card | prompt tokens total | raw `sys_hub_flow` writes attempted | refused before any card | Business Rule offered | ledger mutations |
|---|---|---|---|---|---|---|---|---|
| Session 0 baseline | 14 | 13 | ~183k | 199.8k | 1 (reached the card) | 0 | yes, as a "native alternative" | 0 (card refused) |
| #1 (before the prompt follow-up) | 10 | never — the turn ended with a question | – | 138.1k | 1 | 1 (`policy_refused`) | yes, in prose | 0 |
| #2 (after) | 19 | 16 | 281.6k | 356.0k | 3 | 3 (`policy_refused`) | no | 0 |

What held, VERIFIED FROM REAL MODEL on dev424910:

- every `update_record sys_hub_flow {active:true}` was refused by policy
  **before** a card existed (WI-4); the refusal reached the model as a result,
  not as a mutation, and the ledger stayed empty;
- the refused `create_flow_live` card was answered in-callback and the gate
  accepted it (`accepted: true`; WI-2); the model's identical resubmission was
  stopped by the rejection registry (`user-rejected`) without a second card;
- no `create_application`, no `create_record` on `sys_script`, and after the
  follow-up sentence no Business Rule offered even in prose;
- the context profile was the same correct 35-of-97 selection (fixed 13.6k:
  system 5.8k, schemas 7.8k).

What did not: the **≤ 6 iterations to the card** target. Both samples spent
their iterations on reads, and sample #2 on three refused activation attempts.
The reason is visible in the transcript: `list_live_flows` returns the golden
pair already installed as drafts (the Session 0 artifacts on this workspace),
so the model's plan becomes "activate the existing flow" rather than "build
one", and the only activation path it can see is the raw write the policy now
refuses. Its closing message asks the user whether to activate the draft. That
is the honest state of the instance (installed ≠ published) and it is Session
2's problem to give the model a sanctioned activation path (W2) and a lean
workspace (W1); no Session 1 lever changes it. Iteration count is one sample
each and the model is non-deterministic; the numbers are reported, not
claimed as a trend.

The plan route, warm, for the same request (WI-5): six of six samples now
parse (finish=stop; completion 1.3k–2.4k against the 8,192 budget), versus
zero of three before. Two of six validate — both as `create_flow_live` on the
SDK mechanism with scope `x_2002152_nwforge` stamped, none on REST, none on
`sys_flow`. The other four are refused by the deterministic dataflow rules:
the model plans "author, then publish" as two `create_flow_live` steps and
references a `blueprint` output the tool does not declare
(`reference_unknown_output`), or writes a reference in a non-canonical form
(`malformed_reference`). That is the F4 bundle-step case for Session 3, and
one taxonomy fact worth noting there: `flow_authoring` and `flow_publish` both
map to the same tool, which is what invites the two-step reading.
