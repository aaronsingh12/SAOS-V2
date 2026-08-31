# ServiceNow Fluent SDK — Research Findings

Phase 0 research for NowHelpAssist live Flow Designer authoring.

**Status:** pipeline proven end-to-end on `dev442675.service-now.com`.
Everything below marked ✅ **verified** was executed against the real CLI/instance in this
repo, not read off a docs page. Where the published documentation contradicts the shipped
CLI, the CLI wins and the discrepancy is called out.

---

## 1. What actually ships

| Item | Value |
|---|---|
| npm package | `@servicenow/sdk` |
| Version used | **4.10.1** (`latest`) |
| Binaries | `now-sdk`, `sdk`, `now-sdk-debug` |
| Node requirement | 18+ (this machine: v24.18.0) |
| Install | `npm install -g @servicenow/sdk@latest` ✅ |

Release-aligned dist-tags exist: `washingtondc: 1.0.6`, `xanadu: 3.0.2`, `latest: 4.10.1`.
The SDK major tracks the platform release family; `latest` (4.x) worked against this PDI
without a compatibility flag. If a future instance is older, pin the matching dist-tag.

### `now-sdk explain` — the best documentation source

The CLI bundles its own reference docs, which are **more accurate and more complete than the
public docs site**:

```bash
now-sdk explain --list                 # ~200 topics
now-sdk explain wfa-flow-guide         # full guide text
now-sdk explain action-api             # every action.core.* signature
```

This matters for Phase 2: the codegen cheatsheet is derived from `explain` output, and the
same command can regenerate it when the SDK is upgraded.

---

## 2. Documentation errata (verified against `--help`)

The public CLI page at `servicenow.github.io/sdk/cli` lists **kebab-case flags that do not
exist**. Using them fails. Verified correct spellings:

| Public docs say | Actually shipped | Command |
|---|---|---|
| `--frozen-keys` | **`--frozenKeys`** | `build` |
| `--error-on-conflict` | **`--errorOnConflict`** | `build` |
| `--skip-clean` | **`--skipClean`** | `build` |
| `--legacy-choices` | **`--legacyChoices`** | `build` |
| `--app-name` | **`--appName`** | `init` |
| `--scope-name` | **`--scopeName`** | `init` |
| `--package-name` | **`--packageName`** | `init` |
| `--demo-data` | **`--demoData`** | `install` |

Flag casing is genuinely inconsistent within `install`: `--demoData` is camelCase while
`--skip-flow-activation` and `--open-browser` are kebab-case. Don't assume a convention;
check `--help`.

Also note: the brief's link for "headless auth" (`/config/keys-file`) is about
`src/fluent/generated/keys.ts` — the **sys_id mapping file**. It has nothing to do with
credentials. Real headless auth is in §4.

---

## 3. Project layout (verified)

`now-sdk init` is fully non-interactive when given all flags **and an existing stored
credential** — it contacts the instance to reserve the app record:

```bash
now-sdk init --appName "NowForge Flows" \
             --packageName nowforge-flows \
             --scopeName x_2196302_nwforge \
             --template base
```

Templates: `base`, `javascript.basic|react|aiux|aiux-extension`, `typescript.basic|react|vue`.

### Scope name constraints ⚠️

- Must start with the **instance's vendor prefix** — here `x_2196302_`
  (from `glide.appcreator.company.code`).
- **Maximum 18 characters total.** With a 10-char prefix that leaves 8.
- A mismatched prefix only produces a *warning*, then installs into an app that
  "may not install correctly". Get this right the first time.

`x_2196302_nwforge` (17 chars) is what NowHelpAssist uses.

### What `base` actually generates

```
server/fluent-workspace/
├── now.config.json              { scope, scopeId, name }
├── package.json                 devDeps: @servicenow/sdk, @servicenow/glide
├── .gitignore                   .now/ dist/ target/ node_modules/ *.tsbuildinfo
├── .vscode/extensions.json
├── @types/servicenow/           ← from `now-sdk dependencies` (needs instance)
│   ├── glide.client.d.ts
│   ├── glide.server.d.ts
│   └── tables.modules.d.ts      typed schema for every table on the instance
├── src/fluent/                  ← YOU create this; base template ships no src/
│   ├── flows/*.now.ts           flows AND subflows both live here
│   └── generated/keys.ts        ← auto-generated Now.ID → sys_id map
└── dist/app/                    build output
    ├── scope/sys_app_<scopeId>.xml
    └── update/sys_hub_flow_<sysid>.xml, sys_module_*.xml ...
```

Two surprises worth knowing:
1. **The `base` template creates no `src/` directory at all.** You must create
   `src/fluent/flows/` yourself before the first build.
2. The stock `.gitignore` already covers all build artifacts — no extra ignore rules needed.

---

## 4. Headless authentication (the part the docs bury)

Two independent mechanisms. NowHelpAssist uses (a) today and should support (b) for CI.

### (a) Stored credential aliases — what this machine uses ✅

```bash
now-sdk auth --list          # shows aliases, hosts, usernames; never prints secrets
now-sdk auth --use <alias>   # set default
```

Current state on this machine:

```
*[snada-pdi]
      host = https://dev442675.service-now.com
      type = basic
      username = admin
      default = Yes
```

Because a default alias exists, `init` / `install` / `dependencies` / `query` all run
**non-interactively with no env vars and no password in the repo**. Commands accept
`-a/--auth <alias>` to target a specific instance.

To add one fully non-interactively (undocumented on the docs site — found in `auth --help`
examples; note `--username` / `--password-stdin` are not listed in the flags table but work):

```bash
echo "$SN_PASSWORD" | now-sdk auth --add https://devXXXXXX.service-now.com \
    --type basic --alias my-pdi --username admin --password-stdin
```

### (b) CI environment variables (no stored alias)

```bash
export SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL
export SN_SDK_AUTH_TYPE=basic
export SN_SDK_INSTANCE_URL=https://devXXXXXX.service-now.com
export SN_SDK_USER=admin
export SN_SDK_USER_PWD=...
now-sdk install
```

OAuth variant (preferred for production): `SN_SDK_AUTH_TYPE=oauth` with
`SN_SDK_OAUTH_CLIENT_ID` / `SN_SDK_OAUTH_CLIENT_SECRET`.

**What Phase 2 actually shipped:** the server drives the SDK through the **stored alias** (a),
not the env vars. The alias already exists on this machine, works non-interactively, and keeps
the instance password out of the Node process entirely — NowHelpAssist never handles it. Mechanism
(b) remains the documented path for CI, where no credential store is present.

Note the two credential stores are independent: the SDK's alias store is separate from
NowHelpAssist's `server/data/settings.json`, so they can point at different instances.
`capability()` compares the alias host against the configured instance URL and the UI warns on
a mismatch, since flows would otherwise deploy somewhere other than the instance being read.
(There is no `.env` anywhere in this project — see §9.)

---

## 5. Build and install semantics (verified)

### `now-sdk build` runs offline ✅ — architecturally important

`build` printed no "Attempting to log into instance" line and completed successfully, whereas
`init`, `dependencies`, and `install` all print one. So:

> Once `@types/` has been fetched once via `now-sdk dependencies`, **`build` validates
> generated TypeScript with zero instance contact.**

This is exactly what the mission needs: the codegen loop can compile-check LLM output and
reject bad Fluent *before the instance is ever touched*. `dependencies` is the only
network-dependent setup step, and it is a one-time (per-schema-change) cost.

Exit codes: `0` on success, **`1` on compile failure**, with TypeScript diagnostics carrying
file, line, column and TS error code — precisely the text to feed back to the model on a retry.
Observed format (ANSI colour codes present; strip them before prompting):

```
[now-sdk] ERROR: src/fluent/flows/daily-p1-digest.now.ts:21:6 - error TS6133: 'params' is declared but its value is never read.
[now-sdk] ERROR: Found 1 diagnostic error(s) while building the project.
[now-sdk] ERROR: Build failed due to errors
```

This was a real failure hit while writing the examples, and it is the single most likely class
of LLM mistake: **`noUnusedParameters` is enforced.** A scheduled flow's body must be declared
`() => {`, not `(params) => {`, because scheduled triggers expose no `current` record. The
cheatsheet calls this out as a hard rule.

### `now-sdk install` — flows auto-activate ✅

```
[now-sdk] Rollback (undo installation): https://.../sys_rollback_context.do?sys_id=7840f401...
[now-sdk] Flow activation complete: 3/3 succeeded
[now-sdk] Installation completed. Access the application at: https://.../sys_app.do?sys_id=c44f3c6c...
```

Three things to exploit:
- **`Flow activation complete: N/N succeeded`** is a parseable success signal.
  `--skip-flow-activation` disables it; do not pass that flag.
- Every install prints a **rollback URL** (`sys_rollback_context`) — a genuine undo path worth
  surfacing in the NowHelpAssist UI.
- The app URL contains the scope sys_id, so a deep link is derivable without another query.

`-r/--reinstall` uninstalls then reinstalls. It **destroys on-instance metadata not present
locally** — never use it as a routine deploy.

### Read-back without REST credentials ✅

`now-sdk query` reads any table using the stored alias, with JSON output:

```bash
now-sdk query sys_hub_flow -q "sys_scope.scope=x_2196302_nwforge" \
    -f sys_id,name,active,type -o json
```

Useful as a verification path that doesn't depend on `server/.env` being populated.
It is **read-only** — there is no SDK write command, so creating test records for an
execution test still requires the Table API (i.e. `server/.env`).

---

## 6. Identity and deletion

### `Now.ID` → `keys.ts`

`$id: Now.ID['descriptive-key']` maps a human key to a generated sys_id recorded in
`src/fluent/generated/keys.ts`. On rebuild the same key resolves to the same sys_id, so
**redeploying updates in place instead of creating duplicates** — this is the idempotency
mechanism Phase 3 requires. `keys.ts` must be committed; it is the source of truth for record
identity. `now-sdk build --frozenKeys` fails the build if keys would change, which is the
right guard for CI.

Never let a model invent a sys_id. Every `$id` must be a `Now.ID[...]` key.

### Deletion

For records the SDK created, **delete the source file** — removal is tracked automatically and
the record is deleted on the next `install`. `Now.del(table, keysOrSysId)` is for *out-of-box*
records the SDK didn't create. So `remove(name)` in Phase 2 = delete the `.now.ts` file +
rebuild + reinstall.

---

## 7. Flow authoring model (summary — full syntax in the cheatsheet)

A flow is exactly three arguments: config, one trigger, one body callback.

```typescript
Flow(
  { $id: Now.ID['...'], name: '...', runAs: 'system' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['...'] }, { table: 'incident', condition: '...' }),
  (params) => { /* wfa.action / wfa.subflow / wfa.flowLogic.* */ }
)
```

Constraints that bite (all confirmed in the bundled guides):

- **Exactly one trigger per flow.** Subflows have none.
- **Never assign a data pill to a variable.** `wfa.dataPill(...)` goes directly inside an
  action parameter. Capturing an *action result* in a `const` is correct and required; capturing
  a *data pill* is not.
- **Template literals interpolate in `ah_subject` and `log_message` only.** Not in `ah_body`,
  not in SMS `message`, and not inside `TemplateValue({...})` — pass the bare data pill there.
- **No JavaScript in flow-logic conditions.** `if`/`elseIf`/`else` take encoded queries only;
  `javascript:gs.daysAgoStart(30)` fails. JS is allowed in *table action* conditions.
- **Action parameter names are inconsistent by design** — `values` (createRecord/updateRecord)
  vs `field_values` (createTask/updateMultipleRecords) vs `fields` (createOrUpdateRecord) vs
  `ah_*` (catalog task). Always check `action-api`.
- **`lookUpRecord` outputs are capitalised** — `Record`, `Table`; `lookUpRecords` gives
  `Records`, `Count`. Most other actions use lowercase `record`. This is the single easiest
  thing for an LLM to get wrong.
- **`waitForCompletion` belongs in the subflow's *inputs* object** (3rd arg), not the instance
  config (2nd arg).
- `TemplateValue`, `Time`, `Duration`, `Now.ID` are **globals** — importing them is an error.
- There is no `deleteMultipleRecords`; use `lookUpRecords` + `forEach` + `deleteRecord`.

---

## 8. Phase 1 proof — what is live right now ✅

Built and installed from `server/fluent-workspace`, then read back off the instance:

| Artifact | sys_id | type | active |
|---|---|---|---|
| P1 Network Escalation | `ee327e93b62847e4901ba23b1b31e03f` | flow | **true** |
| Notify Manager | `af90366362d04879b7ab39f6dc66bcc1` | subflow | **true** |
| NowForge Smoke Test | `317907f254684c749d9b458f84e30938` | flow | **true** |

- Trigger instance confirmed on the flow (`trigger_type = record_create`).
- Subflow inputs confirmed on the instance: `Task Table`, `Task Sys ID`, `Message`.
- Both UC files compiled clean on the **first** `now-sdk build` — the syntax in the cheatsheet
  is build-verified, not guessed.

**Note on duplicate rows (corrected in Phase 2):** querying action instances by
`flow.name=<name>` returns them in pairs (order 1,1,3,3,5,5), because Flow Designer keeps a
published *snapshot* record carrying the same name as the master. Querying by
`flow=<sys_id>` returns each step exactly once, so `detail(sysId)` is unaffected and needs no
deduplication.

### Execution proof ✅

Created a P1 incident against the Network group via NowHelpAssist's own Table API client, then
watched the flow run:

```
created: INC0010005  priority = 1 - Critical
sys_flow_context: [{ name: 'P1 Network Escalation', state: 'In Progress' }]   (~3s)
assigned_to : Bow Ruggeri            ← the Network group's manager
work_notes  : ['P1 Network Escalation: the Network group manager has been notified.']
deleted test incident INC0010005
```

Both the work note *and* the manager assignment landed, and they are steps 3 and 4 — i.e.
downstream of the `wfa.subflow(...)` call at step 2 with `waitForCompletion: true`. **The
subflow wiring is therefore proven**, not just present. The test incident was deleted and a
follow-up query confirms it is gone.

### ⚠️ Bug found in NowHelpAssist's existing readers — `_v2` tables

`flows.detail()` in `server/src/servicenow/flows.js` queries `sys_hub_trigger_instance`,
`sys_hub_action_instance`, and `sys_hub_flow_logic`. On this release those return **nothing**:

```
triggers(non-v2): 0   actions(non-v2): 0   logic(non-v2): 0
triggers(_v2):    1   actions(_v2):    3
```

The current tables are **`sys_hub_trigger_instance_v2`**, **`sys_hub_action_instance_v2`**, and
**`sys_hub_flow_logic_instance_v2`** — confirmed independently by the generated `keys.ts`, which
maps SDK records to exactly those `_v2` table names. Phase 2 must update these readers, ideally
querying `_v2` first and falling back to the legacy names for older instances.

Second, smaller issue: `flows.list()` hardcodes `type=flow`, so **subflows are invisible** in
the NowForge Flows page. `Notify Manager` (`type=subflow`) does not appear. Live authoring
creates subflows, so the list needs to include them (and label the type).

---

## 9. Open items / risks

| Item | Status |
|---|---|
| `server/.env` does not exist — **and is not needed** | The brief asks for `server/.env`, but nothing in this codebase reads `.env` (no `dotenv`, no `process.env` for connection). Credentials live in **`server/data/settings.json`** via `config/store.js`, and were already correctly populated for `dev442675`. Phase 2 should keep using the settings store; if `.env` support is wanted it must be added deliberately. |
| Repo is not a git repo | No `.git` present, so the per-phase commits the brief asks for **cannot be made**. Needs `git init` before Phase 2. |
| `_v2` reader bug | See §8 — `flows.detail()` returns empty for every modern flow. Fix in Phase 2. |
| Subflows hidden from the UI | `flows.list()` filters `type=flow`. Fix in Phase 2. |
| `forEach` pill type ambiguity | **Resolved.** `wfa.dataPill(result.Records, 'records')` compiles against a `lookUpRecords` output; `'array.object'` is the underlying generic form. Use `'records'`. |
| UC3 built but not deployed | `daily-p1-digest.now.ts` is build-verified and sits in the workspace, deliberately **not installed** — Phase 3 owns its deployment. The next `now-sdk install` will deploy it. |
| Serialized deploys | `build` writes to a shared `dist/`, so concurrent builds in one workspace would race. Phase 2's queue must serialize (already planned). |
| UC4 approvals | `askForApproval` + `wfa.approvalRules()` are fully documented and appear usable; not yet built. |

---

## 10. Phase 2 findings (codegen pipeline)

Everything here was measured while wiring `server/src/servicenow/fluent.js`.

### Build exclusion is by location, not configuration ✅

There is **no build-level exclude glob**. `now-sdk build` scans `fluentDir` (default
`src/fluent`) for `.now.ts` files; the config's `excludeFilePatterns` applies to
`now-sdk transform` only. So `server/fluent-workspace/staged/`, sitting outside the scanned
tree, is excluded by construction — verified by rebuilding and watching
`sys_hub_flow_b2f18c96….xml` disappear from `dist/app/update/`.

### Removing a source is a pending DELETE ✅

The build records removals in `keys.ts` as `deleted: true` while **retaining the sys_id**:

```typescript
daily_p1_digest_flow: { table: 'sys_hub_flow', id: 'b2f18c96…', deleted: true }
```

The next `install` deletes that record from the instance, and restoring the source later
reuses the same identity. This is the mechanism behind `removeManaged()` — confirmed live:
deleting "Auto triage incident" removed it, and an independent read-back returned zero rows.

### Cost of the CLI, and what actually proves auth

Every `now-sdk` invocation pays ~5s of start-up:

| Command | Time | Contacts instance? |
|---|---|---|
| `now-sdk --version` | ~5s | no |
| `now-sdk auth --list` | ~5.5s | **no** — reads the local credential store |
| `now-sdk install --info` | ~2.3s | prints a URL only; not an auth proof |
| `now-sdk query sys_user -f sys_id --limit 1` | ~8.5s | **yes** — the cheapest real proof |

So `capability()` is shallow by default (version + stored credentials, ~6s, cached 30s) and
takes `deep: true` to run the authenticated query. `auth --list` proving a credential *exists*
is not the same as proving it still *works* — the API reports `verified: 'stored' | 'live' | 'failed'`
so callers can tell which claim they have.

Parsing gotcha: every CLI line is prefixed `[now-sdk] …`, so a naive `\[([^\]]+)\]` block regex
matches the log prefix as a credential alias. An alias header is a bracketed token **alone on
its line**, and a block with no `host =` is a log line.

### Windows cannot `execFile` the CLI

`now-sdk` is a `.cmd` shim: `execFile('now-sdk')` → `ENOENT`, `execFile('now-sdk.cmd')` →
`EINVAL` (Node ≥20 refuses batch files without `shell: true`). Rather than enable a shell,
the service spawns `node <sdk>/bin/index.js` and passes **only fixed literal arguments** —
no injection surface. Anything needing user-supplied values (read-back by name) goes through
the REST client instead.

### Compile diagnostics are good enough to self-repair

Failure output is precise and machine-usable:

```
[now-sdk] ERROR: src/fluent/flows/x.now.ts:27:33 - error TS2551: Property 'deleteMultipleRecords'
  does not exist on type '{ ... }'. Did you mean 'updateMultipleRecords'?
[now-sdk] ERROR: Found 2 diagnostic error(s) while building the project.
```

Exit code 1, ANSI colour codes present (strip before prompting). Feeding this back verbatim
is what drives the retry loop. An intentionally-invalid spec burned all 3 attempts, then the
candidate was deleted and the workspace rebuilt: `src/` returned to its exact prior file list,
`keys.ts` gained no orphaned keys, and every artifact on the instance kept its original
`sys_updated_on`.

### The failure mode that compiles cleanly ⚠️

The sharpest lesson of this phase: **a semantically wrong flow is still a valid flow.**

"when a change request is created with risk set to High" generated `condition: 'risk=4'`. It
compiled, installed, and activated — but on this instance `risk` is High=2, Moderate=3,
**Low=4**, so the flow was built to fire on Low risk. Nothing in the toolchain can catch this;
only reading the choice list can.

Cause was the prompt, not the model: the live-context block emitted `risk (integer) [2|3|4]`,
values with no labels. It now emits `choices[2=High, 3=Moderate, 4=Low]` and instructs the
model to use the numeric value and never assume a conventional ordering. Re-running the same
spec produced `risk=2`, verified by read-back — and reused the same sys_id, confirming
deterministic filenames plus `Now.ID` update in place rather than duplicating.

Generalisation: any instance-specific encoding (choice values, catalog variable type codes,
state models) must be *given* to the model, never inferred.

### Reasoning models silently truncate

Not an SDK issue, but it blocks codegen. `gpt-oss` bills hidden reasoning tokens against
`max_tokens` and returns **HTTP 200 with empty `content`** and `finish_reason: 'length'` when
the budget is exhausted:

```json
{ "message": { "content": "", "reasoning": "The user request: …" }, "finish_reason": "length" }
```

At `max_tokens: 40` content was empty; at 400 the same prompt answered correctly. The adapter
now raises a specific error instead of returning an empty string, and codegen budgets are
sized for reasoning models (intent 3000, generation 12000).

### Nothing was blocked

No SDK limitation prevented any Phase 2 requirement. Live authoring, subflows, offline
validation, idempotent redeploy, and deletion all work through supported commands.

---

## 11. Phase 3 findings (semantic verification)

### No supported manual-execute path for scheduled flows ⚠️

Checked before building the verification layer, because firing a scheduled flow on demand
would be the cleanest way to verify one:

- **`now-sdk --help`** exposes no run/execute/trigger command. The only execution-related
  commands are `cicd test run` and `cicd testsuite run`, which run **ATF** tests — that
  requires authoring ATF artifacts, not executing a flow.
- **`sn_fd.FlowAPI`** (`FlowAPI.getRunner().flow('scope.name').inBackground().run()`) exists,
  but it is **server-side script only**. Reaching it over REST would mean creating a Scripted
  REST API or running a background script purely to trigger a flow — neither is a supported
  path, and both are exactly the kind of hack this project refuses.
