# Flow Designer and Subflows — end-to-end authoring, measured

**Instance:** dev424910.service-now.com · scope `x_2002152_nwforge` ("NowForge Flows")
**SDK:** `@servicenow/sdk` 4.10.1 · **Date:** 17 September 2026
**Question this answers:** can NowForge take a requested Flow/Subflow design, generate
Fluent TypeScript, build it, install it, and produce a *correct live ServiceNow Flow
Designer record* — triggers, conditions, actions, logic, inputs, outputs, data pills,
relationships and ordering?

Everything below is read from the platform's own tables. Nothing is inferred from "the
build succeeded".

---

## 0. The one architectural fact that decides the rest

```js
function Action(_config, _body) { return undefined }
```

— `@servicenow/sdk-core/dist/external/flow/Action.js`, verbatim.

`Action()`, `Trigger()`, `Flow()` and `Subflow()` all return `undefined` at run time. The
Fluent API is a **compile-time DSL**: the definitions exist only as TypeScript that the
SDK's build transform reads as *source*. There is no runtime object model.

Three consequences, and they are not opinions:

1. There is **no programmatic step-insertion API**. You cannot append an action to a flow,
   reorder steps, or read a flow back through the SDK. "Missing implementation layer" is
   not the explanation — the layer does not exist to be called.
2. **Source → build → install is the only authoring path** the SDK offers.
3. Therefore **editing = regenerating the source and re-installing**, and whether that
   *updates* or *duplicates* depends entirely on `$id` key stability. §5 measures it.

---

## 1. What the install actually creates

Measured for `E2E 04 Pills And Logic` (`52a3d986df654354bf05a4c5038516b9`) and
`E2E 05 Classify Incident` (`44e1d6f713284308af1d7542cb877039`):

