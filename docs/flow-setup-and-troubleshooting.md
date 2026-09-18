# Flow authoring — setup, and what to do when it says it failed

Hand this to anyone who needs flow creation working on their machine. It takes about
ten minutes, most of it waiting for `npm install`.

---

## 1. Set it up

```bash
# 1. Node 20 or newer                        https://nodejs.org
node --version

# 2. The ServiceNow SDK, globally
npm install -g @servicenow/sdk
#    then REOPEN the terminal so PATH picks it up
now-sdk --version          # expect 4.10.1 or newer

# 3. Server dependencies
npm install --prefix server

# 4. Fluent workspace dependencies  (this is the one people forget)
npm install --prefix server/fluent-workspace

# 5. Instance type definitions — what makes `incident` a table the build knows
cd server/fluent-workspace && now-sdk dependencies && cd ../..
```

Then set the instance in the app's **Settings** page: instance URL, username, password.
Nothing is read from a `.env` file, and the SDK's own stored credential alias is ignored —
the SDK binding is derived from that Settings entry on every invocation.

## 2. Check it, before you need it

```bash
npm --prefix server run doctor
```

Twelve checks, each naming the exact command that fixes it. `--quick` skips the live
instance probe:

```bash
node server/scripts/flow-doctor.mjs --quick
```

Do not start a demo without seeing `Ready to author flows.`

---

## 3. "The flow could not be built because the SDK install timed out"

**Read this before retrying. The install has probably succeeded.**

The SDK waits for the deployment with a hard-coded 300-second abort
(`AbortSignal.timeout(options.timeoutMs ?? 300000)` in `sdk-api/dist/connector.js`). There
is **no flag, no environment variable and no config key** that changes it — `now-sdk
install --help` lists none, and nothing in the SDK reads one. So on any instance where the
deployment takes longer than five minutes, the CLI gives up and exits non-zero **while the
server carries on and finishes the install.**

Measured on dev424910 on 17 Sep 2026: three consecutive installs each reported
`The deployment request timed out waiting for a response`, and **all three had completed** —
eleven artifacts, every one correct on the instance.

**What the code now does about it.** `deploy()` fingerprints the artifact before the
install and, when the install reports failure, polls the instance for up to five minutes.
If the artifact appeared, or its `sys_updated_on` moved, the deploy is reported as the
success it was, with `installReported: 'failed'` kept beside it so nothing is hidden. If
nothing changed, it says so. If the instance could not be read at all, it says *that* —
"we could not look" is never reported as "it is not there".

**If you still see a timeout failure**, check in this order:

1. **Is the artifact actually there?** This settles it in seconds:
   ```bash
   node server/scripts/flow-readback.mjs "Your Flow Name"
   ```
   If it prints the flow with its trigger and actions, the install worked. Publish it and
   carry on.
2. **Is the PDI awake?** Log into it in a browser. A hibernating PDI makes every request slow.
3. **Is another install running?** Installs are serialized; a queued one waits.
4. Only then retry the build.

---

## 4. "The existing source file X collides with a prior request"

This is not a failure of the build — it is a refusal to guess. A flow already exists whose
name produces the same source file, and it came from a *different* request.

- **To change that flow**, re-run with `updates` set to its exact name. The error message
  now names the value to use. Editing in place keeps the same `sys_id` and the same element
  keys, which is what makes it an update rather than a duplicate.
- **To create a separate flow**, give this one a different name in your request.

Get exact names with `list_live_flows`, or:

```bash
node server/scripts/flow-readback.mjs "Some Flow Name"
```

---

## 5. Publishing is a separate step from installing

An installed flow is a **draft**. It will never run until it is published.

- Publish one artifact through the agent's `activate_flow` tool, by exact name.
- Publishing takes **90–100 seconds** per artifact. That is the platform, not us.
- **An install reverts every published flow to draft.** The reconciler re-publishes
  anything recorded as meant to be live and reads it back, but this is why publishing is
  the *last* step before a demo, not the first.

---

## 6. Scoped vs global — what actually works

The application installs into its own scope (`x_2002152_nwforge`). Flows in it can and do
read and write **global** tables: the app holds cross-scope privileges for `incident`
(Read + Write) and `sys_user_group` (Read), and every `lookUpRecord` / `updateRecord`
against those tables is verified working.

**One caveat, and it matters for a demo.** A record-triggered flow in our scope, on the
global `incident` table, has **never been observed firing** on this PDI. Publishing and
structure are correct; the trigger simply does not fire. It is not a permissions problem
(the privileges are present and `Allowed`) and not the `access` field (ours is `public`,
same as the OOTB flows that do fire). The cause is unresolved.

**So for a live demo, show one of these, which are proven to execute:**

- a **scheduled** flow, or
- a **subflow** invoked through the execution harness (`sn_fd.FlowAPI`), or
- the **authoring** story itself: spec → generated Fluent → build → install → live records
  → publish → read-back, which is fully verified end to end.

Do not stake a demo on a record trigger firing on a global table.

---

## 7. If code generation itself fails

The default provider is Ollama (`gpt-oss:120b-cloud`), which is free and the weakest at
Fluent. If generation keeps failing, switch to Anthropic or OpenAI in Settings — it is the
single biggest lever.

A generation cut off by the token budget now fails with a message that says so, rather
than handing a half-written file to the compiler. The ceiling is `CODEGEN_MAX_TOKENS` in
`server/src/servicenow/fluent.js` (currently 20000).

---

## 8. The commands worth knowing

```bash
npm --prefix server run doctor                        # is this machine ready?
npm --prefix server test                              # the full offline suite
node server/scripts/flow-readback.mjs "Flow Name"     # what the instance really stored
node server/scripts/flow-e2e-matrix.mjs               # the end-to-end matrix, PASS/FAIL
```

All four are read-only except `npm test`, which touches nothing outside the repo.