- Forcing the platform scheduler (editing the `sys_trigger` row's `next_action`) manipulates
  internals and is not verification of the flow's own schedule.

**Consequence:** scheduled flows are verified by **metadata assertion** against the decoded
`trigger_inputs` config — the flow is active, a scheduled trigger exists, and the cadence
fields carry the expected values. `verifySchedule()` returns an explicit `caveat` saying this
proves the schedule is *configured*, not that it *fired*. Waiting on wall-clock firing is not
an option a verification run can take.

### `.verify.json` next to sources is safe ✅

The build scans `fluentDir` for `.now.ts` only. A `probe-test.verify.json` placed in
`src/fluent/flows/` built cleanly and produced no extra artifact, so verification specs can
live beside their source (same slug) without polluting the app.

### Journal fields need a different read path

`work_notes` and `comments` are journal fields: a plain `GET` returns them empty, because the
entries live in `sys_journal_field` keyed by `element_id` + `element`. Any assertion on a work
note has to read that table instead — this is why the Phase 1 manual proof queried
`sys_journal_field` directly. `readFieldValue()` detects journal types from the schema and
switches read path automatically, and compares by **containment** (journals accumulate
entries) while every other field compares **exactly**.

### sys_flow_context states

```
terminal ok   : COMPLETE
terminal bad  : ERROR, CANCELLED, PRESUMED_INTERRUPTED
settled-paused: WAITING, PAUSED          ← an approval flow legitimately stops here
in flight     : IN_PROGRESS, QUEUED, CONTINUE_SYNC, PAUSED_IN_DEBUG
```

The runner treats settled-paused as assertable (effects before the pause have landed), which
is what makes approval flows verifiable at all.

### Whole-app install touches every artifact's `sys_updated_on`

Measured during the Step 0 clean-up: deleting two flows advanced `sys_updated_on` on **all
three** surviving artifacts, because `install` redeploys the entire application. Idempotency
must therefore be measured as *same sys_id, no new rows* — never as *timestamps unchanged*.

---

## 12. Phase 4 — the duplicate-identity failure class ⚠️

A live codegen run failed **all 3 build attempts** with an SDK abort that never appeared before:

```
Record sys_hub_flow_logic_instance_v2.3f6799c741524cc3afadf8bbd2a3e52d is defined 2 times in the project
Record sys_hub_action_instance_v2.10c0ec9dcf0c486ab1e40f73c0edbe8d   is defined 2 times in the project
```

The offline build gate held exactly as designed: **zero instance mutation**, three attempts, then
a stop-and-ask. Nothing was deployed. What follows is the diagnosis.

### The mechanism: `$id` keys are a PROJECT-GLOBAL namespace

This is the part that was never written down. `$id: Now.ID['add_work_note']` does **not** mean
"an element called add_work_note inside this flow". `keys.ts` is a **flat, project-wide map**:

```typescript
add_work_note:        { table: 'sys_hub_action_instance_v2',      id: '10c0ec9dcf0c486ab1e40f73c0edbe8d' }
if_priority_critical: { table: 'sys_hub_flow_logic_instance_v2',  id: '3f6799c741524cc3afadf8bbd2a3e52d' }
```

One key → one sys_id, for the whole application. So when a *second* flow declares
`Now.ID['add_work_note']`, it does not get a fresh record — it resolves to **the same sys_id as
the first flow's action**, and the build aborts because one record is now claimed by two flows.

`HARD RULE 2` told the model the $id must be *"unique within the file"*. That is the bug in one
line: **the constraint is project-wide, and the rule said file-wide.**

### Evidence — Step 1a, source inventory

`ls server/fluent-workspace/src/fluent/flows/` at diagnosis time (8 sources, 5 verify specs):

| source | tracked | `.verify.json` | note |
|---|---|---|---|
| `daily-p1-digest.now.ts` | yes | — | scheduled; verified by metadata |
| `demo-incident-flow.now.ts` | **no** | **missing** | ⚠️ see below |
| `demo-incident-priority-notification.now.ts` | no | yes | |
| `escalate-network-p1-incident.now.ts` | yes | yes | |
| `handle-high-priority-incident.now.ts` | no | yes | last good deploy, 10:51 |
| `high-risk-change-approval.now.ts` | yes | yes | |
| `notify-p1-incident-assignment-group-manager.now.ts` | no | yes | |
| `smoke-test.now.ts` | yes | — | |

**No candidate from the failed run survived** — invariant (b) held. The `flows/` directory mtime
is `11:03:06` with no file carrying that mtime, which is the signature of a create-then-delete:
the candidate was written and swept. `keys.ts` was rewritten at `11:03:13` by the cleanup build.

`demo-incident-flow.now.ts` is a **hygiene smell but not the cause**: it is a real deployed
artifact (it owns flow `ba6a8fa5…` on the instance) that was never committed and never got a
verification spec. It is unmanaged, not stray.

### Evidence — Step 1b, the two definition sites

```
$ grep -rn "3f6799c7\|10c0ec9d" server/fluent-workspace/
src/fluent/generated/keys.ts:14   id: '10c0ec9dcf0c486ab1e40f73c0edbe8d'   ← key add_work_note
src/fluent/generated/keys.ts:390  id: '3f6799c741524cc3afadf8bbd2a3e52d'   ← key if_priority_critical
```

The raw sys_ids appear **only** in `keys.ts` — sources never write them, they write the *key*.
Resolving each key to its declaring source:

```
$ grep -rn "add_work_note\|if_priority_critical" src/
escalate-network-p1-incident.now.ts:110   { $id: Now.ID['add_work_note'] }         → 10c0ec9d…
demo-incident-flow.now.ts:32              $id: Now.ID['if_priority_critical'],     → 3f6799c7…
```

And `dist/` proves both sys_ids were already **owned by deployed flows** before the failed run:

```
dist/app/update/sys_hub_flow_55a03b37….xml:61   <sys_id>10c0ec9dcf0c486ab1e40f73c0edbe8d</sys_id>
dist/app/update/sys_hub_flow_ba6a8fa5….xml:123  <sys_id>3f6799c741524cc3afadf8bbd2a3e52d</sys_id>
```

### Diagnosed class: **CLASS C**

Both duplicated sys_ids **already existed in previously deployed artifacts** (`Escalate Network
P1 Incident` and `Demo Incident Flow`). The failing candidate declared `add_work_note` and
`if_priority_critical` a *second* time, and each collided with a different existing flow.

- Not **CLASS A**: the collisions are candidate-vs-existing, not two `$id`s inside one file.
  Cross-checking all 60 `Now.ID` keys across the 8 surviving sources reports **zero** duplicates.
- Not **CLASS B**: no stray candidate from a prior failure was involved. The second definition
  site in each pair is a legitimately deployed artifact, not a leftover.

### Why the model reached for those two keys

The spec under generation said *"add a work note on the incident"* and *"If the incident's
priority is Critical"*. The model named its elements **semantically** — `add_work_note`,
`if_priority_critical` — which is exactly what a sensible author does, and exactly what
collides, because two different flows that both add a work note converge on the same name.

The cheatsheet makes this worse rather than better: it is fed into every codegen prompt as
"authoritative, build-verified" and its examples use **the live keys of deployed sources
verbatim** — `notify_manager_subflow`, `nm_lookup_task`, `nm_send_email`, `nm_outputs_sent`,
plus bare keys like `log`, `note`, `set`, `t`, `step`, `guard`. Any of those copied into a new
flow reproduces this failure immediately. Semantic convergence and example-copying are the same
defect: **a key that is not freshly minted is a live sys_id belonging to someone else.**

### Rejected fix: timestamp-suffixed keys

The runtime agent proposed suffixing keys with a timestamp. **Rejected.** That guarantees a
different key on every regeneration, which is precisely the Phase 3 identity defect in §6:
`Now.ID` stability is what makes redeploy *update in place* instead of duplicating. A spec that
regenerates must keep its sys_ids. Random or time-based identity is never the answer here —
uniqueness has to come from a **namespace**, not from entropy.

### Fix: three guards (see §13)

1. **Pre-build static validation** of every candidate — duplicate `$id` within the candidate, or
   collision with any other project source, is rejected *before* `now-sdk build`, with a precise
   retry diagnostic naming the key and both definition sites.
2. **Retry hygiene invariant** — every attempt for one request targets the same
   fingerprint-derived filename, never the model's chosen flow name; `src/` is swept before each
   request and *asserted* back to its pre-request state after a failure.
3. **Context sanitation** — `$id` keys in any source fed back into the prompt are neutralised
   (names kept), and the cheatsheet carries a HARD RULE with the mint format.

---

## 13. The three identity guards (Phase 4 fix)

All three are **offline**. None of them can touch the instance, and all three run before
`now-sdk build` is spawned. `npm test` in `server/` exercises them (18 tests, no network).

### Guard 1 — pre-build static validation ✅

`validateCandidateIds(candidate, others, { file })` parses every `Now.ID['key']` out of a
candidate and rejects it *before* the SDK runs when:

| check | why |
|---|---|
| same key twice inside the candidate | CLASS A |
| key already declared by another source in `src/` | CLASS B / CLASS C |
| literal 32-hex sys_id used as an `$id` | identity the SDK cannot track |
| leftover `__ID_n__` placeholder | guard 3 round-trip failed; never ship it |

The value is the *diagnostic*. The SDK aborts with a sys_id the model never wrote:

```
Record sys_hub_action_instance_v2.10c0ec9dcf0c486ab1e40f73c0edbe8d is defined 2 times in the project
```

There is nothing in the model's own source matching that string, so the retry is blind — which
is why all three attempts failed identically. The guard says instead:

```
ERROR: identity validation failed before build.
ERROR: Duplicate $id across the project: Now.ID['add_work_note'] is defined 2 times —
candidate-<fp>.now.ts:8 and escalate-network-p1-incident.now.ts:8. Now.ID keys are a
PROJECT-WIDE namespace: this key already identifies a live record owned by
escalate-network-p1-incident.now.ts, so reusing it collides instead of creating a new element.
Mint a fresh key unique to this flow (prefix every key with a short slug of this flow's name,
e.g. 'vhp_add_work_note').
```

It names the key, both definition sites, the rule, and the repair. It is shaped like compiler
output so the existing retry prompt feeds it back unchanged — **a cryptic abort became a
self-correcting retry**. A rejected candidate is never written to `src/`, so an identity failure
costs no disk state and no SDK invocation at all.

### Guard 2 — retry hygiene, asserted ✅

- **One filename per request.** Every attempt writes `candidate-<spec-fingerprint>.now.ts`.
  The model's chosen flow name no longer selects the file it is written to; a new artifact is
  renamed to its readable slug **only after it builds**, and never onto a name another spec
  already owns (that returns a loud `stage: 'naming'` failure instead of clobbering a live
  artifact's source).
- **Sweep on entry.** Any `candidate-*.now.ts` on disk means an earlier request died without
  cleaning up. It is removed and reported (`hygiene_swept`) before the run starts.
- **Cleanup is proven, not assumed.** `src/` is snapshotted (content-addressed) after the sweep
  and diffed after a terminal failure. The result carries
  `hygiene: { restored, drift, sweptOnEntry }`, and a non-empty `drift` changes the failure
  message. Invariant (b) is now an assertion the pipeline reports on.
- **Latent bug fixed.** The old terminal-failure path ran `rm(file)` — but on a *regeneration*
  `file` is the deployed artifact's own source. Three failed attempts at editing an existing
  flow would have deleted it from `src/`, and the next whole-app install would have deleted it
  **from the instance**. Restore-from-snapshot replaces the delete.

### Guard 3 — context sanitation ✅

Every source fed into the codegen prompt has its `Now.ID` keys swapped for `__ID_n__`
placeholders through one shared map, and the real keys are substituted back into the model's
output. Two consequences:

- The model **never sees a live key**, so it cannot copy one — the CLASS C vector is closed at
  the source rather than argued against in prose.
- Identity of a regenerated artifact is preserved **mechanically**. Previously the prompt asked
  the model to keep every `Now.ID` key verbatim and trusted it; now keeping a placeholder is the
  only thing it *can* do, and the mapping back is deterministic. This is strictly stronger than
  the old instruction, and the `sanitize → edit → restore` round trip is unit-tested.

`name:` values are never touched — the verbatim-name survival mechanism is what keeps the
platform matching the same artifacts, and it stays exactly as it was.

Cheatsheet examples are prefixed `ex_` before being embedded. Its snippets are **real deployed
sources**, so `Now.ID['nm_send_email']` in an example is a *live key*; copying it reproduced the
collision exactly.

### The rule that was wrong, in both places

`HARD_RULES` rule 2 (`fluent.js`) and rule 2 of the cheatsheet's non-negotiables both said keys
must be unique **"within the file"**. Both now state the project-wide namespace, forbid copying
from examples or existing sources, forbid entropy-based uniqueness, and give the **mint format**:

```typescript
// Flow "Vendor Hold Problem" → prefix vhp_
$id: Now.ID['vhp_trigger']
$id: Now.ID['vhp_create_problem']
$id: Now.ID['vhp_if_critical']
```

The prefix supplies uniqueness; the suffix supplies readability. Bare keys (`log`, `note`,
`set`, `add_work_note`, `if_priority_critical`) are precisely the ones that collide.

---

## 14. Phase 4 live test — the vendor-hold spec

Driven through `createLiveFlow()` → `verify()`, the entry point the panel route
(`POST /api/flows/live`) and the agent tool `create_flow_live` both call. Provider: Ollama
`gpt-oss:120b-cloud`.

### Deploy ✅

| | |
|---|---|
| build attempts | **1** |
| activation | **10/10** |
| flow | `Create Problem for On Hold Vendor Incidents` — `39acb67eac164650a6b15f5e724cae76`, active |
| structure read back | 1 trigger, 5 actions, 1 logic block |
| element keys | `vpo_trigger_updated`, `vpo_lookup_hw_group`, `vpo_create_problem`, `vpo_update_incident_problem`, `vpo_add_work_note`, `vpo_if_critical`, `vpo_assign_problem_manager` |

Every key is flow-prefixed and freshly minted. Across all six live runs the identity guard never
had to reject a candidate — the HARD RULE alone was enough once the cheatsheet stopped handing
out live keys.

### The guards, measured live ✅

- **Guard 2** — every attempt wrote `candidate-0a8c04f64afd4b31.now.ts`, the spec fingerprint,
  including a run where attempt 1 failed on `TS4111` and attempt 2 succeeded. The model named the
  flow *"Create Problem for On Hold Vendor Issues"*, *"...Vendor Incidents"* and *"...On Hold
  Vendor Incident"* on different runs; not one of those names ever selected a filename.
- **Guard 3** — on the regeneration path the deployed source went to the model with its keys
  replaced by `__ID_n__`, and came back with **every `cphv_*` key byte-identical** and the
  artifact name preserved verbatim, while the body changed. Identity survived mechanically.

### Trigger and condition, as generated

```typescript
wfa.trigger(
    trigger.record.updated,
    { $id: Now.ID['vpo_trigger_updated'] },
    { table: 'incident', condition: 'state=3^hold_reason=4', run_flow_in: 'background' }
),
// lookup:  conditions: `sys_id=8a5055c9c61122780043563ef53438e3`
// if:      condition: `${wfa.dataPill(params.trigger.current.priority, 'integer')}=1`
```

**Encoded values, not display labels** — confirmed against the instance's own choice lists:

| written | means | label on this instance |
|---|---|---|
| `state=3` | `state` value 3 | On Hold |
| `hold_reason=4` | `hold_reason` value 4 | Awaiting Vendor |
| `priority ... =1` | `priority` value 1 | 1 - Critical |
| `sys_id=8a5055c9…` | resolved sys_id | the Hardware group |

Not one display label leaked into a query. The group is matched by resolved sys_id rather than by
name, which is what the rewritten NO MATCH guidance pushes the model toward.

### Verification: create-then-update works, one promise is unsatisfiable

The runner extension fired correctly. Setup created the incident **outside** the trigger
condition, then transitioned it in, and the platform's computed value was read back:

```
transition -> incident_state: On Hold (3), hold_reason: Awaiting Vendor (4), priority: 1 - Critical
flow execution state: COMPLETE
```

`priority` was driven through `impact=1` + `urgency=1` and landed as Critical, never written
directly. A record-UPDATED trigger is now reachable; before this extension it was not.

**Direct read-back counter-probe of all five promised effects** (measurement, not a
model-authored assertion):

| | promise | expected | actual |
|---|---|---|---|
| ✅ | problem created, description prefixed | `Vendor issue: Counter probe alpha` | `Vendor issue: Counter probe alpha` |
| ✅ | problem assigned to Hardware | `Hardware` | `Hardware` |
| ❌ | incident's Problem field links back | `PRB0040006` | **no such field on this instance** |
| ✅ | work note contains the problem number | contains `PRB0040006` | `Linked Problem PRB0040006` |
| ✅ | Critical → problem Assigned to = Hardware manager | manager is EMPTY, so no assignment | empty |

**4 of 5 confirmed. The one failure is not a flow defect and not a pipeline defect.**
`problem_id` exists on **no table** on this instance — `element=problem_id` returns zero
`sys_dictionary` rows, and none of the 20 reference fields on `incident`/`task` points at
`problem`. The request asked for a link the instance has nowhere to store. ServiceNow accepts a
write to an unknown field silently, so the flow "succeeds" and the effect simply never happens.

The fifth promise is vacuous in a different way: the Hardware group has no manager
(`manager = ""`), so "assign to the group's manager" can only ever produce an empty value. The
flow does the right thing; there is nothing to observe.

### The false green, and why `verify` now refuses to run some specs ⚠️

One generated spec reported **4/4 green** and it was **wrong**. It proved the Problem link with

```json
"locate": { "byQuery": "sys_id={{setup.sys_id}}^problemISNOTEMPTY" }
```

ServiceNow **silently drops** a condition naming a field that does not exist. Measured against a
single incident:

```
sys_id=<id>^problemISNOTEMPTY             MATCHES
sys_id=<id>^problemISEMPTY                MATCHES   <- both, simultaneously
sys_id=<id>^zzz_totally_madeupISNOTEMPTY  MATCHES
sys_id=<id>^work_notesISNOTEMPTY          no match  <- a real field constrains
```

So the locator matched regardless, and an effect that never happened reported green. This is the
worst failure mode in the pipeline: it does not merely miss a bug, it **certifies its absence**.
Every asserted field and every field a locator constrains on is now checked against the live
schema — at generation time, and again before a stored spec runs. On the final run the model
spent all 3 attempts insisting on `^problemISNOTEMPTY`, so **no verification spec was produced**
and `createLiveFlow` reported the gap:

```
"verification": { "available": false,
  "reason": "Could not produce a valid verification spec in 3 attempts." }
```

That is the correct outcome. The flow is deployed and honest about being unverified, rather than
carrying a green that means nothing.

### Other defects this test surfaced (all fixed, each committed separately)

| defect | consequence | fix |
|---|---|---|
| create-only setup | a record-UPDATED trigger could never fire | `setup.update` transition step |
| empty related field omitted from context | model invented a group manager "John Doe" | empty fields stated as EMPTY |
| `{{token}}` accepted in `expect` | a correct work note reported FAIL | non-literal expectations rejected |
| `*` wildcard / "not empty" in `expect` | a correct work note reported FAIL again | same guard, widened |
| unresolvable proper noun | `name=Hardware group` matched nothing → **flow ERRORed on every run** | retry without trailing common noun; a real miss lists what exists |
| deployed source outranked live context | a stale name survived every regeneration | live context wins for values, never for identity |
| locator on a non-existent field | **false green** | schema check on every asserted and constrained field |

### Honest status

- Deploy: **green**, 1 attempt, 10/10, read back off the instance.
- Flow behaviour: **4 of 5 promises confirmed by direct read-back**; the 5th is unsatisfiable on
  this instance.
- Pipeline verification: **not green — no spec could be produced**, because the only assertion the
  model would write for the impossible promise was one that could only pass vacuously.
- The flow is **left deployed and active** for manual counter-probes.

The provider is the weak link throughout. Across six runs the same spec produced a different flow
name every time, dropped the `"Vendor issue: "` prefix on one regeneration, and wrote a different
malformed assertion on nearly every verification attempt. Each guard added here catches a real
class of that damage; none of them can make a weak model competent. `fluent.js` already surfaces
this as a hint, and it is the first lever to pull before reading anything else into these results.

---

## 15. Step 0 audit — is the field-existence checker lying?

The checker blocked a verification spec three attempts running and left Test 1 unverified. A
guard that blocks work has to meet the same falsifiability bar as the assertions it blocks, so
the claim *"`problem_id` has zero `sys_dictionary` rows on any table"* was re-tested from
scratch. The suspicion was reasonable: `problem_id` is standard OOB on `incident`, and this
instance plainly has a `problem` table — the flow created `PRB0040006` on it.

### Verdict: **the checker is correct. `incident.problem_id` does not exist on this instance.**

Four independent lines of evidence, one of which never touches `sys_dictionary`.

**(a) Raw `sys_dictionary`**

```
  0 rows | name=incident^element=problem_id
  0 rows | nameINincident,task^element=problem_id      (full hierarchy: incident -> task)
  0 rows | element=problem_id                          (ANY table)
  0 rows | nameINincident,task^element=problem
  0 rows | nameINincident,task^elementSTARTSWITHproblem
```

**(a2) …and the dictionary read is neither blocked nor truncated.** The same query path returns
**92 rows** for the chain (`task` 70, `incident` 22) against a limit of 2000, with ordinary
elements coming back (`hold_reason`, `caller_id`, `category`, `child_incidents`, …). The reader
works; there is simply no `problem_id` row to find.

**(b) `getSchema('incident')`** — 91 fields, `problem_id` absent, `problem` absent, and **zero**
reference fields pointing at `problem`.

**(c) The checker's own path**, exercised directly — and it is *not* over-generalising the
model's word "problem". It independently rejects `problem_id`, and it **passes** the real
control:

```
FAIL | assert field problem_id            FAIL | locator on bare problem
FAIL | locator on problem_id              PASS | locator on work_notes   <- real field, accepted
FAIL | assert made_up_field_xyz (control)
```

**(d) Independent of `sys_dictionary` entirely — the Table API itself.** A full record GET
returns **89 fields**; `problem_id` is not among them. Asking for it by name gets it dropped
exactly like an invented field, while a real field comes back:

```
sysparm_fields=sys_id,problem_id        -> ["sys_id"]
sysparm_fields=sys_id,made_up_field_xyz -> ["sys_id"]
sysparm_fields=sys_id,work_notes        -> ["sys_id","work_notes"]
```

And the silent-drop signature is unambiguous — a condition on an absent field matches *both*
`ISNOTEMPTY` and `ISEMPTY`, while a real field constrains:

```
problem_id         ISNOTEMPTY=match ISEMPTY=match   <- dropped
problem            ISNOTEMPTY=match ISEMPTY=match   <- dropped
rfc                ISNOTEMPTY=match ISEMPTY=match   <- dropped
caused_by          ISNOTEMPTY=match ISEMPTY=match   <- dropped
work_notes         ISNOTEMPTY=none  ISEMPTY=none    <- constrains
```

`rfc` and `caused_by` are absent too. That is a coherent pattern, not a random hole: **this PDI
does not carry the ITSM incident↔problem/change linkage fields at all.**

### So the model's three-attempt insistence was WRONG, and the guard was right

The hypothesis going in was that the guard had starved a valid assertion. It had not. The model
kept proposing `^problemISNOTEMPTY` for a field that does not exist, which would have passed
vacuously — the false green the guard was built to stop. `createLiveFlow` refusing to emit a
verification spec, and saying so, was the correct outcome.

The guard is now held to the bar it imposes: an **offline** regression test injects a schema
resolver and asserts that a field which exists passes (in both the asserted position and the
locator), that an absent field fails in both, and that an unreadable schema never fails a spec —
the guard must not block on our own outage.

### The link mechanism that DOES exist here

`problem` extends `task`, and so does `incident`, which leaves two real reference fields — both
verified to constrain properly:

| field | → | label | direction |
|---|---|---|---|
| `incident.parent` | `task` | Parent | incident → problem |
| `problem.first_reported_by_task` | `task` | Origin task | problem → incident |

```
incident.parent                ISNOTEMPTY=none ISEMPTY=match   <- constrains
problem.first_reported_by_task ISNOTEMPTY=none ISEMPTY=match   <- constrains
```

`task_rel_task`, `incident_problem` and `m2m_incident_problem` are all absent, so there is no m2m
route either.

**Test 1's third promise is therefore restated, not dropped:** *"link it back by setting the
incident's Problem field"* becomes **set `incident.parent` to the new problem** — the nearest
mechanism this instance actually provides, and one a verification spec can prove without faking
it. Writing `problem:` was never going to work; ServiceNow accepts writes to unknown fields
silently, which is why the flow reported success while the effect never landed.

---

## 16. Trap ledger

Instance and SDK behaviours that produce a *confidently wrong* result rather than an error.
Each one cost a debugging cycle here.

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 1 | **`keys.ts` is a flat project-wide map** | `Record <table>.<sys_id> is defined 2 times in the project`, naming a sys_id absent from your source | `$id` keys are global. Prefix every key with a per-flow slug; never copy one from an example |
| 2 | **Encoded queries silently DROP conditions on unknown fields** | `^fooISNOTEMPTY` and `^fooISEMPTY` both match the same record | Check every queried field against the live schema before trusting a locator |
| 3 | **Writes to unknown fields are silently accepted** | flow completes, `activation 10/10`, effect never happens | Read the effect back off the instance; never infer it from a green deploy |
| 4 | **`sysparm_fields` drops unknown names without complaint** | requested 2 fields, got 1, no error | Compare returned keys against requested keys |
| 5 | **`priority` is computed** | `{"priority":"1"}` lands as `4 - Low` | Drive `impact` + `urgency`; never write the result |
| 6 | **`lookUpRecord` on a query matching nothing ERRORS the flow** | build green, every execution fails | Resolve proper nouns against the instance first; a miss is a loud failure, not a fallback |
| 7 | **Journal fields are invisible to a plain GET** | `work_notes` reads empty on a record that has notes | Read `sys_journal_field` by `element_id` + `element` |
| 8 | **`now-sdk install` ships the WHOLE application** | one artifact requested, every artifact's `sys_updated_on` moves | Measure idempotency as *same sys_id, no new rows* — never as unchanged timestamps |
| 9 | **This PDI lacks `problem_id`, `rfc`, `caused_by`** | "the standard field" isn't there | `incident.parent` / `problem.first_reported_by_task` are the available task-to-task links |
| 10 | **`trigger_strategy` defaults to `once`, and `once` means once EVER** | a record that re-enters the trigger condition is never processed again | Set it explicitly on every updated/createdOrUpdated trigger; `unique_changes` is the per-transition form |
| 11 | **`sys_hub_trigger_instance_v2` has no `condition`/`table_name` columns** | a field query returns a row of nulls | The config is a gzip+base64 blob in `trigger_inputs`; decode it |
| 12 | **A reserved word as an unquoted object key stops the whole job from running** | `sysauto_script` inserts fine, stores byte-identical, `active=true` — and never executes. No syslog row, no error, no partial output | The script engine is ES3-era: `{ case: x }` is a syntax error, `{ 'case': x }` is fine (confirmed by A/B). Quote reserved words; read "the job never reported" as *suspect the script*, not the scheduler |
| 13 | **`GlideRecordSecure.getRowCount()` never matches what you can actually read** | called before iterating it returns the *unfiltered* count; called after, it returned `0` where 6 rows were genuinely readable | Count impersonated reads by iterating. Trusting `getRowCount` produced a clean false "ACLs make no difference" pass |
| 14 | **Plain `GlideRecord` hands back rows that `canRead()` denies** | under impersonation `.get()` → `true` and 9 rows iterate, while `canRead()` on the same object → `false` | Plain `GlideRecord` ignores the impersonated user's ACLs entirely. `canRead`/`canWrite`/`canCreate`/`canDelete` are truthful; the returned data is not |
| 15 | **`isImpersonating()` and `canImpersonate()` are constants in a background job** | `isImpersonating()` is `true` before, during and after; `canImpersonate()` returns `true` for an inactive user and for a GUID matching no `sys_user` row | The job session is already `system` impersonating `admin`. `gs.getUserID()` is the only identity authority; eligibility must be NHA's own `sys_user` query |
| 16 | **An impersonated denial never says anything** | no exception, no falsy return — a denied read/update is shaped exactly like "no such row" | Only read-back-as-admin proves what happened. See `docs/impersonation-phase0-ledger.md` |
| 17 | **`impersonate()` with an unknown sys_id silently lands on `guest`** | no error, no no-op — the session becomes a different real user, and `canImpersonate()` already said `true` for that id | Assert `gs.getUserID() === ` the requested sys_id immediately after the switch and abort if it differs. Measured at the B1 proof gate |

---

## 17. Step 2 — behavioural counter-probes

The verification layer proves *that a promised effect happened*. It cannot prove *that an effect
happens only when it should*, or *how often*. Both blind spots were probed live against the
deployed flow, with every test record deleted and the deletion read back.

### The trigger construct, read off the instance

`sys_hub_trigger_instance_v2` stores its config in `trigger_inputs`, a gzip+base64 blob.
Decoded:

| parameter | value |
|---|---|
| `trigger_type` / `trigger_definition` | `record_update` / `Updated` |
| `table` | `incident` |
| `condition` | `state=3^hold_reason=4` |
| `run_flow_in` | `background` |
| `run_on_extended` | `false` |
| **`trigger_strategy`** | **`once`** |

So it is a **condition-on-update** trigger, not a changes-to construct. Nothing in the generated
source set `trigger_strategy` — the SDK left it out and the platform supplied its default.

> Reading this needed a detour: asking `table.query` for `condition`, `table_name`, `type` on
> `sys_hub_trigger_instance_v2` returned a row of **nulls**, because those columns do not exist —
> trap #4 (silent `sysparm_fields` drop) catching our own probe. The real columns are `flow`,
> `trigger_type`, `trigger_definition`, `trigger_inputs`.

### PROBE A — is the Critical branch actually conditional? ✅ **yes**

The probe as specified would have passed **vacuously**: `assigned_to` is set from the Hardware
group's manager, and that manager is empty, so `assigned_to` ends up empty whether the branch
runs or not. That is trap #2 applied to our own test. A manager (`Abel Tuter`) was set for the
duration and restored to empty afterwards, read-back confirmed, which makes the branch observable.

| | priority | assignment_group | assigned_to | `sys_mod_count` |
|---|---|---|---|---|
| non-critical | `4 - Low` (impact 3 + urgency 3) | Hardware | **empty** | 0 |
| critical (control) | `1 - Critical` (impact 1 + urgency 1) | Hardware | **Abel Tuter** | 1 |

The branch fires only for Critical, and the unconditional part (assign to Hardware) runs for
both. `sys_mod_count` agrees independently: the problem is untouched after insert in the
non-critical case, updated once in the critical one.

### PROBE B — does an unrelated update re-fire the flow? ✅ **no**

With the incident still On Hold / Awaiting Vendor, an unrelated field (`comments`) was updated.
Executions stayed at **1**, problems stayed at **1**. **No duplicate-record spam.**

### PROBE B2 — but `once` means once *ever*, not once *per transition* ⚠️

`trigger_strategy: 'once'` needed pinning down, so one incident was driven through a full cycle:

```
[1] entered condition  (On Hold / Awaiting Vendor)  -> 1 execution, 1 problem
[2] left the condition (In Progress, no hold reason) -> 1 execution, 1 problem
[3] RE-ENTERED the condition                         -> 1 execution, 1 problem
```

**The flow never runs again for that record.** An incident that goes on vendor hold, gets worked,
and later goes back on vendor hold gets **no second problem** — silently.

That behaviour was never chosen. The SDK exposes the setting and documents its default:

```typescript
trigger_strategy: Typed<"every" | "once" | "unique_changes" | "always", {
  label: "Run Trigger", default: "once",
  hint: "Run Trigger every time the condition matches, or only the first time.",
  choices: { once: "Once", unique_changes: "For each unique change",
             always: "Only if not currently running", every: "For every update" } }>
```

The spec said *"when an incident is **updated to** state On Hold"* — a **transition**, which is
`'unique_changes'`. The generated flow omitted the parameter, so the platform picked `'once'` and
narrowed the promise to "the first time this incident ever hits vendor hold".

The cheatsheet already listed `trigger_strategy` and even said "prefer `unique_changes`" — and
the model omitted it anyway. A parameter listed in a table is easy to skip; a **silent default
with teeth** is not something the author should be allowed to skip. Both the cheatsheet and
`HARD_RULES` now state that omitting it is not neutral, what `once` actually costs, and which
value a "updated TO" phrasing implies.

**Regenerating Test 1 with `trigger_strategy: 'unique_changes'` is the correct follow-up**, and
is queued behind the provider switch — it needs a generation run.

### What the probes cost, and what that says about the verification layer

Neither of these findings is reachable from a verification spec as the layer is built: both
require *two* runs of the same flow, or a run that is expected **not** to happen. The
`.verify.json` shape has one setup, one wait, one set of assertions. Branch conditionality and
re-fire semantics are structurally outside it. They belong in a separate probe harness, and until
one exists they are a known, named gap rather than a silent one.

---

## 18. Step 3 — hygiene closure, and two broken artifacts it exposed

### `demo-incident-flow.now.ts` is under git ✅

It is tracked, along with every other source and verify spec in `src/fluent/flows/`. The
working tree is clean.

### It cannot be given a verification spec — three independent reasons

**1. It has never executed. Not once.** Its trigger is `record_create` on `incident` with an
**empty condition**, so it should fire on every incident insert. Across this session's probes —
including a dedicated one that created a P1 incident and waited a fixed 45s — it produced **zero**
`sys_flow_context` rows, while other flows on the same insert did:

```
Notify P1 Incident Assignment Group Manager -> Complete
Demo Incident Priority Notification         -> Error
Demo Incident Flow                          -> (never appears)
```

Verification works by firing a flow and asserting its effects. A flow that does not fire cannot
be verified by any spec.

**2. `u_demo_flag` does not exist on `incident`.** Verified the same three ways as `problem_id`:
absent from the 91-field schema, no `u_*` fields on the table at all, and `sysparm_fields=sys_id,
u_demo_flag` returns only `sys_id`. The flow's `update_demo_flag` action writes to nothing, and
the field-existence checker would reject any assertion on it — correctly.

**3. The group "Incident Manager" does not exist.** The nearest is **"Incident Management"**. The
flow's `lookup_incident_manager_group` uses `conditions: name=Incident Manager`, which matches
nothing — trap #6, the failure that ERRORs a flow at run time.

So two of its three promised effects target things this instance does not have, and the flow
never runs. **The precise reason it has no `.verify.json` is recorded here rather than papered
over with a spec that could only pass vacuously.**

### Why it never fires: undetermined, and stated as undetermined

Two hypotheses were tested and **both failed**:

- *"Empty `compiler_build`"* — it is empty on this flow, **but also on `Handle High Priority
  Incident`, which runs.** Not the discriminator.
- *"The trigger instance is malformed"* — a field-by-field diff against `Demo Incident Priority
  Notification` (also `record_create` on `incident`, and it does fire) shows the two trigger
  records are structurally identical: same `trigger_type`, same `trigger_definition`, same scope.
  Not the difference.

One unexplained inconsistency remains, recorded without a causal claim: its published
`master_snapshot` is dated **2026-08-17 18:40:08**, which is *older* than its own trigger
instance's last update (**23:34:50**) and older than the source file itself. `latest_snapshot`
and `master_snapshot` are the same record, whereas working flows have them differ. That is
suspicious, not proven.

**Recommended disposition:** this artifact is a demo leftover whose two distinctive effects are
unbuildable here. Either regenerate it against real targets (`Incident Management`, and an effect
on a field that exists), or remove it with `removeManaged`. Both need a generation run, so both
are queued behind the provider switch.

### Bonus finding — `Demo Incident Priority Notification` is broken in production

It is active, it fires on every P1/P2 incident, and it **errors every time**:

```
Email validation failed: Email has no recipients.
```

Same root class as the Hardware manager: it emails a group's manager, the manager (or their
email) is empty, and `sendEmail` with no recipient is a hard error rather than a no-op. This is
pre-existing and unrelated to the hotfix, but it is a live flow failing on every execution and
should not stay that way.

### Survey of all 10 NowHelpAssist-scoped artifacts

| artifact | type | active | ever run |
|---|---|---|---|
| Notify P1 Incident Assignment Group Manager | Flow | ✅ | ✅ |
| Handle High Priority Incident | Flow | ✅ | ✅ |
| Create Problem for On Hold Vendor Incidents | Flow | ✅ | ✅ |
| Escalate Network P1 Incident | Flow | ✅ | ✅ |
| Demo Incident Priority Notification | Flow | ✅ | ✅ **errors every run** |
| Notify Manager | SubFlow | ✅ | ✅ |
| High Risk Change Approval | Flow | ✅ | ✅ |
| Daily P1 Digest | Flow | ✅ | ❌ scheduled, window not yet hit |
| NowForge Smoke Test | Flow | ✅ | ❌ no trigger by design |
| **Demo Incident Flow** | Flow | ✅ | ❌ **should fire on every incident; never does** |

---

## 19. The model-proofing floor (guards A1–A5)

Phase 4 ended with a working pipeline and an honest problem: *the provider is the weak link
throughout*. Six live runs of one spec produced six different flow names, one regeneration
silently dropped a promised text prefix, and three verification attempts re-sent the same
impossible locator. None of those is a bug in NowHelpAssist. All of them shipped, or nearly shipped,
a wrong artifact.

The floor is five guards that make each of those failure classes **structurally unable to reach
the instance**. They do not make `gpt-oss:120b-cloud` competent. They make it *presentable*: when
it is wrong, the pipeline says so instead of deploying it.

Offline proof: `server/test/model-proofing.test.js`, 30 cases, part of `npm test`.

### A1 — deterministic decoding, and the measurement that matters ⚠️

`temperature: 0` and a seed derived from the spec fingerprint are now sent on every codegen and
verification call, passed through by each adapter to whatever the provider actually has
(Anthropic has no `seed`, so none is fabricated — `DECODING_SENT` records that rather than
implying otherwise).

Then the obvious question was asked instead of assumed: **does Ollama honour any of it?**

Four pairs of identical calls, `gpt-oss:120b-cloud`, high-entropy prompt:

| probe | setup | result |
|---|---|---|
| P1 | temp 0, seed 42 twice | **DIFFERENT** |
| P2 | temp 0, seed 42 vs seed 9999 | **IDENTICAL** |
| P3 | temp 1.0, seed 42 twice | **DIFFERENT** |
| P4 | temp 1.0, seed 42 vs 9999 | DIFFERENT |

P2 and P3 together are decisive, and they point the same way: **the seed has no causal effect.**
Two different seeds produced identical text; the same seed twice produced different text. If the
seed were honoured, both of those results would be the other way round.

A follow-up separated "the OpenAI-compat shim drops the field" from "the backend ignores it".
Three calls to the **native** `/api/chat` with identical `options.seed` at temperature 1.0:

```
n1: Eclipsed Lattice of Aeons | Vermilion Quasar Canticle | Silicate Maelstrom Voyager | …
n2: Aetherial Nomad          | Chronicle of the Void     | Obsidian Whisperwind        | …
n3: Eclipsed Aurora          | Quantum Siren             | Obsidian Celestia           | …
```

Three seeded-identical requests, three different answers. **The seed is ignored by the backend,
not dropped by the shim.**

And temperature 0 is only *approximately* stable — three identical calls:

```
t1: Celestial Harbinger | Obsidian Whisper | Aetheric Nomad  | Quantum Siren     | Eclipsed Aurora
t2: Celestial Harbinger | Obsidian Whisper | Quantum Aurora  | Eclipsed Seraphim | Nebulae's Lament
t3: Celestial Harbinger | Obsidian Whisper | Quantum Aurora  | Eclipsed Seraphim | Nebulae's Lament
```

A shared prefix, then divergence at item 3 — the signature of batched GPU inference, where the
greedy argmax is stable while one candidate dominates and flips when two are near-tied.

**Consequence, and it is load-bearing:** no guard in this repo may assume a reproducible
generation, because on the only model available here there is no such thing. Every guard A2–A5
is written to hold under non-determinism. The parameters are still sent, because a stronger model
swapped in through Settings may well honour them and the passthrough costs nothing — which is
exactly the "a stronger model is a pure Settings swap" property this build is designed around.

`providerInfo()` now reports this reality to the UI, so a non-reproducible backend is a visible
fact rather than a footnote.

### A2 — pinned flow identity

The platform matches artifacts by **name**. A rename is therefore not cosmetic: it creates a
second flow instead of updating the first. Across six runs this model produced *"…Vendor
Issues"*, *"…Vendor Incidents"* and *"…Vendor Incident"*, and HARD RULE 2 asking it not to had
no measurable effect.

So the name is no longer requested — it is **imposed**. Pinned once per request (the deployed
name on a regeneration, the intent name on a new one), then rewritten into the model's output at
the string level, with every correction streamed as an SSE warning. Identity survives
mechanically, on the same principle as guard 3's placeholder substitution.

The names are located by **brace matching** on the `Flow(`/`Subflow(` config object, not a
fixed-width regex window: an `updateRecord` action's own `name:` parameter sits well inside an
800-character window, and a window-based rewrite would have pinned the wrong string. There is a
test for exactly that.

### A3 — promised literals

One regeneration dropped the `"Vendor issue: "` prefix the request asked for. It compiled,
installed, activated 10/10, and wrote the wrong text. Nothing downstream could catch it: the
build is green, and the verification assertion is written by the same model that dropped it.

The intent extractor now lists `promised_literals`, and every one is checked into the generated
source before the SDK runs.

The load-bearing detail is that **the extractor cannot invent a requirement**. Its list is
intersected with the spec text, so a hallucinated literal is discarded rather than blocking a
correct flow — the model can narrow this guard and never widen it. This repo has already had to
undo two guards that failed correct work (`{{token}}` and `*` in expectations); A3 is built so
that cannot happen.

Trailing whitespace is preserved deliberately. `"Vendor issue: "` and `"Vendor issue:"` are
different promises, and the space is the entire point of a prefix.

**Known limit, stated rather than assumed away:** grounding proves a string is in the *request*,
not that it is text the flow should *write*. A choice label the flow matches on ("Awaiting
Vendor", correctly encoded as `hold_reason=4`) would be enforced as a literal if the extractor
mislabelled it, and would then reject a correct flow. What prevents that is the extractor prompt,
not the checker. There is a test pinning this boundary so it stays visible.

### A4 — trigger_strategy lint

Trap #10, promoted from documentation to enforcement. An `updated` / `createdOrUpdated` trigger
must set `trigger_strategy` explicitly, and a request phrased as a **transition** ("updated to",
"moves to", "becomes", "whenever") must set `unique_changes`.

This is the least visible defect in the whole pipeline. The build is green, the install is 10/10,
and a single-shot verification run **passes** — because the first firing is correct. `once` is
only wrong the *second* time a record makes the transition, in production, weeks later. No
existing check could see it; §17's PROBE B2 found it only by deliberately re-transitioning a
record twice.

### A5 — retries that add evidence

Measured in §14: three verification attempts sent the same question and got the same rejected
answer. The attempt budget bought nothing, because nothing about attempt 2 differed from
attempt 1.

Two changes:

1. **Every rejection contributes measured evidence.** A field-check failure now attaches the
   instance's actual field inventory for the tables the spec named — including *every reference
   field and the table it points at*. "`problem` does not exist on `incident`" is a claim the
   model spent three attempts disbelieving. The dictionary is not a claim.
2. **An identical re-ask is structurally impossible.** A `RetryLedger` hashes every outgoing
   prompt and refuses to send one that repeats an earlier attempt, with a message saying this is
   a defect in the evidence builder rather than a model failure. Loud, per the house rule — the
   old behaviour quietly spent an attempt on a question that had already been answered.

Verification attempts were raised 3 → 4. Raising a budget is only worth anything *because* of
(2); four identical re-asks would simply cost four times as much.

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 12 | **Ollama accepts `seed` and ignores it** | no error, no warning; the parameter is simply inert on `*-cloud` models, on both `/v1` and the native `/api/chat` | Never assume reproducibility. Verify with two identical seeded calls at temperature > 0 — if they differ, the seed is decorative |
| 13 | **`temperature: 0` is only approximately deterministic** | repeated identical calls agree for a while, then diverge mid-output | Batched inference re-orders floating-point reductions. Guards must hold under non-determinism; a "we pinned the seed" comment is not a guarantee |

---

## 20. Test 1 Step 1 resume — it closes, after the guards stopped contradicting each other

§14 left Test 1 with a deployed flow and **no verification spec**: three attempts running, the
model insisted on `sys_id={{setup.sys_id}}^problemISNOTEMPTY`, a locator on a field that exists
nowhere on this instance. Resumed here with the attempt budget at 4 and A5's measured evidence in
play.

**Result: closed. `ok: true`, 2 attempts, 3 assertions + 2 confirmed-unverifiable promises.**

Getting there took finding two bugs in the guards themselves, both of which mattered more than
the original failure.

### Provenance, stated plainly

The original spec text was **never persisted** — only its fingerprint, `0a8c04f64afd4b31`, and
none of three careful reconstructions reproduces it. The spec used here was rebuilt from the
deployed source's own `description` plus the five promises measured in §14.

So this is a re-run of the same **problem**, not a byte-identical replay of the same **request**.
That is a real limitation of the result and it is also the first concrete argument for Track A:
a pipeline that cannot say what it was asked to build cannot reproduce its own work. Sessions and
specs are now persisted (§A-1), so the next resume will not have this asterisk.

### The old failure class is gone

Attempt 1 reached for `^problemISNOTEMPTY` exactly as before. A5 attached one measured evidence
block — the actual reference-field inventory of `incident`, every field and the table it points
at — and **attempt 2 never returned to it, in any run.**

Three attempts of prose ("that field does not exist") had failed to move this model. One
dictionary listing moved it immediately. That is the whole thesis of A5, and it is the single
clearest measurement in this document: *the model does not need to be told again, it needs to be
shown once.*

### CLASS D — two guards that could not both be satisfied ⚠️

The first resume run did not close. It failed differently, and worse:

```
attempt 1  rejected: locator on `problem`, which does not exist        (evidence +1)
attempt 2  rejected: 6 promised effects, only 4 assertions written     (evidence +0)
attempt 3  rejected: 6 promised effects, only 4 assertions written     (evidence +0)
attempt 4  REFUSED by A5 — this prompt is byte-identical to attempt 3
```

The model had done exactly as instructed. The field-existence check told it to **drop** the two
assertions this instance cannot support; the coverage rule then rejected it for **dropping**
them. Two guards in direct contradiction, and **no model could have satisfied both.** More
attempts, a better model, a different prompt — none of it would have helped.

A5 caught it and named it correctly, in its own message: *"This is a defect in the evidence
builder, not a model failure."* Before A5, this would have quietly burned attempt 4 and reported
"could not produce a spec in 4 attempts", filing a bug in our own logic under the model's name.
That is the guard doing precisely the job it was built for.

Both dropped promises were independently re-measured and are genuinely unsatisfiable here:

```
incident.problem exists?                 false
incident.problem_id exists?              false
incident fields referencing `problem`:   NONE
Hardware group manager                   {"display_value":"","value":""}
```

**gpt-oss identified exactly the two promises §14's hand-run counter-probe found impossible, and
dropped exactly those two.** It was right, and the pipeline punished it for being right.

### The fix: a verified escape hatch, not a weaker rule

Coverage was not relaxed. A promise may now be excused only by naming itself, in a form this code
**checks against the live instance**:

```json
"unverifiable": [
  { "effect": "link the new problem back to the incident",
    "kind": "field_absent",  "table": "incident", "field": "problem" },
  { "effect": "assign the problem to the Hardware group manager when Critical",
    "kind": "source_empty",  "table": "sys_user_group", "field": "manager",
    "sys_id": "8a5055c9c61122780043563ef53438e3" }
]
```

`field_absent` is confirmed against the dictionary; `source_empty` by reading the named record.
An excuse that does **not** hold is rejected with the measurement refuting it — if the field turns
out to exist, or the value turns out to be non-empty, the model is told to assert the effect
instead. Without that, the hatch would be a way to assert nothing and still report a clean pass:
the false green of §14 in different clothes.

### Two bugs in the hatch, caught by running it

The first implementation of the hatch was itself wrong, in both of the ways this repo keeps
having to learn:

**1. A bare `catch` swallowed unverifiable claims.** The model excused a promise with
`table: "problem", field: "assigned_to"` while passing the sys_id of a **sys_user_group** record.
The read threw, `catch { continue; }` ate it, and the claim counted anyway. A silent fallback,
straight into the house rule. It now fails closed and says which table it could not read.

**2. Coverage subtracted CLAIMED excuses, not CONFIRMED ones.** A spec listed two excuses, only
one held up, and the requirement dropped by two regardless — a promise vanishing on the strength
of a claim about the wrong table. `validateVerifySpec` now takes `verifiedExcuses`, the count
`checkUnverifiableClaims` actually confirmed, and **defaults it to 0** so an unchecked caller
subtracts nothing.

The deliberate asymmetry is worth stating, because it looks like an inconsistency: the field
checker *never* fails a spec on our own outage, while an unverified *excuse* always fails closed.
Those protect opposite things. An unreadable schema must not block a correct **assertion**; an
unverified excuse must not silently remove a **requirement**. The failure modes are not
symmetric, so the rules are not either.

### The closing run

```
attempt 1  rejected: locator on `problem`             (evidence +1)
attempt 2  ready:    3 assertions, 2 excuses CONFIRMED
```

3 asserted + 2 confirmed-unverifiable = 5, exactly the 5 promised effects. The setup is a proper
create-then-update transition, and priority is driven through `impact` + `urgency` rather than
written directly — trap #5 respected without being reminded.

### Non-determinism, visible in the results themselves

Across three runs of the identical spec the intent extractor produced **6, 6 and 5** promised
effects, and the flow name came back as *"…Vendor Incidents"* once and *"…Vendor Issues"* twice.
Same input, same temperature 0, same seed. This is §19's finding showing up in ordinary
operation rather than in a probe, and it is why A2 imposes the name instead of asking for it.

### What remains, precisely

- **The deployed flow still carries trap #10.** `create-problem-for-on-hold-vendor-incidents.now.ts`
  sets no `trigger_strategy`, so it inherits `once` and fires **once ever** per incident.
  A4 now blocks new flows from shipping this defect, but it does not retro-fix a deployed one.
  Regenerating this flow would trip A4 and force the fix — that is a deliberate, separate change,
  not something to slip into a verification resume.
- **A3's ceiling is the intent extractor.** Grounding proves a literal is in the request, never
  that it is text the flow must write. A mislabelled choice label would reject a correct flow.
- **The spec is proven, not run.** `regenerateVerification` reads schema and calls the model; it
  writes nothing to the instance. Executing the spec is still a separate, approved step.

---

## 21. Memory and sessions (Part A)

The vanishing-chat bug had exactly one cause: history lived in a module-level
`Map`. Navigating Agent → Settings → Agent lost the transcript, and restarting the
server lost every conversation that had ever happened. Everything below follows
from fixing that at the root rather than papering over it in the client.

Offline proof: `server/test/memory.test.js`, 34 cases. Live acceptance runs are
quoted verbatim below.

### Storage — `node:sqlite`, checked rather than assumed

The choice was made by probing, not by preference:

| need | built-in `node:sqlite` on Node v24.18.0 |
|---|---|
| `DatabaseSync` / `StatementSync` | present |
| BLOB round-trip (`Uint8Array`) | works — required for float32 embeddings |
| FTS5 virtual tables | available — required for the keyword fallback |

All three hold, so `better-sqlite3` was not needed and the whole storage layer
is **dependency-free**. That matters specifically here: this is a Windows
machine with no node-gyp toolchain, so better-sqlite3 would have meant trusting
a prebuilt binary to match this exact Node ABI.

One file, `server/data/nowhelpassist.db`, gitignored. Migrations are idempotent on
boot, keyed on `PRAGMA user_version`, each in its own transaction — a
half-migrated database is worse than one that refuses to open. `migrate()` is
exported so the offline suite builds its scratch database through the **same**
code path; copying `sqlite_master` instead fails outright, because FTS5's shadow
tables (`chunks_fts_data`, …) cannot be created directly.

### A-1 — persistence

`sessions` / `messages` / `tool_events`. `messages.json` stores the neutral
history entry **verbatim**, so this table does not need migrating every time a
provider adapter learns a new field.

`tool_events` is deliberately a separate table, not a view over messages. It is
the record of what was done to the instance and what a human approved, and
**compaction rewrites messages but must never rewrite it**. There is a test
asserting exactly that.

### A-2 — the acceptance run, verbatim

Driven through the real HTTP surface the browser uses.

```
--- turn 1 ---
tools: lookup_reference
said : The Hardware group (sys_user_group) has the sys_id: 8a5055c9c61122780043563ef53438e3

--- turn 2: something unrelated in between ---
said : A ServiceNow subflow is a reusable, modular flow fragment…

--- remount: refetch the transcript exactly as the page does ---
messages persisted: 6 · tool events: 1 · tokens 175 / 24000

*** server killed (PID 11476, SIGKILL) and cold-restarted ***

transcript identical across the restart: YES   (6 -> 6 messages)

--- turn 3, on the freshly restarted server ---
tools: (none — answered from memory)
said : The Hardware group's sys_id is 8a5055c9c61122780043563ef53438e3.
```

The third turn is the one that matters: **no tool call**. The agent answered
from persisted history two turns later, across a process death.

The rail rehydrates from the NEUTRAL history rather than a second UI-shaped
copy, so what is redrawn cannot drift from what the model actually saw.
Approval cards are deliberately not reconstructed — an approval is a live
decision on an in-flight turn, and what it gated is visible in the tool card
beside it.

### A-3 — compaction

Oldest span → structured digest (artifacts + sys_ids, decisions, open threads),
spliced back as a **system-side note**, last K turns verbatim. The digest prompt
puts identifiers first and says so plainly, because an identifier cannot be
reconstructed and is what gets asked for later.

Budget sized at 24k against an advertised 131k window, deliberately. gpt-oss
bills hidden reasoning tokens against the same budget, and the adapter's
specific error ("the max_tokens budget was exhausted before any output was
produced") **must never fire during compaction**: a failed compaction leaves the
session over budget, so the next turn fails too. That is a loop, not a
degradation. The estimator uses 3.5 chars/token rather than the usual 4 for the
same reason — tool results are JSON and tokenise worse than prose, and guessing
high costs one early compaction while guessing low costs a failed request.

Every failure path is non-destructive: a summariser that throws, or returns an
empty digest, discards **nothing** and says so. Tested both ways.

Acceptance: a synthetic 100-turn session compacts under budget, and a probe
about turn 5 is answerable because its sys_id survives into the digest.

### A-3 again, live — where the offline test was lying to me ⚠️

The offline acceptance passed from the start. Running the same thing against
the real model did not, and the failure is the most instructive one in Part A
because **nothing reported an error**.

First live run, 60 turns of realistic traffic (query results dominating, one
flow deployed at turn 5):

```
history before: 36958 tokens (budget 24000), 120 entries
compacted: true  (76.5s)
tokens: 36958 -> 2502, under budget: true

ARTIFACTS AND IDENTIFIERS
- INC0010000 — incident — sys_id N/A — state 2
- INC0010001 — incident — sys_id N/A — state 2
- INC0010002 — incident — sys_id N/A — state 2
… 100+ more …

sys_id from turn 5 survived: false
flow name survived:          false
```

Green on every measurable signal — compacted, under budget, no error — and
**completely useless**. Told to "copy every record number and sys_id", the model
did exactly that: it enumerated a hundred padding incident numbers from query
*results*, hit its 6000-token cap, and never reached the one flow sys_id that
mattered. The digest was truncated, and a truncated digest is well-formed text
that simply stops.

The offline test passed because its stand-in summariser was a regex that pulled
out 32-hex strings. It was testing the splice, the budget arithmetic and the
failure paths correctly — and it could not test the only thing that failed,
because a regex is not a language model. **That is the general shape of the
lesson: a test double cannot exhibit the failure mode of the thing it doubles.**

Three fixes, in order of how much each mattered:

1. **Collapse list-shaped tool results before the model sees them.** A
   query result of 12 rows becomes `[12 rows returned; first row: …]`. Asking
   the model not to copy 700 record numbers is strictly weaker than not showing
   them to it. This is also what took the run from 76.5s to 8.8s.
2. **Separate the two kinds of identifier in the prompt.** `ARTIFACTS BUILT OR
   CHANGED` (created/updated/deleted — must be verbatim) versus `RECORDS ONLY
   LOOKED AT` (transient — a count, never a list). The old single heading
   invited exactly the confusion that occurred.
3. **Refuse a truncated digest.** All four headings must be present, or the
   generation was cut off and whatever came after it is gone. Without this,
   silent loss is indistinguishable from success — and this guard immediately
   caught two of my own test doubles, which is the right kind of noisy.

Same fixture, after:

```
compacted: true  (8.8s)
tokens: 36958 -> 2502, under budget: true

ARTIFACTS BUILT OR CHANGED
- Create Problem for On Hold Vendor Incidents — flow — sys_id 39acb67eac164650a6b15f5e724cae76 — active

RECORDS ONLY LOOKED AT
- 55 queries on Incident table for unassigned critical incidents

DECISIONS
- Deployed the "Create Problem for On Hold Vendor Incidents" flow to address vendor-hold incidents

OPEN THREADS
none

sys_id survived : true
flow name       : true
padding INC numbers leaked into the digest: 0
```

The adapter's reasoning-token error never fired in any run, which was the
specific risk this budget was sized against.

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 16 | **A truncated LLM response is well-formed text that stops** | a summary that is fluent, plausible and silently missing its tail | Require a structural marker from the END of the expected output. Length and "no error" prove nothing |
| 17 | **A test double cannot exhibit the failure mode of the thing it doubles** | a green offline suite over a live path that is broken | Doubles test the plumbing. Run the real thing against the acceptance criterion at least once, or the criterion is untested |

### A-4 — the instance knowledge ledger

Seeded from §16 and §19. Everything this project learned the hard way was
sitting in a document the agent could not read.

Scope is enforced, and it is the part most likely to cause harm if sloppy: SDK
and platform traps are stored against `*` and apply everywhere, while a fact
MEASURED on one instance (`problem_id` exists nowhere here) is stored against
that instance and never leaks to another. A second PDI may well have the field,
and a confidently-wrong "it does not exist" is precisely the damage this ledger
exists to prevent.

Read into **both** prompts. The codegen context is the one that matters most —
`HARD_RULES` has no rule about calculated fields at all.

#### The acceptance demo, and its confound stated plainly

The specified demo — "a brand-new flow's verification setup drives priority via
impact+urgency without being told" — **passes**, but it does not isolate the
ledger: `VERIFY_SYSTEM` rule 9 already states the same thing, so a pass there is
over-determined. Reporting it as proof of the ledger would be dishonest.

The agent system prompt has **no** priority rule, so on that path the ledger is
the sole carrier. Run live, fresh session:

```
tools called: get_table_schema

{
  "short_description": "Test incident for Critical priority",
  "urgency": "1",   // 1 = High
  "impact":  "1",   // 1 = High → Priority is calculated as Critical (P1)
  "category": "inquiry"
}

Why these fields: urgency = 1 + impact = 1 forces the platform's calculated
priority = Critical (P1)…
```

`impact` and `urgency` driven, the word "calculated" used unprompted, and
`priority` never written. That is the ledger working, on a path where nothing
else could have supplied it.

Write paths: failed verification assertions, calculated-field discovery during
`get_table_schema`, and a `remember:` affordance. Re-observing a fact raises its
confidence; a changed value replaces it and resets provenance, because the old
evidence no longer supports the new claim.

### A-5 — recall, and a ranking bug the acceptance test caught ⚠️

Embeddings through the same `baseUrl` as chat. Endpoint checked rather than
guessed: Ollama 0.32.14 exposes **both** `/api/embed` (native, batch `input`)
and `/v1/embeddings`; the native one is used. They fail differently when a model
is missing — `{"error": "..."}` vs `{"error": {"message": "..."}}` — so the
probe reads both shapes.

Float32 blobs in SQLite, brute-force cosine in JS. A dimension mismatch is
skipped rather than scored, because comparing across embedding models produces a
number that looks exactly like a real similarity.

**The bug.** The A-5 acceptance query ranked the correct session **last of
five**:

```
0.6256  accept-laptop-catalog     <- wrong session winning
0.4351  (unrelated)
0.3533  (unrelated)
0.3058  accept-p1-digest
0.2467  accept-vendor-hold        <- the right one, dead last
```

Two causes, both mine:

1. **`Math.abs` on a value whose sign carried the meaning.** SQLite's `bm25()`
   returns a NEGATIVE score where a better match is *more* negative. Normalising
   with `1 / (1 + Math.abs(score))` inverted the ordering, so the best match got
   the lowest number and `searchSessions` — sorting descending — returned the
   worst first. Negating is the entire conversion.
2. **No stopword removal.** The acceptance question is five stopwords and three
   content words; leaving them in let a session match on "we" and "about".

After both fixes, the same query in the same mode:

```
5.4763  accept-vendor-hold
1.4074  accept-p1-digest
```

This is worth recording for a reason beyond the fix: **the offline tests were
green throughout.** They asserted that search returned hits, that it reported
its mode, that it degraded loudly — every property except the one that mattered,
which was the ORDER. Only running the acceptance criterion end to end found it.

#### Both modes, as required

| mode | condition | result |
|---|---|---|
| keyword | embedding model absent | `accept-vendor-hold` **5.4763**, next 1.4074 |
| semantic | `nomic-embed-text`, 768d | `accept-vendor-hold` **0.7897**, next 0.5628 |

The embedding model was pulled to demonstrate the second row (`ollama pull
nomic-embed-text`, ~274MB, local and free, reversible with `ollama rm`). The
degraded path is not a fallback that hides — the UI banner and the API both
report `mode: "keyword"` with the exact pull command, and the agent tool's
description tells the model to mention the mode if results look thin.

One test lesson: the fallback test originally went through `search()` and
asserted `mode === 'keyword'`. It **flipped mid-run** when the pull finished. A
test that changes meaning when someone runs `ollama pull` is testing the
environment, not the fallback, so it now calls the keyword path directly.

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 14 | **`bm25()` is negative, and more-negative is better** | a relevance sort that returns the *worst* matches first, with plausible-looking scores | Never `Math.abs()` a value whose sign carries meaning. Assert the ORDER in a test, not merely that hits came back |
| 15 | **A test that branches on the environment silently changes meaning** | a green suite that was asserting something different yesterday | Call the degraded path directly. `ollama pull` finishing mid-run should not alter what a test proves |

---

## 22. Track B — SLAs and access control

Everything below was executed against `dev442675.service-now.com` before the
code that relies on it was written. Where a claim is a measurement, the numbers
are the ones that came back; where something was not verified, it says so.

### Storage note

Track B adds no storage. The SLA and ACL layers are stateless readers and
writers over the Table API — there is nothing durable to keep that the instance
is not already the source of truth for. `server/data/nowhelpassist.db` is unchanged
and no migration was added.

---

### B-1 — SLA definitions

`server/src/servicenow/sla.js`, `server/src/routes/sla.js`, the **SLA** page,
and the agent tools `sla_meta` / `list_slas` / `get_sla` / `create_sla`
(mutating, amber gate) / `verify_sla_live` (mutating).

#### The duration codec ✅

`contract_sla.duration` is a `glide_duration`, and it is **an offset from
1970-01-01 with whole days carried in the DATE half**:

| stored | means |
|---|---|
| `1970-01-01 04:00:00` | 4h |
| `1970-01-01 00:15:00` | 15m |
| `1970-01-03 00:00:00` | **2 days** — read as a clock time this is zero |

Read off this instance: "Priority 1 resolution (1 hour)" stores
`1970-01-01 01:00:00`, "Priority 4 resolution (2 day)" stores
`1970-01-03 00:00:00`.

#### `duration_type` replaces the duration entirely

`duration_type` references `cmn_relative_duration` (5 rows here: *Breach on Due
Date*, *End of next business day*, *Next business day by 4pm*, *2/3 business
days by 4pm*). When it is set, the fixed duration is not used and the breach
clock cannot be checked arithmetically — `assertTaskSla` says so and skips that
check rather than inventing an expectation.

#### The schedule is inert unless `schedule_source` switches it on ⚠️

Two definitions, identical but for one field, one incident, one run:

| definition | `schedule` | `schedule_source` | task_sla.schedule | wall-clock to planned end |
|---|---|---|---|---|
| probe A | 8-5 weekdays | `no_schedule` | *(empty)* | **4.00h** |
| probe B | 8-5 weekdays | `sla_definition` | 8-5 weekdays | **7.84h** |

Both were created with a 4h duration. Setting the schedule reference alone
produced a clock that ignores it, with nothing anywhere reporting that the
field was inert. `createSla` warns on exactly this combination, and the SLA
page prints the warning at the field, not after the save.

The 7.84h is correct arithmetic, incidentally: the incident was created at
04:09 PDT, before the schedule's 08:00 window opens, so the clock starts at
08:00 and four business hours land at 12:00 PDT = 19:00 UTC.

#### Conditions are field-checked before the write ✅

Trap #2 is worse on this table than anywhere else it has come up. A start
condition naming a field that does not exist is not rejected — the clause is
**dropped**, so `active=true^prioritee=1` becomes `active=true` and the SLA
attaches to **every active record on the table**. Nothing errors, and the
definition looks right in the UI.

`validateSlaInput` checks every one of start/stop/pause/reset/cancel against
the target table's live dictionary and refuses before anything is written.
Measured live:

```
create_sla { start_condition: 'active=true^prioritee=1' }
  → refused: The start condition constrains on "prioritee", which does not exist
    on incident. ... An SLA start condition loses its filter and attaches to
    every record on the table.
```

An SLA with **no** start condition is refused for the same reason.

#### Writes are read back field by field ✅

Trap #3 applies here too, and was re-measured on this table: a deliberate
`zzz_nowhelpassist_not_a_field` was accepted by the POST and absent from the stored
record, with no error. So `createSla`/`updateSla` compare every field sent
against the stored record and return `mismatches[]`; conditions compare modulo
the `^EQ` end marker, which the platform appends to anything saved through its
own condition builder and does not append to a REST write.

The live creation of the acceptance definition:

```
Created SLA definition "P1 resolve in 4h" (796fadd5837acf10b939cc65eeaad3ea);
every field read back as sent.
  duration  1970-01-01 04:00:00 → 4h
  clock     24x7 (no schedule in effect)
  start     active=true^priority=1
```

`contract_sla` writes land in the `global` scope as `sys_class_name:
contract_sla`, and DELETE followed by a read-back returns 0 rows — so create
and delete are both proven, not assumed.

---

### B-2 — SLA-aware verification

The runner gains an assertion type. In a `.verify.json` spec:

```json
{ "type": "sla",
  "sla": "P1 resolve in 4h",
  "locate": { "bySetupRecord": true },
  "expect": { "attached": true, "stage": "in_progress", "breached": false,
              "plannedEndToleranceSec": 120 },
  "note": "the P1 resolution clock starts" }
```

and `verifySla(name)` runs the same evaluator standalone for a definition that
has no flow attached to it. One implementation, two entry points.

#### The setup record is DERIVED, not generated ⚠️

A start condition is already a precise machine-readable statement of what has
to be true. Asking a model to restate it as a payload adds a way to be wrong
and nothing else — which is the entire §14/§20 failure class. So
`derivePayloadFor` parses the condition and builds the record in code, applying
trap #5 on the way:

```
start_condition   active=true^priority=1
derived payload   { active: "true", impact: "1", urgency: "1" }
note              priority=1 is CALCULATED (trap #5) — set impact=1, urgency=1
                  instead and never write priority
```

Then — and this is the part that makes the derivation checkable rather than
merely plausible — **the platform is asked whether the stored record satisfies
the condition**, by querying `sys_id=<id>^<start_condition>`. Live:

```
satisfies: true
observed:  active=true  impact=1 - High  urgency=1 - High  priority=1 - Critical
```

If a PDI had a customised priority matrix, this is where it would surface as a
named mismatch instead of a mysteriously unattached SLA. The check is sound
only because every field in the condition was confirmed to exist first —
otherwise the clause would drop and `sys_id=<id>` alone would match, passing
vacuously. Trap #2 defending against itself.

A clause with no single satisfying value (`LIKE`, `!=`, a `javascript:` value,
a dot-walk, an OR arm) is **named and the run refuses**, rather than being
approximated.

#### A task_sla row proves nothing about which SLA ⚠️ — new trap #18

One P1 incident, three attachments:

| task_sla.sla | name | planned end (UTC) |
|---|---|---|
| `796fadd5…` | **P1 resolve in 4h** (ours) | 15:24:19 |
| `35420982…` | Priority 1 resolution (1 hour) | 12:24:19 |
| `2ca94b74…` | Priority 1 response (15 minutes) | 11:39:19 |

An assertion of the form "a task_sla exists on the record" passes here **with
the definition under test deleted**. So the assertion filters by
`task_sla.sla == definition.sys_id`, and `sla` is mandatory in the spec —
enforced in `validateSlaAssertion`, not left to the prompt. When ours does not
attach, the failure names the rivals that did, because "nothing attached" and
"three attached and ours was not one of them" are different diagnoses and only
the second one is usually true.

#### Trap #UTC, applied

`task_sla` times are stored in UTC; the Table API's `display_value` renders
them in the session timezone. The same instant, from the live run:

```
start_time        value 2026-08-18 11:24:19   display 2026-08-18 04:24:19
planned_end_time  value 2026-08-18 15:24:19   display 2026-08-18 08:24:19
```

Seven hours. A runner that reads the display half and adds the 4h duration
expects 08:24:19, sees 15:24:19, and reports a **correct** SLA as seven hours
broken. `parseSnowUtc` takes only the `value` half and parses it with an
explicit `Z`; the display half is carried into the result for a human to look
at and is touched by no calculation. The offline suite fixture carries both
halves so a regression fails there rather than on a PDI.

#### The tolerance is stated in the spec, not defaulted in the runner

The clock starts when the platform attaches the row, not when the runner posted
the record, so the two differ by the insert's own latency. A tolerance living
inside the runner is a number that never appears in the artifact a human
reviews, so `expect.plannedEndToleranceSec` is **required** and its absence is
a validation error. Observed drift on the live run: **0s**.

#### Schedule-bound SLAs are bounded, not recomputed

Recomputing the schedule engine's arithmetic would mean reimplementing it, and
asserting the 24×7 expectation against it fails a correct SLA by 3.84h (see
B-1). So the assertion reports which mode it ran in and, for a scheduled SLA,
asserts what is actually true: the clock runs forward, it cannot be shorter
than the duration (a schedule can only push a breach out), and the schedule the
platform used is the one the definition names. Stated in the result, not
silently skipped.

#### Acceptance run, verbatim ✅

```
sla_verify_definition   P1 resolve in 4h on incident
sla_verify_setup        incident {active:"true", impact:"1", urgency:"1",
                                  short_description:"NowHelpAssist SLA check ..."}
                        note: priority=1 is CALCULATED (trap #5)
sla_verify_setup_done   INC0010035
sla_verify_setup_checked satisfies=true  priority=1 - Critical
sla_verify_poll         attached=1  pass=true
sla_verify_cleanup_done ok=true taskSlasAtStart=3 cascaded=true
                        taskSlasLeft=0 recordLeft=0

ok: true — "task_sla attached to the right definition with a sane breach clock
(4 checks passed)"
  exactly one task_sla references this definition
  stage is "in_progress"
  has_breached is false
  planned_end is start + 4h within 120s (drift 0s)
```

Cleanup is read back rather than assumed: deleting the incident **cascades**
its task_sla rows away on this instance (measured: 3 at start, 0 left), and any
survivor would be deleted explicitly and re-counted. A verification run that
leaves a running clock behind is debris with a breach date.

---

### B-3 — ACL analyzer (read / explain / diff)

`server/src/servicenow/acl.js`, `server/src/routes/access.js`, the **Access**
page, and the read-only tools `acl_report` / `acl_diff` / `explain_acls`.

**No authoring, deliberately.** An ACL is the one artifact class where a
confidently wrong write is a security incident rather than a bug. There is no
tool to create one and the system prompt forbids simulating one through
`create_record` on `sys_security_acl`.

#### `operation` and `type` are references with inconsistent sys_ids ⚠️ — new trap #16

`sys_security_operation` mixes two conventions in one table:

```
sys_id "read"    name read          sys_id "create" name create
sys_id "write"   name write         sys_id "delete" name delete
sys_id 0997ab83733303005978e4b9cdf6a7b9   name report_view
sys_id 7aad4c50b7f4621062b62181ce11a918   name conditional_table_query_range
```

A raw read gives a report that is half readable and half opaque, which looks
like a data problem rather than a reading error. `sys_security_type` is the
same: `record` is its own sys_id, `ux_page` is 32 hex. Every operation and type
is resolved through the display value, with a lookup map as the fallback and an
explicit `operationResolved: false` when neither can name it.

#### `nameSTARTSWITHincident` also matches `incident_task` ⚠️ — new trap #17

`incident_task` is a different table with **43** ACLs of its own. A prefix
query sweeps every one of them into an incident report. The query is
`name=<t>^ORnameSTARTSWITH<t>.` and each row is re-checked against
`belongsToTable`. Measured: **0 of 43** leaked.

#### ACLs are inherited

`incident` is governed by its own rows and by every `task` row. The report
walks `getTableHierarchy` and each row carries `definedOn` / `inherited`, so a
rule the reader cannot find on the incident ACL list is still visible with the
table that defines it named.

#### ACL conditions get the same trap #2 check

An ACL condition naming a field that does not exist has its clause dropped,
which makes the rule **broader** than it reads. Flagged per row and counted in
`counts.conditionsOnUnknownFields`. On `incident`: 0 — the OOB set is clean,
which is worth knowing rather than assuming.

#### The incident report, and the spot-check ✅

```
hierarchy   incident -> task
visibility  full        complete true
counts      total 143 · record 27 · field 116 · inactive 3 · scriptGuarded 17
            adminOverrides 99 · noRoleRequired 32 · conditionsOnUnknownFields 0
operations  conditional_table_query_range, create, delete, list_edit,
            query_range, read, report_view, save_as_template, write
roles       20
```

**Spot-check: 3/3.** Three ACLs — a deny-unless rule with a security attribute
and no roles, a role-plus-condition rule, and a script-guarded rule — were
re-read through a **separate** code path (a direct `table.get` per record plus
its own `sys_security_acl_role` query, sharing no helper with the analyzer) and
compared field by field on name, operation, type, active, admin_overrides,
advanced, condition, script presence and roles. All three match.

> **Provenance, stated plainly.** This is a read-back against the raw records,
> which is what the platform form renders. It is **not** a human opening three
> ACL forms in the ServiceNow UI, and it cannot be — nothing in this
> environment drives a browser. If the platform form shows a field this
> comparison does not read, the spot-check would not catch it.

#### The diff shows real differences ✅

`admin` vs `itil` on `incident`:

```
only itil   conditional_table_query_range, read, write
both        report_view
only admin  (none)
field differences  36
```

That "only admin: none" invites a wrong conclusion, and the diff says so
above the grid rather than under it: **21 of 27 record ACLs on incident set
`admin_overrides`**, which means they are *skipped* for admin. Admin not being
named is the grant, not the absence of one. The result also carries a standing
caveat that this compares which rules **name** each role and is not an
evaluation of access — the platform runs every matching ACL at each level, most
specific first, and a field ACL, condition, script or security attribute can
deny what a table-level row appears to allow. NowHelpAssist does not run that
engine, and a report implying it did would be worse than no report.

#### Read-restricted renders loudly ✅

`sys_security_acl` is itself ACL-protected: a connection without the
`security_admin` elevation gets a refusal or an empty list. An empty list
rendered as an empty report says *"this table has no ACLs"*, which is the most
dangerous sentence this feature could produce. Three states, always reported:

| `visibility` | what happened | what the banner says |
|---|---|---|
| `full` | rows read | the count and the chain |
| `empty` | none for this table, but other tables' ACLs ARE readable | "a real absence rather than a permission problem" |
| `restricted` | no ACL row visible anywhere | "a visibility result, not a security result… do not read this as *X has no ACLs*" |
| `error` | the read threw | "This report is INCOMPLETE", quoting the failure |

`complete` is false for `restricted` and `error`. The banner is rendered on
every report, not only the bad ones, so the reader is never left to infer which
state they are looking at.

The same distinction runs one level down. An ACL with **no role rows** is "no
role required"; an ACL whose roles could **not be read** is `roles: null,
rolesUnknown: true`. These are opposite answers, and a bug caught while writing
the tests had them sharing `undefined` — which rendered an unreadable rule as
an unrestricted one, in a security report. Both states are now asserted.

Since this cannot be produced on an admin connection, it is driven in the
offline suite by injecting a reader that throws and one that returns empty.
**Not** verified against a real de-elevated login here.

#### The explanation, and a measured model failure ⚠️ — guard B-1

"Explain in plain language" sends the structured report through the configured
provider, read-only, and the answer is labelled AI-generated at the API
boundary and again in the UI.

The **first live run** against `gpt-oss:120b-cloud` opened correctly and then
collapsed:

```
Roles that appear on record ACLs include sn_incident_read, sn_incident_write,
itil, itil_admin, … sn_incident_comments_write, sn_incident_write,
sn_incident_read, sn_incident_admin, sn_incident_comments_write,
sn_incident_write, sn_incident_read, sn_incident_admin, …
```

— four role names cycling roughly sixty times inside one sentence, at HTTP 200,
with plausible prose either side of it. That output is worse than none: it sits
beside a report that IS accurate, so the loop reads as a finding about the
instance rather than as the model breaking down.

`detectDegenerateRepetition` rejects it on two independent signals (a short
n-gram repeating back to back, or a 40-word window with fewer than 7 distinct
words), then **retries once with the repeated fragment quoted back as
evidence** — the A5 rule, because a byte-identical re-ask of a backend that
provably ignores `seed` (trap #12) is a coin flip dressed as a correction. Two
degenerate attempts is a loud 422 that says the failure is the generation's and
that the structured report beside it is unaffected.

The captured loop is a fixture in the offline suite. Re-running the same
request afterwards produced a clean, usable explanation on the first attempt —
which is trap #13 restated: nothing here is reproducible, so the guard has to
hold rather than the generation.

#### The assertion inside a real flow spec ✅

The two halves above — the evaluator and `verifySla` — were proven separately,
which leaves the runner's own dispatch unproven. So an SLA assertion was added
to the live spec for `Escalate Network P1 Incident` (a deployed flow whose setup
raises a P1) and the whole spec run:

```
verify_setup_done   INC0010036
verify_execution    IN_PROGRESS -> COMPLETE
verify_assert       incident.work_notes    PASS
verify_assert       incident.assigned_to   PASS  (Bow Ruggeri)
verify_assert       sla:P1 resolve in 4h   PASS
verify_cleanup

ok: true — 3/3 assertions passed
clock  { mode: "24x7", startUtc: "2026-08-18 11:43:07",
         plannedEndUtc: "2026-08-18 15:43:07", expectedSec: 14400,
         observedSec: 14400, driftSec: 0, toleranceSec: 120 }
others [ "Priority 1 resolution (1 hour)",
         "Priority 1 response (15 minutes)",
         "Network group resolution" ]
```

Three rival SLAs that run this time, not two — the flow assigns the Network
group, which brings a third definition with it. The spec file was restored
byte-for-byte afterwards and the working tree is clean.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 16 | **`sys_security_acl.operation` / `type` sys_ids are inconsistent** | half the report reads `read`/`write`, the other half reads `0997ab83733303005978e4b9cdf6a7b9` — it looks like corrupt data | The core operations' sys_ids ARE the words; extended ones are 32-hex. Resolve through `display_value`, keep a `sys_security_operation` map as the fallback, and flag anything neither can name |
| 17 | **`nameSTARTSWITH<table>` matches sibling tables** | 43 `incident_task` ACLs land in an `incident` report and read as incident rules | Query `name=<t>^ORnameSTARTSWITH<t>.` and re-check each row: a name belongs to a table only if it equals it or starts with it plus a dot |
| 18 | **A `task_sla` row proves nothing about WHICH SLA** | "the SLA attached" passes with the definition under test deleted — one P1 incident attaches three rows here | Filter by `task_sla.sla = <contract_sla sys_id>`, and when it is missing, report which rivals DID attach |
| 19 | **`contract_sla.duration` carries days in the DATE half** | a 2-day SLA reads as `00:00:00`, i.e. zero | It is an offset from 1970-01-01: `1970-01-03 00:00:00` is 2 days. Decode it; never read the time half alone |
| 20 | **A `schedule` is inert unless `schedule_source` is `sla_definition`** | the field is set, the UI shows it, the clock runs 24x7 | Measured: 4.00h vs 7.84h on otherwise identical definitions. Set both, and check `task_sla.schedule` on the attached row rather than the definition |
| 21 | **`task_sla` times are UTC; `display_value` is session-local** | a breach clock checked against the display half is out by the offset — 7h here — and fails a correct SLA | Parse the `value` half with an explicit `Z`. Trap #UTC, now with a second table it applies to |
| 22 | **A weak model can return HTTP 200 and a repetition loop** | correct prose, then one phrase cycling sixty times, printed next to an accurate report where it reads as a finding | Check generated text for n-gram loops and low lexical variety before showing it. Retry once WITH the fragment quoted as evidence, then refuse loudly |

---

## 23. Track C — catalog UI policies, variable editing, agent parity

Measured against `dev442675.service-now.com` before the code that relies on it
was written. The centrepiece is a constraint that changed the design mid-build.

---

### The finding: `catalog_ui_policy_action` cannot be written over REST ⚠️

A POST to `catalog_ui_policy_action` returns **201 Created** and silently
discards `ui_policy` and `catalog_variable` — the two fields that attach an
action to its policy and to its variable. Everything else lands. Field by
field:

```
ui_policy          sent="6717f5d5…"                stored=""   <-- DROPPED
catalog_variable   sent="IO:3617b5d5…"             stored=""   <-- DROPPED
variable           sent="justification"            stored="justification"  OK
visible            sent="false"                    stored="false"          OK
mandatory          sent="true"                     stored="true"           OK
disabled           sent="true"                     stored="true"           OK
order              sent="250"                      stored="250"            OK
```

The result is a policy with actions that do nothing, and nothing anywhere says
so. `PATCH` after insert is dropped too.

**The cause, found with Track B's own analyzer in one query:**

```
sys_security_acl:  sys_ui_policy_action.ui_policy / create  roles=["nobody"]  admin_overrides=false
                   sys_ui_policy_action.ui_policy / write   roles=["nobody"]  admin_overrides=false
```

A field ACL granting only the role `nobody`, with `admin_overrides` **off**, so
not even an admin passes it — and the Table API DROPS a field the caller may not
write rather than refusing the request. That is trap #3 wearing a different hat:
the same silence, a different reason.

Note the inversion that makes this hard to guess at. `variable` and
`catalog_item` ARE marked `read_only: true` in the dictionary and they store
fine; `ui_policy` and `catalog_variable` are `read_only: false` and do not. The
dictionary is not the thing to read here.

**Measured through three independent channels before redesigning around it:**

| channel | result |
|---|---|
| Table API, basic auth, admin | 201, both fields empty |
| Table API from a logged-in browser session with `X-UserToken` | 201, both fields empty |
| the platform's own classic form | renders `ui_policy` **read-only**; `sysparm_query` does not prefill it |

It is not a credential problem and not an item-state problem: it reproduces on
an out-of-box item whose policies already work. The `catalog_variable` half has
no ACL naming it and is presumably dropped by the `Restrict edit if the item is
checked out` business rule, whose script is not readable through any channel
tried here — so that half is a **measurement without a mechanism**, and is
recorded as such.

### The answer: drive the SDK, which is what the repo already does for `sys_hub_*`

`now-sdk explain --list` has `cataloguipolicy-api`. The SDK installs metadata as
a system operation, so both fields land:

```
action  ui_policy        = 668aba2f…   (the installed policy)
        catalog_variable = IO:3617b5d5…
        variable         = justification
        visible          = false
```

So NowHelpAssist **reads catalog UI policies over the Table API and writes them
through the SDK**, in one deterministic template — a policy draft is already
precise, so there is nothing for a model to add and one more way to be wrong.
`fluent.js` exports a shared build/install surface, because two concurrent
`now-sdk install` runs would each ship a half-built `dist/`.

One SDK detail, measured: `variableName` takes the **bare sys_id**. Passing
`IO:<sys_id>` produced `catalog_variable = "IO:IO:<sys_id>"`.

---

### Four more behaviours the builder handles up front

1. **The condition is not an encoded query.** `catalog_conditions` is a
   `variable_conditions` field addressing variables by sys_id with an `IO:`
   prefix — `IO:35c19214f7752110ed589ef0e3bfd6c3=true^EQ`. A field name means
   nothing here. `conditions.js`'s `splitQuery` handles the joiners, since
   `^` / `^OR` / `^NQ` mean the same thing; only the operand grammar differs.

2. **An action needs both `variable` and `catalog_variable`** — the internal
   name AND `IO:` + the sys_id. Every out-of-box action sets both.

3. **`visible` / `mandatory` / `disabled` are the strings `ignore` / `true` /
   `false`.** `ignore` means leave alone and is the default, so an action that
   sets nothing saves cleanly and does nothing. Refused before the write.

4. **`ui_type` — and a claim that was wrong.** It defaults to 0, labelled
   "Desktop" against 1 "Mobile / Service Portal" and 10 "All", and 82 of the
   100 out-of-box policies here sit at 0. The obvious reading is that a
   default-valued policy does not run on the portal, and this project asserted
   exactly that, in a code comment, a validation warning and a commit message,
   before measuring it.

   **It is wrong on this release.** The same policy installed at ui_type 0 hid
   and revealed its variable on `/sp?id=sc_cat_item` identically to the same
   policy at 10 — reinstalled at 0, re-driven through the portal, reinstalled
   back at 10, re-checked. The warning is gone; a guard that fires on a
   distinction which does not exist teaches people to ignore guards. NowHelpAssist
   still writes 10, but for a defensible reason rather than a measured one: it
   is the SDK's own default for `runScriptsInUiType` and unambiguous everywhere.

---

### C-1 — the builder ✅

`server/src/servicenow/catalogPolicy.js`, routes under `/api/catalog`, and a
**UI policies** tab in the item view alongside Variables and Variable sets.

Choice-aware by construction: the value control becomes a dropdown of the
variable's real choices the moment a variable with any is picked, so the
commonest way to write a condition that can never be true — comparing a select
box against its display label rather than its stored value — is not reachable
from the form. Validation refuses, before anything is written:

| refused | why it matters |
|---|---|
| a condition on a variable that is not on the item | evaluated against the form, so it can never be satisfied |
| a choice value the variable cannot hold | never true; the real values are listed in the error |
| a checkbox compared with anything but true/false | same |
| an action left entirely on `ignore` | saves cleanly, does nothing |
| no condition at all | always true, so it applies unconditionally |

Hiding a variable that is **mandatory** warns rather than blocks: it is legal,
and the correct fix (`mandatory: 'false'` in the same action) is one field away.
The SDK's own guide agrees — "hide mandatory variables that have no value" is on
its NEVER list.

**Acceptance, live, driven through NowHelpAssist's own UI:**

```
policies before the UI run: 0
  → item picked, UI policies tab, form filled, Create policy
result: Installed UI policy "Hide justification unless approval is needed"
        with 1 action(s); every action reads back attached to the policy and
        to its variable.
policies after: 1  managed=true  actions=1  problems=0

Service Portal /sp?id=sc_cat_item:
  checkbox unchecked → Justification NOT visible
  checkbox ticked    → Justification visible
```

Screenshots: `docs/media/c1-ui-1-builder.png`,
`c1-ui-2-installed.png`, `c1-ui-3-policy-list.png`,
`c1-portal-1-hidden.png`, `c1-portal-2-shown.png`. Visibility is asserted from
the element's own bounding box, not its presence in the DOM.

---

### C-2 — variable editing ✅

Inline edit (question text, order, mandatory, help text, default), reorder, and
choice CRUD on choice-type variables.

**Reordering renumbers the whole list**, server-side, from 100 in steps of 100,
reading every row back. `order` is an integer and two variables sharing a value
render in an order the platform picks — which looks exactly like the reorder
having failed. Measured live: swap and restore, every row `ok: true`.

**Editing is in place, never delete-and-recreate.** A recreated variable gets a
new sys_id, and every UI policy condition and action naming the old one keeps
the reference and silently stops matching. The agent tool description says so
too, because that is the shortcut a model reaches for.

A derived choice value drops punctuation rather than underscoring it:
`Contractor (30 days)` was producing `contractor_(30_days)`, a value nobody
wants to type into a condition and one that reads like a mistake when it turns
up in one.

Destructive confirmation is one module — `client/src/components/confirm.js` —
with the consequence text written once per artifact kind. Track D's dialog
replaces that file and nothing else.

---

### C-3 — completeness, and a stale hardcoded list ✅

Item active toggle, category creation inline where a category is picked, order
guide and record producer delete, and a producer row that links straight into
the item view — a record producer IS a catalog item, so managing its variables
should not mean finding it again by hand. Each exercised over HTTP against the
live PDI.

**Variable type codes now come from the instance dictionary.** The hardcoded
list was wrong here in the way hardcoded lists go wrong:

| code | the hardcoded list said | this instance says |
|---|---|---|
| 31 | Rich Text Label | **Requested For** |
| 32 | Attachment | **Rich Text Label** |
| 33 | *(absent)* | **Attachment** |

26 codes against the instance's 31. It survives as a fallback, and the UI says
loudly when it is being used — serving stale codes quietly is how a variable
ships with a silently different type.

---

### C-4 — agent parity, and A6 ✅

Five tools: `get_catalog_item` (deep read with the real choice VALUES),
`add_catalog_variable`, `update_catalog_variable`, `list_ui_policies`,
`create_ui_policy`. The two writers are mutating and gated.

#### Operator labels, normalised

Asked for "mandatory only when duration is Permanent", the model emitted
`"operator": "is"` — the label this module publishes in its own metadata.
Accepted now: the mapping is exact and closed, so rejecting it would be
pedantry. The choice VALUE is deliberately **not** normalised — "Permanent" and
"permanent" are genuinely different there, and guessing is how a condition ends
up never matching.

The same reasoning applies to action states: `visible: false` from a JS caller
means "hide it", which is what the string `"false"` means here. That used to
happen by accident through a bare `String()` call; it is now a named function
with a comment, because an accident is not a decision.

#### A6 — the stalled turn ⚠️

**Twice in three runs.** The model resolved the item, read its variables, quoted
the two correct sys_ids and the right choice value in a tidy table, and ended
the turn with:

> *Shall I create this UI Policy now? (It will take about a minute.)*

Nothing was created. Nothing said so. From outside, a stalled turn looks exactly
like a finished one: prose arrives, the stream closes.

Tightening the prompt did not fix it — the system prompt already said the
approval gate IS the confirmation and to call the tool, and the model asked
anyway. That is §20's lesson again, so it is a guard. One nudge per turn,
carrying the fact the model lacked: that its question reached nobody, and that
approval is requested BY calling the tool.

Narrow by construction — it needs a directive from the user, an assistant line
asking to proceed, and **no mutation anywhere in the turn**. That last clause was
itself a fix: the first version counted calls in the closing iteration and
nudged a turn that had already created the policy and was signing off politely.

**Acceptance, live, one approval:**

```
lookup_reference → get_catalog_item → list_ui_policies →
create_ui_policy (approved) → list_ui_policies

Corp VPN, Service Portal:
  duration = Temporary → justification aria-required="false"
  duration = Permanent → justification aria-required="true", starred,
                         and listed under "Required information"
```

Screenshots: `docs/media/c4-vpn-1-optional.png`, `c4-vpn-2-mandatory.png`.

#### A UI policy is proven by the form, never by the record

Driving that form produced one more finding worth keeping. Setting the Angular
model directly — `scope.$apply(() => { scope.fieldValue = 'permanent'; })` —
changed the value and did **not** re-evaluate the policy. Only a real click
through the input pipeline did. The record was identical in both cases.

---

### How the browser checks were run

No Playwright or Puppeteer, and none added: adding a browser dependency to this
repo for an acceptance run would change its dependency profile without being
asked. Node 24 ships a global `WebSocket`, so the checks drive the installed
Chrome directly over the DevTools protocol — launch with
`--remote-debugging-port`, attach to the page target, `Page.navigate`,
`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`. About
90 lines, and it lives in the scratchpad rather than the repo.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 23 | **`catalog_ui_policy_action` silently drops `ui_policy` and `catalog_variable`** | POST returns 201, every other field lands, and the policy has actions that do nothing | A field ACL granting only `nobody` with `admin_overrides` off; the Table API DROPS a field the caller may not write. Write these through the SDK. Read the ACLs before assuming a write path exists |
| 24 | **The dictionary's `read_only` flag does not predict which fields a REST write keeps** | `variable` is read_only and stores; `ui_policy` is not and does not | Field ACLs decide, not the dictionary. Test the write and read it back, per field |
| 25 | **A catalog UI policy condition is `IO:<variable sys_id>`, not a field name** | a condition written with field names saves and never matches | `catalog_conditions` is a `variable_conditions` field. Address variables by sys_id with the `IO:` prefix, and end with `^EQ` |
| 26 | **`visible`/`mandatory`/`disabled` default to `ignore`** | an action saves cleanly and changes nothing | They are strings, not booleans, and `ignore` means leave alone. An action must set at least one |
| 27 | **`ui_type` 0 is labelled "Desktop" but is NOT a Service Portal exclusion** | you build a guard around a distinction that does not exist | Measured: a policy at ui_type 0 worked on `/sp` identically to one at 10. Read the label as a label |
| 28 | **Hardcoded platform code lists go stale silently** | a variable ships as "Requested For" when you asked for "Rich Text Label" | 31/32/33 all shifted here, and five codes were missing. Read choice lists from `sys_dictionary`; keep any hardcoded list as a loud fallback |
| 29 | **A stalled agent turn is indistinguishable from a finished one** | correct analysis, correct sys_ids, then "Shall I create this now?" — and nothing happened | The approval gate is only shown by CALLING the tool. Detect a directive answered with a request to proceed and no mutation, and feed that fact back |
| 30 | **Setting an Angular model directly does not re-evaluate a UI policy** | the variable's value changes on the form and the policy does not fire, so a correct policy looks broken | Drive the real control through the input pipeline. A UI policy is proven by the form, never by the record |

---

## 24. Track D — the experience layer

Six items, all client-side except the audit trail, which needed a fifth
migration before its page could say anything true. The rule for the whole track
was that the theme is fixed: the wordmark, the sidebar, and the `ink / panel /
verdigris / amber` + `Sora / Inter / IBM Plex Mono` token set are extended,
never replaced. Every selector added below resolves to a value already declared
at the top of `styles.css`.

The interesting part of this track is not the components. It is that four of
its six items were shipped with a defect that only a **measurement** exposed,
in each case after the code read as obviously correct.

### D-1 — markdown in agent bubbles ✅

`react-markdown` + `remark-gfm`. Agent bubbles render; user bubbles stay
literal, because what you typed is what you should see.

The plugin list and the element overrides live in a plain-JS
`markdownConfig.js` rather than inside `Markdown.jsx`. That is not tidiness:
Node cannot import `.jsx`, so anything expressed there is unreachable from the
offline suite, and "we added react-markdown" is not a claim worth making
without rendering something. `server/test/markdown.test.js` renders the real
pipeline through `react-dom/server`.

Two things that rendering found and reading would not have:

- **react-markdown passes the mdast `node` into every component override.**
  Spreading it onto a DOM element emits `node="[object Object]"` and makes
  React log *"does not recognize the `node` prop"* on every message. D-6's
  clean-console requirement would have failed on the agent page alone.
- **`**Vendor issue: **` is not emphasis.** The first draft of the test used
  the A3 guard's literal, trailing space and all, and failed. That is
  CommonMark working as specified — a closing `**` preceded by whitespace is
  not a closer. Pinned in a test so leftover asterisks there are never read as
  this feature being broken.

Raw HTML stays escaped; `rehype-raw` is absent and should stay absent, because
this text is written by a language model.

**Measured on the live page** (session `c9c9be27`, which contains the original
defect): 1 table inside its scroll wrapper, 19 `<strong>`, 5 `<code>`, 4 lists,
**0** stray `**`, **0** stray pipe rows, 0 `node=` attributes, user bubbles
plain, code rendered in IBM Plex Mono on `rgb(27,34,43)` — which is `--panel-2`
exactly.

### D-2 — toasts and one confirmation dialog ✅

Seven `window.confirm` calls and one `window.prompt` are gone. They already
routed through `components/confirm.js`, the seam Track C left for this, so the
swap touched call sites only to give the dialog what the native one could never
show: **the sys_id next to the label**, because a display name is not unique on
an instance, and **the stated consequence**, because deleting a catalog
variable does not fail — it silently breaks every UI policy that names it
(trap #25).

Cancel takes focus, not the destructive button, so Enter and Escape both mean
*no* on a dialog someone may have opened by accident.

Toasts are a module-level store rather than a React context, for two reasons
that are both about correctness rather than convenience. Raises happen in
`.catch` blocks and SSE callbacks that outlive the render that started them.
And React runs effects **child-first**, so a page toasting from its own mount
effect fires before an app-root host could have registered a sink — the store
queues, so an early toast renders late instead of vanishing.

With no dialog mounted, `confirmDestructive` throws rather than falling back to
`window.confirm`. A silent fallback would restore the removed behaviour on the
one code path where being wrong deletes a record.

### D-3 — loading, empty, and disconnected ✅

The honesty defect first, because it is the reason this item exists. Incidents,
SLA and Flows each rendered **one sentence for two opposite facts**:

> No incidents match. Connect your PDI on the Dashboard first.

That is the failure the ACL analyzer needed a `visibility` field to avoid (§22)
— an empty result and an unreadable one look identical unless something states
which it is. Worse, the binding was answered by four sources that disagreed:
the topbar's private 20s interval, the Dashboard reading `/system/settings`,
and three pages inferring it from an empty array.

One store, one poller, in-flight coalescing. `/api/system/health` is the only
answer, and "nothing matched" now only ever means nothing matched.

The rest: skeleton rows shaped like the table they stand in for, with widths
derived from position rather than random — a skeleton that reshuffles between
renders reads as content still arriving, and StrictMode's double render in dev
would make it visibly twitch. Designed empty states carrying a reason and a
next action. `aria-busy` on 27 async buttons, driving the spinner from the same
attribute assistive tech reads, so a button cannot be visually busy and
semantically idle. A route-level `ErrorBoundary` with a copyable stack, keyed
on the path so one bad page cannot brick the session.

### D-4 — identity ✅

One SVG, loaded by both the browser tab and the sidebar, so the two cannot
drift. `NH` in verdigris on ink, rounded square, hairline in verdigris-dim — it
splits where the wordmark splits, Now | HelpAssist. The
letters are **paths, not `<text>`**: a favicon renders outside the page, cannot
see the Sora webfont, and would fall back to whatever each OS picked.

The geometry was set by rendering it at 16px rather than by looking at it
large. The first pass had so much padding that the glyphs closed into a smudge
in the tab strip; they now occupy 56% of the square.

Two silent failures, both found by measuring `naturalWidth` rather than by
looking at the tab:

- **A double hyphen is illegal inside an XML comment.** Naming the design
  tokens the usual way put `--ink` and `--verdigris` in the comment. The HTML
  parser forgives that when an SVG is inlined; the XML parser does not when the
  same file is fetched through `<img>` or `<link rel=icon>`. The sidebar drew a
  broken-image glyph while the tab icon looked fine.
- **An SVG carrying only a `viewBox` has no intrinsic size**, so `<img>`
  reports `naturalWidth: 0`. It needs `width`/`height` as well.

And the mark's 35px cost the sidebar subtitle its single line, which pushed
every nav item down — so the subtitle keeps its own full-width row.

Titles are per route (`Agent — NowHelpAssist`). Eight pages behind one title made a
pinned tab unidentifiable among its own siblings.

### D-5 — the audit page ✅

`tool_events` was named after a job it could not do. Two gaps, both in storage:

1. **Results were never stored.** The sys_id of a created record exists only in
   the tool's return value, so *"what did this session do to the instance"* was
   unanswerable from the table whose comment says it is the audit trail.
2. **It is keyed on an agent session.** Every build driven from a module page —
   a flow deploy, a catalog UI policy, an SLA verification, each writing to the
   instance through the SDK — belonged to no session and left no trace at all.

Migration 5 adds `result`, `actor` and `instance` to `tool_events`, plus
`build_runs` and `build_events`. Instance and account are captured **per
event** rather than read off the session, because the bound connection can
change under a long conversation and the trail has to say where a write landed.
Six SSE routes stream through an audited emitter; `smoke` and `DELETE` are
recorded too, so the audit has no hole shaped like *"writes we did quickly"*.

Three honesty properties, each asserted in `server/test/audit.test.js`:

| property | why it is not cosmetic |
|---|---|
| `auto` stays `auto` | it means auto-approve was on and **no human saw the gate**. Rendering it as "approved" would assert a decision that never happened, on the one page whose entire job is trust |
| pre-migration rows say *not recorded* | "nothing came back" and "we did not store it" are opposite facts, and an empty cell asserts the first |
| a run that dropped events says so | an audit write must never kill a deploy already touching the instance, and must never vanish either. The count goes in the row and the page prints "this history is incomplete" |

On *"who approved"*: NowHelpAssist has no user management, so naming a person would
be a lie. What is recorded is what can be stated truthfully — the decision
(`approved` / `rejected` / `auto` / none) and the ServiceNow account the write
landed under.

Two bugs the tests caught:

- **sys_id harvesting used `\b`.** A ServiceNow deep link URL-encodes its
  separator — `catalog_ui_policy.do%3Fsys_id%3D196e6cb2…` — and the `D` of
  `%3D` is a word character, so `\b` never matched. The page dropped precisely
  the identifier of the thing that had just been created, in precisely the
  format the agent uses to report its own work. The boundary is "not more hex",
  not `\b`.
- **The CSV neutralises a leading `=`, `+`, `-` or `@`.** Excel and Sheets
  evaluate those, and these cells carry model-authored text.

#### Live acceptance (dev442675)

Driven end to end against the real PDI, then answered from `/api/audit` alone:

```
create_record   mutating=true  approval=approved  ok
                sys_ids  6816f79cc0a8016401c5a33be04be441 (caller)
                         c84b2da1837a4350b939cc65eeaad385 (INC0010037)
delete_record   mutating=true  approval=approved  ok
                sys_ids  c84b2da1837a4350b939cc65eeaad385
sla_verify      source=build   approval=ui        ok    dropped=0
                8 streamed events, 6 sys_ids incl. the task_sla rows
```

The CSV honours the page's filters rather than dumping the table, because an
export that silently differs from the screen is worse than no export.

### D-6 — the sweep ✅

The connected click-through was clean. The **disconnected** one logged 18
console errors and exposed two bugs behind them.

**The instance gate gated the wrong thing.** Wrapping a page's returned JSX
controls what it *draws*, not what it *does* — the component is already mounted
and its `useEffect` has already fired the request. Every gated page asked an
unbound instance for data and 400'd before the gate replaced it. The first fix
attempt got 18 → 14, which is the useful part of the story: gating inside the
component **cannot** work. Moving the wrapper to the route means React never
mounts the page. 18 → 0.

**`/api/system/health` blocked on the SDK capability probe** — two `now-sdk`
shell-outs, ~5.5s on a cold cache — to populate a field no client reads. That is
the endpoint every page polls to answer *"is an instance bound"*, so the topbar
read `checking…` for five seconds and the SLA page rendered ungated because the
answer had not arrived. It now serves the cached probe and refreshes in the
background: **5.5s → 21ms cold, 2ms warm.** A probe that has not run reports
`pending`, not `ok: false` — the latter prints fix commands for a problem
nobody has.

That is also what made it affordable for the gate to hold a page back while
health is unknown rather than render it optimistically, and the D-3 test
asserting the opposite was inverted with its reasoning kept.

**The session rail's actions were unreachable by keyboard.** They were revealed
on hover with `display: none`, which removes an element from the tab order — so
rename and delete could not be tabbed to on any row but the active one, and
D-2's dialog could not restore focus to a button that had gone `display: none`
while it was open. Adding `:focus-within` to that rule was measured and found
**inert**: nothing can focus into a subtree that is not rendered. Clipping
keeps them focusable and looks identical.

#### How the keyboard pass was run

Real key events over CDP (`Input.dispatchKeyEvent`), not `element.focus()`.
The distinction is load-bearing: `:focus-visible` — which is what paints
NowHelpAssist's verdigris ring — deliberately does **not** match programmatic focus,
so the first probe reported "no focus ring" on components whose ring is fine.
A probe that only looks for an `outline` also reports a false gap on every
select and textarea, because this theme gives fields a verdigris **border**
instead (`.input:focus { outline: none }`, which predates Track D).

Measured:

| check | result |
|---|---|
| focus indicator, tabbing every control on the Audit page | **14/14** verdigris (outline on buttons/links, border on fields) |
| collapsible payload blocks | reached by Tab, opened with Enter, `aria-expanded` flips |
| rail rename/delete on a non-active row | reachable, revealed on focus |
| confirm dialog | opens from the keyboard, focus lands on **Cancel**, Tab cycles only inside it, Escape closes, focus returns to the button that opened it |
| Enter-to-send | plain Enter sends; Shift+Enter still inserts a newline |
| console, 9 pages × connected and disconnected | **0 problems** |

Browser checks use the same scratchpad CDP driver §23 established — no
Playwright, no Puppeteer, no new repo dependency.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 31 | **Gating a component's returned JSX does not gate its effects** | a page that "cannot run without an instance" still fires every request and logs 400s behind its own not-connected screen | The component is mounted before it returns. Gate at the ROUTE — or anywhere the child is an unmounted element — so React never mounts it |
| 32 | **A status endpoint that shells out is a status endpoint that lies** | the topbar reads `checking…` for five seconds; a gate renders the wrong branch because the answer had not arrived | `/health` was `await capability()` — two `now-sdk` spawns, 5.5s cold, for a field no client read. Serve cached, refresh in the background, and report a probe that has not run as `pending` rather than `ok: false` |
| 33 | **`display: none` removes an element from the tab order, so `:focus-within` can never reveal it** | you add `:focus-within` to a hover-reveal rule, it changes nothing, and the CSS looks correct | Nothing can focus into a subtree that is not rendered. Clip it (`position: absolute; clip: rect(0 0 0 0)`) instead — focusable, and visually identical |
| 34 | **`:focus-visible` does not match `element.focus()`** | an accessibility probe reports "no focus ring" on components whose ring is perfect | Drive real key events. And read the indicator the design actually paints: this theme rings buttons with an outline and fields with a border |
| 35 | **A double hyphen inside an XML comment makes an SVG invalid** | the same file renders inlined and silently fails as `<img>` or `<link rel=icon>`; `naturalWidth` is 0 | Naming CSS custom properties in a comment (`--ink`) is enough to do it. The HTML parser forgives, the XML parser does not. Check `naturalWidth`, not the tab |
| 36 | **An SVG with only a `viewBox` has no intrinsic size** | `<img>` renders it as broken, or at 0×0, with no error anywhere | Ship `width`/`height` alongside `viewBox` |
| 37 | **`\b` does not bound a hex id inside a URL-encoded string** | a sys_id scanner silently skips `…sys_id%3D196e6cb2…` — the exact format the agent uses to report what it created | The `D` of `%3D` is a word character. Bound with "not more hex" (`(?<![0-9a-f])…(?![0-9a-f])`), and test against a real transcript rather than a tidy example |
| 38 | **A spreadsheet executes a CSV cell starting with `=`, `+`, `-` or `@`** | an audit export of model-authored text becomes a formula on open | Prefix a single quote. An export is the one artifact that leaves the tool, so it is the one place untrusted text becomes someone else's problem |
| 39 | **`**bold **` is not bold** | a markdown renderer ships and asterisks are still visible in one spot, so the feature looks broken | CommonMark: a closing `**` preceded by whitespace is not a closer. The source is wrong, not the renderer |

---

## 25. The rename — NowForge → NowHelpAssist

The product is renamed everywhere it names itself: the wordmark, the mark, tab
titles, prompts, log lines, error text, package names, the CSV export filename,
this document. The mark splits where the wordmark does — `NH` for
Now | HelpAssist — and was re-cut and re-checked at 16px, because that is the
only size the geometry is actually for.

### What was NOT renamed, and why

A name is a label in most places and an **address** in a few. The addresses are
left alone, and this is the list, because a later reader will otherwise see
"NowForge" in the tree and assume the rename was simply incomplete.

| kept | what it is | what renaming it would do |
|---|---|---|
| `x_2196302_nwforge` (+ its `scopeId`) | the scope of the application **installed on the PDI** | `now-sdk install` would create a second, empty application and leave all nine deployed artifacts behind in the first. A scope is not a display name; it cannot be edited in place |
| `NowForge Flows` | that application's name | same — the SDK matches the app by it |
| `nowforge-flows` | the SDK package name inside `fluent-workspace` | build identity for the above |
| `// nowforge-spec: <fingerprint>` | how `fluent.js` finds the existing source for a request (invariant **d**) | every managed source becomes unrecognisable, so the next edit of an existing flow deploys a **duplicate** instead of updating it. That is the CLASS C failure §12 exists to document, re-created on purpose |
| `// nowforge-policy: <slug>` | the same mechanism for catalog UI policies | a policy NowHelpAssist authored would start reading as one it did not, and become un-editable and un-removable through the toolchain (§23) |
| `NowForge Smoke Test`, and its `short_descriptionLIKEnowforge-smoke-test` trigger | a deployed flow and the condition it fires on | the deployed flow keeps the old name; a renamed source would install a second one |
| `NowForge: change approved…`, `NowForge URGENT escalation…` | **promised literals** asserted by `.verify.json` against flows currently running | the A3 guard would fail its own specs until every flow was regenerated and redeployed. These are the flows' content, not the product's name |

The whole of `server/fluent-workspace/` is therefore untouched.

If the scope should genuinely change, that is a migration, not a rename:
install under the new scope, move or recreate the artifacts, verify each one,
then delete the old application. It is worth doing deliberately or not at all.

### Two addresses that WERE renamed, with a migration each

| moved | carried across by |
|---|---|
| `server/data/nowforge.db` → `nowhelpassist.db` | `adoptLegacyDatabase()` runs before the first open: it checkpoints the old WAL into the main file — so renaming one file cannot strand committed rows in a `-wal` nobody will look for again — renames it, clears the stale sidecars, and logs that it did. Idempotent: once the new file exists it is a no-op |
| `localStorage['nowforge.sessionId']` | read as a fallback on mount and cleared on the first write, so a chat open across the rename is not silently replaced by a new empty one |

Both exist for the same reason: the Audit page's entire claim is that history
survives, and a rename that quietly started a fresh database would have been
the most ironic possible way to break it.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 40 | **A rename is a find-and-replace until it hits an address** | the product renames cleanly, the build is green, and the next deploy silently creates a second scoped application beside the live one | Separate labels from addresses first. A ServiceNow scope, an app name, an identity marker a tool matches sources by, and any literal a verification spec asserts are all addresses — protect them explicitly, and write down why, or the next reader will "finish the job" |
| 41 | **A renamed data file is a discarded data file** | the app starts, works perfectly, and has no history — the old database is sitting next to the new one | Rename the file *and* carry the data, checkpointing WAL first. The same applies to any localStorage key holding live state |

---

## 26. The empty turn, and why nothing was written down

A session reported `invalid message content type: <nil> (ref: …)` on every
message, forever. The UI showed a red box; the server terminal showed nothing,
because the failure arrived as an SSE `error` event that the client rendered
and dropped. Finding it meant reading the database by hand.

### The bug

The first hypothesis was wrong, and only a probe against the real backend
showed it. Measured on `gpt-oss:120b-cloud` through Ollama's `/v1` shim:

| assistant message | result |
|---|---|
| `content: null`, **with** `tool_calls` | **200** |
| `content: null`, **no** `tool_calls` | **400** `invalid message content type: <nil>` |
| `content: ''`, no `tool_calls` | **200** |

So the guess — "OpenAI allows a null content beside tool_calls and Ollama does
not" — was backwards. Ollama honours that case fine. What it rejects is a bare
null, and the adapter emitted one for any assistant entry with empty text:
`content: m.text || null`.

That mattered because of what the orchestrator stored. When the model returns
an empty turn — no text *and* no tool calls, which this model does — that was
appended to the history as a message. Replayed on the next turn it became
`{role:'assistant', content:null}` with no `tool_calls`, and the session was
**permanently bricked**: every later message failed at the wire, with an error
naming neither the session nor the offending entry.

Scanning the live database found exactly one such row across 90 messages —
`assistant text=EMPTY toolCalls=0` — and it was in the reported session.

Fixed at both levels, because either alone is insufficient:

- **The wire** coerces every `content` to a string. This repairs histories that
  already contain the poison message, including the user's.
- **The orchestrator** refuses to store an empty turn at all. A model returning
  nothing is a failure to report, not a message to keep. The existing
  "returned no content" guard only fired on `finish_reason: length`; this
  catches the rest.

### The reason it took a database read to find

Nothing logged. That is the real defect, and it is now fixed separately: see
§27.

---

## 27. One log stream

`server/src/logging.js`, plus `POST /api/logs` and `client/src/logging.js` so
the browser's half prints in the same terminal. Levels, a scope column, colour
when stdout is a TTY, `LOG_LEVEL=debug` for the health poll and per-request
reads.

What it prints without being asked: every HTTP request with status and
duration; every agent turn with its session, provider and model; every tool
call with its arguments, outcome and elapsed time; every approval decision,
with an explicit `UNGATED` warning when auto-approve let one through; every
build run; every migration; and on the browser side every navigation,
`console.error`/`warn`, uncaught exception, unhandled rejection, failed API
call and render error, tagged with the route it happened on.

Three properties that are load-bearing rather than nice:

- **Secrets never reach it.** Request bodies are never printed, and structured
  metadata goes through `redact()`, which masks `password`, `apiKey`,
  `client_secret`, `Authorization` and friends at any depth. A falsy secret is
  passed through as itself — `<redacted>` against an absent password would read
  as one being stored.
- **The browser half cannot loop.** A failure of the log transport is never
  logged over the transport.
- **Repeats collapse.** Consecutive identical entries become one line with a
  count. StrictMode double-invokes every effect in dev, so each navigation
  logged twice; more importantly a render loop would otherwise bury its own
  cause under a hundred copies of its symptom.

Immediately worth it: the first live run surfaced the bound PDI dropping a
request (`Could not reach dev428633… Is the PDI awake?`) and the agent
recovering by calling `test_connection` and retrying — a self-correction that
had been happening invisibly.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 42 | **An empty model turn, stored, bricks a session forever** | one conversation fails on every message with a wire error that names neither the session nor the message; every other conversation is fine | A turn with no text and no tool calls is the model returning nothing. Refuse it where it happens. Anything persisted into a replayed history is a permanent input, not a transient one |
| 43 | **`content: null` is legal beside `tool_calls` and illegal without it** | you fix the wrong branch, confidently, because the OpenAI spec says null is allowed | It is allowed — for the tool-call case, which is the one that was already working. Probe each shape against the actual backend; the wire is where the spec and the implementation differ |
| 44 | **A UI that renders an error is not a system that recorded one** | a red box in the browser, a silent terminal, and a bug that can only be found by reading the database | Log both halves into one stream. An SSE `error` frame, a rejected fetch and a render error are all invisible server-side unless the client sends them |

---

## 28. `Internal Server Error (ref: …)` — how a size limit turned out not to be one

A session building a Flow + Subflow died on iterations 3 and 4 with a 500 from
Ollama's cloud shim. The new log (§27) had already narrowed it: both failures
carried `historyEntries: 19` and `26`, and the turn before each had returned a
6–8KB tool result.

### The measurement that nearly produced the wrong fix

Replaying the captured request body — the exact bytes the app sent — bisected
cleanly at first, and then stopped being clean:

| variation | bytes | result |
|---|---|---|
| exactly what the app sent | 111,412 | **500** |
| the same, without tools | 88,094 | 200 |
| the same, last 6 messages only | 69,106 | 200 |
| 30 tools | 106,685 | 200 |
| **24 tools** | 100,710 | **500** |
| 12 tools | 93,902 | 200 |

24 tools failing while 30 passed is not a size limit. Sending the *same body*
six times settled it:

| body | successes |
|---|---|
| the full failing request | 4/6 |
| the same, without tools | 5/6 |
| half the history | 6/6 |

Nothing deterministic. On that evidence the obvious fix — truncate history hard
— would have degraded the agent's memory to work around someone else's flaky
afternoon.

### The measurement that produced the right one

Single attempt, three sizes, **round-robin** so a bad minute could not fall
disproportionately on one variant:

| variant | bytes | ~tokens | success |
|---|---|---|---|
| full history (26 msgs) | 111,412 | 27,853 | **4/8 — 50%** |
| last 16 msgs | 80,454 | 20,114 | **8/8 — 100%** |
| last 8 msgs | 76,620 | 19,155 | **8/8 — 100%** |

Every failure landed on the largest variant. So it *is* size-dependent — there
is a cliff between ~20k and ~28k tokens — and the earlier non-monotonic bisect
was noise being read as signal, because each of those cells was a single
sample.

### The defect this exposed in our own code

`HISTORY_TOKEN_BUDGET = 24_000`, and its comment reads *"leaves room for the
system prompt, the fact ledger, tools, and reasoning"*. Nothing ever subtracted
them. Measured on this session:

```
system prompt   19,663 B   ~5,600 tokens
tool schemas    23,288 B   ~6,650 tokens   (37 tools)
history         88,034 B  ~22,000 tokens
                          ~27,850 tokens total
```

A 24k *history* allowance therefore shipped a ~35k request at the limit. The
budget was doing exactly what it said and still permitting the failure.

Fixed by budgeting the **request**: `historyBudgetFor({system, tools})`
subtracts the real overhead each turn, `REQUEST_TOKEN_BUDGET = 18_000` is what
compaction aims at, and `REQUEST_TOKEN_CEILING = 20_000` — the largest size
measured 8/8 — is where the warning fires. Those are two constants on purpose:
warning at the budget would cry wolf at 19.5k, a size measured to succeed every
time, and a warning that fires on healthy traffic is one nobody reads.

Retry stays as well, because transient failures are real — bounded to 3
attempts, on 5xx/429/408 and network errors only. **Never on a 4xx**: that is
our own malformed request, and retrying one three times is how the
`<nil>` defect of §26 stayed invisible as long as it did. The retry wraps the
model call only; a mutation approved at the gate is never re-run by it.

### Verified

The session that could not complete a turn now completes three in a row.
Compaction fires (a third digest, written mid-turn), the request drops from
~27,850 to ~19,500 tokens, and the agent answers from its own history.

Both numbers are properties of *this backend*, not of the model's advertised
context window. A stronger provider raises them — the Settings swap this
project is built around.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 45 | **One sample per cell is not a bisection** | a clean-looking size threshold with one cell out of order, which you explain away | Failure was probabilistic, so every cell was a coin flip. Repeat the SAME input N times before believing any boundary. The out-of-order cell is the signal, not the anomaly |
| 46 | **A context budget that counts only the history is not a budget** | it is set to 24k, it is enforced, and requests still go out at 35k and fail | Count what the adapter actually serialises — system prompt and tool schemas included. Ours even said in a comment that it left room for them, and it never did |
| 47 | **Retrying a 4xx makes a bug slower, not rarer** | an intermittent-looking failure that is actually a deterministic malformed request, now taking 3× as long to surface | Retry transport failures only: 5xx, 429, 408, dropped connections. A 4xx is your own request and must fail on the first attempt |
| 48 | **Compacting to dodge a flaky upstream costs real capability** | the agent forgets things, and the flakiness is still there | Establish whether the failure is size-dependent or time-dependent FIRST, by interleaving variants. Only one of those is fixed by sending less |

---

## 29. `finish reason: load` — a cold start reported as a broken model

Reported straight from the UI:

> The model returned an empty turn — no text and no tool call (finish reason:
> **load**). … the model in Settings may not be answering reliably.

`load` is not an OpenAI finish reason. There are four of those — `stop`,
`length`, `tool_calls`, `content_filter` — and this is none of them. It is
Ollama's own: the request **loaded the model and generated nothing**. A cold
start.

So the message was wrong twice over. It told the user their model choice was
unreliable, when what had happened was a warm-up; and it made a transient
condition terminal.

### The structural bug behind it

The empty-response check sat **after** `withRetry` returned:

```js
const data = await withRetry(…, async () => { …fetch, parse, throw on !ok… });
const text = data.choices?.[0]?.message?.content || '';
if (!text && …) throw new Error(…);   // ← outside the retry
```

The retry added in §28 covered transport failures — 5xx, 429, dropped
connections — and every one of those is *less* likely to resolve on a second
attempt than a cold start is. The single failure mode most obviously worth
retrying was the one that structurally could not be.

Parsing moved inside the retry callback. Now:

| empty completion | behaviour | why |
|---|---|---|
| `finish_reason: load` | retried | the model was loading; nothing was generated |
| `finish_reason: stop`, no content | retried | the model hiccupped — non-deterministic, so another attempt is a real chance |
| `finish_reason: length`, no content | **not** retried | deterministic: the budget went on hidden reasoning tokens. Three attempts arrive at the same place, slower. Reported with its remedy instead |
| any content, or any tool call | returned | the commonest shape this model produces is no prose and one tool call, and that is a full answer, not an empty one |

The orchestrator's guard stays as the last resort, but it no longer suggests
sending the message again — by the time it fires, the request has already been
made three times. It names the likely cause instead.

### Verified

Five turns in a fresh session against the live PDI: 5/5, no retries needed on
that run. The unit tests drive each finish reason directly, since `load` cannot
be provoked on demand.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 49 | **A provider's finish reasons are not the spec's** | an error naming `load`, a value that appears in no OpenAI documentation, handled by a default branch that assumes the worst | OpenAI defines `stop`, `length`, `tool_calls`, `content_filter`. Ollama adds `load` for "the model was loaded and nothing generated". Treat an unrecognised finish reason as unknown-and-transient, not as broken |
| 50 | **A retry that wraps the transport but not the parse** | 5xx gets three attempts while the empty response — the most transient failure there is — gets one | Decide what "success" means INSIDE the retried function. If the check for a usable answer sits after the retry helper returns, it is not retryable no matter how transient it is |
| 51 | **An error message that guesses at a cause teaches the wrong lesson** | "the model in Settings may not be answering reliably" printed for a cold start, sending someone to change a model that was fine | Say what happened and what was tried. A message that speculates about a cause is worse than one that just reports the finish reason |

---

## 30. "Add if/then to it" — three defects behind one failed build

A deployed flow, *Add Demo Comment on Incident Creation*, and a follow-up ask:
add branching and an end condition. The build failed three attempts with
identical diagnostics, the user's flow was then deleted, and the session ended
on a cold start. Three separate defects, one visible symptom.

### 1. The agent could create a flow but never edit one

`createLiveFlow(spec, emit, { updates })` has supported in-place edit since
invariant **d** — the Flows page uses it, and it is what keeps a flow's sys_id
stable across a changed spec. The agent's `create_flow_live` tool called
`createLiveFlow(spec)` and did not expose `updates` at all.

So "add if/then to it" had exactly one path available: build a *new* flow. The
model duly named it *Add Demo Comment* — a different string, so not even
matched to the original — and it collided with the deployed one on its element
keys. The tool now takes `updates`, and its description says plainly that
editing keeps the sys_id while creating a second flow collides with the first.

### 2. Colliding `Now.ID` keys were asked of the model, not imposed

The diagnostic was good. It named the key, both definition sites, and the fix:

```
Duplicate $id across the project: Now.ID['adc_flow'] is defined 2 times —
candidate-1b6e66c38010a6f0.now.ts:6 and
add-demo-comment-on-incident-creation.now.ts:6 … Mint a fresh key unique to
this flow (prefix every key with a short slug of this flow's name, e.g.
'adc_adc_flow').
```

The model ignored it three times, producing the same two collisions each time
and burning the whole attempt budget. That is A2's lesson arriving a second
time: **identity the platform matches on is too important to ask for.** A2
imposes the flow *name* by string rewrite rather than requesting it;
`namespaceCollidingIds` now does the same for keys, prefixing only the keys
another source already owns and leaving the model's own choices alone.

What still reaches the validator is what a rewrite cannot honestly fix — the
same key twice inside one candidate (a modelling mistake, where renaming both
would silently merge two elements), literal sys_ids, and unresolved
placeholders.

A5 was not at fault here: it refuses a byte-identical *prompt*, and each
attempt's prompt differed by its cosmetically-different prior source. The model
was making the same mistake in three different ways.

### 3. A cold start was waited on like a network blip

The session ended on `ollama returned an empty completion (finish reason: load)
(after 3 attempts)`. §29 made `load` retryable, which was right, but it
inherited the generic 600ms/1.8s backoff — so all three attempts fell inside
~2.4s while a 120-billion-parameter model was still loading. A cold start now
starts at 4s.

### Verified

Offline, against a fixture built from the transcript's own sources: the three
colliding keys are rewritten, the two unique ones are untouched, every
occurrence moves (a half-rewritten key would build and wire an action to the
wrong element), and editing a flow in place does not namespace it away from its
own deployed identity.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 52 | **A capability the UI has and the agent does not** | the agent solves an "edit this" request by creating a second artifact, and collides with the first | `updates` existed on the function and on the HTTP route for two tracks before the tool exposed it. When a pipeline grows an option, check every caller — a tool schema is a caller |
| 53 | **A good diagnostic is not a fix** | the error names the key, both files and the remedy, and the model repeats the mistake until the budget is gone | If a rule can be enforced mechanically, enforce it. Asking is for things that need judgement; a namespace collision needs a rename |
| 54 | **Retryable is not the same as "retry soon"** | a cold start correctly marked transient, then abandoned inside 2.4s while the model was still loading | Back-off has to match what is being waited for. Loading a 120b model and recovering from a 502 are not the same wait |

---

## 31. Three digests in one turn — the budget was 4% of the window

### The report

One long spec (19 requirements) through the agent produced, in a SINGLE turn:
three compaction digests (9,629 → 4,308, 7,209 → 3,774, 6,298 → 2,476 tokens),
several blank assistant rows between them, and finally
`ollama returned an empty completion (finish reason: load) (after 3 attempts)`.

Three hypotheses, all settled by measurement before anything was changed. Two
were confirmed; the third was confirmed but is fuel rather than cause.

### Step 1 verdicts

**The window was never the constraint.** Read off the daemon rather than
assumed:

```
$ curl -s localhost:11434/api/show -d '{"model":"gpt-oss:120b-cloud"}'
  "gptoss.context_length": 131072
```

**H2 — the compactor is thrashing. CONFIRMED, and it is the cause.** Measured
against the real system prompt and the real 37 tool schemas:

```
system prompt   20,586 chars ->  5,882 tokens
tool schemas    23,330 chars ->  6,666 tokens
FIXED OVERHEAD                  12,548 tokens
REQUEST_TOKEN_BUDGET            18,000
=> HISTORY BUDGET                5,452 tokens
```

5,452 tokens on a 131,072-token model — 4% of the window. Every "before" number
in the report is above that line and every "after" is below it. That is not a
coincidence, it is the budget.

It also **ratcheted**. Digests are appended to the SYSTEM PROMPT, so the fixed
overhead grows with every compaction and the next turn's allowance shrinks.
Three digests cost roughly 1,500 tokens of overhead, dropping the budget from
5,452 to about 3,950 — which is why each fold landed just under a line that the
next tool result immediately pushed back over. And `compactIfNeeded` ran on
**every iteration** of a 15-iteration tool loop, so nothing stopped it happening
again inside the same turn.

**H3 — oversized tool results. CONFIRMED as the fuel.** Measured live against
dev442675:

```
incident: 91 fields (incident -> task)
FULL schema: 29,152 chars -> 8,330 tokens
```

One `get_table_schema('incident')` is **153% of the entire history budget**. The
orchestrator's 8,000-character result cap hid that instead of fixing it, and hid
it in the worst way available — fields are sorted alphabetically, so the cut
landed after `company`:

```
total fields: 91 | survive the 8000-char truncation: 26
last field the agent sees: company
dropped: contact_type, contract, description, due_date, escalation, ...
```

The agent never saw `state`, `priority`, `description` or `assignment_group`.
And because `u_` fields sort last, **it could not observe that a custom field
was absent** — which makes "I checked, `u_sla_start` is not there" and "I could
not see far enough to tell" indistinguishable from the outside. The stress
spec's whole acceptance criterion was unreachable for a reason that had nothing
to do with the model.

**H1 — empty completions appended as real turns. CONFIRMED, with a mechanism.**
§29 already rejected `!res.text && !res.toolCalls?.length`. That test is
truthiness, and a bare newline is truthy. A whitespace-only completion — which
this model emits when hidden reasoning eats the token budget — walked past the
guard, was stored as a real assistant turn, rendered as a blank bubble, and then
rode along in every outbound request for the rest of the session. That is the
shape of the blank rows in the screenshot.

**The reliability cliff the old budget was built on has expired.** The 18,000
constant came from a measured cliff (~27,900 tokens at 4/8, ~20,100 at 8/8).
Re-measured 2026-08-19, single attempt, no retry, five shots per size:

| estimated | real `prompt_tokens` | result | avg |
|---|---|---|---|
| ~8,000 | 5,798 | 5/5 | 1044ms |
| ~16,000 | 11,502 | 5/5 | 1356ms |
| ~24,000 | 17,209 | 5/5 | 1456ms |
| ~32,000 | 22,911 | 5/5 | 1204ms |
| ~40,000 | 28,614 | 5/5 | 1465ms |
| ~56,000 | 40,023 | 5/5 | 1526ms |
| ~72,000 | 51,429 | 5/5 | 1523ms |

35/35, latency flat to 51k real tokens. The cliff did not reproduce. §28's own
conclusion — that the upstream is flaky rather than limited — is what makes this
consistent: the retry and the cold-start warm-up added since are what now cover
the flakiness the small budget was dodging. Note also that the estimator runs
~40% pessimistic (32,000 estimated = 22,911 real), which is the safe direction
to be wrong in.

### The three numbers, after

```
model context 131072 (localhost:11434/api/show, gptoss.context_length)
capped at      32000   (cost and latency, not reliability)
fixed overhead 13160   (system prompt + 37 tool schemas, measured per turn)
output headroom 6144   (> max_tokens 4096: reasoning bills against the same budget)
=> history budget 12696
```

5,452 → 12,696, and all three are logged at meta time and shown on the digest
badge's hover. The fixed overhead is measured **per turn**, so the digest
ratchet is now visible in the number rather than hidden behind a constant.

### Compaction count per turn, before and after

Replayed over the 18 real sessions the acceptance produced, counting how many
times the OLD budget-plus-per-iteration-loop would have folded:

```
Across 18 sessions — compactions the OLD budget+loop would have run: 18
                            compactions the NEW budget+guard runs:    1
```

One session (peak history 14,160 tokens) would have compacted **seven times in
a single turn** — the reported defect, reproduced from real data. It now
compacts once.

### Acceptance

`docs/stress-prompts/sla-escalation.md`, both sections, live against
gpt-oss:120b-cloud on dev442675.

**Section 1 — the stress case.** Eight trials on the final build:

| measure | result |
|---|---|
| infrastructure errors | **0/8** |
| compactions | **0/8** (limit was ≤1) |
| blank assistant bubbles | **0/8** |
| discovers all five `u_sla_*` fields are absent | **8/8** |
| stops and asks, per the Important clause | **8/8** |
| mentions the native SLA route | 5/8 |

The correct output is the clarification question, and that is what arrives.

**Section 2 — the control.** Three trials: `design_flow_blueprint` →
`create_flow_live` → approval gate, 3/3, with 0 errors, 0 compactions and 0
blank bubbles. The first draft of this control was itself broken: it said "the
group that handles payment incidents" without naming one, no such group exists
on this PDI, and the agent correctly stopped to ask which group to use. Right
behaviour, useless control — a control that asks a question proves nothing about
proceeding when nothing is missing. It now names `Service Desk`, read back off
the instance before the file named it.

### What did not fully land

Two behavioural items, reported as measured rather than as fixed:

- **The native-capability mention is 5/8, not 8/8.** Buried as rule 16 of 17 it
  fired 2/6; hoisted to the flow-authoring decision point, where the model is
  already reading, 5/8. Better, and still prose — which §20 already established
  is the weak lever for this model. A structural guard would be the reliable
  fix, and is not built here.
- **The agent sometimes submits a mutation to create the missing fields**
  despite being told to stop and ask. The approval gate caught it every time and
  nothing was written, so the safety property holds structurally — but the
  instruction did not.

### A separate defect this run exposed

When a mutation is rejected at the gate, the tool result says *"The user
rejected this operation. Do not retry it; ask what they would like to change."*
Measured in the section 2 control: the model re-submitted the identical
`create_flow_live` call **nine times in one turn**. The gate held each time, so
nothing was written — but it burns the iteration budget and inflates history,
which is the same family as the defect above. A `(tool, input)` pair rejected in
a turn should not be re-submittable in that turn. Not fixed here: it deserves
its own measurement, and it changes approval semantics, which is not something
to change in passing.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 55 | **A budget nobody ever subtracted from** | the constant says 18,000 and reads as generous; the actual allowance is 5,452 because 12,548 of overhead was never counted | Print the three numbers — window, fixed cost, allowance — at runtime. A budget you cannot see is a budget you cannot tell is wrong |
| 56 | **Truncation that hides the field you were asked about** | the agent reports a field is absent, and it is — but it would have said the same thing either way, because the list was cut off before that letter | If a result is truncated, the truncation is part of the answer. An alphabetical list cut at `company` cannot speak about `u_*` at all |
| 57 | **Truthiness is not emptiness** | a whitespace-only completion passes `if (!text)`, becomes a stored turn, an empty bubble, and a passenger in every later request | `.trim()`. And enforce it at every layer that can produce the shape, not only the one where it was found |
| 58 | **A compaction that lands just under the line** | the transcript folds, fits, and is pushed straight back over by the next tool result — three times in one turn | Require a minimum GAIN, not just a threshold breach. A fold that saves less than it costs is an LLM call and a loss of history in exchange for nothing |
| 59 | **A constant that outlived its measurement** | 18,000 was honestly derived from a real cliff; re-measured a track later, 35/35 succeeded at four times that size | Date the measurement in the comment. When a constant is load-bearing and cheap to re-measure, re-measure it before building on it |
| 60 | **A restart that silently did not happen** | `pkill` reports nothing, the new process dies on EADDRINUSE, and the old binary serves the "new" measurement | Verify the change is live from OUTSIDE the process — an endpoint that reports the number you just changed. A rising fixed-overhead count nearly passed for a prompt edit that had not loaded |

---

## 32. Subflows as first-class artifacts

§11 closed the question of executing a triggerless artifact like this:

> **`sn_fd.FlowAPI`** … exists, but it is **server-side script only**. Reaching it over REST
> would mean creating a Scripted REST API or running a background script purely to trigger a
> flow — neither is a supported path, and both are exactly the kind of hack this project
> refuses.

The first sentence is right. The conclusion was wrong, and this section is the measurement
that replaced it.

### The mechanism: a one-shot scheduled job, created over the ordinary Table API

There is a third option §11 did not consider. `sysauto_script` — Scheduled Script Execution —
is an ordinary table. A row with `run_type = 'once'`, `active = true` and `run_start`
backdated is claimed by the platform scheduler and **runs within seconds** of the insert. No
Scripted REST API, no update set, no UI.

Measured, first probe, end to end:

```
POST sysauto_script  { run_type: 'once', run_start: <now - 60s>, script: "gs.info('[TOKEN] …')" }
  → created                                                          05:28:48
  → syslog row                                                       05:28:50   (~2s)
  → script field round-trips byte-identical                          true
  → DELETE sysauto_script                                            gone
```

Two things about that probe are worth keeping:

- **The `sys_id` may be minted client-side.** POSTing an explicit `sys_id` is honoured, which
  is what makes the job correlatable to its own execution before it reports anything.
- **`syslog` cannot be deleted over REST.** `DELETE /api/now/table/syslog/<id>` answers
  **403**. So `gs.info` is unusable as the job's return channel: it would make "every test
  record was removed" a claim the harness cannot honour. Trap #61.

### The runner's real signature

Confirmed against the live instance rather than against documentation — the SDK docs shipped
in `@servicenow/sdk@4.10.1` mention `sn_fd.FlowAPI` exactly once, in an unrelated paragraph
about `resumeFlow`.

```javascript
sn_fd.FlowAPI.getRunner()
  .subflow('<scope>.<internal_name>')
  .inBackground()                        // or .inForeground()
  .withInputs({ … })
  .run()
```

The returned object answers `getContextId()` and `getOutputs()`. Introspection is otherwise
useless: `sn_fd.FlowAPI` is a native function, `getRunner()` returns an object with **no
enumerable keys**, and `String(sn_fd.FlowAPI.getRunner)` is `function getRunner() { [native
code] }`.

| behaviour | measured |
|---|---|
| scope prefix | **mandatory**. `.subflow('notify_manager')` resolves as `global.notify_manager` and throws `java.lang.IllegalArgumentException: flow object for 'global.notify_manager' does not exist` |
| `internal_name` is not the slug | `High-Priority Incident Escalation Logic` → `highpriority_incident_escalation_logic` — the hyphen is **dropped**, not converted. Read it off `sys_hub_flow`, never derive it |
| `.inBackground()` | returns in **14–29 ms** with a valid contextId; the flow then runs asynchronously |
| `.inForeground()` | blocks (measured 175–742 ms) and returns outputs directly — but **throws** when the subflow errors: `com.glide.plan.runners.FlowObjectAPIException: The current operation ended in state: ERROR. Detail: <reason>. Context id: <id>` |
| a subflow that errors, in background | `sys_flow_context.state = ERROR` with the full reason in `error_message` |
| correlation | `sys_flow_context.source_record` = **the sysauto_script sys_id**, `source_table = 'sysauto_script'` |

**Background ships, foreground does not.** Foreground's throw takes the contextId with it —
the caller loses the one handle that would let it report what actually happened — and a
subflow that pauses would block a scheduled job to its own timeout. Background makes a failing
subflow arrive as a state the existing record-triggered runner already knows how to talk
about, so a timeout is a FAIL carrying the last observed state instead of a hang.

### Outputs ARE capturable

Not from the script, and not from `sys_flow_context`, which has no output column. They are in
`sys_flow_runtime_value`:

```
query : context=<contextId>^type=output
value : {"managerEmail":{"@class":"com.snc.process_flow.val.OutVal","value":"",
          "displayValue":"","hasValue":true,"simpleType":"OPAQUE"},
         "notified":{…,"value":false,"displayValue":"false",…}}
```

Two traps in that shape:

- `getOutputs()` in **background** mode returns `{}` — the flow has not run yet. The runtime
  value table is the authority, not the script's return value.
- an **errored** run mixes engine bookkeeping into the same map: `__action_status__`,
  `__dont_treat_as_error__`. The parser is therefore given the subflow's DECLARED output names
  and reports anything else separately, instead of presenting `__action_status__` as an output
  the subflow promised.

### A reference input will not take a sys_id ⚠️

The first live run of the finished harness failed at the call, and this is the finding the
acceptance run bought:

```
com.snc.process_flow.exception.ProcessAutomationException: Invalid GlideRecord input format found
```

`withInputs({ task: '<sys_id>' })` does not start the flow at all when `task` is declared as a
`ReferenceColumn`. Two formats work, both measured:

```javascript
var gr = new GlideRecord('task'); gr.get(id);     // { task: gr }          ✅
                                                  // { task: { table: 'task', sys_id: id } }  ✅
```

The GlideRecord form ships, because it can fail usefully: `.get()` returning false becomes
`input task: no task record <id>` **before** the flow is invoked, rather than an execution
that dies later for a reason nobody can trace back to an input. This is also why the harness
takes the subflow's CONTRACT and not just a bag of values — only the declared types say which
inputs need a record fetched.

### The return channel

One namespaced `sys_user_preference` row (`x_2196302_nwforge.exec_harness.<token>`), written
by the job, read by the harness, then deleted and **read back**. `value` holds 65,000
characters, and create/read/delete over REST all work. The wrapper puts the sink insert
*after* the catch, so a body that throws still reports — failing to report is precisely the
condition the harness times out on.

### What ships

`server/src/servicenow/execution-harness.js`, deliberately artifact-agnostic:
`runServerScript({ body })` runs any server-side script through the job/sink/cleanup dance and
hands back its JSON report; `executeSubflow({ qualified, inputs, declaredInputs,
declaredOutputs })` is the subflow case built on top. v0.4's fix-script and script-include
verification calls the first one rather than growing a second copy.

Injection surface: the qualified name is the only value concatenated into the generated
script and it is validated against `^[a-z0-9_]+\.[a-z0-9_]+$`; a reference table is validated
against `^[a-z0-9_]+$`; everything else goes through `jsLiteral()`, which also escapes
U+2028/U+2029 — legal in JSON, illegal in the platform's ES5 string literals.

### Contracts, the catalog and the graph are PARSED, not asked for

A subflow's inputs and outputs are its public interface: a caller wires itself to input
NAMES, so a rename is a broken call. That is the A2 argument about artifact names applied one
level down, so `subflows.js` reads the contract out of the source rather than taking a model's
summary of it.

The parser is bracket-matched with a string-aware matcher, and that is load-bearing rather
than tidy. The existing matcher in `codegen-guards.js` counts braces blindly, which is right
for finding a `name:` literal and wrong for walking INTO a config object: a description
containing `{`, or a condition written as a template literal with `${...}` in it, closes the
block early and yields **half a contract** — the exact shape of a confidently wrong answer.
Both cases are fixtures in `server/test/subflows.test.js`.

Three things come out of the same parse:

| product | used for |
|---|---|
| the CONTRACT | the result card, the managed listing, the verification spec validator, and the harness's reference-input handling |
| the CATALOG | injected into codegen with the real import path, a filled-in `wfa.subflow(...)` call, and the subflow's description |
| the CALL GRAPH | `calls` / `calledBy` on every managed artifact, and the delete guard |

A `wfa.subflow('<sys_id>', …)` call is kept as an **unresolved** edge rather than dropped. An
edge nobody can see is how a delete gets to break a live caller.

### The instance is read back beside the source

`sys_hub_flow_input` / `sys_hub_flow_output`, keyed by `model = <flow sys_id>`, are
var_dictionary-shaped rows whose `element` is the internal input name. So a deployed subflow's
contract can be read off the instance and compared with the one parsed from the source that
produced it. Both are reported; the card shows the instance half only when the two disagree.

`internal_name` is read, never derived — see the table above.

### Two lints, because a good diagnostic is not a fix (trap #53)

`artifact_type` — the artifact the request asked for is the artifact that must come back, and
a declared contract must be one the body honours:

| rejected | because |
|---|---|
| a "subflow" containing `wfa.trigger(...)` | the platform stores a triggered artifact as a **flow**. The badge says flow, `type` says flow, and nothing downstream notices the request was for something else |
| a `Subflow(...)` that is not `export const` | no other flow can import it, so it can never be called |
| a declared output never named in an `assignSubflowOutputs` values object | it reads back empty, and the caller cannot tell that from a legitimately empty value |
| `assignSubflowOutputs` handed anything but `params.outputs` | it compiles and assigns nothing |
| a declared input never read via `params.inputs.<name>` | the caller can pass it with no effect |

`subflow_reuse` — the prefer-call rule, enforced rather than requested. A candidate that
re-creates a catalogued subflow by NAME, or by an identical set of input names, is rejected
before the build with the existing one named and the call spelled out. Its false positive —
two genuinely different subflows that happen to take identical inputs — is stated in the
rejection text, so a human reading it can see what the rule decided rather than guessing.

### Dependency safety

Removing a source is a pending DELETE: the next install takes the record off the instance. If
a managed flow still calls it, that flow's own source is untouched, so **the build stays green
and every execution fails at the subflow step**. `removeManaged` therefore refuses, with the
callers named, and the route answers **409** rather than 422 — nothing about the request was
wrong.

One message was also fixed on the way: deleting an artifact that shares a file with another (a
flow+subflow pair lives in one source named after the flow) used to answer "No managed source
file for X", which is true and useless. It now names the file and what else is in it.

### Acceptance

#### A1 — standalone subflow authoring ✅

Panel path, `artifactType: 'subflow'`, spec verbatim from the request.

| measure | result |
|---|---|
| compiled on attempt | **1** of 3 |
| deployed | `Escalate To Duty Manager`, `sys_id 39507ca8439f4d0e8c764db2b3d3838e`, `type = subflow`, **active** |
| `internal_name` | `escalate_to_duty_manager` |
| flow activation | **17/17** |
| contract, parsed from source | `task: reference → task (required)`, `message: string (required)`; no outputs |
| contract, read back off the instance | **identical** |
| triggers on the instance | **0**, and `flows.detail` says so: *"Subflows have no trigger by design"* |
| verification spec | produced on attempt 1, `kind: subflow`, 1 assertion |

Declaring no outputs is correct here and is rule S6: the request promises nothing back, and a
declared-but-unassigned output is worse than none.

**The catalog changed what got written, on the first live run.** Asked for a subflow that
"looks up the task's assignment group manager, sends them the message as a notification, and
adds a work note", the model did not re-implement the lookup — it imported `notifyManager` and
called it, then added the work note itself. That is the prefer-call rule producing composition
rather than duplication, unprompted.

#### A2 — harness verification ✅

The pipeline's own spec, run through `verifySubflow`:

```
setup      task TASK0020272 created
invoke     x_2196302_nwforge.escalate_to_duty_manager  (job e7cfd485…, deleted)
execution  COMPLETE, run_time 186 ms
assert     sys_journal_field.value = "Escalation verification note 12345"   PASS
cleanup    job deleted ✓   sink row deleted ✓   setup record gone ✓   leftovers []
```

1/1. Independent read-back after the run: 0 harness jobs, 0 sink rows, 0 test records.

**The notification half was not asserted, and that is not an oversight to hide.** The intent
extractor deliberately does not count "sends an email" as an effect observable on a record, so
the request yielded ONE promised effect and the spec covered it. The setup task also had no
assignment group, so no notification could have been sent — the Hardware-fixture shape from
§14 again.

So a second run, spec hand-written, drove the same subflow against a group that HAS a manager
(`Database` → Don Goodliffe) and asserted both halves:

```
execution  COMPLETE, run_time 305 ms
assert     sys_journal_field.value  = "A2B-AJ1PT9"                    PASS
assert     sys_email.recipients     = "don.goodliffe@example.com"     PASS
cleanup    job ✓  sink ✓  incident ✓  sys_email row ✓   (0 of each left)
```

2/2. Note that `sys_email` rows **can** be deleted over REST, unlike `syslog`.

#### A3 — reuse ⚠️ BLOCKED, with partial evidence

Spec, through the agent: *"When a P1 incident is updated to state On Hold with hold reason
Awaiting Vendor, escalate to the duty manager with the message 'P1 on vendor hold'."*

**What was proven.** Both live runs did what the reuse work was for: the agent called
`list_live_flows` unprompted, read the catalog, and designed a flow that CALLS
`Escalate To Duty Manager` — in its own words, *"This flow simply re-uses the existing Escalate
To Duty Manager subflow, so we don't duplicate logic."* The no-duplicate counters held across
both runs:

| counter | before | after |
|---|---|---|
| subflow sources in the workspace | 3 | 3 |
| `sys_hub_flow` subflows in scope | 3 | 3 |
| `escalate-to-duty-manager.now.ts` sha256 | `272f88fa0356e06e` | unchanged |
| its `Now.ID` keys in `keys.ts` | 3 | byte-identical |
| new source files | — | none |

**What was NOT proven.** No flow was deployed, so "the generated flow calls the subflow" is
evidence from a design, not from a source that compiled. Two separate causes:

1. **Run 1 stalled** — trap #29 again. The model produced the whole design and closed with
   *"If you're happy with this design, I'll create the flow on the instance. Let me know!"* and
   the A6 guard did not fire. It missed on **both** conditions: `ASKS_TO_PROCEED` required
   "let me know **if**" and the model wrote "Let me know!"; `IS_DIRECTIVE` had `\bupdate\b`,
   which does not match "updat**ed**", and none of the verbs an automation request is actually
   written with. Both widened, with the measured text as a regression test. Trap #62.
2. **Run 2 was cut off by the provider.** The widened guard **fired** (`nudged {reason:
   stalled, asked: "let me know"}`) and the agent resumed acting — then Ollama answered
   `429 you (…) have reached your weekly usage limit` on 11 consecutive calls, and every cloud
   model on the account answers the same. No generation of any kind is possible until the limit
   resets, so A3 cannot be completed in this session.

The run also exposed a real gap, fixed: the agent stopped to ask **who the duty manager was**
while holding a subflow whose description is *"Looks up the task assignment group manager,
notifies them, and adds a work note"*. The catalog was rendering identity and shape and
dropping the one field that says what the thing is FOR. It now carries the description into
both the codegen prompt block and the managed listing — fixed and unit-tested, but **not**
measured to move the model, because the provider was gone before the run could be repeated.

So A4 needed a caller that generation could not provide. One was **hand-authored** —
`escalate-p1-vendor-hold-incident.now.ts`, and the file says so in its own header — put
through the pipeline's five pre-build gates and deployed by the same build/install/read-back
path:

```
artifact_type      PASS        subflow_reuse     PASS
trigger_strategy   PASS        identity          PASS
literals           PASS   ("P1 on vendor hold" survives into the source)
install            activation 18/18, 18 artifacts from 17 sources
read-back          Escalate P1 Vendor Hold Incident  44a22c90…  type=flow  active  1 trigger
```

It is a real caller, and it is not evidence about the model. Both statements belong in the
record.

#### A4 — dependency safety ✅

All live, with the caller above in place.

| step | result |
|---|---|
| A4.1 edges | subflow `calledBy = ["Escalate P1 Vendor Hold Incident"]`; flow `calls = ["Escalate To Duty Manager"]` |
| A4.2 delete the subflow while it has a caller | **REFUSED**: *"Refusing to delete: \"Escalate To Duty Manager\" is still called by \"Escalate P1 Vendor Hold Incident\". Deleting it would leave those callers pointing at a record that no longer exists — their own source is unchanged, so the build stays green and every execution fails at the subflow step."* |
| A4.3 delete the caller first | ok, activation **17/17**, `findByName` read-back `[]` |
| A4.4 edges after | subflow `calledBy = []` |
| A4.5 delete the subflow | ok, activation **16/16**, `findByName` read-back `[]` |
| A4.6 final | both absent from the instance and from the workspace |

The activation counts falling 18 → 17 → 16 are the whole-app install semantics of trap #8
showing through: every delete redeploys everything that is left.

The graph also reads a subflow→subflow edge correctly — `Escalate To Duty Manager` itself
calls `Notify Manager`, and that edge appears alongside the flow→subflow one.

#### A5 — this section ✅


### A subflow CALL is not an action instance ⚠️

Caught in the A4 read-back, and it is the §8 `_v2` bug's shape again. The caller flow deployed
and installed cleanly, and `flows.detail()` reported it as:

```
triggers 1   actions 0   logic 0
```

A flow that does nothing. Its only step is a subflow call, and those live in
**`sys_hub_sub_flow_instance_v2`** — a table `detail()` did not read. The row carries `order`,
`wait_for_completion`, the called subflow's reference, and the input mapping in
`subflow_inputs`, gzipped and base64-encoded exactly like `trigger_inputs`, so one decoder
serves both:

```
subflow             81d8a54583f64f10b939cc65eeaad361  (display "Notify Manager")
wait_for_completion true
order               2
subflow_inputs      → { taskTable: "incident",
                        taskSysId: "{{Created_1.current.sys_id}}",
                        message:   "P1 escalation - Network group manager notification" }
```

`detail()` now reads it, reports the family it came from, and adds a note when a flow has
subflow calls and no actions — so "0 actions" cannot be read as "empty" again. The Flows page
renders it as a **Calls** section with the input mapping. Trap #67.

The reverse direction — *who calls this subflow* — is two hops, and the first one lands
somewhere unhelpful. A call's `subflow` field does not reference the subflow: it references a
published **snapshot** (`sys_hub_flow_snapshot`), and the snapshot points back through
`parent_flow`. Stopping after one hop yields an id that is on no table anyone would think to
query, which is what made this look like a dead end:

```
sys_hub_sub_flow_instance_v2.subflow   81d8a545…   → not on sys_hub_flow
sys_hub_flow_snapshot 81d8a545…        parent_flow → Notify Manager (af903663…)
```

`flows.callers(sysId)` does both hops, so a subflow's detail view says **Called by** for any
deployed caller — including callers this project does not manage, which the source-derived
graph cannot see. A subflow nobody calls now says so, rather than showing an empty section.

Note in passing: `sysparm_fields` dropped `sub_flow` and `active` from the first probe of that
table without complaint, because neither column exists. Trap #4, still true.

### What remains

- **A3 end to end.** The generation half is blocked on the provider, not on anything in this
  repo. When the limit resets the run is one command: the spec, through the agent, with the
  no-duplicate counters above re-measured. Everything it depends on — the catalog, the lint,
  the widened stall guard, the description — is in place and unit-tested.
- **The description fix is unmeasured against the model.** It closes the gap the run showed;
  whether it stops the model asking is not known.
- **Four `syslog` rows from the early probes cannot be removed**, and that is the finding, not
  an oversight: three probes used `gs.info` as their return channel before the 403 was
  measured, and their lines are `[NHAPROBEMT12YEKQ]`, `[NHAFAMT12ZWIO]` and two
  `[NHARUNMT131U0K]`. Nothing that ships uses that channel. Everything else the probes and the
  acceptance runs created — jobs, sink rows, tasks, incidents, emails — is gone, read back:
  0 harness jobs, 0 sink rows, 0 probe records, 0 test emails.
- **`removeManaged` builds twice.** Once itself, once inside `deploy()`, ~20s of the delete's
  wall clock. `deploy()`'s build is what makes invariant (a) hold for every caller, so the
  duplicate is deliberate rather than a bug — noted so the next reader does not rediscover it
  as one.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 61 | **`syslog` cannot be deleted over REST** | a probe that logs its result works perfectly, and "every test record was cleaned up" quietly becomes false | DELETE answers 403. Anything a harness writes as a RETURN CHANNEL has to be on a table it can also delete — `sys_user_preference` and `sys_email` both are |
| 62 | **A guard's regex is only as good as the phrasings it was measured on** | the stall guard misses a turn that designs the whole thing and builds nothing, because the model wrote "Let me know!" instead of "let me know if", and "updated" instead of "update" | Both halves of a conjunction have to be widened together, and the widening has to be tested against the exact text that got through. `\bupdate\b` does not match "updated" |
| 63 | **A reference input to `FlowAPI` will not take a sys_id** | `Invalid GlideRecord input format found`, and the flow never starts — so nothing appears anywhere to debug | Fetch a positioned `GlideRecord` (or pass `{table, sys_id}`). Which inputs need it is knowable only from the subflow's declared contract |
| 64 | **`internal_name` is not the slug** | `High-Priority Incident Escalation Logic` becomes `highpriority_incident_escalation_logic` — the hyphen is DROPPED, not converted — and a derived name is refused by the runner | Read `internal_name` off `sys_hub_flow`. The same applies to the scope prefix: an unqualified name silently becomes `global.<name>` |
| 65 | **`getOutputs()` returns `{}` on a background run** | a subflow that plainly worked reports no outputs, and it reads like the outputs are broken | It has not run yet. Outputs live in `sys_flow_runtime_value` (`type=output`) once it settles — and an errored run mixes `__action_status__` in with them |
| 66 | **A catalog that lists shape but not purpose** | the agent holds exactly the subflow it needs, can see it takes `task` and `message`, and stops to ask a question that subflow's own description answers | Names and types identify an artifact; only the description says what it is FOR. Ship it wherever the catalog is rendered |
| 67 | **A subflow CALL is not an action instance** | a flow that installs, activates and reads back as "1 trigger, 0 actions, 0 logic" — a flow that does nothing | Calls live in `sys_hub_sub_flow_instance_v2`, with the input mapping in `subflow_inputs` (same gzip+base64 as `trigger_inputs`). Any reader that enumerates "the steps of a flow" has to read four part tables, not three |
| 68 | **A call references a SNAPSHOT, not the subflow** | `sys_hub_sub_flow_instance_v2.subflow` resolves to nothing on `sys_hub_flow`, so "who calls this?" looks unanswerable | It is a `sys_hub_flow_snapshot` id. Hop through `parent_flow` to reach the artifact. One hop gets you an id that is on no table you would think to look at |

---

## 33. Transport and scope — Step 0 mechanism experiments

Everything below was run against dev442675 over the ordinary Table API, using the repo's own
`client.js`, and every probe artifact was deleted and read back (see *Cleanup*, end of section).
The instance finished at its starting state: 22 update sets, one `sys_update_set` preference
row for `admin`, zero probe records.

The phase brief carried three platform truths to verify rather than assume. Two survived, one
needed correcting, and the correction is the most load-bearing result here.

### The capability matrix

| operation | Table API (REST) | server-side script (`execution-harness`) |
|---|---|---|
| create a **global** update set | ✅ | ✅ |
| create a **scoped** update set | ❌ **silently global** | ✅ read back as `x_2196302_nwforge` |
| create **scoped metadata** (`sys_script` with `sys_scope`) | ❌ **silently global** | not needed — the SDK is the sanctioned path |
| re-parent an update row, **same scope** | ✅ | ✅ |
| re-parent an update row, **cross scope** | ❌ 403, aborted by a named business rule | ❌ same rule, same abort |
| delete a `sys_update_xml` row | ✅ (28/28, global) | — |
| read `sys_store_app` | ❌ 403 for `admin` | not probed |

**The matrix line, stated as the standing rule it became (AD-2):**

> REST-created artifacts are global; scoped artifacts are born via the SDK tier.

The shape of that table is the phase's real finding: **the REST tier is global-tier**. It is not
that scoped writes are awkward over REST — they are accepted, answered `201`, and silently
demoted to `global`. Which is exactly why the SDK tier exists, and why only the REST tier needs
update sets to become portable.

### E1 — capture routing. VERDICT: the preference route works, and must not be used alone

Creating `sys_update_set` "NHA capture test" over the Table API, pointing the API user's
`sys_user_preference` (`name=sys_update_set`) at it, and writing one `sc_category`:

```
E1.3 created sc_category cb94ffca8372c750b939cc65eeaad371
E1.4 update rows found: 1
   name=sc_category_cb94ffca8372c750b939cc65eeaad371
   update_set=3e94ffca8372c750b939cc65eeaad313  => THE NAMED SET
```

Clearing it routes to Default, three ways, all measured: value set back to the global Default
(`GLOBAL_DEFAULT`), value blanked (`GLOBAL_DEFAULT`), row absent entirely (`GLOBAL_DEFAULT`).
So the mechanism is real and it is immediate — no session, no login, no cache warm-up.

Two things then broke it, and both are silent.

**Blanking the value does not clear the preference — it replaces the row.** The row we blanked
(`7b9f900a…`) was gone on the next read, and a *new* row (`5bb4f30e…`) holding the global
Default had taken its place. A later `create` of a second preference row for the same user was
therefore not "setting the preference", it was adding a rival:

```
B4 created pref row a6e47b0e… value= 3e94ffca…   (the named set)
B4 (fresh pref row -> named set) -> landed [GLOBAL_DEFAULT]   WRONG
```

Two rows, disagreeing, no error; the platform read the other one. Patch the single existing row
and it is correct every time (`C1`, `C2`, both pass).

**The preference is per-USER, and every NowHelpAssist session shares one API user.** This is the
finding that decides the phase. Two "sessions" interleaved across eight timing offsets, each
patching the preference and then writing one category — the pattern any two concurrent chat
turns produce:

```
round 0 A: want SET_A got [SET_A] ok        round 0 B: want SET_B got [SET_A] WRONG
round 1 A: want SET_A got [SET_B] WRONG     round 1 B: want SET_B got [SET_B] ok
…
RACE_RESULT: 8/16 landed in the WRONG set
```

Exactly one of each pair is right, because the last writer of the shared preference wins for
both. Not a flake at 8/16 — it is the structure. A per-session current-set cannot be built on a
per-user preference, at any timing.

**Verdict:** reliable *only* under a single serialized session with exactly one preference row,
patched in place and read back. That is a real constraint, not a caveat, so the preference route
is an optimisation at best and a silent corrupter at worst.

### E2 — sweep validity. VERDICT: valid, and it is a supported operation

Re-parenting one of E1's misrouted rows with a plain `PATCH` on `sys_update_xml.update_set`:

```
PATCH returned update_set = 7b25bf0e…
re-read update_set        = 7b25bf0e…   MOVED
payload_hash unchanged?   = true
update_guid unchanged?    = true
application unchanged?    = true (global)
sys_mod_count 0 -> 1
subject present in SET_B? true
subject absent from SET_A? true
```

The payload, its hash and the update GUID are all preserved; only `sys_mod_count` moves, which
makes a swept row honestly distinguishable from an untouched one. Both sets report the change
from their own side, so this is not a dangling reference.

It is also *sanctioned*. The business rule found in E3 does not merely permit a same-scope move,
it maintains `sys_update_version.source` to follow it. The sweep is the platform's own path.

### E3 — per-scope truth. VERDICT: the set is stamped with a scope; membership is enforced only on MOVES

The brief said update sets are per-scope. The observation contradicts the strong reading of that:
the global Default set on this instance holds rows from **~30 different applications**, ten of
them `x_2196302_nwforge`.

```
=== applications present inside the GLOBAL Default set ===
{ "global": 303, "c44f3c6c37c24793be9f8b759c7818e4": 10, "3c467b5f…": 18, … } (total 400+)
```

So `sys_update_set.application` is the set's **own** scope attribute, not a filter on what may
sit inside it. Rows arrive cross-scope through ordinary platform activity and nothing objects.

What *is* enforced — hard — is re-parenting. Every attempt to move a scoped row into a
global set answered 403, and the detail named the mechanism instead of leaving it to inference:

```
Operation against file 'sys_update_xml' was aborted by Business Rule
'Handle updates moving between sets^0e5b994583764f10b939cc65eeaad3c1'.
```

Reading that rule off the instance settles it exactly, with no sampling required:

```js
if (newUpdateSet.application.scope != current.application.scope) {
    current.update_set = previous.update_set;
    current.setAbortAction(true);
    gs.addErrorMessage("Cannot move update to a set for a different scope");
    return;
}
```

**The rule the sweep must obey, verbatim from the platform:** a row may be re-parented only into
a set whose `application.scope` equals the row's own `application.scope`. Confirmed in both
directions — a scoped row into a global set is refused, and the same scoped row into a
*same-scope* set is allowed over the plain Table API:

```
subject: "Auto triage incident" (application=nwforge)
  -> SAME-SCOPE move: ALLOWED over plain Table API
     application preserved: true
  RESTORED to origin: yes
```

One set per scope is therefore not a design preference to be adopted for tidiness. It is the
only shape the platform will accept, and the failure mode for getting it wrong is a 403 in the
middle of a sweep.

**The gap this opens, and how it closes.** A scoped sweep needs a scoped destination set, and
E3.1 showed REST cannot mint one — `application` requested as the nwforge app came back
`global`, same silent demotion as E4. The repo's existing `execution-harness` closes it, because
a server-side `GlideRecord` insert is not on the REST tier:

```
{ "step": "A_plain_insert", "application": "c44f3c6c37c24793be9f8b759c7818e4",
  "scopeOfApp": "x_2196302_nwforge", "matches": true }
```

The same probe confirmed `GlideUpdateSet` exists server-side, and that `.get()` returns whatever
the preference points at — which is the independent confirmation of E1's mechanism, read from
the platform's side rather than inferred from where rows landed.

### E4 — `sys_scope` on insert. VERDICT: REST is global-tier only

Three attempts to create a `sys_script`, each answered `201`:

| request | returned `sys_scope` | read back |
|---|---|---|
| `sys_scope` = the app sys_id | `global` | `global` |
| `sys_scope` = `x_2196302_nwforge` | `global` | `global` |
| no `sys_scope` (control) | `global` | `global` |

No error, no warning, no difference from the control. Asking for a scoped business rule over
REST gets you a global one and a success code. Recorded verbatim in the capability matrix
because either answer was going to be load-bearing, and this one draws the tier boundary:
**scoped artifacts are born through the SDK, global artifacts are born through REST, and only
the latter needs an update set to travel.**

### The mechanism decision

**The sweep is primary. The preference route is not adopted.**

- E2 makes the sweep sufficient on its own: it moves rows, preserves payload and GUID, is
  visible from both sets, and is maintained by the platform's own business rule.
- E1's 8/16 makes the preference route unsafe as the mechanism of record. It is correct only
  under a global serialization we do not otherwise need, and its failure is silent — a change
  in a plausible-looking wrong set, with no error anywhere.
- Adopting it "and keeping the sweep as reconciliation" was the brief's fallback, and it is
  rejected on cost/benefit: it would buy nothing the sweep does not already do, while adding a
  shared mutable per-user setting that a crashed turn leaves pointing somewhere wrong for
  every other session and for a human logged in as the same user.

The sweep therefore runs after every mutating tool success, and reconciles at turn end. It
groups the rows it finds **by the row's own `application`**, and re-parents each group into the
session's set for that scope, creating that set lazily — global sets over REST, scoped sets
through the harness.

### Two defects in our own code that these probes exposed

1. **`client.js` diagnoses every 403 as bad credentials.** The cross-scope abort surfaces as
   *"dev442675 rejected the credentials for admin (403) … the password is wrong … the PDI is
   hibernating"*, for a request whose credentials were perfect. That is trap #51 committed by
   us, in the one place a transport sweep will hit it routinely.
2. **`gs.addErrorMessage` text does not survive the REST boundary.** The reason —
   *"Cannot move update to a set for a different scope"* — is nowhere in the response. Only the
   business rule's *name* comes through, so a caller that wants to explain the failure has to
   recognise the rule by name.

### Cleanup

25 `sc_category` probes, 3 `sys_script` probes and 4 update sets deleted, then the 28 `DELETE`
update rows the cleanup itself produced — because deleting configuration is configuration, and
a sweep that ignores `DELETE` rows would miss half of what a session does. Read back: 0 probe
records, 0 probe sets, 0 stray `NHA E*` update rows, 0 harness sinks, 0 one-shot jobs,
`sys_update_set` back to 22.

One thing did not return to its exact starting state, and it is stated rather than smoothed
over: the admin preference **row** is now `5bb4f30e…` where it began as `7b9f900a…`, because
blanking a preference makes the platform replace the row. Its value — the global Default — is
restored and read back. The setting is identical; the row identity is not.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 69 | **`sys_scope` on a REST insert is silently demoted to `global`** | `201 Created`, every other field lands, and you have a global business rule where you asked for a scoped one — the control row is indistinguishable from the two that asked | REST is a global-tier writer. Read `sys_scope` back and compare; scoped artifacts are born through the SDK. The same demotion hits `sys_update_set.application` |
| 70 | **Blanking a `sys_user_preference` value replaces the row** | you clear a preference, then create one with the right value, and the platform keeps reading the *other* row — with no error and no duplicate warning | Patch the existing row in place and read it back. Then assert there is exactly ONE row for that `user`+`name`; two disagreeing rows resolve to whichever the platform picks |
| 71 | **The current update set is per-USER, not per-session** | two concurrent sessions each set "their" current set and 8/16 changes land in the other one's — every set looks plausible and nothing errors | A shared API user has one preference. Never build a per-session current-set on it; re-parent rows after the fact, where the row's own identity decides where it goes |
| 72 | **An update row may only move between sets of the SAME scope** | a sweep that works all through development dies on a 403 the first time it touches a scoped artifact | Business rule `Handle updates moving between sets` compares `newUpdateSet.application.scope` to the row's. One set per scope, keyed on the ROW's `application` — not on the session's, and not on the tool's |
| 73 | **A 403 from a business-rule abort is not an auth failure** | an error that tells you to check the password and wake the PDI, for a request whose credentials were fine | The `detail` names the rule: *"aborted by Business Rule '<name>'"*. Parse it before reaching for the credentials branch — and note that the rule's own `gs.addErrorMessage` reason never crosses the REST boundary |
| 74 | **Cleaning up configuration writes more configuration** | "every probe record was deleted" is true, and the update set has 28 new `DELETE` rows recording it | A `DELETE` on a `sys_metadata` table is a tracked change like any other. Sweep and clean the `DELETE` rows too, or the tally of what a session did is wrong in both directions |

---

## 34. Transport and scope — what shipped, and the Session 1 acceptance

§33 measured the mechanism; this is what was built on it and how it was proven.
Every acceptance run below is EXECUTED tier — a real agent turn against dev442675,
approved at the real gate, read back afterwards — and every artifact it created was
deleted and the deletion read back.

### The shape

```
agent turn
  └─ mutating tool succeeds
       └─ captureAfterTool()            agent/capture.js
            ├─ table is DATA?  ────────► audit row: "not captured — data, not configuration"
            └─ otherwise
                 └─ sweep()             servicenow/transport.js
                      ├─ find rows      window + <table>_<sys_id> + nameENDSWITH<sys_id>
                      ├─ group by the ROW's application        (trap #72)
                      ├─ ensure a set per scope, lazily
                      │     global → Table API
                      │     scoped → execution-harness          (trap #69)
                      ├─ re-parent, read back each move
                      └─ collapse same-name rows in the set
  └─ turn ends
       └─ reconcileTurn()               time-only, catches what no tool named
```

`sys_update_xml.name` is `<table>_<sys_id>`, so a tool that reports what it touched can be
swept exactly. But an id alone is enough: `nameENDSWITH<sys_id>` matches the same row without
knowing the table, which is why the hook has no per-tool table map to go stale (trap #28). The
time window stays because it is the only thing that catches COLLATERAL rows — a catalog item's
variables, a flow's snapshots, the twelve cross-scope privileges an install writes beside the
artifact you asked for.

### Four behaviours the sweep had to be built around

**One row per record, per SET — not globally.** Editing a record twice rewrites one row
(`sys_mod_count` 0 → 2). But sweep that row into a session set, edit the record again, and a
SECOND row with the same name appears in Default. Move that one in too and the set holds two
rows sharing a name; the platform does not dedupe:

```
rows named sc_category_1139bb46… now: 2
   d539bf46… set=OURS mod=3 hash=1106473295
   4869378683b2c750b939cc65eeaad340 set=OURS mod=1 hash=801901976
DUPLICATES IN ONE SET: 2 rows share the name -> platform did NOT dedupe
```

Both would apply on import and the count would read higher than the number of artifacts, so
the sweep collapses to the newest. That is lossless because a payload is a complete
`<record_update>` snapshot rather than a diff — checked by reading two versions of the same
row side by side, where only `<description>` differed.

**Sets may be parented across scopes even though rows may not.** The constraint in trap #72 is
on `sys_update_xml.update_set`, and it does not extend to `sys_update_set.parent`: a scoped
child minted through the harness took a global parent over plain REST and kept its own
application. So the batch parent the brief made conditional is implemented — a second scope in
one session creates `NHA · <session>` and adopts the first set into it.

**`sys_recorded_at` is not a watermark.** It is typed `counter`, it sorts stably, and it looks
exactly like the high-water mark a sweep wants. Its order has nothing to do with creation time:
sorted descending, the top row was created 2026-08-19 and the seventh 2026-08-20. It is also
not a number — `1a01f54d4620000001`. Trusting it would have skipped rows silently, so the sweep
uses `sys_created_on` plus the exclusion of rows already in a NowHelpAssist set, which is what
makes re-sweeping idempotent (measured: second sweep scans 0, moves 0).

**Cleanup writes configuration.** Deleting the probe records produced 28 `DELETE` update rows
recording the deletions (trap #74). The sweep therefore treats `DELETE` rows like any other,
and the Transport page renders that action in red rather than hiding it.

### Export: why it never uses CDATA

The platform's own exporter, `export_update_set.do`, answers **401 to basic auth** — it wants a
UI session. The record serializer `sys_update_xml_list.do?XML` does authenticate, and reading
one export off it produced the detail that matters:

| row in the same set | how the platform wrote its payload |
|---|---|
| a catalog item | `<payload><![CDATA[ … ]]></payload>` |
| a business rule | entity-escaped, no CDATA |

The business rule's payload carries `<script><![CDATA[…]]></script>`, and CDATA cannot nest —
so the platform falls back to escaping whenever the content already contains `]]>`. An exporter
that always wrapped would emit **invalid XML for every script-bearing artifact**: business
rules, script includes, UI actions. This one always escapes, which is unconditionally valid and
round-trips to the identical string. Both rows in the acceptance set contained `]]>`, so the
hazard was live for 2/2 of them.

Exports are deterministic — the remote set's sys_id is derived from the local one rather than
generated — which is what lets the offline suite assert the format without an instance.

### SESSION 1 ACCEPTANCE (live, dev442675)

**S1-A — capture.** One agent session, capture ON by default, told to create a catalog item and
a business rule. Both approved at the real gate:

```
[tool] create_catalog_item (mutating)
[gate] create_catalog_item -> approving
transport capture set "NHA · Transport acceptance S1-A · global" (69bfbf82…) for scope global
transport sweep (create_catalog_item): 1 captured, 0 failed, 0 superseded
[tool] create_record (mutating)
transport sweep (create_record): 1 captured, 0 failed, 0 superseded
turn done  15.5s
```

Read back:

| check | result |
|---|---|
| exactly one set for the session | PASS |
| it holds exactly 2 updates | PASS |
| no duplicate names inside it | PASS |
| every update the AUDIT claims is in the set, and nothing else | PASS |
| the global Default gained nothing | PASS — 412 rows before, 412 after |
| no artifact of this session sitting in Default | PASS |
| exactly one set added to the instance | PASS — 22 → 23 |
| both artifacts really exist | PASS — both `sys_scope=global`, as §33's E4 predicts |

The names were matched against the audit rather than against what the run expected to happen —
the audit's capture rows and the set's contents were compared as sets, in both directions.

**S1-B — export.** Downloaded through the real HTTP route:

```
Content-Disposition: attachment; filename="NHA_Transport_acceptance_S1-A_global.xml"
X-NHA-Parity: verified
Content-Length: 10606
```

Round-parsed with **Python's ElementTree** rather than our own reader, so the check is not
circular:

```
PASS  parses as well-formed XML (ElementTree)
PASS  root element is <unload>
PASS  1 header, 2 sys_update_xml elements
PASS  header summary matches the number of update elements
      Catalog Item   NHA Transport Item  hash=-446080273  payload 3853ch  ok <record_update table=sc_cat_item>
      Business Rule  NHA Transport Rule  hash=-296922400  payload 1669ch  ok <record_update table=sys_script>
```

Each payload is itself well-formed XML after unescaping, and both are byte-identical to the
live rows with matching `payload_hash`. The set name contains `·`; the UTF-8 bytes `c2 b7` are
present in the file and the name round-trips exactly — only the Windows console mangles it.

**S1-C — scope visibility.** Driven in headless Chrome over CDP, the scratchpad driver §23
established:

```
stats: 3 custom applications | 739 store applications | 1 managed by NowHelpAssist
   NowForge Flows   scope=x_2196302_nwforge  v0.0.1  managed=NowHelpAssist fluent-workspace · 25 sources
   SNADA Authored   scope=x_2196302_snada    v0.0.1  managed=—
   TechSnitch DMS   scope=x_tepv_ts_dms      v0.0.1  managed=—

Flows:   headers [NAME, TYPE, SCOPE, STATUS, ACTIVE]     100 scope badges
Catalog: headers [NAME, CLASS, SCOPE, ACTIVE]            100 scope badges
SLA:     headers [NAME, TABLE, SCOPE, DURATION, CLOCK]    45 scope badges
Access:  … OP, DEFINED ON, SCOPE, ROLES …                 28 scope badges
console errors across every page visited: 0
```

The Store tab renders all 739 read-only, which is the point of reading them through
`sys_scope`: the table they live on is closed to this user.

**Beyond the brief's three, because the requirement was explicit.** A data-only session:

```
[tool] create_record (mutating)
[capture] captured=false reason=data :: not captured — data, not configuration (incident does not extend sys_metadata)
```

| check | result |
|---|---|
| a capture row was written at all | PASS — it does not silently vanish |
| it reports NOT captured, reason `data` | PASS |
| the exact required wording is present | PASS |
| no capture set was created | PASS |
| the instance gained no update set | PASS — 23 → 23 |
| the incident itself was really created | PASS — INC0010045 |

### Three defects this phase found in our own code

1. **Every 403 was reported as a credentials failure.** The cross-scope abort and the
   API-level ACL on `sys_store_app` both answered "the password is wrong … the PDI is
   hibernating" for requests whose credentials were perfect — trap #51, committed by us, in the
   one place a sweep hits routinely. Now a pure `diagnoseFailure()` with the branch asserted
   offline.
2. **`SkeletonRows` renders a `<tbody>`** and both new pages used it outside a table, which the
   browser pass caught as three `validateDOMNesting` errors. `SkeletonLines` is the
   outside-a-table form. Zero console errors after.
3. **Store-app descriptions are HTML-encoded** — `table&#39;s fields` rendered literally,
   because React escapes text. Decoded at the service, still rendered as text.

### Cleanup

Both acceptance sessions, their catalog item, business rule, incident and update set deleted,
then the `DELETE` update rows the cleanup itself produced. Read back: 0 NHA config records,
0 NHA incidents, 0 NHA update rows, 0 NHA sets, 0 rows in `capture_sets`,
`sys_update_set` back to **22**, the global Default back to **412** — the two numbers the
acceptance started from.

### What is NOT done

- **On-demand scoped applications.** The workspace registry generalises the scope → workspace
  mapping and the harness can mint a scoped set, which is the groundwork; creating a NEW scoped
  application on demand is not implemented and was not part of Steps 0–3.
- **Import.** Export is proven; nothing reads an update set XML back in. The parser in
  `transport-export.js` exists to verify our own output and is not an importer.
- **A scoped capture has not run end to end.** Every acceptance artifact was born over REST and
  is therefore global (E4). The scoped path — harness-minted set, same-scope re-parent — was
  measured directly in §33 (E3.1 and the "Auto triage incident" move) but has not been driven
  through a whole agent turn, because reaching it needs an SDK install inside the turn.
- **Multi-scope batch parenting is unexercised as a whole.** The linkage was measured; no
  session has yet touched two scopes at once, for the same reason.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 75 | **`sys_recorded_at` looks like a watermark and is not** | typed `counter`, sorts stably, and a sweep built on it silently misses rows | Its order is unrelated to creation time — descending, the newest row here was two days older than the seventh. It is not even a number (`1a01f54d4620000001`). Use `sys_created_on` plus an exclusion of what you already claimed |
| 76 | **One row per record holds per SET, not globally** | you sweep a row out of Default, edit the record again, and now two rows share a name — the platform does not dedupe, and both apply on import | Collapse by name inside the set after every sweep. It is lossless: a payload is a whole `<record_update>` snapshot, not a diff |
| 77 | **CDATA cannot nest, and the platform knows it** | your exporter always wraps payloads in CDATA, and every business rule, script include and UI action produces a file that truncates at the first `]]>` | The platform escapes instead whenever the payload already contains CDATA. Always-escape is unconditionally valid and round-trips identically |
| 78 | **`export_update_set.do` is a UI processor** | the obvious endpoint answers 401 to perfectly good basic auth, and it reads like a credentials problem | It wants a session cookie. `sys_update_xml_list.do?XML` authenticates but emits the generic `<xml>` list, not the `<unload>` an import expects — a reference, not a substitute |
| 79 | **A row constraint is not a set constraint** | you assume the same-scope rule that blocks re-parenting also blocks batch parenting, and build per-scope sets with no grouping | Measured: a scoped child set took a GLOBAL parent over plain REST and kept its own application. The rule in trap #72 is on `sys_update_xml.update_set` alone |

---

## 35. Session 1 addendum — AD-1 to AD-5

Five follow-ups folded in from the Session 1 verdicts. Two of them found live defects; one
of those was in code this project shipped one commit earlier.

### AD-5 — did the last install ship anything unintended? No.

The dirty tree Session 1 committed was verified by `now-sdk build` before committing but never
installed, so the question is really about the install that preceded it. Answered by comparing
three things that should agree, and do:

| | |
|---|---|
| source files in `src/fluent/flows` | 24 |
| artifacts those files declare | **25** — `escalate-network-p1-incident.now.ts` declares a Subflow *and* a Flow, the same-file pair from §32 |
| `sys_hub_flow` rows in the scope | **25** |
| live `sys_hub_flow` ids in `keys.ts` | **25** — 0 in keys.ts missing from the instance, 0 on the instance missing from keys.ts |

And the part records line up exactly with what `keys.ts` claims:

```
sys_hub_action_instance_v2      352 rows -> 103 on a live flow  (keys.ts: 103)
sys_hub_flow_logic_instance_v2  172 rows ->  80 on a live flow  (keys.ts:  80)
sys_hub_sub_flow_instance_v2     23 rows ->   7 on a live flow  (keys.ts:   7)
sys_hub_trigger_instance_v2      17 rows ->  17 on a live flow  (keys.ts:  17)
```

The remainder is 357 snapshot-parented parts (normal — a flow keeps versioned copies) and
**58 orphaned parts** whose parent no longer exists in scope. Those are debris from earlier
regenerate/delete cycles, not from the last install, and the dates say so rather than the
reasoning: all 58 were created 2026-08-17 → 2026-08-20, **0** inside the install's 13:18–13:20
window. Nothing at all was created in the scope on 2026-08-21.

**Noted, not fixed:** 58 orphaned part records are real debris and a hygiene item for a later
pass. And the controlled install below surfaced one broken artifact among the committed sources
— `Resolve Approval Matrix` fails activation with *"At least one Action Instance is required to
publish a subflow"* (24/25 succeeded). That is a source defect inherited from an earlier
session, shipped faithfully; it is not something the install did wrong.

### AD-3 — does `now-sdk install` emit update rows? YES. And the answer exposed a defect.

Measured properly: snapshot every `application = x_2196302_nwforge` update row, install, diff.

```
nwforge update rows: 56 BEFORE -> 56 AFTER  (delta 0)
NEW rows created by the install : 0
EXISTING rows whose payload changed: 24
EXISTING rows whose sys_mod_count moved: 24
```

So install **does** emit update rows, tagged with the app's scope — 46 of the 56 sit in the
scope's own Default set. But it emits them by **rewriting rows that already exist**, because
one row per record already existed for each artifact (trap #76, from the other direction).

That is the part that mattered, and it broke the sweep this repo shipped one commit earlier:

| | |
|---|---|
| `sys_created_on` moved on | **0 / 24** |
| `sys_updated_on` moved on | **24 / 24** |
| a sweep asking `sys_created_on>=since` finds | **0 rows** |
| a sweep asking `sys_updated_on>=since` finds | **24 rows** |

```
CONFIRMED: an install is INVISIBLE to a created-only sweep
```

An entire SDK install — 24 artifacts changed — would have reported "nothing captured", with no
error anywhere. The window locator now asks for created **or** updated, and the same probe
after the fix returns all 24:

```
findCandidateRows(since=2026-08-21 06:13:47) -> 24 rows
by application: { "c44f3c6c37c24793be9f8b759c7818e4": 24 }
```

`sys_created_by` is applied only to the created half: the row was created by whoever first
changed that artifact, which for an install over an existing app is a previous session or a
previous day.

**AD-3's decision, per the brief's YES branch:** S2-B and S2-C **merge** — app creation and
flow deploy run inside ONE captured agent session, asserting that the per-scope set
materialises and that a same-session global config change links both under the batch parent.
Cross-scope batch parenting was already measured clean (§34, trap #79).

### AD-1 — the three defects, confirmed fixed, and a fourth 403 shape

`SkeletonRows` and the HTML-decoding were fixed in Session 1 and are confirmed: the browser
pass reports **0 console errors** across every page visited, and `decodeEntities` is asserted
offline.

The 403 classifier needed more than confirming. AD-1 asks specifically for a **row-level** ACL
403, and that shape was NOT handled — it fell through to the credentials branch. Measured:

| probe | detail | was | now |
|---|---|---|---|
| `DELETE syslog` | `ACL Exception Delete Failed due to security constraints` | *"the password is wrong…"* | `row-acl` — names the operation, table and sys_id |
| `GET sys_store_app` | `Failed API level ACL Validation` | `table-acl` | unchanged |
| `PATCH` cross-scope | `aborted by Business Rule '…'` | `business-rule` | unchanged |
| `GET` a missing record | `Record doesn't exist or ACL restricts the record retrieval` | *"No Record found"* | `missing-or-hidden`, ruling neither out |

This sits directly on the sweep: `collapseDuplicates` **deletes** superseded `sys_update_xml`
rows, so a protected row lands on exactly this branch. Table-level and row-level are kept
distinct because the remedy differs — one is "this table is unreachable over REST at all", the
other is "you can read the table, you may not touch that record".

Live, after the fix:

```
delete was refused by a record-level ACL on dev442675.service-now.com for
syslog a24153138322031059c0cc65eeaad364. "admin" can reach the table but not delete
that row — a permissions constraint on the record, not a credentials problem.
```

### AD-2 — E4 as a pipeline invariant

`assertScopeIntentHeld()` runs on every REST create at the one funnel they all pass through. If
a payload carries scope intent — `sys_scope`, or `application` on the update-set tables — the
created record's value is read back and a mismatch throws, naming both values and where scoped
artifacts actually come from. Asking for `global` and getting `global` is not a mismatch; the
only thing refused is a silent demotion.

Matrix line, verbatim, now in README and in §33's capability matrix:

> REST-created artifacts are global; scoped artifacts are born via the SDK tier.

### AD-4 — the collision guard

The existing exclusion (skip rows already in a NowHelpAssist set) covers the *sequential* case.
It does nothing for the live one: two captured sessions running at once, both sweeping, both
seeing a row still unclaimed in Default. Whichever sweeps first takes it — which is E1's
contamination with a different mechanism.

A row inside more than one open capture window is now **contested**, and is never assigned on
timing. It is resolved by provenance — whether this session's own `tool_events` report touching
that record, which is the one honest tiebreak because a created record's sys_id exists only in
a tool's return value. Four outcomes, all tested:

| situation | verdict |
|---|---|
| only one window covers the row | mine |
| contested, my audit trail reports the record | mine |
| contested, the rival's audit trail reports it | **theirs — never taken** |
| contested, neither reports it | **unassigned, reported, not moved** |
| contested, **both** report it | **unassigned** — never duplicated |

Windows open at turn start and close in a `finally`, so a crashed turn cannot leave one open
and make every later session's rows look contested. Unassigned rows are surfaced in the capture
event and the audit row rather than silently skipped: left behind in Default is recoverable,
filed under the wrong session is not.

### A leak this phase's own lens exposed

The execution harness writes its return channel as a `sys_user_preference` with `system = true`
— which makes it **configuration**. Every harness run therefore emitted a `sys_update_xml` row,
and deleting the sink record did not remove it (trap #74 again). Measured: **10** rows had
accumulated in the global Default, one per run since 2026-08-20.

Untidy is the smaller half. A captured session that runs a subflow verification would have
**swept one into its update set**, and the export would carry a meaningless "User Preference"
artifact into whatever instance it was imported on. The harness now deletes its own update rows
as part of cleanup, verified on a fresh run (`updateRowsDeleted: 1`, count unchanged), and the
10 historical ones were removed.

### Instance state

`sys_update_set` **22** (baseline). Global Default **402** — 412 minus the 10 harness leaks
just cleaned, which is a correction rather than drift. Zero NHA artifacts, zero harness rows.

**One thing to record against myself:** an AD-1 probe wrote `label = "NHA probe"` to
`sys_db_object` for `incident` without a guaranteed revert, and the platform cascaded it to two
Modules and a Field Label. Caught on the next read, reverted to `Incident`, cascade records
confirmed correct, and the 3 update rows it produced deleted. A probe that mutates a platform
table should revert in a `finally`, the same rule the verification runner has had since §11.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 80 | **An SDK install REWRITES update rows rather than creating them** | a capture sweep reports "nothing captured" for an install that changed 24 artifacts, and no error appears anywhere | Measured: `sys_updated_on` moved on 24/24, `sys_created_on` on 0/24, because a row already existed per artifact. Any window over `sys_update_xml` has to be created **OR** updated |
| 81 | **`ACL Exception <Op> Failed due to security constraints` is a ROW-level denial, not a login problem** | a delete that the table plainly permits fails, and the error sends you to check a password that is fine | Distinct from `Failed API level ACL Validation`, which is the whole table. The remedies differ, so the diagnosis has to. Both are 403 |
| 82 | **A harness return channel written as a `system` preference is CONFIGURATION** | "every test record was cleaned up" is true, and the update set has one new row per run — 10 of them here | `system = true` on `sys_user_preference` makes it tracked. Anything a harness creates has to be checked for an update row too, or a captured session exports it |
| 83 | **Two sweeps racing for an unclaimed row is a different bug from two sweeps racing for a claimed one** | the "already in one of our sets" exclusion looks like it solves concurrency, and it only solves the sequential half | A row still sitting in Default is unclaimed by construction. Arbitrate on provenance from the audit trail, and leave a genuinely ambiguous row where it is |

---

## 36. Hardening sprint — the seven defect classes from the 2026-08-20/21 transcript

A live session against dev442675 produced seven defect classes, the worst of which had the agent
reporting success on writes the platform silently discarded. Every fix below is harness-level and
model-agnostic: none of it is a prompt asking the model to be more careful, because in the
transcript the model *was* careful — it correctly refused to create an application one turn before
creating one anyway, and it printed the payload disproving its own success claim.

All three headline defects were reproduced live before anything was written, on the same records.

### E1 / E2 — the platform accepts a write and discards it

Re-run on the transcript's own record (`29b5648983be0f10b939cc65eeaad36b`, "AGAMYA_Scope"):

```
subject 29b5648983be0f10b939cc65eeaad36b application=global mod=0 updated=2026-08-17 11:23:38
PATCH returned:            application=global mod=0 updated=2026-08-17 11:23:38
requested c44f3c6c37c24793be9f8b759c7818e4
=> SILENTLY DROPPED; sys_mod_count 0 -> 0 (UNCHANGED — no-op signal)
```

HTTP 2xx, the record untouched, and `sys_mod_count` / `sys_updated_on` both frozen at creation.
`sys_update_set.application` is forced to the session's current application scope on **both** insert
and update — the same demotion §33 E4 measured for `sys_scope` on an insert, which is why the AD-2
guard from the previous sprint fired on this sprint's own fixture recorder.

The frozen pair is the cheap decisive signal, and it is checked before the field diff.

### The rules the diff had to encode, each measured rather than assumed

| behaviour | measured |
|---|---|
| journal fields | `comments` writes fine and reads back `value: ""` — the text lives only in `display_value`, wrapped in a timestamp and an author. Never verifiable by echo |
| booleans | `active: true` (a real boolean) returns the string `"true"` |
| choice labels | `state: "On Hold"` IS resolved to `"3"`, and `display_value` comes back as "On Hold" |
| computed fields | `priority` is derived from impact+urgency; writing it is ignored (trap #5) |
| unknown fields | a field that is not a column is **absent from the response entirely** |
| encoded-query `=` | case-insensitive on strings and on sys_id — `user_name=ADMIN` returns the `admin` row |

The choice-label case gave the discriminator that separates a lost write from a resolved one: a
returned `display_value` equal to what was *asked for* proves the platform resolved a label. Without
it, every label-addressed write would report as dropped.

### E3 — the lookup could not find the record it was named after

```
lookup("admin", sys_user):
   dd9b3742c37030009b5efcfc5bba8fb6  Certification Admin
   8ff5b254b33213005e3de13516a8dcf7  CMDB Admin
   860a4d35eb32010045e1a5115206fe54  Credential Admin
```

One line of cause: `${displayField}LIKE${q}^ORDERBY${displayField}`. A contains-match on `name`,
alphabetical — and `user_name` was never searched at all, so the user whose `user_name` **is**
`admin` could not win a search for its own key. Two incidents were created with caller ≠ opener.

`lookup("global", sys_scope)` returned "Enhanced Global Search UI" for the same reason, over a
record whose sys_id is the literal string `global`.

### E5 — the husk, and the route that works

`create_record` on `sys_scope` produced `sys_class_name: "sys_scope"`, `scope: ""`, no version.
Investigated as the brief required: `now-sdk init` takes `--appName --packageName --scopeName` and
the build emits `dist/app/scope/sys_app_<id>.xml` — a **sys_app**, which is the whole difference.
So the boundary is enforced in `create_record` and `create_application` offers the real path.

Scope naming is validated first, against the vendor prefix read live from
`glide.appcreator.company.code` (`2196302` here → `x_2196302_`, leaving 8 of 18 characters). A wrong
prefix is only a *warning* at install time and the application then "may not install correctly"
(§3), so a second of validation replaces a broken application.

### E7 — a fabricated sys_id, found while fixing the playbook

The transcript reported the blocking business rule as
`bfdd88168376c750b939cc65eeaad39f`. Checked:

```
sys_script       -> not found
sys_metadata     -> not found
sys_update_xml   -> not found
sys_update_set   -> not found
```

It exists nowhere on the instance. Which is the argument for enrichment over guidance: the playbook
now looks the rule up and returns real rows, or says it found none.

Reading the rule also changed the recommendation. "Abort changes on group" exists **five times** on
this instance, one per task table, and the `incident` copy
(`6a2e9d1453e80010833addeeff7b124f`) fires on
`assigned_toISNOTEMPTY^assignment_groupVALCHANGES^assignment_groupISNOTEMPTY` — aborting only when
the assigned user is **not a member of** the assignment group. That is correct business logic. The
transcript's response — silently dropping those fields from every later write, forever — was the
worst of the four available options, and "pick a user who is in the group" was never offered.

Matching on name alone would have returned the `change_task` copy for an `incident` write, so the
lookup is keyed on name **and** table.

### What each work item ships

| | |
|---|---|
| **WI-1** | `write-verify.js` — pure, no I/O. Diffs the requested payload against the returned record and classifies each field `applied` / `dropped` / `transformed` / `unverifiable`. The verification block is appended AFTER truncation, because spliced in before it is exactly the tail an 8,000-character cut removes — leaving the model reading a plausible success with the disproof deleted |
| **WI-2** | `mutation_ledger` + a report rendered by the HARNESS. Pinned structurally: compaction deletes from `messages` and `chunks` and touches nothing else, so no code path can drop a ledger row even by mistake |
| **WI-3** | `write-guard.js` — a drop registry (session-scoped, because platform behaviour persists) and a rejection registry (turn-scoped, because a user who asks again means it), both checked BEFORE the approval gate |
| **WI-4** | Per-table key fields, four-rank ordering, a literal/sys_id probe, `matchType` and `ambiguous` on every result |
| **WI-5** | The husk guard, plus `create_application` and `check_scope_name` |
| **WI-6** | `executeTool()` refuses a mutation without a resolved approval; emission reordered; `writeOutcome.js` derives glyph and words from one object |
| **WI-7** | The capture annotation in the tool result body, and the business-rule playbook |
| **WI-8** | Shipped, default on: a completion carrying both a question and mutating calls holds the calls |

### Two claims in the brief that were not in the tree

The brief listed both as already shipped and asked that they not be regressed. Neither existed:

- **"turn-scoped canonical-input-hash rejection denial"** — the only rejection handling was the
  prose string *"The user rejected this operation. Do not retry it"* in the tool result. No
  registry, no hash, no enforcement. Built in WI-3.
- **"relevance-ordered tool-result truncation with omission markers"** — true for *schemas*
  (`toCompactSchema`, §D-7), not for tool results, where `truncate()` is
  `str.slice(0, 8000) + '…[truncated]'`. Left alone rather than rewritten, and WI-1's verification
  block is placed beyond the cut instead.

### Two defects introduced and caught during the sprint

Worth recording because both were caught by the tests rather than by review: a `Object.defineProperty`
with `enumerable: false` immediately followed by `Object.assign` on the same key (throws in ESM's
strict mode), and an ambiguity rule that flagged `sys_user_group` exact matches as ambiguous because
the table's key **is** its display field — which would have made the agent confirm something it got
exactly right.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 84 | **ServiceNow REST can silently drop field writes and return 200 with the unchanged record** | the agent announces "is now linked" with the disproving payload in its own tool result, three times | Diff every requested field against the response, and check `sys_mod_count`/`sys_updated_on` — frozen means nothing was stored. Known instance: `sys_update_set.application` is forced to the session's current application scope on both insert and update |
| 85 | **Bare `sys_scope` inserts create husks, not applications** | `201 Created`, and an "application" with `sys_class_name: "sys_scope"`, no technical `scope` name and no version, that Studio will not list | Real custom apps are `sys_app` records with an `x_<vendor>_<name>` scope, created via Studio or `now-sdk init`. The build output names it: `dist/app/scope/sys_app_<id>.xml` |
| 86 | **`lookup_reference` contains-matching shadows exact key matches** | "admin" resolves to "Certification Admin", and two incidents get a caller who is not the opener | Rank exact key-field matches first, search the KEY field and not only the display field, and treat a non-exact top hit as ambiguous. Some sys_ids are literals — `sys_scope`'s Global row has `sys_id = "global"` |
| 87 | **Incidents, and every non-`sys_metadata` table, are data** | a user believes their incident was created "inside" an update set or an application scope | Update sets capture configuration only. Say it in prose when the question implies otherwise; the tool result already knows |
| 88 | **A choice LABEL that the platform resolved looks exactly like a dropped write** | `state: "On Hold"` comes back as `"3"`, and a naive diff calls it lost | The returned `display_value` equal to what was REQUESTED is the proof it was resolved. Without that check, every label-addressed write reports as dropped |
| 89 | **A fabricated sys_id reads exactly like a researched one** | the agent names the business rule blocking a write, with an id that exists on no table | Enrich the tool result with the real lookup instead of asking the model to report one. And when a rule name matches five rows — one per task table — match on name AND table, or the wrong copy is reported with total confidence |

---

## 37. `finish reason: load` on a well-formed request — the compaction that folded the question away

A session against dev442675 died twice in a row on
`ollama returned an empty completion (finish reason: load) (after 3 attempts)` — six identical
failures, on large prompts, and only ever after a compaction had run. §29 had already established
that `load` is Ollama's own value for "the model was loaded and nothing was generated", and §31 had
already ruled out the context window. Both were right, and neither was the cause.

### What the stored session showed

The session's last message row is a `create_record` tool result at `11:23:23.102`. Its second digest
was written at `11:23:28.329`. Nothing was persisted after that — which is the error path behaving
exactly as designed, and also the whole clue: **the fold ran mid-turn**, about thirty-nine seconds
into a turn that opened at `11:22:49.818`, after roughly thirteen assistant/tool rows.

`KEEP_LAST_TURNS` is 8. Thirteen rows is more than eight. So `cutIndex = rows.length - 8` landed
*after* the turn's user message, and the fold deleted it. What went to the model was:

```
system > assistant(tool_calls) > tool > assistant(tool_calls) > tool > ...
```

A conversation with nothing in it asking for anything. It is perfectly well-formed — every guard in
the D-7 degenerate-request family passed it, because every one of those guards checks that a bad
shape is *absent* and none checks that a necessary row is *present*.

Three properties then made one bad request into six:

- the request body was serialised **once**, above `withRetry`, so all three attempts POSTed
  byte-identical bytes;
- the error path writes nothing, so the UI's Retry re-ran the turn against unchanged history — and
  the fold had already happened, so the shape was frozen;
- the error card asserted a cause it could not know (*"usually a transient load on Ollama's side"*),
  sending the reader to Settings while the defect was in `compaction.js`.

### What it was not

Worth recording, because both were plausible and both are now excluded by arithmetic rather than by
opinion. The failing request carried roughly 15,700 tokens of fixed overhead and ~2,800 of history —
about **18.5k estimated, 13.5k real**. §31's own table has 35/35 successes at up to 51,429 real
prompt tokens on this same path. It was not size, and it was not the window. Nor was it throttling:
`openaiCompat.js` checks `res.ok` before treating a body as a success, so a 429 or a 5xx surfaces as
`API error (<status>)` and could never print `finish reason: load`.

### A separate defect the same screenshot exposed

The "empty bubble" in the transcript was not a blank assistant turn — there are none in the stored
session. `AgentChat.jsx` rendered the harness's mutation report as
`<Markdown>{m.markdown}</Markdown>`, and `Markdown` destructures a `text` prop. WI-2's central
guarantee — that an executed mutation cannot be absent from the turn's report — had been rendering
to an empty `<div>` on every turn that mutated.

### Fixed

The cut is role-aware and never crosses the newest `user` row; where that leaves nothing worth
folding the fold is skipped with a reason. The serialiser reports whether a user turn survived and
the adapter refuses the send if not — refuses, rather than injecting a synthetic one, because a
repaired request would carry a turn built on corrupt state into the approval gate. The
empty-completion dump now persists to `tool_events` with a `roleSequence` field, which is the one
value that would have shown this in a minute rather than a morning.

---

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 90 | **Mid-turn compaction can orphan the active user turn** | a long tool loop, a fold that fires on iteration seven, and a request that no longer contains the question it is answering | Cut placement must be role-aware. A row count is not a turn boundary: `keepLast` is four tool round-trips and a real turn routinely runs longer, so clamp the cut to the newest `user` row rather than trusting arithmetic |
| 91 | **Serializers need presence invariants, not just absence checks** | every degenerate-shape guard passes, and the request is still meaningless | Absence checks ("no blank assistant turn, no orphaned tool result") cannot see a row that was removed. Assert what must BE there. And refuse rather than repair — injecting a synthetic user message makes the send succeed on a conversation nobody had, and the turn carries on into the approval gate |
| 92 | **`finish_reason: "load"` arrives on a 200 with a non-empty `messages` array** | §29's conclusion — "a cold start" — applied to a request that had been warmed up three times | `load` means the request produced no generation; it does not prove the model was loading. Treat it as "the upstream had nothing to say about this request" and check the request first. A user-less conversation reproduces it on a warm model |
| 93 | **A diagnostic that only reaches stderr does not exist** | the one block that answers "degenerate request or unlucky upstream?" is gone by the time anyone asks | Persist guard dumps where compaction cannot reach them — `tool_events`, not `messages`. Bound the raw body; a failure path is the worst place for an unbounded write |
| 94 | **A payload serialised outside the retry closure makes every retry a replay** | three "attempts" that are one attempt sent three times, and a flaky-upstream reading of a deterministic bug | Decide inside the retried function what is being sent. Identical bytes may well be correct — but it should be a choice the function makes, not a property of where a `const` happened to sit |

---

## 38. Database Administration — Phase 0 foundations

The DBA module's dependency order is fixed: Schema Intelligence (read) → Impact
& Safety → Authoring → Data ops. Phase 0 builds none of those. It builds the one
service every later layer has to quote: **what can this instance actually
recover?** Getting that wrong is not a bug, it is a promise to a user that a
deleted record can be brought back when it cannot.

Everything below is measured on **dev428633** (2026-08-31). Note the instance
id — earlier sections in this document were written against dev442675, which is
no longer the bound PDI.

### The rollback matrix is conditional, and every condition had to be measured

Runbook §1.5 states the recovery rules but each one is gated on an instance
fact. Four probes, four surprises.

#### 1. `glide.db.rdbms` answers `gs.getProperty` and has no `sys_properties` row

```
gs.getProperty('glide.db.rdbms')      ->  "mysql"    (server-side script)
sys_properties  name=glide.db.rdbms   ->  NO ROW     (Table API)
sys_properties  nameLIKErdbms         ->  auxdb.db.rdbms = "mysql"   <- the AUXILIARY db
```

The engine is load-bearing — MySQL/MariaDB gets rollback *and* delete recovery,
Oracle rollback only, SQL Server neither — so this is the difference between
offering a recovery window and refusing to. A REST search for the property finds
only `auxdb.db.rdbms`, which is the auxiliary database's engine. Here they
happen to agree, so reading it would have been **right by luck**, and wrong on
any instance where they differ.

`stats.do` was tried as an alternative and does not carry the engine: 200,
21,216 bytes, zero matches for mysql/mariadb/oracle/sqlserver/rdbms/jdbc.

So engine detection costs one execution-harness round trip (~2s wall, measured
`elapsedMs: 35` server-side). It is cached for an hour, and when it fails it
returns `null` — never a default. `recoveryVerdict` degrades to `unknown` and
tells the caller to treat every delete as irreversible.

#### 2. Delete recovery is PARTIAL here, and a boolean would have to lie about it

`sys_plugins` is 403 over REST. `v_plugin` is readable and carries the same
state:

| plugin | id | state |
|---|---|---|
| Delete Recovery | `com.glide.delete_recovery` | **active** |
| Delete Recovery: Partial Undelete Support | `com.glide.delete_recovery.partial_undelete` | **active** |
| Restore Deleted Records | `com.snc.undelete` | **INACTIVE** |

§1.5 requires both for record-delete recovery. Deletes on this instance *are*
being captured — `sys_delete_recovery` holds rows in state `finished` ("Ready
for Recovery"), the newest created 2026-08-30, one of them from a
`/api/now/table/sys_user/…` DELETE — but the plugin providing the restore path
is not installed.

"Recoverable?" is therefore **three-state**, not two: `full` / `partial` /
`none`, and `partial` is the state this instance is in. A boolean would have to
round it either to "yes, 7 days" (false — nothing can restore it) or to "no"
(false — the data is captured and one plugin activation away). The verdict
string says exactly that, and the offline suite asserts the partial state never
reports a `windowDays`.

The 7-day figure itself stays labelled as documentation: there is **no**
delete-recovery retention property on this instance to measure it against.

#### 3. Rollback retention is per-category, not the single 10 days §1.5 implies

```
glide.rollback.expiration_days_scripts_bg     10     background scripts
glide.rollback.expiration_days_app_install    15
glide.rollback.expiration_days_plugin         15
glide.rollback.expiration_days_redact          3
glide.rollback.expiration_days_inst_preview    1
```

Quoting "10 days" at someone whose change was a plugin activation understates
their window by a third; quoting it after a redact overstates it by more than 3x.

#### 4. `security_admin` does not exist on this instance

`sys_user_role` where `name=security_admin` returns **zero rows**, while `admin`
is one of only two directly-held roles (the other is
`snc_required_script_writer_permission`; 124 roles total, 122 inherited). So the
runbook's "requires `security_admin` elevation" cannot be implemented as a role
check here. The context service reports the measurement and refuses to infer an
elevation capability from a role that is not there — the route this repo
actually established is in `docs/role-elevation-gate*.md`.

### Four different shapes of "no" for one question: where are the indexes?

`dba.listIndexes` looked like the easiest Layer 1 tool. It is the hardest, and
each candidate source fails differently:

| source | result |
|---|---|
| `sys_index` | **403** `Failed API level ACL Validation` — closed to REST even for admin |
| `sys_index_ii` | **400** `Invalid table` — does not exist on this instance |
| `v_db_index` | **200, zero rows** — unfiltered *and* for `table=incident`. Readable and inert |
| `sys_package` (to reach it via the parent) | **403** — the read-the-parent trick does not rescue it |

`sys_index` **is** readable from a server-side script. Measured shape, 18
columns:

```
logical_table_name   the readable table name   <- query on this
table                a sys_id reference to sys_db_object
col_name_string      the indexed column
index_col_name       sys_id of the column record
unique_index         "0" / "1"
access_method        "btree"
```

So the index path is the execution harness, not REST, and `sys_index_ii` should
not be looked for at all. This is recorded in `dba-metadata.js` as a `REACH`
table so a caller gets "this needs the server-side path" instead of a 403 it
will misread as bad credentials — trap #51 in our own code, again.

### What Phase 0 ships

- `server/src/servicenow/dba-metadata.js` — the metadata client. Pages to a
  stated ceiling and marks the result `truncated` (the Table API returns exactly
  `sysparm_limit` rows with no indication there were more); enforces trap #4 by
  comparing returned keys against requested ones; carries the `REACH` table.
- `server/src/servicenow/dba-context.js` — engine, plugins, retention, identity,
  scope, and the three-state recovery verdict.
- Two read-only agent tools, `dba_context` and `dba_raw_metadata`.
- 13 offline tests. `npm test` — **991 pass, 0 fail**.

The audit store is **reused, not rebuilt**: `mutation_ledger` already records
who/what/old/new/when/instance/actor, and a second parallel log would be the
architecture the runbook's rule 2 forbids.

### One defect this phase found in its own code

The truncation warning fired on `max: 1` identity lookups — asking for one row
and getting one row genuinely does not prove there was only one, so
`truncated: true` is correct, but logging a scan-ceiling WARNING for a
deliberate single-row read trains the reader to ignore the warning that matters.
The flag is still always reported; the log line is now reserved for reads that
hit the ceiling unintentionally.

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 95 | **`glide.db.rdbms` has no `sys_properties` row** | a REST search for the database engine finds `auxdb.db.rdbms` and nothing else | The property answers `gs.getProperty` server-side only. `auxdb.db.rdbms` is the AUXILIARY database — on this instance it agrees, so reading it is right by luck. Detect the engine through a server script, and return `null` rather than a default when that fails |
| 96 | **One question, four different shapes of "no"** | `sys_index` 403, `sys_index_ii` 400, `v_db_index` 200-with-zero-rows, `sys_package` 403 | A 403 on a metadata table is an API-level ACL, not a credential problem, and no credential fixes it; a readable view that is always empty is worse, because it looks like an answer. Record reachability per table and route to the server-side path instead of retrying REST |
| 97 | **Delete Recovery active + Restore Deleted Records inactive** | deletes are captured in `sys_delete_recovery` marked "Ready for Recovery", and nothing on the instance can restore them | Recoverability is three-state. A boolean must round this either to "7-day window" (nothing can restore it) or to "not recoverable" (the data is captured and one plugin away). Say which of the two halves is missing |
| 98 | **Rollback retention is per-category** | "contexts purge after 10 days", quoted at every change | 10 is `scripts_bg` only: app_install 15, plugin 15, redact 3, inst_preview 1. Read `glide.rollback.expiration_days_*` and quote the row that matches the operation |

---

## 39. Database Administration — Phase 1, Schema Intelligence

Thirteen read-only tools over the metadata tables. It builds on `schema.js`
rather than beside it — that module already walks `super_class` and merges the
dictionary across the chain, and a second schema reader would be two readers
that can disagree. What Phase 1 adds is the DBA half: origin tables, overrides,
inbound references, classification, relationships, indexes, and the derived map.

### Acceptance, live on dev428633

The runbook's own examples, run against the instance:

| question | answer |
|---|---|
| What does `caller_id` reference? | `sys_user`, display field `name`, no qualifier in effect |
| Show all fields referencing `sys_user` | **3,999** inbound reference fields, not truncated |
| Where does `incident.number` actually come from? | origin `task` — inherited, `string`, max length 40 |
| Resolve `INC0000060` | `incident` / `1c741bd70b2322007518478d83673af3` |
| Classify `incident` | `core-ootb`, uncustomised, "not-directly" safe to modify |
| Classify a `u_` table | `custom-in-scope`, safe to modify: yes |
| Schema map for `incident`, depth 1 | 43 nodes, 201 edges (6 extends, 195 reference) |
| `incident.state` choices | 6, defined on `incident` |
| Dot-walk `caller_id.department.name` | valid, 3 hops, resolves to `cmn_department.name` |

### Three measurements that changed the implementation

**`sys_dictionary.reference` holds the table NAME, not a sys_id.** The raw cell
is `{value: "sys_user", display_value: "User"}`. So "every field referencing
sys_user" is one query on `reference=sys_user` rather than a lookup and then a
query.

**`super_class` holds a sys_id.** Walking UP can dot-walk `super_class.name`;
walking DOWN needs the parent's sys_id. `task` has 47 direct children.

**`sys_dictionary_override` values are inert without their flags.** Each
attribute has both a value and a `<attr>_override` boolean, and real rows carry
`mandatory: "false"` / `read_only: "false"` with every flag false — a record
that overrides nothing. Reading the values alone reports configuration that is
not in effect, so `shapeOverride` returns only flagged attributes and counts the
rest as `inertOverrideRows`.

### `dba.listIndexes` is the one Layer 1 tool that cannot be completed

It looked like the easiest. Every candidate source was probed, server-side where
REST refused:

| source | result |
|---|---|
| `sys_index` over REST | 403 `Failed API level ACL Validation` |
| `sys_index` server-side | readable — and **33 rows instance-wide**, none for `incident`, `task` or `sys_user` |
| `sys_index_ii` | 400 Invalid table — absent |
| `v_db_index` | 0 rows: REST and server-side, filtered and unfiltered |
| `v_index_creator` | 0 rows server-side |
| `GlideTableDescriptor('incident').getIndexes()` | `undefined` — no such method |

`sys_index` extends `sys_metadata`: it is a table of index **definition
records** (the 33 are plugin-shipped CMDB ones), not a catalogue of the physical
indexes the platform maintains. Nothing reachable on this instance enumerates
those.

Every table has at least a primary key, so `count: 0` would be a confidently
wrong answer indistinguishable from a real empty. The tool therefore never
claims completeness: it returns `complete: false` always, and on an empty result
returns a `zeroMeans` field saying in words that this is "no index DEFINITION
RECORD", not "no indexes", and pointing at System Definition > Database Indexes.
Verified both ways — `incident` returns 0 with the disclaimer, and
`cmdb_ci_endpoint_app` returns its 3 real definition records with `zeroMeans:
null`.

### Two defects the guards caught in their own author

Both were written into this module and both failed loudly rather than silently,
which is the entire argument for the Phase 0 guards:

1. `sys_number.maximum` does not exist; the column is `maximum_digits`.
   `assertFieldsHonoured` threw a 502 naming the column. Without it, `maximum`
   would have been `undefined` on every auto-number report — a field-shaped
   nothing.

2. `sys_relationship` uses `apply_to` / `query_from`, **not** `applies_to` /
   `queries_from`, which is what the plural label suggests and what was written
   first. This one is worse than a wrong field list: an encoded query on an
   unknown field is silently DROPPED (trap #2), so
   `applies_toIN…^ORqueries_fromIN…` degrades to *no condition at all* and would
   have returned every relationship on the instance as though each applied to
   the table asked about. Caught by re-reading the measured column list, and now
   held by the field guard.

### A third defect, found by running it: the map fanned out instance-wide scans

`generateSchemaMap` first called `getTable` + `getReferences` per node. Both are
correct and both are catastrophic here: `getReferences` runs an instance-wide
inbound scan (`sys_user` alone is 3,999 rows over four pages), and at depth 1
`incident` has 24 outbound targets. That is ~25 full-instance scans for a graph
that needs none of them, and it ran past two minutes without finishing.

A map edge only ever needs OUTBOUND references, which come from the node's own
chain. Classification is now read once, for the root. With `tableRow` and
`chainDictionary` memoised, depth 1 on `incident` returns 43 nodes and 201 edges
well inside the timeout.

### Cost

Tool schemas grew from **11,759 to 13,732 estimated tokens** (51 → 64 tools),
about 152 tokens per new tool. That is a 17% rise in fixed overhead, which
matters on the constrained model this project is pinned to — descriptions were
written tight for that reason, keeping only the load-bearing warnings
(`listIndexes` partiality, `resolveIdentifier` refusing a bare sys_id,
`getReferences` truncation).

### What ships

`server/src/servicenow/dba-schema.js`, thirteen read-only tools
(`dba_get_table`, `dba_list_fields`, `dba_get_field`, `dba_get_hierarchy`,
`dba_get_references`, `dba_resolve_reference`, `dba_dot_walk`, `dba_classify`,
`dba_resolve_identifier`, `dba_list_choices`, `dba_get_relationships`,
`dba_list_indexes`, `dba_schema_map`), and 8 offline tests over the two pure
verdict functions. `npm test` — **999 pass, 0 fail**.

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 99 | **`sys_index` is a metadata table, not an index catalogue** | `listIndexes('incident')` returns zero and looks like an answer | It extends `sys_metadata` and holds only explicitly-defined index records — 33 instance-wide, none for the common tables. No reachable source enumerates physical indexes (`v_db_index`/`v_index_creator` are empty even server-side, `GlideTableDescriptor.getIndexes` does not exist). Every table has a primary key, so a zero here can never be reported as "unindexed" |
| 100 | **`sys_relationship` is `apply_to`/`query_from`, singular** | a relationship query that returns every relationship on the instance | The plural reading is the natural one and it is wrong. An encoded query on an unknown field is DROPPED, not rejected (trap #2), so the wrong name widens the query to everything instead of narrowing it to nothing — which reads like a table with a great many relationships |
| 101 | **A `sys_dictionary_override` value is inert without its `_override` flag** | a child table appears to make a field mandatory, and the form disagrees | Every attribute is a pair: `mandatory` and `mandatory_override`. Rows exist carrying values with every flag false. Report only flagged attributes; count the rest as inert |
| 102 | **A graph walk that calls a scan per node** | a schema map at depth 1 that never returns | `getReferences` is instance-wide (3,999 rows for `sys_user`). An edge needs only the node's own outbound refs. Check what a traversal actually reads before letting it fan out — 24 targets turned one cheap question into 25 full scans |

---

## 40. Database Administration — Phase 2, Impact & Safety

There is no out-of-the-box "what breaks if I change this?" API. Phase 2 builds
one, and the shape of the build is dictated by that absence: the answer is only
as good as the list of artifact tables scanned, so the registry is declarative,
every finding names the column it matched on, and **every report states what it
could not see**. A dependency report that lists its hits and stays quiet about
its blind spots is the most dangerous artifact in this whole module, because it
reads as exhaustive.

This closes the read-only v1. Layers 1 and 2 ship with zero destructive
capability, exactly as §2.2 requires.

### Impact, measured on dev428633

`incident`, table-level — **481 dependents**:

| severity | what | count |
|---|---|---|
| structural | inbound reference fields | 79 |
| high | ACLs 112, business rules 39, client scripts 24, UI policies 15, data policies 1 | 191 |
| medium | form sections 44, UI actions 25, lists 20, forms 8, transform map 1 | 98 |
| low | reports 72, notifications 24, filters 14, templates 3 | 113 |

`incident.caller_id`, field-level — 29: 11 field ACLs, 10 form placements, 4
client scripts, 2 UI policy actions, 1 business rule, 1 label.

**Trap #17 is load-bearing here, not a footnote.** `nameSTARTSWITHincident`
matches `incident_task`, `incident_task.state`, `incident_task.close_notes` — a
naive prefix scan reported **155** ACLs for incident where the true figure is
**112**. Every table-scoped match in this module is exact (`name=incident`) or
exact-plus-dot (`nameSTARTSWITHincident.`), never a bare prefix.

### The blind spots are published with every report

Flow Designer is the big one and it is structural, not an oversight: a flow's
trigger table is a gzip+base64 blob inside
`sys_hub_trigger_instance_v2.trigger_inputs` (trap #11), not a queryable column,
so flows cannot be matched by table with any query. Also declared: dynamically
constructed table/field names, scoped artifacts this credential cannot read, and
everything outside the instance. Field mode adds one more — text matches on a
column name are heuristic, since the name can appear in a comment, an unrelated
string, or as a dot-walk on another table.

### The matrix is the default; the instance is the answer

`classifyOperation('record_delete')` first returned `reversible: true` — which
is what §1.5 says, and wrong here. The live verdict on this instance is
`partial` (captured by Delete Recovery, not restorable without
`com.snc.undelete`). The prose was correct while the flag was not, and any
consumer reading the flag alone would have got the opposite of the truth: the
two-state rounding the three-state verdict was built to prevent, reintroduced
one layer up.

Engine-dependent operations now overwrite the flag with what the instance
supports and report the divergence explicitly:

```
reversible:          "partial"
reversiblePerMatrix: true
matrixDivergence:    "The rollback matrix says true, but this instance
                      supports \"partial\". The instance wins."
```

Irreversible DDL is unaffected by any of this — no engine makes a drop
recoverable, and the offline suite asserts that all eight of those operations
say "CANNOT be undone … on any database engine" in words, carry a reason, and
demand all three §2.4 confirmations.

### A category error the acceptance run caught: schema rules applied to data

`preflight({ operation: 'record_delete', table: 'incident' })` returned three
blockers, one of which was *"incident is a platform table. Never edit an
out-of-scope object directly…"*.

That statement is about changing the table's SCHEMA. Applied to deleting a
record it is a category error, and a load-bearing one: every useful table on a
PDI is OOTB, so a preflight that raised it for data would block every record
operation NHA will ever be asked to perform — and **a gate that always says no
is a gate that gets bypassed**. The same applied to structural dependents:
79 inbound reference fields matter enormously when the column is going away, but
for one record delete the question is which rows point at that row, which is a
per-record check belonging to Layer 4.

Every operation now declares `acts_on: 'schema' | 'data' | 'platform'`, and the
schema-only blockers are gated on it. Verified after the fix:

| preflight | verdict | blockers | confirmations |
|---|---|---|---|
| `drop_column` on `incident.caller_id` (schema, OOTB) | no-go | 2 | 3 (impact-ack, snapshot, typed phrase) |
| `drop_column` on a `u_` table (schema, custom) | no-go | 1 — irreversibility only | 3 |
| `record_delete` on `incident` (data) | no-go | 1 — the partial-recovery divergence | 2 (preview, confirm) |

The custom-table row is the one that proves the gate discriminates rather than
just refusing everything.

### checkIntegrity is bounded, and says so

Mandatory-empty, unique-duplicate and orphaned-reference checks, each capped at
a sample (500 rows by default, 100 distinct values for reference checks).
`incident` returns `clean-within-sample` over 10 checks. The verdict is worded
that way deliberately: a diagnostic that silently sampled and reported "clean"
is worse than no diagnostic, and one that scans a production table to exhaustion
gets switched off.

Worth stating because it surprises people: mandatory is enforced on the FORM,
not in the database, so historic rows routinely violate it. An empty mandatory
column is a finding about data, not proof of a broken dictionary.

### `dba_audit` records an assertion and does not dress it as a verification

It writes through the existing `mutation_ledger` — no second audit store — and
stamps every entry `status: 'unverified'` with `note: "Recorded as reported by
the caller; no read-back was performed by this tool."` The ledger's other
statuses are earned by an actual field-by-field read-back, and letting a
self-reported entry sit beside them unmarked would devalue every honest row in
the table.

### Cost, and the running total

Tool schemas: **13,732 → 14,860 estimated tokens** (64 → 69 tools). Across all
three phases the DBA module adds 20 tools and about 3,100 estimated tokens of
fixed overhead.

`npm test` — **1015 pass, 0 fail**.

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 103 | **A static rollback matrix outliving the instance it describes** | `reversible: true` on a record delete that nothing on the instance can restore | The documented matrix is a DEFAULT, not an answer. Where an operation's reversibility depends on engine or plugins, overwrite the flag with the live verdict and publish the divergence — prose saying one thing while a boolean says another is worse than either alone |
| 104 | **Schema rules applied to data operations** | "never edit this platform table directly" blocking an ordinary record delete | Every useful table on a PDI is OOTB, so this blocks everything and the gate gets routed around. Tag each operation with what it acts on and gate schema rules on that |
| 105 | **A dependency report that does not publish its blind spots** | a clean impact report for a table that three flows depend on | Flow triggers are a gzip blob (trap #11) and are unqueryable by table; dynamic names are unfindable by any search. List what was scanned AND what was not, in the report itself, every time |
| 106 | **A bounded check reporting an unbounded verdict** | "clean" from a diagnostic that looked at 500 of 400,000 rows | Say `clean-within-sample` and state the bound. A diagnostic that scans everything gets turned off; one that silently samples gets believed |

---

## 41. Database Administration — Phase 3, Schema Authoring (scoped-scratch)

Phase 3 was deliberately scoped to a custom table in our own application: no
OOTB table was touched, and the augment path is generated and build-checked
only, never deployed. What the phase actually produced is a working authoring
pipeline, three SDK facts the docs did not supply, and **one finding that
invalidates part of every live result in this document**.

### The finding: the SDK and the Table API were bound to DIFFERENT INSTANCES

```
REST / Table API   server/data/settings.json      dev428633.service-now.com
SDK  / now-sdk     credential alias "snada-pdi"   dev442675.service-now.com
```

The PDI was replaced at some point and only `settings.json` was moved. So the
end-to-end run did this:

```
[  0.0s] dba_preflight        name is free on dev428633 — true, and irrelevant
[  1.1s] dba_source_written
[  1.1s] dba_building
[ 36.3s] dba_installing       now-sdk install → SUCCESS, real activation
[177.2s] dba_verifying
         → "The install reported success but no sys_db_object row named
            x_2196302_nwforge_asset exists. The table was NOT created."
```

Every layer behaved correctly. The build was valid — `dist/` contains the
dictionary XML, six `sys_dictionary` rows, the `sys_choice` set and the
`sys_documentation` labels. The install genuinely succeeded. The table genuinely
exists. It is simply **on dev442675**, and the read-back runs against
dev428633, where there is no table and — the confirming detail — **no
`sys_update_xml` rows either**. Corroborated independently: the `lastInstall`
record in `server/data/fluent-state.json` from 2026-08-20 carries
`rollbackUrl: https://dev442675.service-now.com/...`. The SDK tier has always
pointed there.

This is the most expensive shape of confidently-wrong this repo has hit, because
it is not a bug in either tier and **neither tier can detect it alone**. The
REST half sees a table that does not exist. The SDK half sees a successful
install. Only comparing the two hostnames reveals it, and nothing was comparing
them.

It also means: **§8's "Phase 1 proof — what is live right now", and every other
live SDK claim in this document written before 2026-08-31, describes dev442675,
not the currently bound instance.** The Table-API measurements in §38-§40 are
dev428633 and are unaffected.

#### The guard

`assertTiersAgree()` refuses the install, with both hostnames and the alias
named:

> REFUSING TO INSTALL: the two halves of NowHelpAssist are bound to DIFFERENT
> INSTANCES. The Table API reads and verifies against "dev428633.service-now.com"
> (server/data/settings.json), but the ServiceNow SDK would install to
> "dev442675.service-now.com" (credential alias "snada-pdi"). An install would
> succeed, report activation, and put the artifacts on the other instance —
> where the read-back cannot see them.

It runs **after** the offline build (so it does not reject specs that were never
going to install) and **before** the install (because the install is the thing
that becomes untrue). It throws rather than warns.

⚠️ **The same exposure exists in `fluent.js deploy()`**, which every flow, SLA
and catalog-policy install goes through. That path is untouched by this phase
and still installs without checking.

### Three SDK facts the docs did not supply

Read off `node_modules/@servicenow/sdk-core/dist/db/Table.d.ts` in this
workspace, on the pinned 4.10.1 — not from the docs site, not from memory.

**1. The Table must be a NAMED EXPORT whose name equals the table's.** The first
generated source emitted a bare `Table({...})` and the build refused it:

```
TS213: Table definition should be exported as a named export with the name
       'x_2196302_nwforge_asset'
```

This is precisely what the offline build is for (§5: build is free and reaches
nothing), and why nothing installs before one passes. The failed build also
removed its own generated source, verified — a failed authoring attempt
provably leaves nothing for the next install to pick up.

**2. `index` IS available on 4.10.1** — as a Table *option*,
`index: [{ name?, unique, element }]`, not a separate `Index()` artifact. The
runbook said to verify Index support and fall back to guided platform steps if
absent; no fallback is needed for index CREATION.

**3. `augments` is available on 4.10.1** too, so the table-augments pattern for
OOTB tables exists on this version. It is generated here and **not proven** —
labelled as such in the code rather than presented as working.

### The pipeline

`spec → validate → preflight → generate → build (offline) → tier check → install
→ read back → report`. Nothing in it is model-generated: a table spec is
structured input and the Fluent source is DERIVED from it in code, which is why
17 offline tests can assert the emitted source exactly rather than sample it.

Spec validation front-loads the rules the SDK and platform enforce later and
more obscurely: the 30-character name cap (reported with how much room the scope
prefix actually leaves — 12 characters here), the scope prefix, unsupported
column types, a reference column with no target, a choice column with no
choices, a display column that is not in the schema, duplicate columns.
`allowWebServiceAccess` defaults **on**, because §1.7's 403-with-correct-ACLs is
otherwise indistinguishable from a permissions problem, and because a table NHA
cannot read back is a table NHA cannot verify it created.

`$id` keys are namespaced by the table name (trap #1). Confirmed in the build
output: all 199 new lines in `generated/keys.ts` sit under
`x_2196302_nwforge_asset*`, with no bare keys and no collisions.

### One defect in the validator, caught by its own negative tests

The name regex was `^[a-z][a-z0-9_]*[a-z0-9]$`, which requires at least TWO
characters — so a legal single-letter column was rejected as "not a valid column
name", and that message then **masked every other error in the same spec**.
Three negative test cases were all reporting the wrong cause. Fixed to
`^[a-z]([a-z0-9_]*[a-z0-9])?$`; each case now names its real problem.

### Status

The pipeline is proven up to and including a valid offline build and a
successful install; the read-back is proven to work by correctly refusing to
confirm a table that is not there. **End-to-end verification against the bound
instance is NOT done** and cannot be until the SDK is repointed at dev428633.
The generated source and `keys.ts` are kept: they match what is actually on
dev442675, and deleting them would create a drift instead of removing one.

`npm test` — **1032 pass, 0 fail**. 22 DBA tools, exactly one mutating.

### Trap ledger additions

| # | trap | what it looks like | how to not be fooled |
|---|---|---|---|
| 107 | **Two tiers bound to different instances** | `now-sdk install` reports success with real activation, and the artifact is absent from every read-back | NHA binds to "the instance" twice — `settings.json` for REST, a stored SDK credential alias for the CLI — and nothing keeps them in step. Replace a PDI and update one, and every install lands on the old one, correctly, forever. Neither tier can see this alone: compare the two hostnames before installing, and refuse |
| 108 | **A Fluent Table must be a named export matching its own name** | `TS213` naming a table you did define | A bare `Table({...})` compiles as far as the type checker and is rejected by the build. `export const <table_name> = Table({...})`. Cheap to hit, free to catch — the offline build is the reason it never reached an instance |
| 109 | **A validator regex that quietly requires two characters** | three unrelated negative tests all reporting "not a valid column name" | `^[a-z][a-z0-9_]*[a-z0-9]$` has no single-character match. The wrong error did not just fire — it MASKED the real ones, so the spec's actual problems were invisible. Make the tail optional, and check that each negative case reports the cause you meant to test |
