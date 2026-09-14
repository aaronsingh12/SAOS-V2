# NowHelpAssist — Agentic ServiceNow Studio

Connect a ServiceNow PDI and build on it two ways: through clean module UIs, or by telling an AI agent what you want and approving each change it proposes. Bring your own model — Anthropic, OpenAI, or fully-local Ollama. No Now Assist SKUs required.

**Scope (this build):** PDI connection · Incident Management (full CRUD) · Catalog Management (items, all variable types with choices, inline variable editing and reordering, **catalog UI policies**, variable sets, order guides, record producers) · Flow Designer (full read, executions, activate, **live authoring of real flows and subflows via the ServiceNow SDK**, AI blueprint design + classic fallback) · **SLA definitions** (read, create, and semantic verification of the breach clock) · **Access control** (ACL report, two-role diff, plain-language explanation — read-only) · **Health Assist** (CMDB, ITOM and ITSM estate health behind one switch: 25 allow-listed tables, a deterministic rule pack over seventeen domains, a score per area, coverage reported beside every finding, and AI remediation that proposes but cannot apply without your approval) · **Audit** (everything the agent and the module pages did to the instance, with sys_ids, approvals and CSV export) · deep reference-field/table handling everywhere · agentic chat with a human approval gate on every mutation, and markdown-rendered replies.

---

## Quickstart

Requirements: **Node 22.5+** (tested on 24.18), a ServiceNow PDI (free at
developer.servicenow.com), and an LLM — an Anthropic/OpenAI API key or local
Ollama.

> 22.5 is not a preference. The whole storage layer is built on `node:sqlite`
> (`DatabaseSync`), which landed in 22.5.0; on anything older the server dies at
> its first import with `ERR_UNKNOWN_BUILTIN_MODULE`. It is declared in
> `engines` so npm warns rather than letting you find out that way.

```bash
npm install --prefix server
npm install --prefix client

# Both halves, one terminal. Ctrl+C stops both.
npm run dev
```

That starts the API on **:4000** and the React client on **:5173**, prefixes
each line with which half wrote it, and prints a loud `API │ …` line if the
server ever stops answering.

<details>
<summary>Two terminals instead</summary>

```bash
# Terminal 1 — API server on :4000
cd server && npm install && npm run dev

# Terminal 2 — React client on :5173
cd client && npm install && npm run dev
```

Both are needed. The client proxies `/api` to `:4000`, so starting only the
client gives you a working page whose every request fails — vite reports that
as `http proxy error … ECONNREFUSED`, which names neither this app nor the
missing process. The single `npm run dev` above exists to make that
unreachable.
</details>

Open http://localhost:5173 and then:

1. **Dashboard** → enter your PDI URL + admin credentials (basic auth is fine for a PDI) → Save → Test connection.
2. **Settings** → pick your LLM provider, paste the API key (or point at Ollama), save.
3. **Agent** → try: *"Create a Laptop Request catalog item with 6 variables including a reference to sys_user."* Watch it inspect schema, resolve references, then stop at the amber approval card before writing anything.

Credentials live only in `server/data/settings.json` on your machine (gitignored).

### Enabling live flow authoring (optional)

Everything above works without this. To let NowHelpAssist build *real* flows, install ServiceNow's SDK and give it a credential:

```bash
# 1. the CLI (Node 18+)
npm i -g @servicenow/sdk

# 2. one stored credential — piping the password keeps it non-interactive
echo "$SN_PASSWORD" | now-sdk auth --add https://devXXXXXX.service-now.com \
    --type basic --alias nowhelpassist --username admin --password-stdin

# 3. workspace dependencies + instance type definitions
npm install --prefix server/fluent-workspace
cd server/fluent-workspace && now-sdk dependencies
```

The Flows page shows a green banner when this is ready, and the exact fix commands when it isn't. `GET /api/flows/live/capability` returns the same detail (add `?deep=true` to actually round-trip the instance instead of just reading the local credential store).

**On the scope name:** the deployed application is still scoped
`x_2196302_nwforge` and named "NowForge Flows" — that is an address on the
instance, not a label, and renaming it in source would install a *second*,
empty application rather than rename the existing one. Same for the
`// nowforge-spec:` markers that match a request to its already-deployed
source. See `docs/fluent-research.md` §25 for the full list of what was and
was not renamed, and why.

**On credentials:** the SDK keeps its own credential store, addressed by alias — it does **not** read `server/data/settings.json`, and there is no `.env` anywhere in this project. For CI, skip the stored alias and export `SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL`, `SN_SDK_AUTH_TYPE`, `SN_SDK_INSTANCE_URL`, `SN_SDK_USER`, `SN_SDK_USER_PWD` (or the OAuth pair) instead. Note that `keys.ts` — despite living under a docs page called "keys file" — is a **sys_id map, not credentials**; commit it.

Because the SDK and NowHelpAssist authenticate separately, they can point at different instances. The capability banner warns you when they do, since flows would deploy somewhere other than the instance you're reading.

---

## The modules

### Incidents
Full CRUD against the `incident` table. The editor is schema-driven: state/priority/impact/urgency/category choices are pulled live from `sys_choice` through the inheritance chain, and caller, assignment group, and assignee are real reference pickers that typeahead against `sys_user` / `sys_user_group` and store sys_ids. Work notes append on update. Stats chips use the Aggregate API.

### Catalog
Four tabs covering the catalog stack top to bottom:

- **Items & variables** — create items (with category/catalog), then add variables of any type. Choice types (Multiple Choice, Select Box, Lookup) take a one-per-line choices editor that writes `question_choice` rows. Reference (type 8) and List Collector (21) take a live table picker. Variables render with type labels, mandatory flags, and reference targets.
- **Variable sets** — create `item_option_new_set` records, add variables to them, attach sets to items via `io_set_item`.
- **Order guides** — create guides (`sc_cat_item_guide`, two-step supported) and manage rule-base entries.
- **Record producers** — create `sc_cat_item_producer` with a target-table picker and mapping script. Producers are catalog items, so a producer row links straight into the item view.

The item view itself has three tabs:

- **Variables** — add them, edit them in place (question text, order, mandatory, help text, default), reorder with buttons that renumber the whole list server-side and read every row back, and manage choices on choice-type variables. Editing in place matters: a recreated variable gets a new sys_id, and every UI policy naming the old one keeps the reference and silently stops matching.
- **UI policies** — a builder that reads as a sentence: *when `<variable>` is `<value>` then `<variable>` visible / mandatory / read-only*. Choice-aware — the value control becomes a dropdown of the variable's real choices as soon as you pick a variable that has any, so the commonest way to write a condition that can never be true (comparing a select box against its display label instead of its stored value) is not reachable from the form. Existing policies render the same way, with a badge separating the ones NowHelpAssist authored from the platform's own.
- **Variable sets** — attach and inspect.

**Why creating a UI policy takes about a minute.** `catalog_ui_policy_action` cannot be written over REST at all on this platform: a POST returns 201 and silently discards `ui_policy` and `catalog_variable`, the two fields that attach the action to its policy and to its variable. The cause is a field ACL granting only the role `nobody` with `admin_overrides` off — and the Table API drops a field the caller may not write rather than refusing. So policies are authored through the ServiceNow SDK, exactly as flows are and for exactly the same reason, and the result is read back to confirm every action landed attached. See `docs/fluent-research.md` §23.