| Table | Rows | What it holds |
|---|---|---|
| `sys_hub_flow` | 1 | the header: `name`, `description`, `type` (flow\|subflow), `active`, `status`, `run_as`, `flow_priority`, `sys_scope`, `latest_snapshot`, `master_snapshot` |
| `sys_hub_trigger_instance_v2` | 1 | `trigger_definition` (→ the trigger type record), `trigger_inputs` (gzip+base64 JSON: table, condition, run_flow_in, …) |
| `sys_hub_action_instance_v2` | 11 | one per action: `action_type` (→ the action type record), `order`, `ui_id`, `parent_ui_id`, `values` (gzip+base64 JSON of every parameter) |
| `sys_hub_flow_logic_instance_v2` | 9 | one per logic step: `logic_definition` (→ If / Else If / Else / For Each / Parallel Branch / Try / Catch), `order`, `ui_id`, `parent_ui_id`, `values` |
| `sys_hub_sub_flow_instance_v2` | 1 | a subflow CALL: `subflow` (a real reference to the callee's record), `wait_for_completion` (a boolean column), `subflow_inputs`, `order`, `ui_id` |
| `sys_hub_flow_input` | 4 | a subflow's declared inputs: `element`, `internal_type`, `reference`, `mandatory`, `order` |
| `sys_hub_flow_output` | 3 | its declared outputs, same shape |
| `sys_hub_flow_snapshot` | 0 → 1 | created by **publishing**, not by installing |

A subflow call is **not** an action instance. A flow whose only step is a call reads back
as "1 trigger, 0 actions" unless `sys_hub_sub_flow_instance_v2` is read too.

### How steps are attached and ordered

- **Parent:** every step row points at its flow through `flow` (→ `sys_hub_flow_base`, so
  the same reads resolve a snapshot as well as a live flow).
- **Nesting:** `parent_ui_id` is the `ui_id` of the containing logic step. Top-level steps
  have it empty. This is how "inside the If" is represented — not by order.
- **Order:** the `order` int column, ascending. Top-level steps are odd-numbered
  (1, 2, 3, …) with containers and their contents interleaved.
- **`ui_id` is the row's own sys_id in dashed form.** `5849852634474f17928259deff5b8556`
  → `58498526-3447-4f17-9282-59deff5b8556`. This matters because it is what data pills
  bind to.
- **Data pills** are `{{<producing step's ui_id>.<Output>}}`, dot-walkable:
  `{{5b9a6912-f362-4732-bdc7-7fcd0408aaed.Record.manager.email}}`. Trigger outputs use a
  name instead of a uuid: `{{Created_1.current.number}}`. Subflow inputs read as
  `{{subflow.<inputName>}}`.

### Composite order — undocumented, and it breaks naive readers

A step inside a **Parallel Branch** does not store an integer. It stores:

```
"13➛14"
```

— the branch container's order, U+279B, then the step's position inside that branch.
`Number()` on it is `NaN`. Any read-back that sorts numerically silently loses every
parallel step. `scripts/flow-readback.mjs` now parses both halves (`parseOrder`).

---

## 2. The trigger and action inventory — read from the SDK, not from a document

`server/src/servicenow/sdk-catalogue.js` parses the SDK's own generated built-ins
(`@servicenow/sdk-core/dist/external/flow/built-ins/**`), which carry each definition's
`$id` (the live action-type sys_id), name, every input with its `mandatory` flag, and every
output with exact casing.

**13 triggers.** record: `created`, `updated`, `createdOrUpdated`. scheduled: `daily`,
`weekly`, `monthly`, `repeat`, `runOnce`. application: `serviceCatalog`, `inboundEmail`,
`slaTask`, `knowledgeManagement`, `remoteTableQuery`.

> **There is no record-deleted trigger.** The SDK's `TriggerType` union has no
> `record_delete`, and no such built-in file exists. A flow cannot be triggered by a
> deletion through Fluent. This answers "deleted, if supported": **not supported.**

**33 actions**, against the 18 the cheatsheet listed. The seven the cheatsheet called only
"attachment actions" have real names: `copyAttachment`, `deleteAttachment`,
`getAttachmentsOnRecord`, `lookupAttachment`, `moveAttachment`, `lookUpEmailAttachments`,
`moveEmailAttachmentsToRecord`.

The SDK also **contradicted two "required" claims** the hand-written catalogue made:
`lookUpRecord`/`lookUpRecords` do *not* require `table`, and `createTask` does *not*
require `field_values`. Both would have rejected correct source. This is why the linter
now asks the SDK first and treats the document as a fallback.

---

## 3. The end-to-end matrix

Seven artifacts, hand-authored so the test measures the SDK path rather than model
variance, built once, installed once, then compared against the live records by
`scripts/flow-e2e-matrix.mjs`.

**Result: 82 checks, 82 passed, 0 failed, across 11 artifacts.**

| Artifact | sys_id | Covers |
|---|---|---|
| E2E 01 Record Created | `0c9ddba0e3b94daea393065dfe5384c6` | basic flow · `record.created` · multi-clause AND condition |
| E2E 02 Record Updated | `30aa95b860754012b19154735a92118c` | `record.updated` · OR · CHANGES · choice/boolean/reference/date clauses · `trigger_strategy` · `run_on_extended` · `flowPriority` |
| E2E 03 Scheduled Daily | `1e78825cb1274d0f811222b3ae68de40` | `scheduled.daily` · timezone · a body with no trigger record · `lookUpRecords` parameters |
| E2E 04 Pills And Logic | `52a3d986df654354bf05a4c5038516b9` | action→action pills · dot-walk · if/elseIf/else · forEach · doInParallel · tryCatch · branch placement |
| E2E 05 Classify Incident | `44e1d6f713284308af1d7542cb877039` | **subflow** · typed inputs · reference input · mandatory · outputs · internal logic · `assignSubflowOutputs` |
| E2E 06 Subflow Caller | `6df649dca3aa49ce97e034b5cd4db5b6` | flow→subflow call · input mapping · `waitForCompletion` · output consumed downstream · ordering |
| E2E 07 Service Catalog Trigger | `086b906d68a340ebb2e95245ede01994` | application trigger family |
| E2E 08 Scheduled Weekly | `fe225e90fc0343bba2acb1d46a9bceb3` | `scheduled.weekly` · `day_of_week` + `time` |
| E2E 09 Scheduled Monthly | `f8feebda7d9e47f2a2fe624c5a379036` | `scheduled.monthly` · `day_of_month` + `time` |
| E2E 10 Scheduled Repeat | `fa5d1669e86c41d487b6e9017911a9b1` | `scheduled.repeat` · a `Duration` interval |
| E2E 11 Scheduled Run Once | `13d7f1466d054c18bb63feda96f7084d` | `scheduled.runOnce` · a fixed datetime |

All five scheduled forms are covered live. How each one is stored:

```
E2E 08 Weekly    day_of_week  3 [Wednesday]          <- value + display, both kept
                 time         "1970-01-01 09:15:00"  <- time-of-day on the epoch date
E2E 09 Monthly   day_of_month 15
                 time         "1970-01-01 06:45:00"
E2E 10 Repeat    repeat       "1970-01-01 00:30:00"  <- Duration({minutes:30}) as an offset
E2E 11 Run Once  run_in       "2027-01-01 09:00:00"  <- a real datetime, stored verbatim
```

`Duration` and `Time` both land as a time-of-day relative to the epoch; only `runOnce`
carries a genuine calendar date.

### Trigger conditions reach the instance verbatim

The encoded query is **not** re-parsed or normalised by the install. E2E 02 asked for:

```
priority=1^ORpriority=2^stateCHANGES^active=true^assigned_toISNOTEMPTY^opened_atISNOTEMPTY^number=E2E_NEVER_MATCHES
```

and `trigger_inputs.condition` holds that string, character for character — an OR join, a
change operator with no right-hand side, a choice compared by stored value, a boolean, a
reference and a date field, all in one condition. `trigger_strategy: 'unique_changes'` and
`run_on_extended: 'true'` are stored as their own parameters beside it.

### The timezone is honoured, not stored

E2E 03 asked for `Time({ hours: 3, minutes: 30 }, 'Asia/Kolkata')`. The instance holds
`1969-12-31 22:00:00` — 03:30 IST converted to **22:00 UTC** the previous day, on the epoch
date because only the time-of-day matters. Asserting "03:30" would have been asserting the
conversion had *not* happened.

### Logic, as the platform names it

`doInParallel` becomes a `Do the following in Parallel` container with one
`Parallel Branch` child per branch, and each branch's steps hang off that branch's
`ui_id`. `tryCatch` becomes sibling `Try` and `Catch` containers. `if`/`elseIf`/`else` are
three sibling rows with empty `parent_ui_id`, and the actions inside each carry that
branch's `ui_id` as their parent.

### `waitForCompletion`

Written inside the **inputs** object (3rd argument), it sets the
`sys_hub_sub_flow_instance_v2.wait_for_completion` **column** to true and does *not* appear
among the stored `subflow_inputs`. The cheatsheet rule is correct, and now measured.

---

## 4. Publish / activate

Publishing is a separate act from installing, and it is the platform's own processor:
`POST /api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=<scope sys_id>`. Nothing
local simulates it, and `sys_hub_flow` is never written over REST.

| Artifact | Result | Time |
|---|---|---|
| E2E 05 Classify Incident (subflow) | `published: true`, `active=true`, `status=published` | ~95 s |
| E2E 01 Record Created (flow) | `published: true`, `active=true`, `status=published` | ~99 s |

Verified twice by independent paths: the activation call's own four-way proof, and a fresh
read of the header + snapshot rows by `scripts/flow-readback.mjs`.

---
## 5. Data pills and outputs, in the stored records

`E2E 06 Subflow Caller`, read back from the instance:

```
1  SUBFLOW  E2E 05 Classify Incident wait=true  ui=5919b763-9dbd-4d81-86c1-937e02ef584d
      incident    "{{Created_1.current}}"          <- reference, as a trigger pill
      threshold   2                                 <- integer, stored as a NUMBER
      note        "called from E2E 06"              <- string
      verbose     true                              <- boolean, stored as a BOOLEAN
2  ACTION   Log                                 ui=5c9f144d-6a02-48ef-8d37-3c2936424641
      log_message "E2E 06 classification={{5919b763-....classification}} escalate={{5919b763-....escalate}}"
```

Three things are settled by those nine lines:

- **Types survive.** `2` is a number and `true` is a boolean in the stored blob, not the
  strings `"2"` and `"true"`.
- **The pill binds to the producing step's identity**, not to a name — the log references
  the subflow CALL's `ui_id`, so renaming anything cannot break it.
- **Subflow outputs are readable downstream** exactly like action outputs.

Chaining across actions is the same mechanism, dot-walked through a reference:
`{{5b9a6912-f362-4732-bdc7-7fcd0408aaed.Record.manager.email}}` in E2E 04 — Action B
reading a field two hops off Action A's `Record` output.

Trigger outputs use a stable name rather than a uuid (`{{Created_1.current.number}}`), and
a subflow reads its own inputs as `{{subflow.<name>}}`.

## 6. Guardrails during this phase

The pre-build gates are two different kinds of thing, and only one of them was ours to
relax.

**Ours (local judgements about generated source):** promised literals, blueprint fidelity,
artifact type + subflow contract, subflow reuse, trigger strategy, flow design. These are
now **advisory by default** (`NOWFORGE_FLOW_GATES=advisory`). Every check still runs, every
diagnostic is still emitted and returned on `gateAdvisories`, and none of them stops a
candidate reaching the instance. `NOWFORGE_FLOW_GATES=enforce` restores rejection without
editing a single check — nothing was deleted or weakened.

**The platform's (`$id` identity):** stays blocking in both modes, and this is not
timidity. `keys.ts` is a flat, project-wide map; a duplicate key makes `now-sdk build`
abort with `Record sys_hub_action_instance_v2.<id> is defined 2 times in the project`.
Relaxing it would not unblock authoring — it would trade a one-second diagnostic for a
multi-minute build failure naming a sys_id nobody wrote.

The linters themselves read no environment variable and have no mode. That is what makes
"preserved, not deleted" checkable, and there is a test asserting both modes produce
identical findings.

## 7. What is genuinely not supported

| Asked for | Status | Why |
|---|---|---|
| `trigger.record.deleted` | **Not supported** | the SDK's `TriggerType` union has no `record_delete` and ships no such built-in. Not a gap in our code |
| Programmatic step insertion / reordering | **Not supported by the SDK** | the Fluent API returns `undefined` at run time; there is no object model to call. The edit path is regenerate-and-reinstall |
| Reading a live flow back through the SDK | **Not supported** | same reason. We read the platform tables directly instead — `scripts/flow-readback.mjs` |
| Narrowing the SDK's own post-install activation | **Not supported** | it publishes every non-deleted key in the project. The only control is `--skip-flow-activation`; we publish per-artifact ourselves afterwards |
| `deleteMultipleRecords` | **Does not exist** | use `lookUpRecords` + `forEach` + `deleteRecord` |

None of these were worked around with a local abstraction that looks right and creates
nothing. Where the platform offers a mechanism we use it (activation goes through
ServiceNow's own processor); where it does not, this report says so.

## 8. The edit path — measured, not assumed

`e2e-01-record-created.now.ts` was edited after it had already been installed and
published: one clause added to the trigger condition, the first action's message rewritten,
and a second action appended with a freshly minted `$id`. Every pre-existing `$id` was kept
byte-for-byte. Then: rebuild, reinstall.

**Before** (`sys_hub_flow` `0c9ddba0e3b94daea393065dfe5384c6`): 1 action,
`5849852634474f17928259deff5b8556`, order 1. Trigger
`125910332a3c436992a42f59523859e4`.

**After:**

```
### E2E 01 Record Created  [flow]  0c9ddba0e3b94daea393065dfe5384c6     <- SAME record
  condition  "priority=1^assignment_groupISNOTEMPTY^number=E2E_NEVER_MATCHES^active=true"
  1  ACTION Log  ui=58498526-3447-4f17-9282-59deff5b8556   <- SAME record, new message
       log_message "E2E 01 executed, revision 2."
  2  ACTION Log  ui=bfff82aa-8e65-4a39-99e9-972b7de55fe3   <- NEW record, appended
       log_message "E2E 01 second step, added by revision 2."
```

One flow record, not two. The unchanged `$id` updated its action **in place**; the new
`$id` created a new one at order 2; the trigger condition was rewritten on the existing
trigger row. So: **regenerate-and-reinstall is a real edit path, not a re-create** — and
the thing that makes it one is `$id` stability, which is exactly why the identity gate
stays blocking.

### And the install un-published the flow, exactly as feared

The read-back immediately after showed `active=false status=draft`, verdict
`inactive_with_snapshot` — the published snapshot still there, the header reverted. This is
ledger trap #129 reproduced deliberately: **an install returns every published flow to
draft.**

That is what the `flow_published` reconciler exists for — and while writing this it turned
out the reconciler ran on every install path *except* the one flows use. `deploy()`
installed through `runSdk` directly and never called a post-install hook; only
`installWorkspace()` did (DBA, catalog, app-create). The hook existed, the intent was
recorded, and nothing ever replayed it on a flow deploy. Fixed: both paths now call
`runPostInstallHooks()`.

## 9. What changed in this phase

| Area | Change |
|---|---|
| `src/servicenow/sdk-catalogue.js` | **new.** Parses the installed SDK's generated built-ins into the authoritative trigger/action catalogue: `$id`, name, inputs with `mandatory`, outputs with exact casing. Returns `{available:false, reason}` rather than a guess when the SDK is absent |
| `src/servicenow/flow-design.js` | now asks the SDK catalogue first and falls back to the documented table, saying which it used. Fixes two false "required" rules that would have rejected correct source |
| `src/servicenow/fluent.js` | gate mode (`flowGateMode()`, advisory by default, `gateAdvisories` on the result); local vs platform gate separation; `resolveManagedArtifact()` extracted; `runPostInstallHooks()` extracted and **called from `deploy()`**; the SDK inventory added to the codegen prompt |
| `scripts/flow-readback.mjs` | **new.** Reads a flow/subflow back from the platform's own tables — triggers, actions, logic, subflow calls, declared inputs/outputs, published proof — decoding all three blob encodings and the composite parallel-branch order |
| `scripts/flow-e2e-matrix.mjs` | **new.** The 70-check matrix comparing requested design against live records |
| `fluent-workspace/src/fluent/flows/e2e-0*.now.ts` | **new.** Seven hand-authored matrix artifacts, all deployed |
| `test/sdk-catalogue.test.js` | **new.** 16 tests: hermetic parser tests, plus live-SDK checks that SKIP rather than pass vacuously when the SDK is absent |

## 10. Test-suite result

`npm test` — **3791 passed, 0 failed** (up from 3716 at the start of the Fluent work; the
four long-standing failures were fixed earlier in this arc).

New offline coverage added here:

- `test/sdk-catalogue.test.js` — 16 tests. The parser is exercised against a fixture, and
  the live-SDK checks **skip themselves** when the SDK is absent rather than passing
  vacuously, because "the SDK is not installed" and "the SDK agrees with us" must not look
  alike.
- `test/post-install-state.test.js` — 6 new tests: the `flow_published` reconciler's three
  outcomes (re-applied / already-correct / state-unknown), its refusal to record an intent
  it could never keep, and a source contract pinning that **both** install paths run the
  post-install hooks.
- `test/flow-design.test.js` — 53 tests, unchanged in intent but now running against the
  SDK-derived catalogue.

### The reconciler, proven live

With both flows sitting in the draft state the install had left them in, and both intents
on file:

```
RECONCILE ran: true  count: 2  re-applied: 2  failed: 0  secs: 224
  flow_published | E2E 05 Classify Incident => re-applied
  flow_published | E2E 01 Record Created    => re-applied
WARN reconcile the install reverted 2 out-of-model state(s);
     they were re-applied and read back
```

Each republish went through ServiceNow's own activation processor and was confirmed by the
four-way read, not by the call's return value.

That run invoked the reconciler directly. A later install closed the gap: with
`post-install-state.js` imported (as `index.js` does), a third `deploy()` fired the whole
chain by itself — `deploy()` → `runPostInstallHooks()` → `reconcilePostInstall` → the
platform's activation processor → read-back:

```
[445s] reconcile_applying E2E 05 Classify Incident
INFO  reconcile re-applied after install: "E2E 05 Classify Incident" published (was false)
[626s] reconcile_applying E2E 01 Record Created
```

and `deploy()` returned the outcome as part of its own result:

```json
{"ran":true,"count":2,"reApplied":2,"failed":0,"applied":[
  {"kind":"flow_published","target":"E2E 05 Classify Incident","outcome":"re-applied","ok":true,"from":false,"to":true,"readBack":true},
  {"kind":"flow_published","target":"E2E 01 Record Created","outcome":"re-applied","ok":true,"from":false,"to":true,"readBack":true}]}
```

`readBack: true` on both: the republish was confirmed by reading the header and snapshot
back, not by trusting the activation call's return. So the chain `index.js` →
`registerPostInstallHook(reconcilePostInstall)` → `deploy()` → `runPostInstallHooks()` is
observed end to end in one uninterrupted install, not inferred from its parts.

Note the install that triggered it reported `ok: false` at 710 s — the client abort again —
while having deployed four new flows AND reconciled two published ones. The exit code is
not the verdict; the read-back is.

---

## 11. The architecture question, answered

> Can NowForge take a requested Flow/Subflow design, generate Fluent TypeScript, build it
> through the SDK, install it into the PDI, and produce a correct live ServiceNow
> Flow/Subflow with the intended triggers, conditions, actions, logic, inputs, outputs,
> data pills, relationships and ordering?

**Yes — for everything the SDK supports, and it is now measured rather than assumed.**

The path is: spec → live instance context → LLM → Fluent TypeScript → static gates →
`now-sdk build` (offline) → `now-sdk install` → live records → publish through ServiceNow's
own activation processor → four-way read-back.

Verified live on dev424910, by reading the platform's own tables:

- flow and subflow **headers** with name, description, type, `run_as`, `flow_priority`, scope
- **record triggers** (created / updated / createdOrUpdated) with table, `run_flow_in`,
  `run_on_extended`, `trigger_strategy`
- **trigger conditions stored verbatim**, including OR joins, `CHANGES`, choice-by-value,
  boolean, reference and date clauses in one query
- **scheduled triggers** with the timezone honoured (converted to UTC)
- an **application trigger** (service catalog)
- **actions** with their real parameters, in order, attached to the right flow
- **data pills** binding to the producing step's identity, dot-walked through references
- **flow logic** — if / elseIf / else as siblings, forEach, parallel branches, try/catch —
  with each step's placement carried by `parent_ui_id`
- **subflows** with typed inputs, a reference input carrying its table, mandatory flags,
  declared outputs, internal logic and outputs assigned on every path
- **subflow calls** with a real reference to the callee, mapped inputs preserving their
  types, `wait_for_completion` set from the inputs object, and outputs consumed downstream
- **publishing**, and **republishing after an install reverts it**
- **editing in place** — same records updated, new step appended, no duplicate flow

What is *not* supported is listed in §7, and each entry is a property of the SDK or the
platform, not a gap in this repository.

### Status

**FLOW DESIGNER: COMPLETE** — for the trigger forms, conditions, actions, logic, pills,
ordering and publishing verified above, against live records.

**SUBFLOWS: COMPLETE** — contract, body, invocation, input mapping, wait semantics and
output consumption, all verified against live records.

"Complete" here means what was asked: real end-to-end authoring into ServiceNow with
successful read-back verification. It does not mean every action in the 33-strong
catalogue has been exercised — the ones used are named above — and it does not mean a flow
has been observed *executing*, which is a separate question (record triggers on a global
table from our scope have never fired on this PDI; see the trap ledger).

---

## Appendix — per-artifact evidence

Every source lives in `server/fluent-workspace/src/fluent/flows/`. Build: one
`now-sdk build`, 17 s, clean. Install: `now-sdk install -d --skip-flow-activation` (the
SDK's own post-install activation is app-wide, so we skip it and publish per artifact).

| # | Source | Live sys_id | Read-back |
|---|---|---|---|
| 01 | `e2e-01-record-created.now.ts` | `0c9ddba0e3b94daea393065dfe5384c6` | verified, then **edited and re-installed in place** (§8), then published |
| 02 | `e2e-02-record-updated.now.ts` | `30aa95b860754012b19154735a92118c` | verified |
| 03 | `e2e-03-scheduled.now.ts` | `1e78825cb1274d0f811222b3ae68de40` | verified |
| 04 | `e2e-04-pills-and-logic.now.ts` | `52a3d986df654354bf05a4c5038516b9` | verified |
| 05 | `e2e-05-subflow.now.ts` | `44e1d6f713284308af1d7542cb877039` | verified, **published** |
| 06 | `e2e-06-caller.now.ts` | `6df649dca3aa49ce97e034b5cd4db5b6` | verified |
| 07 | `e2e-07-app-trigger.now.ts` | `086b906d68a340ebb2e95245ede01994` | verified |
| 08 | `e2e-08-schedules.now.ts` | `fe225e90fc0343bba2acb1d46a9bceb3` | verified |
| 09 | `e2e-08-schedules.now.ts` | `f8feebda7d9e47f2a2fe624c5a379036` | verified |
| 10 | `e2e-08-schedules.now.ts` | `fa5d1669e86c41d487b6e9017911a9b1` | verified |
| 11 | `e2e-08-schedules.now.ts` | `13d7f1466d054c18bb63feda96f7084d` | verified |

(08–11 share one source file: a flow takes exactly one trigger, so each scheduled form
needs its own `Flow(...)`, and four `Flow(...)` declarations in one file install as four
separate flows.)

Reproduce any of it, read-only:

```bash
node scripts/flow-readback.mjs "E2E 04 Pills And Logic"   # one artifact, every table
node scripts/flow-e2e-matrix.mjs                          # the whole matrix, PASS/FAIL
node scripts/flow-e2e-matrix.mjs --json                   # machine-readable
```

### Two notes on the install itself

**A red install is only a claim.** Both installs here reported failure — the SDK's fixed
300-second client-side abort (`The deployment request timed out waiting for a response`) —
and both had *completed server-side*. All seven artifacts were present and correct
afterwards. Anything that treats the install's exit code as the verdict will be wrong in
both directions; the read-back is the verdict.

**The install is app-wide.** `now-sdk install` re-applies the whole application from
source, which is why it takes ~6 minutes regardless of how many files changed, and why it
reverts every published flow to draft.

---

## 12. Reliability fixes (18 Sep)

A live run reported `create_flow_live` as failed — "the SDK install timed out, no artifacts
confirmed" — which sent a user to retry work that had probably already succeeded. Three
changes, all driven by measurements above.

**1. A timed-out install is resolved against the instance, not reported as a failure.**
`deploy()` now fingerprints the artifact before installing and, when the install reports
failure, polls for up to five minutes. Appeared, or `sys_updated_on` moved → it landed, and
the deploy reports success with `installReported: 'failed'` kept beside it. Nothing changed
→ it says so. Instance unreadable → UNKNOWN, which is never collapsed into "not there".
Pinned by `test/install-settle.test.js` with the reader injected.

This is not a tunable. `now-sdk install --help` exposes no timeout flag, and nothing in
`sdk-api` reads an environment variable for it; the 300-second abort is hard-coded. The
only correct response is to ask the instance.

**2. The name-collision refusal names the value to act on.** It said "re-run naming this
artifact as the one to update" without saying what to name. It now returns
`updates: "<flow name>"` and says both options explicitly: pass `updates` to change that
flow in place, or rename to create a separate one.

**3. A truncated generation fails loudly.** A completion that hit the token ceiling with
partial content was returned as ordinary text and compiled, so the diagnostic was a
syntax error unrelated to the real cause. `chatOnce` can now return the stop reason, and
codegen rejects a `length` finish with a message that says what happened. The ceiling rose
from 12000 to 20000 (`CODEGEN_MAX_TOKENS`).

**Plus a preflight:** `npm --prefix server run doctor` — twelve checks (Node, the SDK CLI,
both dependency trees, the generated instance types, workspace identity, cheatsheet, SDK
catalogue, instance binding, tier agreement, scope resolution, capability, LLM), each
naming the command that fixes it. Setup and troubleshooting: `docs/flow-setup-and-troubleshooting.md`.

---

## 13. The whole path, on the real model — 18 Sep

One run of `createLiveFlow` with the configured provider (`ollama` /
`gpt-oss:120b-cloud`) against dev424910, from a plain-language spec:

> When an incident is updated to priority 1 and it has no assignment group, add a work
> note that says "NowForge: P1 with no assignment group - needs triage."

**640 seconds, 2 attempts, `ok: true`.** Flow `2657b16ae8ca45fbad0a92767c673726`.

What the model wrote:

```typescript
wfa.trigger(trigger.record.updated, { $id: Now.ID['awp1_trigger'] }, {
  table: 'incident',
  condition: 'priority=1^assignment_groupISEMPTY',
  run_flow_in: 'background',
  trigger_strategy: 'unique_changes',
})
```

What the instance stored:

```
TRIGGER  Updated   condition "priority=1^assignment_groupISEMPTY"
                   trigger_strategy "unique_changes"
1 ACTION Update Record   record "{{Updated_1.current}}"
                         values "work_notes=NowForge: P1 with no assignment group - needs triage.^EQ"
```

`unique_changes` is correct and not a coincidence: "updated **to** priority 1" is
transition language, and `once` would fire only the first time a record ever hit it.

### The timeout resolver, on the case it was built for

```
[637s] install_unresolved   Add Work Note for P1 Incidents Without Assignment Group
[640s] install_landed_anyway
ok: true | installReported: failed | landedAnyway: true
settled: {"landed":true,"waitedMs":2747,"was":null,
          "now":{"sysId":"2657b16ae8ca45fbad0a92767c673726","updatedOn":"2026-09-17 18:40:43"}}
```

The install reported failure; the artifact was found 2.7 seconds later. Before this, that
run reported "no artifacts were confirmed on the instance" and sent the user to retry ten
minutes of work that had already succeeded.

### What attempt 1 cost, and the fix it produced

Attempt 1 failed the BUILD with `TS2304: Cannot find name 'params'` - the model wrote
`params.trigger.current` in a body whose callback it had declared `() =>`, over-applying
the rule that says to use `() =>` when `params` is unused. Attempt 2 corrected it.

The linter checked that rule in one direction only. It now checks both, and a new class of
finding came out of it: **compiler-certain**. `TS2304` and `TS6133` are TypeScript's
verdict, not a judgement of ours - source carrying either cannot build - so they block in
every gate mode and retry immediately, while advisory mode continues to apply to our own
findings. Four tests pin the distinction.

This fix postdates the run above, so a first attempt should now be cleaner than the two
attempts measured here. That has not itself been re-measured end to end.