### Flows
- **Read everything:** flows *and subflows* from `sys_hub_flow`, trigger instances, ordered action instances, logic blocks, and execution history from `sys_flow_context`. Activate/deactivate with one click. Trigger configuration (table, condition, run-in) is decoded from the platform's compressed `trigger_inputs` blob, because current releases keep none of it in columns.
- **Live build (the real thing):** type an automation in plain language → NowHelpAssist generates Fluent TypeScript, compiles it **offline**, installs it, and reads the result back. You get an active flow with its sys_id and a link, or a readable compile error and nothing on the instance.
- **Subflows are first class.** Pick **Subflow** in the Live build card (or pass `artifact_type: "subflow"` to the agent) and describe a reusable unit with named inputs and outputs. What comes back has a real **contract** — input names, types and reference tables — parsed from the source and read back off the instance, shown side by side so a drift is visible rather than assumed away. Before the build, four contract rules are enforced: a subflow may not have a trigger (the platform would store it as a flow), it must be exported, every declared input must be read, and every declared output must be assigned.
- **Reuse, not regeneration.** Existing subflows are injected into the codegen prompt with their contract, their description and a filled-in call. A candidate that re-creates one — same name, or same input set — is rejected before the build, with the existing one named.
- **Semantic verification:** press **Verify** and NowHelpAssist fires the flow on a real record, asserts the effects your sentence promised, and deletes the test data. Compiling proves a flow is well-formed; this proves it is *correct*. A **subflow** has no trigger, so it is *called* instead: a one-shot scheduled job invokes it through `sn_fd.FlowAPI` with the spec's test inputs, and both its effects on records and the values it **returns** are asserted. The job and its result row are deleted and read back. See [docs/demo.md](docs/demo.md) for a five-minute walkthrough, and `docs/fluent-research.md` §32 for the measurements behind the harness.
- **Dependency safety:** every managed artifact carries `calls` and `calledBy`. Deleting a subflow a live flow still calls is refused, with the callers named — deleting it would leave their sources untouched, so the build would stay green and every execution would fail at the subflow step.
- **Design with AI:** describe an automation → a precise blueprint (trigger, exact actions, configs, reference fields, test plan). Download it, or hit **Deploy as real flow** to feed it straight into the live pipeline.
- **Classic fallback:** where the SDK can't run, record-triggered blueprints still become an equivalent **Business Rule** (`sys_script`), always created **inactive** for review.

#### How live authoring works

```
plain-language spec
        │
        ├─► extract intent ─────────────► trigger table, artifact kind, proper nouns
        │
        ├─► LIVE CONTEXT from the instance
        │     getSchema(table)      real field names, types, reference targets,
        │                           and choice VALUE=LABEL pairs
        │     referenceLookup(name) real sys_ids for every named group/user/category
        │
        ├─► LLM ──► Fluent TypeScript          (cheatsheet + hard rules in the prompt)
        │
        ├─► now-sdk build          OFFLINE. Compile errors never reach the instance.
        │     └─ on failure: feed the compiler's own diagnostics back, retry (max 3),
        │        then delete the candidate and rebuild so src/ stays clean
        │
        ├─► now-sdk install        serialized; deploys the WHOLE managed app and
        │                          auto-activates flows
        │
        ├─► read back via flows.detail()  ──► {sys_id, type, active, link, counts}
        │
        └─► VERIFY (never automatic — its own button, its own approval)
              setup   create a record matching the flow's own trigger
              wait    poll sys_flow_context until the execution settles
              assert  check the effects the request promised
              resume  for approvals: patch the approval, wait, assert again
              cleanup always, in a finally
```

Two properties worth knowing:

- **`now-sdk install` deploys the entire managed application**, not one file. Every response lists what shipped. A build-verified source you *don't* want deployed goes in `server/fluent-workspace/staged/`, outside the scanned `fluentDir`.
- **Identity is stable.** Each artifact gets a deterministic filename and a `Now.ID` key recorded in `keys.ts`, so regenerating the same spec updates the same record instead of creating a duplicate. Deleting a managed flow removes its source — which is the SDK's own deletion mechanism — reinstalls, and confirms absence by read-back.

### SLA

SLA definitions (`contract_sla`) with the two behaviours that make this table
quietly dangerous handled up front rather than explained afterwards.

- **Create and edit definitions** — table, start/stop/pause conditions as encoded queries, duration, relative-duration type, schedule, retroactive flag, with schedules and relative durations read live off the instance.
- **Conditions are field-checked before the write.** A start condition naming a field that does not exist is not rejected by the platform, it is *dropped* — so `active=true^prioritee=1` becomes `active=true` and the SLA attaches to every active record on the table. NowHelpAssist refuses before anything is written, and a **Check conditions** button runs the same check with no write at all.
- **An inert schedule is called out where the mistake is made.** A schedule is ignored unless `schedule_source` is `sla_definition`. Measured on this instance: two definitions identical but for that field, same 4h duration — **4.00h** elapsed against **7.84h**.
- **Every write is read back field by field**, because unknown fields are accepted and discarded. The response carries `mismatches[]`, not "saved".
- **Verify** creates a record derived from the definition's *own* start condition, asks the platform whether the stored record really satisfies it, asserts the `task_sla` that attaches, and deletes the record again with a read-back. Its own button, its own approval — it writes real data.

Available in the UI and to the agent, where `create_sla` and `verify_sla_live` are mutating and hit the amber gate.

### Access

An ACL reader and explainer. Deliberately **no authoring** — an ACL is the one artifact class where a confidently wrong write is a security incident rather than a bug, so there is no tool to create one and the agent is told not to simulate one through `create_record`.

- **Report** — record and field ACLs across the whole inheritance chain, each with operation, roles, condition, active flag, `admin_overrides`, `decision_type`, security attribute, and whether a script guards it (presence only; the script is never claimed to have been evaluated). Plus an operation × role matrix.
- **Two-role diff** — which rules name each role, per operation and per field.
- **Explain in plain language** — the structured report through your configured model, read-only, labelled AI-generated at the API boundary and again in the UI.

Two honesty properties do most of the work here. An empty result is never rendered as an answer: the report carries a `visibility` of `full` / `empty` / `restricted` / `error`, because `sys_security_acl` is itself ACL-protected and *"you cannot see the rules"* and *"there are no rules"* look identical in an empty table. And the diff states, above the grid, that it compares what the rules **say** rather than what a role can do — the platform evaluates every matching ACL at each level, and a field ACL, condition or script can deny what a table-level row appears to allow.

### Health Assist

Estate health over the connected instance. Reads 25 allow-listed tables, runs a
deterministic rule pack across seventeen domains — CMDB quality, relationship
integrity, CSDM completeness, customisation, integration, performance, upgrade,
security hygiene, MID servers, event binding, **Discovery, credentials, service
mapping and availability** — and reports findings carrying the records each one
was derived from.

**Detection is read-only by construction.** The router does not import the
ServiceNow client, nothing under `health/` calls a write method, and the rule
pack imports nothing at all — each asserted by a test rather than left as a
promise. Remediation does change the instance, but only ever through the
ordinary plan executor after you approve it, so the gate, the read-back and the
audit trail are the same ones every other write in this app goes through.

The part that does the real work is **coverage**. Every table comes back with an
account of how completely it was read, and three things follow from it:

- **Absence rules only run on complete coverage.** "This CI has no
  relationships" is a claim about everything that was *not* found, so on a
  partial read the rule does not run — and says so by name, with the reason.
  Partial extraction plus an absence rule is how *"we could not read the table"*
  becomes *"your CMDB is broken"*.
- **The quality score is withheld** unless `cmdb_ci` and `cmdb_rel_ci` were both
  read completely. A partial relationship read inflates orphan findings and
  would score our own access rather than the estate, so the page prints the
  reason instead of a number.
- **A table absent on this instance and one this account may not read are
  different problems**, and the coverage chip says which.

Measured live on dev424910: 300 of 2,784 CIs read → `limited`, score withheld
with its reason attached, and `business_criticality` reported as a missing field
because `sysparm_fields` drops unknown names without complaint (trap #4). None
of those is an error — all three are the report.

Plain-language summaries are optional and strictly downstream: the model sees
only opaque fingerprints, rules, severities and counts, and a reply naming an id
that was never sent is discarded **whole**, because a model that fabricated one
entry has shown it is not keying off the input. Its failure never removes a
deterministic finding.

#### One switch: All · CMDB · ITOM · ITSM · Platform

A switch at the top scopes the whole page — scorecard, severity bars, areas,
coverage, findings and export — and lives in the URL, so `/health?scope=itom`
opens straight onto ITOM and survives a refresh. Each button shows its finding
count before you click.

Each area is **scored its own way**, because one formula would produce numbers
that look comparable and are not:

- **CMDB** — the share of CIs no CMDB rule objected to.
- **ITSM** — the share of open or recent incidents, changes and problems with no
  ITSM finding, and the score says which slice it covers.
- **ITOM** — the share of capability checks that pass: a MID server exists and is
  healthy, Discovery has run cleanly, credentials are usable, services are
  mapped, the ECC queue drains, outages get closed. A check whose table could not
  be read is shown as *not counted* — never as a pass.
- **Platform** — no score, and it says why: role assignments and integrations
  have no shared denominator, so a percentage would just reflect table sizes.

The All view shows one tile per area side by side and never averages them.

**ITSM is new.** The incident, change and problem tables were always read, but no
rule looked at them — so ITSM produced nothing, which is not the same as healthy.
Eleven rules now cover unassigned, aged-P1, stale, CI-less and reopened incidents;
stale, CI-less, overdue and failed changes; and unassigned or stale problems.
Routing and CI-linking can be fixed through an approved proposal; the time-based
ones deliberately cannot, because a write that only bumped the update time would
hide the finding without anyone doing the work.

Three defects found against a real instance and fixed along the way: a score
withheld because an unrelated optional column did not exist; *"1000 things
found"* when 12,194 had been — every count on the page came from the stored
slice; and extraction stopping early whenever an ACL removed a row from inside a
page.

#### The scorecard, and the two ways out of a finding

The overview leads with a **scorecard** — the CMDB quality score as a plain
number with a plain-English verdict, or a blank and the reason it was withheld —
then bifurcates the findings two ways, both clickable as filters:

- **How serious is it?** Critical · Major · Moderate · Low, as bars. Severity is
  a status scale, so each bar carries its word, its glyph and its count; identity
  never rests on colour alone.
- **Which area?** The ten domains, sorted, in one colour. Colouring each bar by
  its own size would double-encode bar length as hue.

Coverage sits above the findings, never below them, and the findings table is
the charts' table-view twin — every value in a bar is also readable as text.

Opening a finding replaces the list with a two-pane view:

**Left — the problem.** What the rule observed and why it matters, the tables it
read with the exact fields, the blast radius (labelled as topology reachability,
not proven propagation), and the raw evidence rows with their sys_ids.

**Right — the fix.** Two lanes: **Generate remediation plan**, and **Fix it
myself** (numbered manual steps for that rule, ending with how to confirm it
worked). Above both, a time comparison labelled **"Estimated, not measured"**
with its basis attached — manual effort scales with record count because
somebody opens each record; agent effort is broadly fixed because one turn
covers the batch. Nothing here was timed.

#### Remediation: propose → review → approve → execute → validate

**Generate remediation plan** changes nothing. The AI reads the affected
records, works out what it would set, and opens the proposal in the same
`RecordDrawer` that Incidents, Catalog, Flows, SLA, Tables and Transport already
use for editing — a seventh caller, not a seventh editor. It is headed
**"Proposed changes — not yet applied"** until you say otherwise.

Inside, you get the summary, the exact change list — record, field, current
value beside proposed value — the reasoning, the impact (records, table, field,
risks, whether it is reversible) and how it will be checked afterwards. You can
**edit any value**, **remove individual changes**, and add a note. Reference
fields use the app's own picker, so a sys_id is never typed by hand.

Then: **Approve and apply**, or **Reject** (with an optional reason; nothing is
changed and the finding is preserved). Approve and apply first re-reads every
record it will touch from the instance, then asks you to confirm each write on
the same approval card the agent workspace uses — showing the exact table,
record and data — before sending it.

**Approval is the boundary — not the kind of finding.** The AI proposes for
anything, including the findings whose remedy is a judgement call; what it must
do there is *say so*, state the assumption and carry its confidence. On
dev424910, asked to fill an empty `owned_by`, it inferred **David Loo** from the
record's `managed_by`, the name was resolved to a real sys_id through the app's
own reference lookup, and it arrived at confidence 0.8 with the assumption
printed beside it. You can accept it, pick someone else, or reject it.

Three things make *"the agent executed what you approved"* true rather than
hoped for:

- **Editing invalidates the approval.** The proposal is content-hashed; approval
  sends the hash you were looking at. Measured live: editing a value moved the
  hash, and approving with the stale one was refused — *"Nothing ran — review
  the current version and approve that."*
- **It reuses the existing plan pipeline.** The approved list becomes a plan
  that walks the same states, the same fingerprint binding (re-checked before
  *every* step), the same executor and the same read-back as any other write. No
  second gate, no second audit trail. Nothing under `health/` can write to the
  instance at all — a test asserts it.
- **The model cannot widen the scope.** It may not choose the table or the
  field; a reply naming a record that was never sent is discarded whole; and a
  name matching several records stays blank with the candidates offered rather
  than picking the first.

Afterwards you get the result **per record** — applied or not, with the
read-back verdict — and a validation pass that re-reads each record and compares
it against the approved value. Two of five landing is reported as **partially
completed**, never as applied. The whole trail is kept: the AI's original draft,
your edits, exactly what you approved, when, what ran, and what the instance
holds now.

#### ITOM: is anything keeping the CMDB true?

The CMDB rules ask *is this record right?* The ITOM rules ask *is anything
refreshing it?* A perfect CMDB that no Discovery is maintaining is a snapshot
going stale — and every CMDB rule keeps reporting it as healthy, because the
records are well-formed. They are just no longer accurate.

Four more domains — **Discovery**, **Credentials**, **Service Mapping**,
**Availability** — beside the existing MID Server, Event Management and
Performance ones, over ten more tables. Every table was probed against a real
instance before being added: a spec for a table that is not there reports
`unavailable` for ever and teaches people to ignore the coverage strip.

**Absence is the point here.** The two most valuable things this can say about
an ITOM estate are *"Discovery has never run"* and *"there is no MID server"*,
and both are claims about what was **not** found — so both require complete
coverage, and a table that could not be read produces a *skip with its reason*,
never a finding. Getting that backwards would tell somebody their Discovery is
dead because their account lacks a role.

An estate-wide finding also takes the **maximum** impact, not the minimum:
before that fix, "there is no MID server" scored beneath a single CI with a
blank owner, because it names no records. Nothing being there affects
everything downstream of it.

Measured live on dev424910: `MID-NONE` and `DISC-NEVER-RAN` both surfaced at
**P1**, while `em_alert` — Event Management is not installed — reported
`unavailable` and produced no findings at all.

Most ITOM remediation is **operational**: restarting a MID service, opening a
port, running a schedule. A REST write cannot do any of it, so those rules carry
manual steps and deliberately offer no Fix button. The three that genuinely are
a field write do — and "this credential is switched off" fills its own value in
without asking a model, because there is exactly one sensible answer.

#### Living with it: acknowledge, mute, accept

Without this, every run re-reports every finding for ever. A team reviews 900,
decides 400 are known, and has no way to say so — so the next run shows 900
again, and within about three runs nobody opens the page.

- **Acknowledged** — seen and on someone's list. Still counted as outstanding.
- **Muted** — known and deliberately quiet. Needs a reason.
- **Accepted risk** — a decision not to fix. Needs a reason.

**Muting is presentation, never deletion.** A muted finding is still detected,
still stored, still in every count above, and one click from visible — a health
tool that could make findings disappear would be a tool for hiding problems. A
reason is required for the two states that amount to a decision, so the next
person can tell an accepted risk from an unexplained silence.

State is keyed on the finding's **fingerprint**, so muting *"these four CIs have
no owner"* carries across runs and cannot silence a fifth CI that goes ownerless
next week — that is a different fingerprint and arrives as new. A snooze with an
end date re-opens itself when it expires.

#### Also built in, because production needs it

- **One run at a time.** Two concurrent checks leave whichever finished last as
  "latest", so the page would show one run's coverage beside the other's
  findings. A run abandoned by a server crash expires after 30 minutes, so one
  crash cannot disable the feature permanently.
- **Stop.** Cancellation is observed between tables, never mid-table, so the
  partial estate stays an honest description of what finished. Nothing is left
  half-done, because a health check only reads.
- **Score over time**, with runs whose score was withheld drawn as a **gap**
  rather than dropped or zeroed — a line joined across incomplete coverage would
  assert a continuity the data does not have.
- **CSV export** honouring the on-screen filters, with the lifecycle state and
  reason on every row, and cells escaped against the spreadsheet-formula
  problem (trap #38).

#### Capability matrix

Three tiers. **LIVE (verified)** means it was exercised end-to-end against a real PDI and proven by a real execution — not by the deploy log.

**Tier 1 — LIVE, semantically verified**

| Capability | Evidence |
|---|---|
| Flows and subflows from one plain-language spec | flow + subflow generated into one source, 3/3 activated |
| Record triggers (created) with encoded conditions | decoded trigger read back: `priority=1^assignment_group.name=Network^assigned_toISEMPTY` |
| Scheduled triggers (daily, with timezone) | stored `01:30 UTC` verified as `07:00` IST |
| Flow logic — if / else, forEach | present in read-back on every UC |
| Actions exercised: Look Up Record(s), Update Record, Send Email, Log, **Ask For Approval** | across UC1–UC4 |
| Subflow invocation with typed I/O + `waitForCompletion` | UC1 calls UC2; downstream steps land |
| **Standalone subflow authoring, with a declared I/O contract** | "Escalate To Duty Manager" built from a plain-language spec on the FIRST compile attempt, `type = subflow`, active, 17/17 activated; contract parsed from source (`task: reference → task`, `message: string`) and read back off `sys_hub_flow_input` **identical** |
| **Executing a triggerless artifact — subflows are CALLED, not fired** | a one-shot `sysauto_script` drives `sn_fd.FlowAPI.getRunner().subflow(...).inBackground().run()`; execution COMPLETE in 186 ms, work note asserted, job + result row + test record all deleted and read back (0 leftovers) |
| **Subflow OUTPUTS read back off the platform** | `sys_flow_runtime_value` (`type=output`) — `{notified: false, managerEmail: ""}` on a real execution, with the engine's `__action_status__` bookkeeping separated from the declared contract |
| **A notification effect asserted, not assumed** | same subflow driven against a group that has a manager: work note **and** the `sys_email` row addressed to `don.goodliffe@example.com`, 2/2, both cleaned up |
| **Dependency safety** | deleting a subflow with a live caller is REFUSED with the caller named (HTTP 409); the caller deletes first, then the subflow deletes clean — both read back off the instance |
| **Approvals, including the approve-and-continue path** | approval raised for the right approver by identity, patched to approved, flow resumed to COMPLETE, post-approval effect asserted |
| In-place update (same spec, or edited spec via `updates`) | same `sys_id` across repeated and modified deploys |
| Delete | read-back returns 0 rows |
| Failure containment | 3 attempts, candidate deleted, instance snapshot **identical** |
| **SLA definitions created and read back** | "P1 resolve in 4h" created through the agent's gated tool; every field read back as sent, duration stored `1970-01-01 04:00:00` |
| **SLA breach clock, semantically verified** | derived P1 (impact 1 + urgency 1, priority never written), platform confirmed the record matches the start condition, `task_sla` attached to the *right* definition, planned end = start + 4h with **0s drift** against a 120s stated tolerance, cleanup read back (3 rows at start, 0 left) |
| **ACL report matches the records** | 143 rules across `incident → task`; three ACLs re-read through a separate code path and compared field by field, 3/3; `incident_task`'s 43 ACLs, 0 leaked |
| **Two-role diff shows real differences** | admin vs itil: 3 operations only-itil, 36 field-level differences, with the `admin_overrides` inversion stated |
| **SLA assertions inside a flow verification spec** | `Escalate Network P1 Incident` run with an SLA assertion alongside its field assertions: 3/3, 0s drift, and the three rival SLAs that also attached named in the result |
| **Catalog UI policies, proven on the form** | policy built in NowHelpAssist's own UI, installed through the SDK, then driven on `/sp?id=sc_cat_item`: the variable is absent, then rendered, when the checkbox flips. Asserted from the element's bounding box, not its presence in the DOM |
| **Agent-authored UI policy, one approval** | "make the justification field mandatory only when duration is Permanent" → `get_catalog_item` → `create_ui_policy` (approved) → on the Corp VPN form, `aria-required` goes false → true and the field appears under "Required information" |
| **Variable reorder, choices, item toggle, category create** | each exercised over HTTP against the live PDI; reorder renumbers the whole list and reads every row back |
| **The audit trail reconstructs a session** | live on dev442675: agent created `INC0010037` (`c84b2da1…`) through the gate and deleted the same sys_id; an SLA verification ran from the UI path with 8 streamed events and 0 dropped. Every row's sys_ids, approval, instance and account read back from the Audit page alone |
| **Markdown rendering, measured on a real transcript** | the session carrying the original defect now renders 1 table, 19 `<strong>`, 5 `<code>`, 4 lists — and **0** stray `**`, **0** stray pipe rows |
| **Keyboard and console sweep** | 9 pages × connected and disconnected: **0** console problems. 14/14 focused controls paint the verdigris indicator; the confirm dialog traps focus and restores it to the button that opened it |

**What semantic verification does and does not cover.** It creates a record matching the flow's own trigger, waits for the execution to settle, asserts the effects the request promised, and always deletes its test data. It **catches**: the flow never firing, firing then erroring, writing the wrong value, writing nothing, an approval routed to the wrong person. It **cannot catch**: an effect nobody asserted; a trigger condition wrong in the same direction as the setup payload (both derived from one misreading); anything timing-dependent past the wait window; and for scheduled flows, whether the schedule *fires* — there is no supported manual-execute path, so those are verified by schedule metadata only, and the result says so.

**What SLA verification does and does not cover.** It derives a record from the definition's own start condition, confirms with the platform's query engine that the stored record really satisfies it, and asserts that a `task_sla` referencing *that definition* attached with the expected breach clock. It **catches**: the SLA never attaching, attaching with the wrong duration, a start condition that does not match what it appears to, a calculated field the derivation got wrong, and the whole class of "some SLA attached so the test passed". It **cannot catch**: whether the stop and pause conditions behave (nothing here drives a record through them), the exact breach time of a schedule-bound SLA (bounds only — see Tier 2), and a relative `duration_type`, whose end the platform computes by script.

**Tier 2 — LIVE, metadata-verified only**

| Capability | Why |
|---|---|
| Scheduled flows | cannot be fired on demand: no CLI run command, and `sn_fd.FlowAPI` is server-side script only. Verified by decoded schedule metadata with an explicit caveat. |
| Schedule-bound SLA breach clocks | recomputing the schedule engine's arithmetic would mean reimplementing it, and asserting a 24×7 expectation against one fails a *correct* SLA by hours. Bounds are asserted instead — the clock runs forward, it is never shorter than the duration, and the schedule the platform used is the one the definition names — and the result says which mode it ran in. |
| ACL reports on a read-restricted connection | `sys_security_acl` is itself ACL-protected, and this machine has only an admin login. The three degraded states are driven in the offline suite by injection, not against a real de-elevated user. |

**Tier 3 — BLUEPRINT ONLY**

| Capability | Status |
|---|---|
| Editing pre-existing global or third-party flows | **out of scope** — NowHelpAssist only manages artifacts inside its own scoped app |
| Anything when the SDK cannot run | **unavailable, and said so**: the capability banner prints the exact fix commands and the agent reports REQUIRES_MANUAL_ACTION. Nothing is substituted for a flow — the Business Rule fallback was removed on 2026-09-08 (Session 1, WI-4); a Business Rule is created only when asked for by name, and `sys_hub_*` is never written over REST |
| Application triggers (inbound email, SLA, catalog) | supported by the SDK and documented in the cheatsheet, but **not exercised here** — treat as unproven until verified. Note this is the SLA *flow trigger*; SLA **definitions** are Tier 1 above and go through the Table API, not the SDK |
| ACL authoring | **out of scope on purpose**, not a gap to close later with a REST write. The SDK route — `sys_security_acl` as managed source, reviewed and installed like any other artifact — is the only defensible way to author one |
| Editing a catalog UI policy NowHelpAssist did not author | read-only here. Without a Fluent source there is nothing to edit or remove through the toolchain, and the REST path cannot write the fields that matter. Marked "platform" in the UI rather than offered and then failing |

**Scope tiering — a standing invariant, not a caveat.** *REST-created artifacts are global; scoped artifacts are born via the SDK tier.* Measured on dev442675 (`docs/fluent-research.md` §33 E4): `sys_scope` on a REST insert, and `application` on a new `sys_update_set`, are both **accepted with `201` and silently demoted to `global`** — the control row that asked for nothing is indistinguishable from the two that asked. Nothing in the response says it did not do what you asked. So every create that carries scope intent now reads the value back and fails loudly on mismatch, enforced in `client.js` at the one funnel all REST creates pass through rather than remembered at each call site.

There is still **no supported REST API for writing `sys_hub_*` directly**, and NowHelpAssist never attempts it. Live authoring works because it drives ServiceNow's own toolchain.

#### Write-integrity floor (harness-enforced, model-agnostic)

Five guarantees that hold whatever model is behind the agent — they were built and measured on the free
`gpt-oss:120b-cloud` and transfer unchanged to stronger models, because none of them depends on the model
being right. See `CHANGELOG.md` and `docs/fluent-research.md` §36.

| Guarantee | How it is enforced |
|---|---|
| **A write that did not land is never reported as success** | every mutation is diffed field-by-field against the record the platform returns, and `sys_mod_count`/`sys_updated_on` frozen is treated as decisive. A 2xx that stored nothing reads `no-op`, in the tool result the model sees |
| **A disproved write never costs a second approval** | a verified drop is registered for the session and blocked *before* the gate, with the diagnosis and workaround paths named |
| **An executed mutation cannot vanish from the turn's report** | mutations go to a ledger in a table compaction structurally cannot reach, and the report is rendered by the harness, not by the model |
| **A mutation cannot run without a resolved approval** | the executor takes the approval as an argument and refuses otherwise — reordering the code cannot change the safety property |
| **A success glyph cannot appear on a failed write** | the glyph and the words are derived from one verification object |

#### Model-proofing floor (A1–A5)

Every guard answers a failure **measured** against `gpt-oss:120b-cloud`, not a hypothetical one. They do not make a weak model competent; they make it presentable — when it is wrong, the pipeline says so instead of deploying it.

| Guard | The measured failure it answers | Evidence |
|---|---|---|
| **A1** deterministic decoding | — | `temperature 0` + a fingerprint-derived seed, passed through per provider. Probed: this backend **ignores `seed`** on both `/v1` and native `/api/chat`, and `temperature 0` is only approximately stable, so no guard may assume reproducibility (§19) |
| **A2** pinned flow identity | one spec produced a different flow **name** on all six runs; the platform matches artifacts by name, so a rename creates a duplicate | name imposed by string rewrite, located by brace matching so an action's own `name:` cannot be hit; every correction streamed |
| **A3** promised literals | a regeneration silently dropped the `"Vendor issue: "` prefix — compiled, installed, activated 10/10, wrote the wrong text | literals intersected with the spec text, so the model can only narrow the guard, never invent a requirement |
| **A4** `trigger_strategy` lint | nothing set it, so the platform default `once` took over — fires **once ever** per record (trap #10) | the least visible defect in the pipeline: build green, install 10/10, single-shot verification **passes**, wrong only the second time |
| **A5** evidence-fed retries | three verification attempts re-asked the identical question and got the identical bad answer | each rejection attaches the instance's real field inventory; a `RetryLedger` refuses a byte-identical re-ask and names it as *our* defect |
| **A6** the stalled turn | twice in three runs, the model resolved the item, quoted the right sys_ids and the right choice value, then ended with *"Shall I create this UI Policy now?"* — nothing created, nothing said so | a turn ending with a request to proceed, on a directive, with **no mutation anywhere in it**, gets one nudge carrying the fact the model lacked: its question reached nobody, and approval is requested BY calling the tool |

**Test 1 Step 1, resumed and closed** (§20). The §14 failure class is gone: attempt 1 still reached for `^problemISNOTEMPTY`, A5 attached the real reference-field inventory of `incident`, and no attempt in any run went back to it. Three attempts of prose had not moved this model; one dictionary listing moved it immediately.

That surfaced a worse failure that was **ours**: the field check told the model to drop two impossible assertions and the coverage rule rejected it for dropping them — mutually unsatisfiable, unsatisfiable by any model. Fixed with a *verified* escape hatch (`unverifiable`, each excuse checked against the live dictionary or a live read), not a weaker rule. Final run: 2 attempts, 3 assertions + 2 confirmed-unverifiable, covering all 5 promises.

#### Memory and sessions

| Capability | Evidence |
|---|---|
| Conversations survive navigation **and** a server restart | server SIGKILLed mid-session; transcript identical across the restart, and the agent answered a sys_id from two turns earlier **with no tool call** (§21) |
| Compaction into structured digests | synthetic 100-turn session folded under budget; a probe about turn 5 still answerable because its sys_id survived into the digest |
| Compaction never loses data on failure | a summariser that throws, returns an empty digest, or is **cut off mid-generation** discards nothing and says so |
| Compaction verified against the real model | live 60-turn run: 36,958 → 2,502 tokens, flow name and sys_id preserved verbatim, 55 query results collapsed to one line, zero padding leaked (§21) |
| Tool-event audit trail outlives compaction | asserted: messages are rewritten, `tool_events` are not |
| Instance knowledge ledger drives behaviour | on the agent path — where the ledger is the **only** carrier of the fact — a P1 payload came back as `impact: 1` + `urgency: 1`, priority never written |
| Recall in both modes | keyword (no embed model) **5.48** vs 1.41; semantic (`nomic-embed-text`, 768d) **0.79** vs 0.56 — right session first in each |
| Degraded recall is loud | UI banner + API both report `mode: "keyword"` with the exact `ollama pull` command; never a silent downgrade |

Storage is the built-in **`node:sqlite`** — probed, not assumed: `DatabaseSync`, BLOB round-trip for float32 vectors, and FTS5 are all present on Node 24, so the layer is dependency-free (no node-gyp on this Windows machine). One gitignored file, `server/data/nowhelpassist.db`, with idempotent migrations on boot.

---

### Applications and Transport

**Applications** lists every scope on the instance — 743 on dev442675: 3 custom, 739 store, and `global` — each with its version, vendor, and whether NowHelpAssist manages it. The managed flag comes from the SDK **workspace registry** (any directory holding a `now.config.json`), so it is derived rather than a hardcoded scope that would go stale the moment a second scoped app exists. Store applications are read through their `sys_scope` parent because `sys_store_app` itself answers 403 to this user over REST, and the page says so: an instance with 739 store apps showing none would otherwise look exactly like an instance with none.

**Transport** gives the REST tier what the SDK tier already had. An agent session with *Capture changes* on (the default) owns update sets named `NHA · <session> · <scope>`, created lazily per scope on the first captured change, and every mutating tool reports what it captured — or why it did not.

The mechanism is a **sweep**: after each mutating call, the update rows it produced are re-parented into the session's set. Pointing the platform's current-set preference at a named set also works and is deliberately **not** used — it is a per-*user* setting while every session shares one API user, and two interleaved sessions measured **8 of 16** changes landing in each other's set with no error anywhere.

Three rules the sweep obeys, each enforced by the platform rather than chosen:

| rule | what happens otherwise |
|---|---|
| group by the **row's** `application`, one set per scope | business rule `Handle updates moving between sets` aborts with a 403 mid-sweep |
| scoped sets are minted server-side, not over REST | REST hands back a *global* set that then refuses every row |
| collapse rows sharing a name inside a set | the count reads high and the export applies the same record twice |

Two concurrent captured sessions never claim each other's rows: a row inside more than one open capture window is assigned by provenance from the audit trail, or left **unassigned** and reported. Left behind in Default is recoverable; filed under the wrong session silently is not.

**Update sets carry configuration, never task data.** Anything extending `sys_metadata` travels — catalog items, business rules, flows, UI policies, SLA definitions. An incident does not, and a mutation on one says *"not captured — data, not configuration"* rather than going quiet, because silence there reads as a failure.

**Export** builds the update-set XML from Table API reads — the platform's own `export_update_set.do` answers 401 to basic auth, wanting a UI session. Payloads are always entity-escaped rather than wrapped in CDATA: the platform itself only wraps when the payload has no CDATA of its own, and a business rule's payload carries `<script><![CDATA[…]]></script>`, so always-wrapping would emit invalid XML for every script-bearing artifact. Parity is verified against the source rows — count, names and payload hashes — *before* the file is offered, and a mismatch is a 422 with the differences rather than a download.

### Audit

The trust primitive. One timeline over two sources — every tool the agent ran,
and every build driven by hand from a module page — against the bound instance.

- **Filter by session**, including a real *"driven by hand (no agent session)"*
  bucket, and a mutations-only toggle.
- **Approval decisions are visible and never rounded up.** `approved` means a
  human clicked Approve at the amber gate; `auto · ungated` means auto-approve
  was on and **nobody saw it**. Those are different facts and the page counts
  them separately.
- **Request and result** in collapsible mono blocks, with every sys_id the row
  touched pulled out and listed — that is what makes "what did this session
  create" answerable, because a created record's sys_id exists only in the
  tool's return value.
- **CSV export** honouring the on-screen filters, not a table dump.

NowHelpAssist has no user management, so "who" is recorded as what can be stated
truthfully: the decision that was made, and the ServiceNow account the write
landed under. It does not invent a person.

The acceptance test was run live: the agent created `INC0010037`
(`c84b2da1837a4350b939cc65eeaad385`) through the gate and deleted it again,
an SLA verification ran from the UI path, and all of it — sys_ids, approvals,
instance, account — is readable from the Audit page alone.

## The experience layer

- **Markdown in agent replies** — tables, bold, code, lists and links, styled
  to the same tokens as everything else. Raw HTML from the model stays escaped.
- **Toasts and one confirmation dialog** — no `window.confirm` anywhere. A
  destructive dialog shows the exact **sys_id** next to the label (names are
  not unique on an instance) and states the consequence: deleting a catalog
  variable does not fail, it silently breaks every UI policy naming it.
- **Loading, empty and disconnected are three different states.** They used to
  be one sentence: *"No incidents match. Connect your PDI on the Dashboard
  first."* The binding is now answered by `/api/system/health` before a page
  mounts, so an empty list only ever means an empty list, and an unreachable
  local server blames the server rather than your credentials.
- **A route-level error boundary** with a copyable stack, so one bad render
  shows a card instead of a blank screen.
- Keyboard-verified: 14/14 controls carry the verdigris focus ring, the dialog
  traps focus and restores it, Enter sends and Shift+Enter still makes a
  newline. Zero console output across all nine pages, connected *and*
  disconnected.

## Reference-field handling (everywhere)

This is the part most homegrown tools skimp on:

- Every read uses `sysparm_display_value=all`, so each field arrives as `{value, display_value}` — sys_ids for writes, labels for humans.
- `GET /api/system/schema/:table` walks the inheritance chain via `sys_db_object.super_class`, merges `sys_dictionary` across it (most-derived wins), and attaches `sys_choice` lists and reference targets per field.
- `GET /api/system/reference/:table?q=` auto-detects the table's display field (dictionary `display=true`, walked up the chain, with fallbacks) and returns `{sys_id, display}` pairs for typeahead.
- `GET /api/system/tables?q=` searches `sys_db_object` for table pickers (record producers, list collectors).
- The agent is instructed to never invent sys_ids — it must resolve references through the same lookups before any write.

## The agent backbone

Modeled on Claude Code / opencode:

- **Session loop** — provider-agnostic agent iterations (max 15/turn) with a neutral message format translated per provider. History is **persisted to SQLite** and written through on every append, so a conversation survives navigating away and survives a server restart.
- **Tool registry** — 37 tools (`server/src/agent/tools.js`): schema inspection, reference/table lookup, generic record CRUD, incident + catalog composites, flow reading, blueprint design, live flow authoring (`create_flow_live`, `verify_flow_live`, `delete_live_flow`, `smoke_test_flow`, `list_live_flows`, `flow_authoring_capability`), SLAs (`sla_meta`, `list_slas`, `get_sla`, `create_sla`, `verify_sla_live`), catalog items and UI policies (`get_catalog_item`, `add_catalog_variable`, `update_catalog_variable`, `list_ui_policies`, `create_ui_policy`), access control (`acl_report`, `acl_diff`, `explain_acls` — all read-only), and memory (`recall_memory`, `list_instance_facts`, `remember_fact`). Each tool declares `mutating`.
- **Flow authoring tiers** — the prompt makes the order explicit: `design_flow_blueprint` designs, `create_flow_live` builds, and when capability reports `ok: false` or UNKNOWN the agent says flow authoring is unavailable and quotes the fix commands — nothing is substituted. Verifying a flow (`verify_flow_live`) writes real records, so it is a *separate* mutating tool with its own approval and is never automatic after a deploy.
- **Permission gate** — mutating calls pause the loop, stream an `approval_required` event, and wait (5-min timeout) for your Approve/Reject. Rejections are fed back to the model as tool errors. Auto-approve is opt-in.
- **BYO provider** — one adapter for Anthropic's Messages API, one OpenAI-compatible adapter covering OpenAI and Ollama (same wire format). Add a provider by writing one file.
- **Streaming** — SSE over the POST body: `meta`, `assistant_text`, `tool_use`, `approval_required`, `tool_result`, `compacted`, `remembered`, `done`.
- **Model-proofing floor** — five guards (A1–A5) that stop a weak model shipping a wrong artifact: deterministic decoding, pinned flow identity, promised-literal checks, a `trigger_strategy` lint, and retries that must add measured evidence. See the capability matrix and `docs/fluent-research.md` §19–20.
- **Memory** — sessions, an instance knowledge ledger, compaction, and recall, all in one SQLite file. See below.

## API map

```
/api/system      health · settings · connection/test · schema/:table · hierarchy/:table · reference/:table · tables
/api/incidents   list+filters · stats · get · create · update · delete
/api/catalog     meta · catalogs · categories (+create) · items CRUD + deep view
                 variables (+reorder, +choices CRUD) · variable-sets (+variables, attach)
                 items/:id/policies · items/:id/policy-variables
                 policies/validate · policies (POST/PATCH/DELETE, SSE — SDK build + install)
                 order-guides (+items, delete) · record-producers (+delete)
/api/flows       list (flows + subflows, type filter) · :id detail · executions
                 design
                 live (POST, SSE — behind the approval gate; accepts `updates` to edit in place, `artifact_type` flow|subflow)
                 live (GET managed: + contract, calls, calledBy) · live/capability · live/catalog
                 live/verify (POST, SSE — fires a flow, CALLS a subflow) · live/smoke
                 live/:name (DELETE — 409 when a subflow still has callers)
/api/sla         meta · validate (dry run) · list · create · :id (GET · PATCH · DELETE)
                 verify (POST, SSE)
/api/access      acl/:table · diff/:table?a=&b= · explain (POST)
/api/health     meta · runs (POST, SSE — read-only estate check) · runs (GET)
                runs/latest · runs/:id · runs/:id/findings
                runs/:id/findings/:fingerprint (+evidence, +remediation)
                runs/:id/findings/:fingerprint/prompt (the agent draft)
                runs/:id/findings/:fingerprint/proposal (POST — propose, writes nothing)
                proposals/:id (GET · PATCH edit) · proposals/:id/reject
                proposals/:id/approve (POST, SSE — the only path to a write)
                findings/:fingerprint/state (PATCH · DELETE) · states · trend
                runs/:id/export.csv · runs/:id (DELETE)
/api/audit       (GET, filters: session · mutating) · runs/:id · export.csv
/api/agent       info · chat (SSE) · approve
                 sessions (GET list · POST new) · sessions/:id (GET · PATCH rename · DELETE)
                 sessions/:id/messages
                 memory/status · memory/search
                 facts (GET · POST) · facts/:id (DELETE) · facts/seed
```

## Logs

Both halves of the app write to the terminal running the server — the browser's
included, forwarded over `POST /api/logs`. A stack trace in a devtools console
nobody has open is not evidence.

```
┌──────────────────────────────────────────────┐
│ NowHelpAssist  ·  http://localhost:4000      │
│ instance   https://devXXXXXX.service-now.com │
│ model      ollama · gpt-oss:120b-cloud       │
│ storage    …/server/data/nowhelpassist.db    │
│ log level  info                              │
└──────────────────────────────────────────────┘
07:36:41.900 INFO  tool      query_records
      │ {"table":"incident","limit":2,"query":"active=true"}
07:36:52.520 ERROR tool      query_records failed  10.6s — Could not reach the instance
07:37:01.431 INFO  tool      create_record (mutating)
07:37:01.432 WARN  gate      approval required: create_record — waiting for the user
07:37:01.438 INFO  gate      create_record REJECTED by the user
07:39:51.206 ERROR ui        uncaught TypeError: undefined is not a function (/audit)
```

Every request with its status and duration, every agent turn, every tool call
with arguments and elapsed time, every approval decision — including a loud
`UNGATED` warning when auto-approve lets one through — every build run, and
from the browser every navigation, console error, uncaught exception, unhandled
rejection, failed API call and render error, tagged with the route.

- `LOG_LEVEL=debug` adds the health poll and per-request client timings;
  `LOG_LEVEL=warn` cuts it to problems only.
- `NO_COLOR=1`, or piping to a file, drops the ANSI codes.
- **Secrets are never printed.** Request bodies are not logged at all, and
  structured metadata is redacted by key at any depth — this app holds a
  ServiceNow password and an API key, and a debug log is exactly how those get
  out.

## Known caveats

- Order-guide rule-base writes target `sc_cat_item_guide_items`; verify the table name on your release (constant `GUIDE_RULE_TABLE` in `server/src/servicenow/catalog.js`).
- Variable type codes are the stable canonical set but worth a spot-check on brand-new releases (`VARIABLE_TYPES`, same file).
- OAuth uses the password grant with the PDI's OAuth client; refresh-token rotation is Phase 2. Basic auth is the simple path for PDIs.
- This is a local dev tool: no user management, secrets in a local JSON file, CORS open. Don't deploy it to the internet as-is.

## Roadmap

- **Done — flow authoring for real:** ServiceNow SDK (Fluent) codegen with offline compile validation, serialized install, read-back verification, and an approval-gated agent tool.
- **Done — semantic verification:** flows are proven by firing them on a real record and asserting the promised effects, including the approve-and-continue path for approvals. Reference use cases (record-triggered flow + subflow, scheduled digest, approval flow) all regenerated through codegen and verified live; idempotency battery green.
- **Done — the model-proofing floor:** five guards so the pipeline reports a weak model's mistakes instead of deploying them. The one available model (`gpt-oss:120b-cloud`) provably ignores `seed`, so every guard is written to hold under non-deterministic generation; a stronger model stays a pure Settings swap.
- **Done — memory and sessions:** conversations persist across restarts, compact into structured digests when they outgrow the context budget, and are searchable. A per-instance knowledge ledger carries every trap in `docs/fluent-research.md` into the agent prompt *and* the codegen context.
- **Done — SLAs and access control:** SLA definitions with conditions checked against the live dictionary before any write, and a breach clock proven by making the platform run it — `task_sla` matched to the *right* definition, planned end asserted in UTC against a tolerance the spec has to state. An ACL analyzer that reads, diffs and explains, and never authors; an unreadable ACL table reports its visibility instead of rendering an empty report.
- **Done — catalog UI policies and variable editing:** a builder scoped to an item that cannot express a condition the form could never satisfy, variables edited in place and reordered with a full renumber, and agent parity for both. Policies are authored through the SDK because `catalog_ui_policy_action` cannot be written over REST — found by pointing Track B's ACL analyzer at the table that was swallowing the writes.
- **Done — the experience layer and the audit trail:** agent replies render markdown; every native modal is gone in favour of one dialog that shows the exact sys_id and the consequence; loading, empty and disconnected stopped being the same sentence; and an Audit page reconstructs everything a past session did to the instance — sys_ids, approvals, and whether a human actually saw the gate. The disconnected click-through found three real defects (a gate that gated markup instead of mounting, a `/health` endpoint that shelled out to the SDK for 5.5s, and hover-only controls unreachable by keyboard); all three are fixed and both sweeps are clean.
- **Next:** exercise application triggers (inbound email, SLA, catalog) so they can leave the unproven tier; ATF test triggering after builds; OAuth refresh flow. Also: the deployed vendor-hold flow still sets no `trigger_strategy` (trap #10) — A4 blocks new flows from shipping that defect but does not retro-fix a deployed one.
- **Later — productize:** multi-instance workspaces, update-set capture around agent sessions ("everything the agent did in this session" as one exportable set — the Audit page now answers the question, an update set would make it *revertible*), packaging/licensing for consultancies.

## Notes from building this

Things that cost real time and are documented in `docs/fluent-research.md`:

- The published SDK CLI page lists **kebab-case flags that don't exist** (`--frozen-keys`, `--app-name`). The shipped CLI is camelCase. `now-sdk explain <topic>` is the reliable reference — it bundles better docs than the website.
- Modern releases store flow parts in the **`_v2`** tables. The legacy tables still exist and return zero rows, so reading them makes every modern flow look empty.
- Choice fields must be handed to the model as `value=label` pairs. Passing bare values produced a flow that fired on *Low* risk for a spec that asked for *High*, because `risk=4` means Low on this instance — and it compiled and installed perfectly.
- Reasoning models (gpt-oss, o-series) bill hidden reasoning tokens against `max_tokens` and return HTTP 200 with empty content when the budget runs out. NowHelpAssist now raises a specific error instead of reporting "the model returned nothing".
- `priority` on task tables is **calculated** from `impact` and `urgency`. Writing `{"priority":"1"}` is silently stored as *4 - Low*, so a verification setup that sets priority directly never matches a `priority=1` trigger. Drive calculated fields through their inputs.
- Schedule times are stored in **UTC**: `Time({hours:7}, 'Asia/Kolkata')` persists as `01:30`. Asserting the local wall-clock time against the stored value fails a perfectly correct flow.
- `catalog_ui_policy_action` accepts a POST, returns 201, and silently discards the two fields that make the action work. A field ACL grants only the role `nobody`, `admin_overrides` is off, and the Table API drops a field you may not write instead of refusing. The dictionary's `read_only` flag is no guide: on that table the read-only fields store and the writable ones do not.
- A catalog UI policy condition is `IO:<variable sys_id>`, not a field name — and its action states are the strings `ignore`/`true`/`false`, where the default `ignore` means an action that saves cleanly and does nothing.
- `ui_type` 0 is labelled "Desktop", which reads like a Service Portal exclusion. It is not, on this release — this project asserted that it was, in a comment, a warning and a commit message, before measuring it.
- Hardcoded platform code lists go stale silently: 31, 32 and 33 had all shifted for catalog variable types, and five codes were missing.
- A UI policy is evaluated in the browser, so no server-side read proves it works. Setting the Angular model on a portal control even changes the value without re-evaluating the policy — only a real click does.
- A `task_sla` row on a record proves nothing about **which** SLA produced it. One P1 incident attached three: ours and two out-of-box ones. "The SLA attached" is an assertion that passes with the definition under test deleted.
- `contract_sla.duration` carries whole days in the **date** half of the timestamp, so a 2-day SLA is `1970-01-03 00:00:00` and reads as zero if you look only at the clock.
- A `contract_sla.schedule` is inert unless `schedule_source` says `sla_definition`. Same schedule, same 4h duration, one field apart: 4.00h against 7.84h.
- `sys_security_acl.operation` mixes two sys_id conventions in one table — `read` and `write` are literally their own sys_ids, `report_view` is 32 hex. Read the raw value and half your report is opaque in a way that looks like bad data.
- `nameSTARTSWITHincident` also matches `incident_task`, which has 43 ACLs of its own.
- A weak model can return HTTP 200 with a repetition loop in the middle of otherwise correct prose. Next to an accurate report, the loop reads as a finding. NowHelpAssist checks generated text for it, retries once quoting the repeated fragment back, and then refuses.
- Gating a component's returned JSX does not gate its effects. The page is mounted before it returns, so five "you need an instance" screens were rendering on top of five requests that had already 400'd. Only a route-level gate stops the mount.
- `/api/system/health` is polled by every page to answer "is an instance bound", and it was `await capability()` — two `now-sdk` spawns, 5.5s on a cold cache, for a field no client read.
- `display: none` removes an element from the tab order, so adding `:focus-within` to a hover-reveal rule is inert. Clipping keeps the buttons focusable and looks identical.
- `:focus-visible` deliberately ignores `element.focus()`, so an accessibility probe written with it reports a false gap on components whose focus ring is perfect.
- A double hyphen is illegal inside an XML comment, and naming CSS custom properties (`--ink`) in an SVG comment is enough to trigger it. The HTML parser forgives it inline; `<img>` and `<link rel=icon>` do not, and fail silently — `naturalWidth` reads 0 while the tab icon still looks fine.
- `\b` does not bound a hex string inside a URL-encoded one. A sys_id scanner skipped `…sys_id%3D196e6cb2…` — the exact format the agent uses to report what it just created — because the `D` of `%3D` is a word character.
- Excel and Sheets execute a CSV cell beginning `=`, `+`, `-` or `@`, and an audit export is full of model-authored text.
- react-markdown passes the mdast `node` into every component override; spreading it renders `node="[object Object]"` and makes React warn on every message.
- Identity cannot come from an LLM-chosen name. The same spec produced "…Incidents" and then "…Incident", which silently created a duplicate flow *and* a duplicate subflow. Identity now derives from the request itself.
