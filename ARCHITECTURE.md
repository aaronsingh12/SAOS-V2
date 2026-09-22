# NowForge Architecture

An autonomous agentic engineering assistant for ServiceNow. It reads an
instance, reasons about it, plans work, asks a human before it writes, executes
through one choke point, verifies by reading back, and keeps a durable record of
everything it did.

This document is the map: what the system is for, how it is laid out, what each
layer owns, and — most importantly — **which properties must stay true**. The
last part is the reason the rest is shaped the way it is.

---

## 1. What it is for

Five kinds of work, all against a real instance:

| Use case | What the user asks | What the system does |
|---|---|---|
| **Operate** | "Assign INC0010038 to Abel Tuter" | resolve the reference, gate the write, execute, read back, report |
| **Diagnose** | "Why did this incident sit unassigned?" | read audit, journal, SLA, flow executions; correlate; state what the evidence does and does not establish |
| **Review** | "Is this flow safe?" / "What changed?" | deterministic rules over a published flow; semantic diff between two authoritative states |
| **Prove** | "Does this flow actually work?" | build a disposable fixture, trigger it, assert on effects the flow itself produced, clean up |
| **Build** | "Build an equipment request app" | design a dependency graph, validate it against the instance, refuse what the environment cannot build, build the rest, verify it |
| **Assess** | "Is this instance healthy?" | read an allow-listed slice of the estate, run deterministic rules over it, and report findings *beside an account of what could not be read* |

The through-line is the last column. Every one of them ends in **evidence**, not
in an assertion — and where evidence cannot be obtained, the system says so
rather than producing a confident answer.

### The sentence the whole design serves

> A successful tool call is never equivalent to a successful outcome.

ServiceNow will happily return `201 Created` for a write it silently discarded,
accept a `sys_scope` it ignores, and drop a query clause naming a field that
does not exist. So nothing here treats an HTTP status as proof. Every mutation
is followed by a read-back, every read-back verdict is stored, and the verdict
— not the call — is what the user is shown.

---

## 2. The shape, in one diagram

```
                            User
                              │
                    ┌─────────▼─────────┐
                    │   Agent Workspace  │  React, one page, SSE
                    └─────────┬─────────┘
                              │  POST → event stream
                    ┌─────────▼─────────┐
                    │   Agent Kernel     │  orchestrator.js — the turn loop
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │     Planner        │  plan/ — canonical plan, fingerprint
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Policy / Gate    │  approval, write-guard, provenance,
                    └─────────┬─────────┘  elevation, capability discovery
                              │
                    ┌─────────▼─────────┐
                    │  ONE Executor      │  executeTool() — the single choke point
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │    ServiceNow      │  REST Table/Aggregate · SDK · harness
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Read-back / Verify│  mutation-pipeline.js
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │     Evidence       │  durable projection, redacted
                    └────────────────────┘
```

Every arrow is one-way. Nothing below reaches back up: the executor does not
know about plans, the plan layer does not know about the workspace, and the
workspace cannot execute anything. Architecture tests assert this on the import
graph rather than trusting the diagram.

---

## 3. Repository layout

```
nowforge/
├── client/                       React 18 + Vite, dev :5173, /api proxied to :4000
│   └── src/
│       ├── pages/                13 pages — AgentChat is the workspace, the
│       │                         rest are module consoles (Incidents, Catalog,
│       │                         Flows, SLA, Access, Applications, Tables,
│       │                         Transport, Audit, Meetings, Dashboard, Settings)
│       ├── components/           25 components + 10 plain-JS helper modules.
│       │                         The helpers are .js on purpose: Node cannot
│       │                         import .jsx, and the offline suite asserts
│       │                         their decisions directly
│       ├── hooks/                useHealth (one shared poller: "is an instance
│       │                         bound?"), useBinding, useScopeLabels
│       ├── api.js                request() + sse() — the SSE reader that
│       │                         ENFORCES a terminal frame
│       ├── styles.css            design tokens + the module consoles
│       └── experience.css        the agent workspace
│
├── server/                       Node 22+ (node:sqlite), Express :4000
│   ├── src/
│   │   ├── index.js              route mounting; migrations run BEFORE listen
│   │   ├── config/store.js       settings.json — connection · llm · agent ·
│   │   │                         dba · rag · skills
│   │   ├── memory/               THE STORAGE LAYER (15 modules) — §7
│   │   ├── health/               Health Assist: allow-list · extract · PURE
│   │   │                         rule pack · scopes · manifest · store · remediation (§16)
│   │   ├── knowledge/            documentation corpus, ingestion, precedence
│   │   ├── servicenow/           40+ modules — the ONLY code that talks to the
│   │   │                         instance (§6)
│   │   ├── agent/                the kernel and the domains (§5)
│   │   ├── meetings/             meeting capture → understanding → build plan
│   │   └── routes/               17 routers; SSE over POST
│   ├── test/                     151 files, 3,013 tests — offline, no instance
│   ├── scripts/                  33 real-PDI validations and model evaluations
│   ├── fluent-workspace/         ServiceNow SDK app, scope x_2002152_nwforge
│   │   ├── src/fluent/flows/     managed sources — anything here SHIPS
│   │   ├── src/fluent/generated/keys.ts   Now.ID → sys_id (identity; commit it)
│   │   └── staged/               build-verified, deliberately NOT deployed
│   └── data/                     gitignored: nowhelpassist.db (WAL), settings.json
│
└── docs/                         research notes, incident write-ups, the trap ledger
```

---

## 4. The safety kernel

Six properties. Everything else in this repository is arranged so that these
cannot be violated by accident, and each is asserted by a test that fails loudly
rather than by a convention someone has to remember.

### 4.1 One executor

`executeTool()` in `agent/orchestrator.js` is the only function that calls a
mutating tool's `execute`. It takes the approval **as an argument** and refuses
to run without a resolved one — so reordering the code cannot change the safety
property, only deleting the check can, and a test asserts the check directly.

### 4.2 An approval is not a boolean

It is a 32-byte CSPRNG nonce, minted per card, sent once with the card,
compared with `timingSafeEqual`, and bound to **provenance**:

```
approved  requires  source = user_click      (a human resolved the gate)
auto      requires  source = auto_approve    AND auto-approve is actually on
unknown   never executes
```

A mutation whose authorisation cannot be attributed does not run. For plans, the
approval binds to a **plan fingerprint** (SHA-256 over the canonical plan), so a
plan edited after approval cannot inherit it.

### 4.3 Read-back decides

`mutation-pipeline.js` snapshots before, executes, then re-reads and diffs the
requested fields against what the instance actually holds. `no-op` and `partial`
are *failed writes*, whatever the HTTP status said. The verdict is stored on the
step and is what the UI renders.

### 4.4 The model may not invent a sys_id

`memory/provenance.js` records every sys_id the session *observed* — from a tool
result, from the user, or from the ledger. A write targeting a sys_id with no
provenance is hard-blocked before the approval gate, because spending a human's
attention on a confabulated target is worse than refusing.

### 4.5 Capability is discovered, never assumed

`agent/capability-discovery.js` answers whether an operation is possible on
*this* instance through *this* mechanism. `UNKNOWN` is **not** treated as
available. A plan step naming a capability the build does not model is refused
at validation as a hallucination.

### 4.6 Exactly one terminal frame

Every SSE stream ends with exactly one of `done` / `error` / `cancelled` /
`<domain>_complete` / `plan_failed`. The client's `sse()` reader throws if a
stream simply stops, because a truncated stream and a finished one used to be
indistinguishable — the server dying mid-turn looked like success.

---

## 5. `agent/` — the kernel and the domains

```
agent/
├── orchestrator.js        THE TURN LOOP. ≤30 iterations, 4096 output tokens,
│                          5-minute approval timeout, six cancellation safe
│                          points, six turn-control guards. Also the home of
│                          executeTool() and the approval primitives.
├── tools.js               97 tools, 30 mutating. { name, description,
│                          inputSchema, mutating, execute, describeWrite }
├── prompts.js             FROZEN. The system prompt and operating rules.
│                          sha256 prefix 99585f7e…; a freeze test guards it
├── mutation-pipeline.js   snapshot → execute → read back → verdict
├── write-guard.js         refuse a write already proven to be a no-op
├── plan-check.js          plan-time trap detection
├── task-boundary.js       impersonation boundary questions
├── context-engine.js      \
├── context-selection.js    │ Phase 2: send the model the part of its surface
├── context-capabilities.js/  this request is actually about
├── decoding.js            provider-neutral decoding profiles
├── capture.js             update-set capture after a mutating tool
│
├── plan/          canonical plan · $ref dataflow · fingerprint · validator ·
│                  executor · review · states · store
├── recovery/      classification · idempotency · policy · decision · reconcile
├── evidence/      builder · read-model · status · redact  (READS ONLY)
├── activity/      the workspace read model            ← Experience
├── skills/        the skill registry                  ← Experience
│
├── doctor/        investigate: timeline · hypotheses · evidence · diagnosis
├── lint/          NowLint: deterministic rules over a published flow
├── test/          NowTest: fixture · trigger · effects · assertions · runner
├── change/        semantic diff: normalize · baseline · diff · significance · impact
├── knowledge/     truth-aware retrieval: scope · retrieve · classify · answer
├── appbuild/      Application Builder: requirements · discovery · graph ·
│                  architecture · capability · plan · verify
└── providers/     anthropic · openaiCompat (OpenAI + Ollama) · retry · contract
```

### 5.1 The turn loop

One HTTP request → one logical user turn → one task → one step. Provider
retries live inside the adapter, iterations inside the loop, tool calls inside
an iteration — none of them can mint a second task, so "1 turn = 1 task" is
structural rather than counted.

The loop emits frames; it does **not** know about tasks. `task-tracker.js`
watches the frames and projects the lifecycle onto the durable tables. The
dependency arrow points down, and reversing it would make the execution layer
depend on orchestration.

### 5.2 Plans

A plan is a **task with steps** — no separate table. Each step carries its
operation, capability, mechanism, tool, canonical inputs, `depends_on`, promised
effects, verification strategy, approval and result.

- **`$ref` dataflow**: `step_2.result.sys_id` is resolved from a *declared*
  output of step 2. A reference to an undeclared output is refused at
  validation, because "the model asked for `number` and got row 1's sys_id" is
  how an arbitrary record ends up in an update.
- **Canonical form**: the plan is normalised before hashing, so the fingerprint
  is stable across key ordering.
- **The only edge into `executing` is from `awaiting_approval`.** Not because
  the executor remembers to ask — because there is no other edge in the plan
  state machine.

### 5.3 The seven domains

Each is a pure pipeline over reads, with its own vocabulary and its own render;
none of them writes to ServiceNow except through the ordinary plan and executor.

| Domain | Question | The rule that shapes it |
|---|---|---|
| **Incident Operations** | change something safely | every mutation gated, verified by read-back |
| **Doctor** | why did this happen? | read-only; may not execute a plan the registry says would write |
| **NowLint** | is this flow risky? | findings come from rules, not from the model deciding a flow looks wrong |
| **NowTest** | does it actually work? | an assertion may not use a value the setup itself wrote |
| **Change Intelligence** | what changed, and what breaks? | a diff needs **two authoritative states** — a description is not a baseline |
| **Knowledge** | what do we know? | retrieval is context, never authority (§8) |
| **Application Builder** | build this app | one unbuildable component blocks the **whole** build |

---

## 6. `servicenow/` — the only code that talks to the instance

Three transports, chosen per operation because the platform forces the choice:

```
                REST Table/Aggregate API        SDK (now-sdk 4.x)         Execution harness
what it does    records, schema, ACLs,          whole-application         run a server-side
                catalog, SLA                    install of Fluent         script once and
                                                sources                   return its report
born in scope   global, always                  the app's own scope       n/a
                (sys_scope on insert is
                 accepted and IGNORED)
portable by     an update set (the sweep)       the scoped app itself     n/a
```

Key modules:

- **`client.js`** — basic / OAuth password grant with token cache, error
  normalisation (`SnowError`).
- **`schema.js`** — walks `sys_db_object.super_class` and merges
  `sys_dictionary` + `sys_choice`; display-field detection; reference lookups.
- **`fluent.js`** — live authoring: capability probe → LLM codegen against live
  schema → **offline** compile validation with retry → serialized install →
  read-back → semantic verification.
- **`elevation-*.js` / `role-elevation.js`** — the ACL/security path. An
  un-elevated write to `sys_security_acl` is **denied silently**, so the ACL
  tools' `execute` bodies *throw*: they are unreachable by design, and a throw
  makes the guarantee loud if the interception is ever removed.
- **`transport.js`** — session capture. Finds the update rows a call produced,
  groups by the **row's** application, re-parents into a set per scope.
- **`dba-*.js`** — the schema/DBA module: context, impact, authoring, source of
  truth, tiered risk.

### 6.1 Elevation and impersonation

Two separate concepts, deliberately not merged:

- **Elevation** raises the *runner's* role (e.g. `security_admin`) for one
  atomic operation, behind the ordinary approval gate, with an eligibility
  check that fails **closed** when it cannot be verified.
- **Impersonation** performs a write *as another user* to answer "what can they
  actually do". It is per-session mode state with its own audit table, and the
  approval card must name the person whose authority is being borrowed —
  an ADMIN target gets the same red weight as a destructive action.

Neither can be self-granted by the model.

---

## 7. `memory/` — storage and the audit trail

One gitignored SQLite file, `server/data/nowhelpassist.db`, opened through the
built-in **`node:sqlite`** — chosen because it was *probed*, not assumed
(`DatabaseSync`, BLOB round-trip for float32 vectors, and FTS5 are all present),
which keeps storage dependency-free on a Windows machine with no node-gyp.

Migrations are idempotent, keyed on `PRAGMA user_version`, and run **before the
listener binds** — a database that cannot open stops the server rather than
failing the first chat turn with something unrecognisable. **A shipped migration
is never edited.** `user_version` is the only thing that decides what has run,
so an edit would silently skip on every existing file.

**Current schema version: 26.**

| # | Adds |
|---|---|
| 1 | sessions · messages · tool_events |
| 2 | facts — the per-instance knowledge ledger |
| 3 | embeddings + FTS5 index (the no-embedding fallback) |
| 4 | digests — compaction |
| 5 | build_runs / build_events — the UI-driven audit trail |
| 6 | capture_state / capture_sets — update-set capture |
| 7 | mutation_ledger — the harness's own account of what it wrote |
| 8 | approval provenance on tool_events |
| 9 | sysid_provenance |
| 10–13 | impersonation mode, task-boundary questions, impersonation audit, write-ahead provenance |
| 14 | **split the audit trail from conversation history** — tool_events and sysid_provenance stop cascading from `sessions` |
| 15–19 | meeting intelligence: capture, transcription, understanding, build plans, chat origin |
| 20 | kb_documents / kb_chunks / kb_embeddings + snada_observations |
| 21 | **agent_tasks / agent_task_steps** — the durable task substrate |
| 22 | the durable **plan**, carried on the Phase 1 tables (no new table) |
| 23 | `task_id` on mutation_ledger and tool_events — exact correlation |
| 24 | health_runs / health_findings — Health Assist's estate checks |
| 25 | health_proposals — the remediation trail: draft, edits, approval, result |
| 26 | health_finding_state — acknowledged / muted / accepted, keyed on the fingerprint |

### 7.1 Why the audit trail is separate from the transcript

`messages` is rewritten by compaction. `tool_events` and `mutation_ledger` must
never be. Migration 14 removed their foreign key to `sessions` so that
**deleting a chat does not delete the record of what was done to the
instance** — the same reason `agent_tasks` has no FK to `sessions` either.

A task pointing at a conversation that no longer exists is the wanted outcome,
not a dangling reference to repair.

### 7.2 Correlation, and why it had to become exact

Migration 23 added `task_id` so evidence could stop guessing. Until recently
only the *plan* executor wrote it, so every row the ordinary chat loop produced
was NULL and both evidence and the workspace matched by session-plus-time-window
— deterministic, but not a key: two turns overlapping in one session each
claimed the other's tool calls. The turn loop now stamps its task id on every
audit row it writes. Rows that still carry no task keep the window fallback, and
every projected row says which of the two it is.

---

## 8. `knowledge/` — retrieval that cannot become authority

The truth hierarchy, applied as a ranking ladder with an explicit tested map
between the two vocabularies:

```
live instance state   >   live schema   >   managed source   >
verified ledger fact  >   documentation >   model knowledge
```

Retrieved documentation is **context**. It cannot authorise an operation, and
`knowledge/context.js` is structurally unable to: it returns text, and no
consumer of that text is a policy check. A knowledge answer carries
`authorises: false` and the UI shows it.

Three defences that were added because their absence was measured:

- **Scope isolation** — an item declaring INSTANCE scope with no instance was
  once admitted everywhere. Fail-open in isolation is a leak between PDIs.
- **A semantic floor** — a nearest neighbour is not necessarily a neighbour.
- **Authority diversity in packing** — 45 ledger facts once filled every slot
  and pushed out every document.

Secrets are redacted at **ingestion**, using the one redactor in
`memory/redact.js` (see §12).

---

## 9. The Experience layer — the agent workspace

The newest layer, and the one with the strictest rule: **it owns nothing
operational.** No execution, no approval, no verification, no recovery, no task
state machine, no evidence store, no ServiceNow client. It reads and it invokes
existing APIs. An architecture test asserts that on the import graph.

```
agent/activity/          the presentation READ MODEL
  schemas.js             the closed vocabulary: 7 event types, 6 statuses,
                         13 agent statuses, one deterministic precedence list
  normalize.js           SSE frame → activity row, or explicitly NOTHING
  status.js              (task row, step rows, plan_state) → one status word
  project.js             the durable timeline, rebuilt from the tables
  index.js               task history, cheap status

agent/skills/            the skill REGISTRY
  manifest.js            a manifest is DATA. No code, no URL, no credentials —
                         the key list is closed and forbidden keys are refused
                         BY NAME with a reason
  builtin.js             the 7 built-in skills — pointers to capabilities that
                         already exist, never a second implementation
  permissions.js         what a skill can read/change, COMPUTED from the
                         capability taxonomy + the registry's `mutating` flag
  registry.js            install · enable · disable · conflicts · versions
  context.js             what an active skill contributes to a turn
```

### 9.1 The four rules that decide its shape

**Nothing is invented.** `normalize.js` is a *total* map over the frame
vocabulary with exactly two kinds of entry: a descriptor, or `null` meaning
"this frame is real and is NOT activity". A new frame added to the orchestrator
without a decision here is a test failure, not a silently dropped event.

**Status is derived from state, not from the last event.** §13's precedence is
one ordered list: terminal states outrank everything, then `WAITING_FOR_APPROVAL`,
then executing, verifying, planning, thinking, idle. A turn executing a tool
while a card is on screen is **waiting** — what a person needs to know is that
the agent is waiting on *them*.

**Live and durable timelines are never merged.** A live tool row is keyed by the
model's call id, a durable one by `(session, seq)`. They name the same event and
cannot be reconciled without inventing a mapping neither side stores — so
refresh, reconnect and reopening a task **replace** the list. That is stronger
than de-duplicating a merge: there is no merge in which a duplicate could appear.

**Redaction happens at the boundary.** Every `metadata` object leaving the
projection passes through the redactor, so the client never redacts and there is
no second key list to fall behind.

### 9.2 Skills

A skill is a **named bundle of capabilities**, and it cannot *do* anything. It
names capabilities the platform already has and tools the registry already
exposes; enabling one changes what the planner may see, never what exists.

- **Permissions are computed, not declared.** A manifest whose declared change
  permission disagrees with what its capabilities actually grant is BLOCKED.
  That check found the defect in our own built-ins: the Doctor declared no
  change permission while `incident` implied `record_mutation`.
- **Disabling subtracts; it does not select.** `removed = capabilities(disabled)
  − capabilities(enabled)`, and a tool is dropped only when *every* capability
  it has was removed. Disabling nothing removes nothing, so the default state is
  byte-for-byte the pre-Skills behaviour, and a capability no skill claims can
  never be taken away.
- **A task records its skill set when it opens**, in `metadata_json`. Disabling
  a skill an hour later cannot rewrite what a finished run was executed under.
- **The registry is configuration**, not a table — it lives in `settings.json`
  and the database stays at 23.

### 9.3 Cancellation

There is exactly **one** cancellation path and it is not an endpoint: the client
aborts its own fetch, the server sees the disconnect and stops at the next safe
boundary. A cancel *route* would need to identify the turn, which means a
registry of in-flight turns, which is the global state Phase 0 refused to
introduce. The UI says "cancellation requested — the current operation completes
safely and is recorded", because a mutation inside its boundary finishes and
nothing is rolled back.

---

## 10. Cross-cutting pipelines

### 10.1 Verification (NowTest / SLA / flow)

```
verify(name)
   │  <slug>.verify.json
   ├─► setup    create a record satisfying the flow's OWN trigger condition
   │              (calculated fields driven through their inputs: impact+urgency,
   │               never priority directly — the platform overwrites it)
   ├─► wait     poll sys_flow_context for THIS flow's execution
   │              COMPLETE → assertable
   │              WAITING/PAUSED → assertable (approval flows stop here)
   │              ERROR/CANCELLED → fail with the state
   │              timeout → fail with the last observed state, never a hang
   ├─► assert   journal fields read from sys_journal_field and compared by
   │              containment; everything else compared exactly
   ├─► resume   approvals only: patch the approval, wait again, assert again
   └─► cleanup  ALWAYS, in a finally — a failed assertion leaves no test data
```

| Rule | Failure it prevents |
|---|---|
| An assertion may not read a field `setup.payload` itself wrote | passes regardless of what the flow does |
| Assertions must cover every `promised_effect` from intent extraction | proves half the request while reporting a clean pass |

### 10.2 Live authoring

```
spec ─► extractIntent ─► buildLiveContext ─► generate ─► validate ─► deploy ─► verify
         (LLM, JSON)      getSchema()         (LLM +     now-sdk     now-sdk    read
                          referenceLookup()    cheatsheet build       install    back
                                               + rules)   OFFLINE     queued
                                                             │
                                                    fail ────┤ feed diagnostics back,
                                                             │ retry ≤3
                                                             └─► delete candidate,
                                                                 rebuild, return error
```

| # | Invariant | Why |
|---|---|---|
| a | only build-validated sources may sit in `src/fluent` at install time | anything there ships |
| b | a candidate that never compiles is deleted and the workspace rebuilt | keeps `src/` and `keys.ts` clean after a failure |
| c | every build/install goes through one serialized queue | concurrent runs would race on `dist/` and `keys.ts` |
| d | identity follows the **request**, not the model's chosen name | the same spec named its flow "…Incidents" then "…Incident", creating a duplicate |
| e | `deploy()` builds before installing | `install` ships `dist/`; deploying without building silently installs a stale package |

### 10.3 Transport and scope

The sweep re-parents update rows **after** the fact rather than pointing the
platform's current-set preference at a named set. The preference route works —
and is not used, because it is a per-**user** setting while every session shares
one API user. Measured: two interleaved sessions put **8 of 16** changes in each
other's set, with no error anywhere.

| rule | what happens if you get it wrong |
|---|---|
| group by the ROW's `application`, one set per scope | business rule `Handle updates moving between sets` aborts with a 403 mid-sweep |
| scoped sets are minted server-side, not over REST | REST returns a *global* set that then refuses every row |
| collapse rows sharing a name inside a set | the count reads high and the export applies the same record twice |

An update set carries **configuration** — anything extending `sys_metadata`.
It has never carried task data, so a mutation on `incident` reports
"not captured — data, not configuration" rather than going quiet.

### 10.4 Context budgeting

The model's context is finite and the prompt already carries ~100 tool schemas
plus the fact ledger. `context-engine.js` classifies the request into
capabilities, then sends only that part of the surface. Two rules keep it honest:

- **The default is always "include".** An unclassified tool, rule or fact is
  global. Every direction of doubt resolves toward the model seeing *more* — a
  missing tool costs a broken turn, a missing safety rule costs a wrong write.
- **A missing tool is not a refusal.** If the model calls something outside the
  profile it is told so in those words, the profile widens to the full surface,
  and it may call again. Reading "unavailable" as "denied" is how a scoped-out
  mutation gets routed through a generic `create_record`.

`memory/budget.js` measures the prompt that is actually sent; the measured
string and the sent string must be identical, or the budget stops describing the
request.

---

## 11. Routes

17 routers under `/api`. Streaming routes use **SSE over POST**, because the
request carries a body.

| Router | Owns |
|---|---|
| `system` | health, settings, binding, schema/reference lookups |
| `agent` | sessions, messages, facts, memory search, **chat** (SSE), **approve** |
| `plan` | plan creation/execution (SSE) + the domain entry points: `/diagnose`, `/lint`, `/test`, `/change`, `/knowledge`, `/build`; and the read models `/:taskId`, `/:taskId/evidence`, `/:taskId/activity`, `/history/:sessionId` |
| `skills` | the skill registry — list, install, enable/disable, remove |
| `incidents` `catalog` `flows` `sla` `access` `applications` `dba` | the module consoles (the Tables page is served by `dba`) |
| `health` | Health Assist — estate health runs, their manifests and findings (read-only) |
| `transport` | capture state, sweep, update-set export |
| `audit` | the merged timeline, sys_id harvest, CSV export |
| `knowledge` | corpus ingestion and status |
| `meetings` | capture, transcription, findings, handoff |
| `logs` | client → server terminal logging |

The domain entry points live on `plan` rather than on routers of their own
because they all produce **a task**, and a second address for one concept is a
second thing to keep in step.

---

## 12. Redaction

One implementation, in `memory/redact.js`. It lives there rather than in
`agent/evidence/` for a layering reason: knowledge ingestion also needs it, and
`knowledge/` sits *below* the evidence layer — importing upward would invert the
dependency arrow that an architecture test enforces. `agent/evidence/redact.js`
re-exports it, so every existing importer is untouched.

Keys are matched case-insensitively as a **substring**, so `clientSecret`,
`client_secret` and `oauthClientSecret` are all caught by one entry.
Over-matching is the safe direction: redacting `password_policy_name` costs a
reader nothing; missing one costs a credential.

Nothing a credential could reach renders it: activity, plan, tool detail,
approval, evidence, skill manifests, knowledge chunks.

---

## 13. Testing and validation

Four layers, and the distinction between them is load-bearing.

| Layer | What it proves | What it cannot |
|---|---|---|
| **Offline suite** — 151 files, 3,013 tests, `npm test` | contracts, vocabularies, state machines, the import graph, every guard | that ServiceNow behaves as expected |
| **Real PDI scripts** — `scripts/*-pdi.mjs` | the live instance actually does this | that it generalises beyond one instance |
| **Real model evaluations** — `scripts/*-model-eval.mjs` | the real model, on real requests, does not defeat the guards | that another model would behave the same |
| **Client contract tests** | every field a panel reads exists; every value the server emits is one the panel recognises | live browser rendering |

Three disciplines that produced most of the value:

- **Every defect gets a regression test**, and the test names the defect.
- **Never weaken an existing guard test.** When one fires legitimately, the fix
  goes in the code or the guard is extended with written justification.
- **PDI hygiene**: disposable records only, marked, owned by sys_id, deleted by
  sys_id — never by pattern, because deleting everything matching a marker is
  how a test removes somebody else's record. Cleanup runs in a `finally`.

There is no DOM harness. UI correctness is asserted as a **contract** against
real server responses plus the component source, because the failures this class
of code actually has are field-name mismatches, unrecognised status words and
unmapped frames — none of which rendering would catch if the fixture were
written from the same wrong assumption.

---

## 14. Concept mapping

| Claude Code | NowForge |
|---|---|
| Tool registry + JSON schemas | `agent/tools.js` (`inputSchema`, `execute`) |
| Permission prompts before edits | the amber approval gate on `mutating` tools |
| Provider-agnostic model layer | neutral history format + per-provider adapters |
| Streaming progress in the terminal | SSE frames rendered as the activity timeline |
| CLAUDE.md system guidance | `agent/prompts.js` operating rules (frozen) |
| Skills / plugins | `agent/skills/` — capability bundles, data only |
| Compile/typecheck before claiming done | `now-sdk build` offline, retry on diagnostics |
| Never report success unverified | read-back through `flows.detail()` / `verifyMutation` |
| Session resume | durable tasks + the activity projection |

---

## 15. Extension points

**Add a tool.** Append to `TOOLS` in `agent/tools.js`: `name`, `description`
(written for the model), `inputSchema`, `mutating`, `execute(input, ctx)`, and
`describeWrite` if it mutates. Then classify it in
`agent/context-capabilities.js` — an unclassified tool is a **test failure**,
not a silent exclusion. The orchestrator, gate, ledger and UI pick it up.

**Add a provider.** Create `agent/providers/yourprovider.js` exporting
`chat({ system, history, tools, ... }) → { text, toolCalls, stopReason }`,
register it in `providers/index.js` and the Settings select. A test asserts
that none of the twenty **safety-critical** modules — the plan executor and
validator, the recovery decision path, evidence, the mutation pipeline, the
write guard, provenance, the ledger and capability discovery — so much as names
a vendor, because whether something is authorised, verified or recovered must
not change with the model behind it.

**Add a skill.** POST a manifest to `/api/skills`: `id`, `name`, `version`,
`description`, `capabilities`, and optionally `tools`, `rules`, `knowledge`,
`permissions`. It is validated against the live taxonomy and the live registry.
It cannot contain code.

**Add a domain.** Follow the shape the seven share: `schemas.js` (a closed
vocabulary), pure pipeline modules, `render.js`, `intent.js`, `index.js`; an
entry point on `routes/plan.js` that emits exactly one terminal frame; a panel
in `client/src/components/`; and an offline suite plus a real-PDI script.

**Add a migration.** Append to `MIGRATIONS` in `memory/db.js`. Never edit a
shipped one. A migration may be a function as well as a SQL string, for the
cases SQL cannot express (SQLite has no `ADD COLUMN IF NOT EXISTS`).

---

## 16. `health/` — Health Assist

Estate health across **CMDB, ITOM, ITSM and platform hygiene**, switchable by scope (§16.7): read an allow-listed slice of the
instance, run a deterministic rule pack over it, and report findings. Ported from SAOS, a separate Python
service, and folded in rather than run beside NowForge — a sidecar would have
meant a second path that talks to the instance, a second credential store and a
second model config, which is three violations of §16 for a feature that is one
page.

```
health/
├── tables.js     the extraction ALLOW-LIST. 15 tables, each with its own field
│                 list. An unknown table is refused, not skipped
├── extract.js    pagination + COVERAGE, through servicenow/client.js only
├── rules.js      the rule pack. PURE — no socket, no database, no model
├── index.js      extract → rules → manifest
├── explain.js    optional plain-language pass; may never add a finding
├── store.js      health_runs / health_findings, scoped per instance
└── digest.js     the manifest's input hash
```

### 16.1 Coverage is the whole design

A rule that fires on the ABSENCE of something — "this CI has no relationships",
"this service has no offering" — is only sound if the extraction that found
nothing was complete. Partial extraction plus an absence rule is how *"we could
not read the table"* becomes *"your CMDB is broken"*.

So every table comes back with a coverage descriptor, and three things follow
from it:

| rule | what it prevents |
|---|---|
| absence rules require `complete` | an ACL hiding half of `cmdb_rel_ci` turning every CI into an orphan |
| a rule that did not run is listed in `skipped[]` with its reason | a silent rule and a clean rule looking identical |
| the quality score is **withheld** unless `cmdb_ci` *and* `cmdb_rel_ci` are complete | a number that is sometimes about the estate and sometimes about our access |

Measured live on dev424910: reading 300 of 2,784 CIs produced
`status: "limited"`, a withheld score carrying its own reason, and — because
`sysparm_fields` drops unknown names without complaint (trap #4) —
`missing_fields: ["business_criticality"]`, a field that does not exist on that
instance. None of those is an error; all three are the report.

### 16.2 Detection reads; only an approved plan writes

Nothing in `health/` writes to the instance. Detection is entirely a read, and
remediation (§16.3) changes that only in the sense that an **approved** plan is
handed to the ordinary executor — the module itself still has no write path.

Two seams reach the platform, both reads: `extract.js` for the health check and
`instance-read.js` for a field's current value and its re-read afterwards.
Everything else is asserted rather than promised — the router never imports the
table client, no module under `health/` calls `table.create`, `table.update` or
`table.remove`, and the rule pack imports nothing at all.

That split is the point. A change that went out from here directly would land
without the approval gate, without the read-back and without the aud`it trail;
routing every one through the plan executor is what guarantees all three.

The model is strictly downstream of the rules. It receives derived facts — an
opaque fingerprint, the rule, the domain, the severity, a record count — and
returns prose keyed by those ids. A reply naming an id that was never sent is
discarded **whole**, because a model that fabricated one entry has shown it is
not keying off the input. Its failure leaves every deterministic finding intact.

### 16.3 Remediation — propose, review, approve, execute, validate

The AI may propose a fix for **any** finding. Nothing reaches the instance until
a human has read that proposal, edited whatever they disagree with, and
explicitly approved *that version*. **Approval is the boundary — not the kind of
finding.**

```
finding ─► propose ─► review / edit ─► APPROVE ─► plan ─► execute ─► validate
           (AI)       (RecordDrawer)   (human)    (existing pipeline)
```

An earlier shape refused to propose at all for findings whose remedy is a
judgement call, reasoning that a system which picks an owner invents an
accountable party. That reasoning was about the *write*, and it was being
applied one step too early — it stopped the AI from even suggesting. What
survives from it is the part that was load-bearing: a proposal for a judgement
call must **say** it is one, state the assumption it rests on, and carry its
confidence. A confident-looking value with no stated basis is the failure to
avoid; the suggestion itself is not.

**Nothing under `health/` writes.** The two seams that reach the instance —
`extract.js` and `instance-read.js` — are reads, and a test asserts that no
module here calls `table.create`, `table.update` or `table.remove`. Every change
goes through the ordinary plan executor, which is what puts the gate, the
read-back and the audit trail on it.

#### What makes "the agent executed what you approved" true

Two content hashes, checked at different moments, plus one structural rule:

| guard | when | what it refuses |
|---|---|---|
| the **proposal** fingerprint | before a plan is built | an approval given for a version the user has since edited |
| the **plan** fingerprint (`approvePlan`) | before the first step, re-checked before every step | a plan that moved between approval and execution |
| `awaiting_approval → executing` | the state machine | any route into execution that skipped approval |

The proposal hash covers exactly the executable material — target, field, value —
so re-rendering a proposal does not invalidate an approval while changing a
value does. Measured live: editing a value moved the hash, and approving with
the stale one was refused with *"Nothing ran — review the current version"*.

**The approval is bound in `routes/health.js`, not in the domain module.**
`routes/` is the only place this system raises or binds an approval, so someone
auditing "what can authorise a write" can read the routers and stop. An earlier
version passed `approvePlan` in as a callback; that was *worse* than calling it
directly, because the call then lived in the domain module under an alias where
neither the approval inventory nor a reader of the router could see it.
Splitting `prepareRemediation` from `runRemediation` puts the binding where both
can — and the closed inventory in the approval-audit suite is what caught it.

**Approve and apply binds the plan; each write still gets its card.** An
earlier version of this section said there was no second approval card. That
was wrong: the executor raises its per-step gate unconditionally, and the drawer
did not render it — hidden only because every step was being blocked before it
got that far (below). The drawer now renders the executor's own card for each
record (operation, table, sys_id, exact data) and answers it through
`POST /api/agent/approve`, the one resolver. The route could have answered the
gate itself, but that would make `routes/health.js` a second caller of
`resolveApproval`, which the approval inventory forbids. A global auto-approve
preference is deliberately **not** threaded through either: a session-wide
setting must not widen what one specific approval covered.

**The targets are re-read in the remediation's session before the plan is
built.** The executor refuses a write to a sys_id that never appeared in the
writing session. Health Assist's reads (extraction, proposal values, reference
lookup) happen outside any session, so on techsnitchpvtltddemo2 Approve and
apply was refused with *"BLOCKED: sys_id 5f9b83bf… has never appeared in this
session"* — while the same change through the agent worked, because the agent's
own read had put the record in front of its session. The guard was right;
remediation is not exempt from it. `observeTargets` reads each target, and each
referenced record a field will point at, and records the read as an ordinary
`get_record` tool event, so provenance is registered by the same single producer
every read uses. A record that cannot be read stops the remediation before a
plan exists. When nothing was applied, validation is reported as *skipped* with
the reason, not as "failed — 0 of 1".

#### What the model may and may not do

- it may propose a value for the field **the rule names** — never a field or a
  table of its own choosing;
- it may **not** introduce a record: every `sys_id` is checked against the
  finding's own targets, and one that was never sent discards the **whole**
  reply, because a model that fabricated one target is not keying off the input;
- a name it proposes for a reference field is resolved through the app's own
  `referenceLookup`. One match becomes the value; **several or none stays blank**
  with the candidates offered, because picking the first is the invention this
  path exists to avoid.

Measured on dev424910: asked to fill `owned_by`, the model found the answer in
`managed_by` and proposed *nothing* — it knew a reference field holds a sys_id
and it had a name. Feeding it the record's neighbouring fields and resolving the
name afterwards turned that into `owned_by = 5137153c…` shown as **David Loo**,
confidence 0.8, assumption *"inferred from the managed_by field"*. Honest and
blank became honest and useful.

#### Failure is reported per record, never rounded up

The result is derived from the durable step rows, which carry the read-back
verdict — so a `2xx` that stored nothing reads `no-op`, not success. A run where
two of five records landed is `partial`, and calling it applied is the single
most expensive lie this module could tell. Validation then re-reads each record
and compares against the **approved** value, not merely "is it non-empty", and
says in the payload that it is a targeted re-check rather than a fresh health
run.

#### Bulk Fix — the single flow, once per selected finding (22 Sep 2026)

Findings can be ticked on either findings table and fixed together. What that
means is deliberately narrow: **a batch is the sequence above, run once per
finding, in order.** There is no batch-level approval, no batch mutation and
no bulk path to the executor.

```
tick findings ─► POST /bulk/proposals ─► review each (edit · include · exclude)
                 one buildProposal per finding,          │
                 one proposal row each                   ▼
              ◄─ per-finding status ◄─ POST /bulk/approve ─► applyProposal() × N, sequential
                                        body: [{proposalId, fingerprint}]   (prepare → bind → run)
```

Three things make it the same flow and not a weaker copy:

| property | how it holds |
|---|---|
| **one binder** | `applyProposal()` in `routes/health.js` is the prepare → `approvePlan` → execute sequence; the single route and the bulk route both call it, so the approval inventory still counts one `approvePlan` in the file. The bulk route cannot bind anything the single route could not |
| **one fingerprint per version seen** | the approve body carries each proposal's own fingerprint. An item the reviewer edited is saved first and its new hash sent; one they unticked is not sent; one whose hash moved is refused for that item alone while the rest go on |
| **every card, every read-back** | each proposal runs in its own session with its own provenance re-read, and the executor raises its per-record card as it always does. The drawer renders the card tagged with its item and answers it through `POST /api/agent/approve` — a batch of twenty findings is twenty runs of the gate, not one |

**Sequential, on purpose.** A card is one question to one person; two batches of
cards racing for the same reviewer would be a worse interface, not a faster
one. The executor also cancels at a step boundary, so a stopped batch leaves
each item either fully reported or `not_started` — never half-sent.

**The status is per finding, from a closed vocabulary** (`health/bulk.js`):
`proposed · needs_value · no_field_fix · stale · proposal_failed · excluded ·
already_decided · applied · partial · failed · cancelled · not_started`. Each
is decided from the proposal's own facts — its `llm.status`, its executable
change count, the store's read-back verdict — never from the rule id, so a rule
added to `FIX_FIELD` participates without anyone touching the bulk layer. The
summary counts those statuses and is `ok` only when every included item
applied in full; *"3 applied · 1 skipped · 1 failed of 5"* is what a mixed
batch says, because *"done"* would hide the two that were not.

Two smaller decisions. `fixable` on a list row is `hasFieldFix(rule_id)` over
the same registry the proposal reads, so the checkbox and the proposal it leads
to cannot disagree; a finding with no automated fix cannot be ticked and, if
sent anyway, is skipped as `no_field_fix`. And a finding that already has an
applied proposal in this run is **flagged and left out by default**, not
hidden: re-proposing it reads the live value and would offer to write it again,
which is the reviewer's call to make with the prior attempt in front of them.

Bulk work still stops when its page goes away, exactly as a single fix does
(B5): the routes tie their work to the request and touch no registry.

### 16.4 The charts

Severity is a **status scale**, not a set of categories, so it wears reserved
status tones and every mark carries its word, its glyph and its number —
identity never rests on hue, which is what keeps Critical and Major apart for a
colourblind reader when both sit at the red end. The tones were validated
against this theme's panel rather than eyeballed: all four clear 3:1 contrast,
and the closest adjacent pair separates at ΔE 8.1 under deuteranopia, inside the
band that is legal *with* the secondary encoding the glyph and direct label
supply.

Three deliberate restraints: the score is a **hero number**, not a gauge — one
value does not need a second encoding; domain bars use **one** colour, because
colouring each bar by its own size would double-encode length as hue; and the
findings table is the charts' **table-view twin**, so every value in a bar is
also readable as text.

### 16.5 ITOM — is the machinery that maintains the CMDB running?

The CMDB rules ask *"is this record right?"* The ITOM rules ask *"is anything
keeping these records true?"* A perfect CMDB that no Discovery is refreshing is
a snapshot going stale — and every CMDB rule will keep reporting it as healthy,
because the records are well-formed. They are just no longer accurate.

Four domains: **Discovery**, **Credentials**, **Service Mapping** and
**Availability**, alongside the existing MID Server, Event Management and
Performance ones. Ten tables were added, each **probed against a real instance
first** — a spec for a table that is not there reports `unavailable` for ever
and teaches a reader to ignore the coverage strip.

#### Absence is the most valuable finding here

`whenEmpty()` exists because the two most important things this module can say
about an ITOM estate are *"Discovery has never run"* and *"there is no MID
server"*, and both are claims about what was **not** found.

That makes the coverage rule load-bearing rather than decorative:

| what was read | what is reported |
|---|---|
| `discovery_status` complete, zero rows | **DISC-NEVER-RAN** — nothing is refreshing the CMDB |
| `discovery_status` unreadable | a **skip**, with the reason |

Getting that backwards would tell somebody their Discovery is dead because their
account lacks a role. Measured live on dev424910: `MID-NONE` and
`DISC-NEVER-RAN` both fired at **P1**, while `em_alert` — Event Management is
not installed — reported `unavailable` and produced no findings at all.

**An estate-wide finding takes the maximum impact proxy, not the minimum.** The
priority formula multiplies severity by a business proxy derived from affected
services, so a finding naming no records scored 4 — the bottom of P3, beneath a
single CI with a blank owner. That is exactly backwards: nothing being there
affects everything downstream of it. `estate_wide` findings take the maximum,
and their `impact` says *"this names no individual records because the records
are what is missing"* rather than reporting a reachability of zero.

#### Most ITOM remediation is operational, and says so

Restarting a MID service, opening a firewall port and running a Discovery
schedule are not things a REST write can do. Those rules appear in the
remediation catalogue with manual steps and are deliberately **absent from
`FIX_FIELD`** — so the proposal carries instructions instead of a field editor,
rather than offering a Fix button that could not work.

Three ITOM rules do have a real field fix, and one of them carries a `preset`:
"this credential is switched off" has exactly one sensible remedy, so the value
is filled in without a model round-trip that could only add a failure mode. It
is still a proposal and still needs approval.

### 16.6 The finding lifecycle — why this is production-ready

Without it, every run re-reports every finding for ever. A team reviews 900,
decides 400 are known and accepted, and has no way to record that — so the next
run shows 900 again, and within about three runs nobody opens the page. **A
health checker that cannot be told "we know, and we accepted it" gets ignored,
and being ignored is a worse failure than a few false positives.**

Two properties keep it honest:

- **Muting is presentation, never deletion.** A muted finding is still detected,
  still stored, still in every count, and one click from visible. A health tool
  that could make findings disappear would be a tool for hiding problems.
- **State is keyed on the FINGERPRINT**, which is sha256 over rule + table + the
  sorted sys_ids. Muting *"these four CIs have no owner"* carries across runs
  and **cannot** silence a fifth CI that goes ownerless next week — that is a
  different hash and arrives as new.

`muted` and `accepted` require a reason, because the next person has to be able
to tell an accepted risk from an unexplained silence. `acknowledged` does not —
it is triage, not a decision, and still counts as outstanding. A snooze carries
an `expires_at` and is re-evaluated **at read time**: there is no sweeper in this
app, and a state that quietly stayed muted past its own end date would be the
permanent blind spot the field exists to prevent. The decision source is a
literal in the INSERT — a model that could mute its own findings would be a model
that can hide its own mistakes.

Three more production guards, each closing a real failure:

| guard | the failure it closes |
|---|---|
| **one run at a time per instance** | two concurrent runs leave whichever finished last as "latest", so the page shows one run's coverage beside the other's findings. There is no way to merge two snapshots taken at different cutoffs |
| **"running" means this process is executing it** | a row at `running` is only a claim. The route keeps the one set of checks this process owns (`liveHealthRuns`); any `running` row outside it is closed as *interrupted* the next time anyone asks. The 30-minute age bound this replaced was not enough — measured: a server closed mid-run, then a restart and even a reboot, still answered "already running" until the half hour passed |
| **cancellation, observed between tables** | a table half-read would be stored with whatever coverage it happened to reach. Stopping on a clean boundary keeps the partial estate an honest description of the tables that finished — and a health check only reads, so nothing is left half-done |

**A check belongs to the server; the page watches it.** Every other streaming
route cancels when its client disconnects, because they write. A health check
does not, and tying it to the request only lost it: navigating to another page
left it running with nothing on screen, and pressing the button again answered
"already running". So `POST /runs` starts a check and watches it on that
response; leaving closes the watch, not the check. `GET /runs/active` and
`GET /runs/:id/stream` find it again (a finished run answers with its one
terminal frame), and **Stop** is an explicit `POST /runs/:id/cancel`. On the
page, the run lives in an app-wide store (`client/src/components/healthRun.js`),
picked back up on load, and its outcome is announced once — a toast, and a
desktop notification if enabled. The exception is pinned narrowly in the
architecture suite (B5): one registry, in `routes/health.js`, never reachable from
the remediation route — applying a fix is a write and still stops when its page
goes away.

The score **trend** keeps withheld scores as `null` and renders them as a gap
rather than dropping or zeroing them: a line joined across a period where
coverage was incomplete would assert a continuity the data does not have. CSV
export honours the on-screen filters and goes through the audit module's own
`csvCell` — one escaper in this app, because a spreadsheet executes a cell
beginning `=`, `+`, `-` or `@` (trap #38).

### 16.7 Scopes — CMDB, ITOM, ITSM, Platform — and what a score honestly means

`health/scopes.js` is the single definition of the switch: which domains each
scope owns, which tables it reads, and how it is scored. It is pure, so the same
function summarises a run as it finishes and re-reads an older run that was
recorded before the switch existed.

**The scores are deliberately not all the same kind**, because one formula over
four areas would produce four numbers that look comparable and are not:

| scope | score | why that kind |
|---|---|---|
| **CMDB** | share of CIs no CMDB rule objected to | records are the unit of CMDB health. Unchanged from before, so the trend line stays continuous |
| **ITSM** | ITSM Quality (`health/itsm-quality.js`, 21 Sep 2026): a record in the open-or-recent incident, change and problem slice starts at 100 and loses the weight of each distinct charge (Critical 40 · High 15 · Moderate 5 · Low 1), floored at 0; that mean is blended 60/40 with the share of estate-level catalogue rules that pass | the same two-part shape as CMDB Quality, so the two numbers mean the same kind of thing. It replaced a record pass rate in which one Moderate finding failed a whole record — an estate scored 0.7 where the capped deduction read 89. Systemic findings are posture beside the score; a base-Systemic rule never charges. `scopes.itsm.scoring.key` names the model, and the trend refuses to join points made under another. Decisions: `health/rules/itsm/SCORING-OPTIONS.md` §5 |
| **ITOM** | share of *applicable* capability checks that pass | ITOM's important findings are about absence and name no records; "no MID server" cannot be a percentage of rows |
| **Platform** | none, and it says why | 42,000 role assignments and fourteen integrations share no denominator; any percentage would be decided by table size |

The All view shows one tile per scope and **never averages them**.

**A score explains itself.** Record scores carry `score_drivers`: distinct records
per rule, largest first, each clicking through to its findings. Added after the
first live CMDB score came back at 0.3% — correct, and useless alone. The drivers
said why: 3,233 of 3,412 CIs have no owner, 3,211 no relationships, 2,956 unchanged
for 90 days. Re-weighting the score would have flattered a true number (dropping
the Low rule only moves it to 2.8%); naming the levers is what makes it
actionable.

**A vacuous truth is not a pass.** An ITOM check over an empty table — "open alerts
are bound to CIs" with zero alerts — is `not_applicable`. Measured: counting it as a
pass lifted the ITOM score from 42.9% to 50%.

Every score describes only what was read. A table whose rows were not all read is
excluded from its scope and named; if nothing usable is left, the score is
withheld with the specific reason. An ITOM check whose table could not be read is
`not_applicable` and left out of the score entirely — never counted as a pass.
The SQL filter behind the findings list and the in-memory mapping behind the
counts are built from the same definitions, and a test asserts they place every
rule in the same scope.

#### ITSM

The incident, change and problem tables were extracted from the first release and
**no rule read them** — ITSM produced nothing, which is not the same as healthy.
Eleven rules now do: unassigned, aged P1, stale, no CI and reopened incidents;
stale, CI-less, overdue and failed changes; unassigned and stale problems.

They read a stated slice — active, or updated in the last 90 days — because
health is about what is live now, and reading every incident since go-live would
make a run take as long as the instance is old. The same condition goes into the
count, or a table could never be complete. No rule keys off a numeric state code:
those differ between tables and are instance-configurable (trap #28), so `active`
is the only state the rules trust.

Routing and linking are field fixes and get proposals. The time-based rules do
not: a write that only moved `sys_updated_on` would make *"untouched for 40
days"* disappear without anyone doing the work it pointed at.

#### Three defects found on a real instance, and fixed

Measured on techsnitchpvtltddemo2, where the page showed *"No score"* and
*"1000 things found"*:

| what the page showed | what was actually wrong |
|---|---|
| **No score** | `cmdb_ci` read 3,412 of 3,412 rows, but `business_criticality` is not a column there. Coverage conflated *every row* with *every field*, so a missing optional field withheld the score. `rows_complete` now answers the row question on its own; `isComplete(coverage, table, fields)` is the one place every gate asks it, naming only the fields that rule reads |
| **1000 things found** | 12,194 were detected and 1,000 stored, and every count on the page — including "989 Moderate, 0 Low" — was taken from the stored slice. Counts and scores now come from the full detected set — and so do the stored rows: the 25,000 "memory guard" that replaced the 1,000 cap made the same defect the other way round (ITSM counted 56 Low from 29,177 detected while the stored top-25,000-by-priority held none, so selecting Low listed nothing). A run stores every finding it counts; database growth is bounded by keeping findings for the newest runs only |
| (unseen) `sys_script` 998 of 14,059 | ServiceNow removes ACL-hidden rows from *inside* a page, so a page of 500 came back with 498 and the pager took the short page for the end. The first fix — paging on by offset — exposed a second defect live: `sys_script` and `sysauto` are written *while they are read* (14,059 → 14,250 in two days), an insert ahead of the offset shifts every later row, and both tables failed outright on a repeated sys_id. Extraction now uses the DBA module's own keyset walk (`sys_id > watermark`, only an empty page ends it), which cannot shift. Measured after: `sys_script` 14,362 rows, `sysauto` 1,652 |

The fix to the second created a new obligation: storing every finding writes
~12,000 rows per check on a large instance. The **five most recent runs** keep
their findings; every run keeps its manifest — coverage, counts, every scope's
score — which is all the trend reads. Lifecycle states and remediation proposals
keep their own records and are never pruned.

---

### 16.8 CMDB Quality — the trust gate and the two-layer score

The CMDB number is no longer a pass rate. It follows the SAOS rule catalogue
(`SAOS_Health_Rules_Tracker_v3.xlsx`), loaded as data from
`health/catalogue/cmdb.json` — 139 CMDB rules, each with its ten articulation
fields, and the CMDB Quality model's ten dimensions (D1–D10, weights summing to
100) from the data-quality tab.

| layer | what it is | how it is computed |
|---|---|---|
| **1 — trust gate** | findings whose **base** severity is Systemic *and* whose `systemicKind` gates (config_absence, measured_kpi); Systemic *posture* is shown apart and never gates | never enter the number; while one is live the composite and every dimension score are **"Provisional — not trustworthy"** and the blockers are shown above the score |
| **2 — record scores** | every other catalogued finding, in its dimension | `record = max(0, 100 − Σ w)`, `dimension = mean over in-scope records`, `composite = Σ weight × dimension`, with w = Critical 40 · High 15 · Moderate 5 · Low 1 |

**Severity is base + context.** `effective = clamp(base + escalators −
de-escalators, Low, Systemic)`, stacking, from the Schema tab's modifier lists.
The finding's section is its effective band. A finding **escalated** to Systemic
zeroes its record (w = 100) and does **not** trip the gate — `gate` and
`escalated_to_systemic` are separate fields end to end.

**What the engine refuses to invent.** A dimension with no built rule is *not
measured* (never 100). A composite over fewer than ten dimensions states how much
of the 100 weight it covers. A finding below Systemic that names no records is
reported and left out of the arithmetic until how such findings score is decided.
Weighted defect density per 100 records is kept as a secondary trend metric only.

**Group 1 against the real platform** (verified on dev424910, 15 Sep 2026):
`cmdb_health_inclusion_rule` does not exist — inclusion rules are
`cmdb_health_config` (no `active` field), weights are `cmdb_health_metric_pref`,
configured attributes are `cmdb_recommended_fields`, principal classes are
`cmdb_class_info.principal_class`. The rules need a few non-table reads — the
class hierarchy, each inclusion filter's match count, job triggers, policy
execution counts, whether weights are audited — and `extractCmdbMeta` makes them
as bounded queries, each with its own status, so a rule whose read failed skips
with that reason. A rule whose False Positive Guard cannot be checked by machine
says so on the finding (`false_positive_guard.evaluated = false`).

With no principal class designated, principal-scoped rules fall back to every
populated class and name the fallback; CMDB-139 reports the absence itself. On a
PDI, rules whose evidence needs Event Management, Discovery schedules or Service
Graph Connectors are marked *Not testable on PDI* in the tracker — an absent
plugin is not a rule defect.

**Routing by kind and track (16 Sep).** The composite is a *data-quality*
score, so only `track: dimension` findings move it. Group 9 (governance posture),
Group 13 (platform indicator), Group 14 (drift and regression) and Group 11
outside its consumption-blocking rules (CSDM maturity) are counted in their own
panels. Within a dimension, a **record** rule deducts from records, a **kpi**
(percentage) rule contributes its passing % as a sub-score — blended 70/30 with
the record average when both exist — and a **context** rule is shown, never
scored. A base-Systemic percentage rule both scores (its measurement) and gates
(its breach): CMDB-141, the impact-analysis headline, is named in the gate
narrative. The kind and track of every rule are columns in tracker v3.

**Two provisional states, never merged.** `gate_provisional` ("Score not
trustworthy") and `coverage_provisional` ("Provisional — x of 100 weight
measured"). Findings escalated to Systemic are listed in their own band with
their chain (base band → Systemic, and the modifier reasons), apart from the gate.

**Context signals** (`cmdb-signals.js`) decide the modifiers per record and say
which could not be evaluated: Business Critical support (relationships traced
downward from a "1 - most critical" service), production / non-production
(`used_for`, which exists only on some child classes), shared infrastructure (by
class), retiring (lifecycle status) and approved exception ("accepted risk" on the
same fingerprint). Materiality modifiers stay unevaluated until thresholds are set.

**Group 2 against the platform** (dev424910, 16 Sep): `used_for` and
`business_criticality` are not on `cmdb_ci`; `core_company` has no `active` field;
`cmdb_ci` is not audited. Four rules follow their false-positive guard where the
literal detection logic would flood: CMDB-020 is scoped to physical classes,
CMDB-022 skips when no CI allocates cost, CMDB-021 skips when the CMDB is not
audited, CMDB-018 counts companies in use. Live counts cross-checked against the
Aggregate API: CMDB-012 152, CMDB-013 871, CMDB-018 1,889, CMDB-020 15, CMDB-022 124.

**Group 3 and the decisions of 17 Sep.** Every Systemic rule carries a
`systemicKind`: a *config_absence* (CMDB-001, 044, 045) gates only; a
*measured_kpi* (CMDB-046, 057, 070, 141) gates on breach **and** contributes its
sub-score — two outputs of one measurement. Materiality is applied after every
rule has run, per rule and per class over the in-scope CIs: escalate at ≥ 20% of
the class **and** ≥ 10 CIs, de-escalate below max(5, 1% of the class). The
production escalator fires only on *explicit* production (a used_for value that
differs from the class default, or an audit row showing it was set) or independent
evidence (configured production ranges or discovery sources, or an explicitly
production parent service) — never on the OOB default. CMDB-141 counts only
service-bound changes. CMDB-023 reads its permitted set from the instance's
`life_cycle_mapping` (legacy status value → lifecycle stage); nothing is hardcoded.

**Corrections of 16 Sep 2026.** *Systemic is not the same as gate.* `systemicKind`
also takes *posture* (CMDB-038, 056, 091, 104, 112, 131): Systemic, shown in its
own panel, never gating and never scored. CMDB-002 and 003 keep gating; CMDB-116
is shown only. *A record is charged for its own context, never its class's.* Every
catalogued record finding carries two bands: `severity` (where it is reported)
and `deduction_severity` (what its records are charged). Per-CI escalators
(Business Critical support, production, shared infrastructure…) move both, and at
Systemic zero that record. The class-defect-rate escalator is a property of the
class: it surfaces **one** pattern finding per rule and class (`pattern: true`,
base + 1, deducting nothing) and leaves every record at its own deduction. Below
materiality moves reporting only, the same asymmetry in reverse. CMDB-023 flags
only one field in a RUNNING stage against the other in a NOT-RUNNING stage
(configurable sets), so Installed + Non-Operational — Operational + Design on the
OOB mapping, "installed but down" — is valid without naming the pair. CMDB-030
is a conservative subset and logs, every run, that it under-detects serials
until a manufacturer pattern library is built from the estate's own formats.

**Confirmations and corrections of 16 Sep 2026.** *Two modifier families, encoded as
such.* `MODIFIER_FAMILY` marks every modifier `per_ci` or `population`. A per-CI
fact (Business Critical support, production, shared infrastructure, an approved
exception) changes what the record is CHARGED and at Systemic zeroes it; a
population fact (the class defect rate, the materiality floor) changes only where
the finding is REPORTED, and `POPULATION_MODIFIERS` is derived from the family so
the two can never drift. A class-wide pattern is one finding at base + one band.
*The 5× lands on the defect, not the victim*: CMDB-033 carries
`deduction_multiplier_by_record`, charging the twin with no relationships five
times its band — which zeroes it — while the populated twin pays an ordinary
duplicate charge. *Frequency guards are defaults that must be argued with*: when
the serial (> 10 CIs) or name (> 5 CIs of one class) guard fires it prints the
estate's own frequency histogram beside it. *CMDB-037* no longer blanket-skips
cross-source `correlation_id` collisions — those are usually the IRE merge that
did not happen — and skips only where every source involved is registered in
`independentKeySpaces`; anything else is reported at 0.7 confidence. *CMDB-034*
replaces "same branch only" with an allowlist of permitted class pairs: a printer
and a software package sharing a name is reported (an event resolving that name
by text can bind to either) at 0.75 confidence with the branches named, instead
of being suppressed.

**The data-quality slice is per dimension and per RULE INTENT (19–16 Sep 2026).** Completeness,
correctness, uniqueness, identification and reconciliation judge records somebody
is supposed to maintain, so Retired (7), Stolen (8) and Absent (100) CIs are out
of both their findings and their denominator — `dqActive` in `cmdb-signals.js`,
and `dimensionScope` on the score, which reports `records_scored` and a
`scope_note` per dimension. The lifecycle dimension (D8, CMDB-085/087) keeps every
one of them: evaluating those statuses is what it is for. A CI with an EMPTY
install_status stays in scope — it is not retired, it is unmaintained — and is
counted in `measures.cis_without_install_status` until a lifecycle rule owns it.
Decision 5 of 16 Sep 2026 made the second half explicit: every rule carries an
`intent` in the tracker and the catalogue, beside `systemic_kind`.

| intent | what it judges | CI set |
|---|---|---|
| `quality` | records somebody is supposed to be maintaining | live only — Retired (7), Stolen (8), Absent (100) excluded from findings AND denominator |
| `contradiction` | the states quality rules skip: a status that disagrees with itself, an edge into a dead CI, a retired CI still being discovered | the FULL estate |

`cisForRule` in `cmdb-signals.js` hands each rule its set; 24 of the 141 rules are
contradiction rules (CMDB-023–026, 056, 061–065, 073, 076, the D8 lifecycle group,
113–114). A record a contradiction rule actually charged JOINS its dimension's
denominator, so the mean still describes exactly the records that dimension
judged — no more and no fewer.

**CMDB-023 derives its permitted set, and names no stage (16 Sep 2026).** For each
class, the instance's own `life_cycle_mapping` says which stages `install_status`
can reach and which `operational_status` can reach. A stage BOTH can reach is a
claim either field is able to make; two such claims that differ are a
contradiction. Measured on dev424910 for `cmdb_ci`: install reaches Operational,
Purchase, Deploy, Inventory, End of Life, Missing; operational reaches
Operational, Design, Inventory, End of Life — so the shared set is Operational,
Inventory, End of Life. In Stock + Operational contradicts; Installed +
Non-Operational (Operational + Design) does not, because only the operational
field can say Design — "installed but down". `Defective`, `End of Operation` and
`To Be Determined` exist as lifecycle controls on that instance but **no legacy
value maps to them**, so they are stages the instance genuinely does not map and
can never take part.

**Group 5 — Identification and reconciliation (D4/D5).** CMDB-044…055, in
`cmdb-identification.js`. D4 asks whether IRE can tell two CIs apart; D5 whether
the right source wins each attribute. Verified on dev424910: `cmdb_identifier`
(409) and `cmdb_identifier_entry` (471) carry real configuration;
`cmdb_metadata_hosting`/`_containment` (88/145) say which classes are dependent by
design, which is CMDB-047's guard; `sys_object_source`,
`cmdb_datasource_precedence`, `cmdb_datasource_last_update`,
`cmdb_datasource_staleness` and `cmdb_ire_output_aggregate_stats` all exist and
are empty; **there is no `cmdb_ire_error` table on this version**. The inference
the group rests on is stated on every run: ServiceNow keeps no per-CI "processed
by IRE" flag, so CMDB-046/050 infer a bypass from a missing `sys_object_source`
row — and when that table holds no rows at all, they SKIP rather than report a
100% bypass rate, because "we cannot see the machinery" and "the machinery is off"
are different facts. Configuration findings (CMDB-044/045/047/048/049/051/052/
054/055) name config records and carry an `unscored_reason`: they gate or are
reported, and never charge the CIs they govern — one misconfigured identifier
would otherwise zero a whole class.

**Confirmations of 16 Sep 2026 (Group 5).** *Attribute strength is three tiers, not
two*: strong (serial, correlation_id, asset tag, UUID), medium (network identity,
or a STRUCTURAL COMPOSITE of two or more of host / container / install_directory
/ port…), weak (name and other labels). A single structural attribute is not
identity — `install_directory` alone matches every Tomcat on every host — and
CMDB-054 now compares tiers rather than a binary, so "name before serial" and
"name before host+directory" are both caught. CMDB-047 is unchanged by this:
`host` and `container` point at another CI, so a composite that identifies is
still dependent, and the rule still wants an independent local criterion.
*Latent defects*: an identification rule with a defect whose class holds no CI is
pre-ignition, not harmless — it is kept out of the score and the gate and listed
in `measures.latent_identification_defects` (rule, identifier, class, defect), 238
of them on dev424910. *CMDB-045 is one grouped gate finding* naming the classes,
with `grouped_classes` driving one remediation step per class, because seven
separate blockers saying the same thing made the trust gate unreadable.

**A KPI cannot gate on a capability the estate does not have.** A `measured_kpi`
gates because a measured failure invalidates what the composite means. When the
thing measured is ABSENT rather than failing — no service map to traverse from
(CMDB-057 below a floor of 5 live services), no Discovery installed at all
(CMDB-070) — a gate would report a purchasing decision as a measurement. Such a
rule sets `systemic_kind_override` on its finding and must say why in
`systemic_kind_override_reason`; `scoreCmdbQuality` then treats it as posture:
surfaced, never gating, never scored, and labelled with what it was downgraded
FROM. The override is **downgrade-only** — a rule cannot promote itself into the
gate, so gate membership stays the catalogue's decision.

**A rule may declare a smaller CHARGE for a record it still reports in full.**
`deduction_band_override` is read by `applyMateriality`, which is the one place
the charge is computed — a rule writing `deduction_severity` itself would simply
be overwritten on the next pass. It too is downgrade-only, and it is ignored for
a record the CI's own context escalated to Systemic. CMDB-058 is why: an
orphaned laptop and an orphaned database are both holes in the map, and only one
of them matters to impact analysis.

**Group 6 — Relationships (D6).** CMDB-056…069, in `cmdb-relationships.js`. What
the instance keeps decides what can run (verified on dev424910, 16 Sep 2026):
`cmdb_rel_ci` has **no source and no last-confirmed column**, so CMDB-063 and
CMDB-066 skip and say why; `cmdb_rel_type` carries descriptors only and **no
permitted class scope**, so CMDB-064 and CMDB-065 take their scope from
`cmdb_metadata_hosting`/`_containment` (the instance's own direction rules) and
report every other type as unscoped rather than judged. A self-loop is reported
without the type table — a CI related to itself is a cycle whatever the type
means — while longer cycles wait for it, because symmetric types (`Exchanges data
with::Exchanges data with`) must be excluded first or every peer pair reads as a
cycle. CMDB-058 charges orphans only in classes something models: a class where
not one CI has an edge is ONE finding about an unmodelled class (unscored), not
1,767 orphans — measured on `cmdb_ci_spkg`. CMDB-057 traverses from every service
to depth 8 and publishes the reachable share; CMDB-067 benchmarks each service's
depth against the estate's own 75th percentile rather than an imposed standard.
CMDB-056 compares the edge count against earlier runs
(`measures.relationship_counts`, the same snapshot mechanism as CMDB-038). The
three older hand-written rules this group replaces — REL-SELF, REL-DUPLICATE,
CMDB-UNRELATED — step aside with a "subsumed by" skip rather than reporting the
same defect twice.

**Decisions of Sep 2026 (Group 6).** *Classes are per-estate settings, expressed
as subtree ROOTS* expanded through the class hierarchy, so an estate's own
subclasses are covered without editing code — with the coverage boundary stated
rather than papered over: hypervisors outside the server subtree, storage arrays
and network gear carry things through relationship types `hostingTypes` does not
name, and CMDB-059 under-detects there by design. *Orphans are charged by
relationship expectation, not silenced by patterns*: the 808 leaf devices on
dev424910 charge LOW and the unrelated databases charge in full, because letting
a class-wide pattern suppress the records under it would score the worst-modelled
estate best — the D1 runaway in reverse. *Both metadata tables are declared
scope*, and `is_reverse` is honoured on both: it is set on 31 of 88 hosting rows,
and ignoring it inverted the permitted direction for a third of the metadata,
which is the very mistake CMDB-065 exists to report. Containment stores its pairs
as a TREE — `ci_type` is the child and `parent_id` points at another row of the
same table. *Edge provenance is never approximated*: `sys_created_by` names
whoever's session wrote the row, not the edge's origin, so CMDB-063 and CMDB-066
stay permanently not-measured with a reason rather than confidently wrong.
*CMDB-067's benchmark is checked for circularity* — it is a percentile of the
same services it judges, so it is refused unless at least 5 services reach
anything and their depths span a tier; and its 60% pass bar is flagged in the
KPI's own `alerts` as this build's configurable default, not a catalogue
threshold.

**Group 7 — Freshness and source coverage (D7).** CMDB-070…079, in
`cmdb-freshness.js`. The dimension asks not "is the record right" but "is
anything still saying so", and on dev424910 the answer is mostly nothing — which
makes this the group where refusing to score matters most. **Discovery is not
installed**: `discovery_schedule` is not a table on this instance, which
`classifyFailure` reports as `unavailable` rather than a failed read, so asking
for it costs nothing and the answer IS the finding. CMDB-070 therefore reports
posture instead of gating; CMDB-071 and CMDB-072 skip, because a subnet nothing
was ever going to scan is not a gap and an invented tolerance is an opinion with
a number in front of it. With no per-CI source attribution (`sys_object_source`
and `cmdb_datasource_last_update` both empty) CMDB-074 refuses to count the
single `discovery_source` column — that would report every estate as 100%
single-sourced, a fact about the schema. With `cmdb_metadata` absent, CMDB-076
reports the gap AND the reason it matters: **2,659 of 2,784 CIs share one
`sys_updated_on`**, so record-level freshness reads as near-perfect while no
attribute has been confirmed by anything — exactly the illusion CMDB-076 exists
to break. CMDB-077 is not measured **by choice**: the CI keeps only its last
updater, and reading `sys_audit` to do it properly would make the CMDB module
report "changed" on every incremental check and destroy scan reuse — a trade
stated rather than made silently. CMDB-078 publishes the manual share as an
explicit UPPER BOUND because purged import sets look manual, and CMDB-079
refuses to report 0% import-sourced, which would state a retention policy as a
measurement. What the estate CAN answer: CMDB-073 (all 50 CIs claiming "Other
Automated" have an empty `first_discovered`), CMDB-075 (22 CIs untouched since
creation, the oldest by 6,885 days) and CMDB-078. A retired CI that discovery is
still finding is measured here, in `measures.retired_still_discovered`, and
charged by CMDB-087 in D8 — counted once, not twice.

**Group 7 follow-ups (Sep 2026).** *Class tiers are ONE setting* — `CLASS_TIERS`
in `cmdb-signals.js`, shared by D6 and D7 (host, application, hub,
infrastructure, endpoint, discoverable), because three rule packs each carrying
their own class lists is three lists that disagree. UPS, racks and network gear
are INFRASTRUCTURE, not endpoints: a rack full of servers depends on the UPS.
*Script accounts are seeded from the estate*, not hardcoded — the seed (names
plus name shapes) is matched against the accounts that have actually written a
CI here, and the resolved list is named in the finding, because a ratio nobody
can check is not a measurement. *`sys_audit` is OPT-IN* (`optIn` on its spec,
excluded from `DEFAULT_TABLES` and from every module's table list): it is an
append-only log that changes on every run, so reading it by default would make
the CMDB module report "changed" on every incremental check and destroy scan
reuse. A caller enables it by naming it in `tables`, and CMDB-077 stays
permanently not-measured until they do.

**The bulk-touch pair — CMDB-142 and CMDB-143 (minted Sep 2026).** A
synchronised mass write does not mean the records are fresh; it means their
freshness is UNVERIFIABLE, and the estate must not be able to buy a clean
freshness score with a scheduled job. Measured on dev424910: **2,659 of 2,784
CIs (95.5%) share one `system` write on 2026-04-30**, which made record-level
freshness read as near-perfect and hid every one of them from CMDB-075
permanently. CMDB-142 charges each of them — the inverse of a stale charge,
"touched, but the touch carries no information" — and CMDB-143 publishes the
share as a gating `measured_kpi`, because when freshness cannot be believed every
age-based measure in the composite is reporting a job's schedule. A real
migration is exempt: it changes attributes and leaves audit rows to prove it, so
where `sys_audit` is opted in the test is made, and where it is not the rule says
the test could not be run and drops to 0.8 confidence rather than withholding or
asserting. A share alone is not a mass write — an absolute floor stops two saves
on a ten-CI estate reading as a job. D7 fell from 76.7 to 46.6 when this landed,
which is the point.

**Group 8 — Lifecycle and retirement (D8).** CMDB-080…090, in
`cmdb-lifecycle.js`. **The dimension that runs the other way**: every rule here
is a CONTRADICTION rule over the full estate, because the records it judges are
exactly the ones D1–D7 exclude. Three arrived tagged `quality` (CMDB-080, 081,
082) and could therefore never have fired — "Retired CI still holding active
relationships", evaluated over a CI set with the retired CIs removed, is a rule
that cannot match. Corrected in the tracker and pinned by a test, because the tag
IS the behaviour. **The two `install_status` columns do not share values**:
`cmdb_ci` and `alm_asset` both use the name, but `10` is Consumed on an asset
while Absent is `100` on a CI, and `8` is Missing on an asset and Stolen on a CI
— so every state test resolves the LABEL from `sys_choice` first, and mapping by
number would have invented contradictions. On dev424910, 941 asset-CI pairs are
linked, 821 agree and 7 disagree. **Not one CI here is retired**, so six rules
evaluate against an empty population — reported as an evaluated result, never as
a skip, since "no retired CI is doing this" and "we could not check" are
different facts. CMDB-089 is the SINGLE HOME for the 117 CIs with no
`install_status` at all (D1 deliberately leaves them here; CMDB-021 is a class
ratio, never a per-record charge). Two rules consume D7 rather than recompute it:
CMDB-087 reads `measures.retired_still_discovered`, and CMDB-088 reads
`measures.record_freshness` and DECLINES to measure a retirement backlog on an
estate where 95.5% of timestamps come from one job. A retention period is never
assumed — with no policy configured, CMDB-090 points at CMDB-101 instead.

**Two invariants that are checked, not remembered (Sep 2026).**

*The intent invariant.* A rule whose SUBJECT is a dead-status population but
which is tagged `quality` cannot fire — the tag strips the very CIs it exists to
find. Three shipped that way (CMDB-080/081/082) and were caught by reading them.
`intentMisTags` in `cmdb-signals.js` now checks the whole catalogue on EVERY run
and reports violations in `manifest.catalogue_warnings`, because a per-rule test
only catches the ones somebody remembers to write. It reads title and detection
logic only — a false-positive guard that merely mentions retirement is discussing
an exception, not declaring a subject — and it immediately found a fourth:
**CMDB-101**, which measures retired CI age against a retention period and was
tagged `quality`. Now `contradiction`, and the invariant reports zero.

*Label resolution for cross-table status.* `install_status` exists on `cmdb_ci`
AND `alm_asset` with different choice lists: `7` is Retired on both, but `10` is
Consumed on an asset while Absent is `100` on a CI, and `8` is Missing on an
asset and Stolen on a CI. Comparing the numbers across that boundary would have
produced hundreds of confident, wrong findings over 941 linked pairs. `choiceLabels`
in `cmdb-signals.js` is the standard for every cross-table status comparison from
here: read the instance's own labels and compare MEANING, never encoding. The
numeric fallback is declared in the finding when it is used, because one is a
fact about this instance and the other an assumption about ServiceNow.

**Group 9 — Data Manager and attestation (posture track).** CMDB-091…101, in
`cmdb-governance.js`. **Not a scored dimension**: every rule sits on the
`governance` track with no dimension, so none of it deducts from the composite —
proven live, where Group 9 produced 14 findings and the composite stayed at
exactly 76.9. The reason is worth stating: attestation measures whether anybody
ANSWERS for the data, which is a different question from whether the data is
right. An estate can attest diligently to wrong records, or hold perfect records
nobody has signed for; folding the two together would let good governance
disguise bad data. CMDB-091 is Systemic with `systemic_kind: posture` — surfaced,
never gating. **Two mechanisms are read, because an estate may run either, both
or neither**: the modern Data Manager is `cmdb_data_management_*` (NOT
`cmdb_data_manager_*`, which is not a table on any version here) and attestation
on dev424910 is the LEGACY Certification module, since `dcf_*` is not installed.
"Not configured" and "not installed" stay different findings — an estate without
the product has not neglected anything. What the estate showed: 3 Data Manager
policies active and never executed (the oldest 1,709 days after creation), 6
attestation configs with no attester at all, 2 whose attester group has no active
members, **561 failed attestations against 52 certified**, 97 certification tasks
open past 60 days, and one `cmdb_ci` archive rule that is switched off — which is
what CMDB-090 in D8 defers to when it declines to measure a retention breach.

**Group 10 — Ownership (D9).** CMDB-102…108, in `cmdb-ownership.js`. A scored
dimension again after the posture group (weight 6), so the active-status filter
returns: nobody needs to own a decommissioned server, and dead CIs leave both the
findings and the denominator. The theme is that **a filled-in field is not an
owner** — a support group with no members, an owner who has left, an assignee who
merely holds the device: each reads as "owned" on a report and answers nobody.
Group membership is resolved AT EVALUATION TIME (`sys_user_grmember` with
`user.active` dot-walked), never from the group record, because a group row that
exists and is marked active says nothing about whether anybody is in it.
`assigned_to` is deliberately NOT ownership but IS reported as a recoverable
signal, which is what the catalogue's "any inferable owner signal" asks for.
CMDB-107 measures concentration against the WHOLE in-scope estate rather than the
owned subset — one person holding 10 of 33 owned CIs is 30% of the owned set and
0.4% of the estate, and only the second number is about how much one absence
would strand. On dev424910: **2,684 of 2,784 CIs (96.4%) have no owner, manager
or support group**, 35 of 35 classes have no class-level data owner (posture,
ranked by the findings that have nobody to receive them — `cmdb_ci_spkg` alone
carries 3,977), and two support groups with no members carry 13 CIs. D9 = 84.9.

**An opt-in table nobody read is not an input (Sep 2026).** A live bug the
end-to-end tests caught: the dependency tracker records every table a rule
TOUCHED, and the rules do touch `ctx.estate.sys_audit` — they have to, to
discover it is absent and say so. Since `sys_audit` is opt-in it had no stamp, so
every CMDB scan found an input it had never read, concluded it must re-read, and
no module would ever have been reusable again — the optimisation the planner
exists for, undone by a table that was deliberately skipped. `inputsOf` now
ignores an opt-in table with no baseline stamp, and still checks one that was
genuinely read.

**Validation debt (Sep 2026).** A rule that passes its fixtures and has never
fired against a real estate is not validated, it is plausible. The tracker now
carries a **validation debt** sheet, generated from the same results file the
status columns come from so it cannot drift: **32 rules** proved only by
fixtures, because dev424910 has no retired CIs, no Discovery, no reconciliation
definitions, no growth and no per-CI source attribution. It is the standing
priority batch for the first populated-instance validation, assembled as it
accrues rather than reconstructed later from memory.

**CONSEQUENCE SCOPING — the same decision, now named once (Sep 2026).** *When a
defect is near-universal, severity is carried by the CIs where the gap has
operational consequence, not by raw count.* It was decided three separate times
before anybody named it: D1 charges a computer for a missing IP; D6 charges an
orphaned database in full and an orphaned laptop at LOW; D9 charges ownership by
what one absence would strand. `consequenceOf` in `cmdb-signals.js` is the shared
implementation, so Group 11 and everything after it inherits the decision instead
of re-making it. **Both halves are required**: the per-record charge is SCOPED
(never suppressed — every defective record is still reported and still charges
something), AND the estate-wide fact is raised ONCE as a zero-point pattern.
Scoping without the headline hides "96.4% of this estate has no owner" behind
deliberately uneven charges; the headline without scoping is the raw count again,
where 2,684 laptops outweigh every database. A rule doing one and not the other
has got this wrong. Where the share is extreme (default 80%), the headline
SELF-DISCLOSES the parameter it measured and prompts for the alternative, because
a near-universal absence is occasionally the wrong field being measured.

**WARRANTED EXPECTATION — the principle under consequence scoping (named 17 Sep
2026).** *A class's expected data is a function of what that class is for;
absence is a defect only where presence was warranted.* It is one idea that was
decided three times: CMDB-124 expects no relationships from software packages or
laptops, D6 charges an orphaned database in full and an orphaned laptop at LOW,
and D9 charges ownership by what one missing owner would strand. This is what
separates SAOS from a naive checker. Charging every absence equally floods: 1,767
software packages without edges, or 2,684 laptops without an owner, drown the
handful of databases and servers where the same gap stops an impact analysis.
Charging by warranted expectation stays honest because every expectation is a
named, per-estate setting that the result discloses whenever it decides a verdict,
so a customer whose estate does warrant the data can raise it and re-run. It is
never a hidden exemption.

**Group 11 — CSDM linkage (mixed track).** CMDB-109…115, in `cmdb-csdm.js`.
Unlike Group 9 this group is **not uniformly posture**: CMDB-109/110/113/114 feed
the scored D10 dimension, and CMDB-111/112/115 are CSDM-maturity posture. The
distinction is not stylistic — CMDB-113/114 are contradictions, two records in
the same instance asserting different things, while CMDB-112 measures how far an
estate has climbed the CSDM ladder, which is a programme's progress and not a
data defect. `CSDM_TRACKS` DECLARES which is which and `trackMisroutes` checks it
against the catalogue every run, alongside the intent invariant, because a
posture rule that quietly acquires a dimension starts charging the composite and
a D10 rule that quietly loses one stops — and neither announces itself. On
dev424910 **the CSDM class model is not in use** (business service, application
service, discovered service, service offering, business app and business
capability classes are all empty; all 42 services sit on the base class) and
**`svc_ci_assoc` is empty**. So the rules name the missing layer rather than
reporting zero defects — "no Business Service is unreachable" and "there are no
Business Services" look identical in a count and are opposite findings — and
CMDB-113/114 refuse outright, because a symmetric difference against an empty set
would report all 220 relationship edges as disagreements, which is the
catalogue's own documented false positive. Where a layer is absent the rules fall
back to the base service class and SAY SO, the same discipline as the
principal-class fallback: a fallback that is not named is an assumption.

**Group 12 — Consumption and trust (D10).** CMDB-116…123, in
`cmdb-consumption.js`. The dimension that asks whether anybody USES the CMDB: a
CMDB nobody consults is not a data-quality problem, it is the whole problem
expressed as silence. **D10 is shared and Group 12 completes it** — CMDB-109/110/
113/114 (Group 11) and CMDB-141 were already in it, so this group ADDS records
(CMDB-121) and KPIs (CMDB-117/118/123) to that set rather than replacing them.
No rule re-derives another's defect: CMDB-121 asks whether work REFERENCES a CI,
CMDB-115 whether it is in the service model, CMDB-105 whether anybody owns it —
the same CI can fail all three and each is a different question. Tracks are mixed
again (`CONSUMPTION_TRACKS`, checked by the same `trackMisroutes` guard):
CMDB-116/119/120/122 are context-only. **CMDB-116 is the trust score itself and
is `derived`** — computed FROM the composite, so charging the composite would let
the number mark its own homework, and gating would make a low score proof of its
own untrustworthiness. It is shown with the default-weight caveat and deducts
nothing. CMDB-119 judges only classes that actually extend `cmdb_ci` (the five
`u_cmdb_qb_result_*` tables on dev424910 are Query Builder output, not CI
classes), and CMDB-120 never marks an estate down for ServiceNow's own deep
hierarchies.

**`parseDate` moved to a leaf module, `time.js` (Sep 2026).** Ten rule packs
imported it from `rules.js`, which every pack also depends on for its engine — so
each one closed an import cycle. ESM tolerated that only while `rules.js` was
imported FIRST; importing a rule pack directly resolved the cycle the other way
and left `rules.js` reading a rule-list export that had not initialised yet
(`ReferenceError: Cannot access 'CONSUMPTION_RULES' before initialization`). A
pure function with no dependencies now lives in a file with no dependencies, and
`rules.js` re-exports it so nothing else had to move.

**THE BLEND IS PER DIMENSION TYPE, NOT ONE GLOBAL RATIO (Sep 2026).** A
dimension blends its mean record score with the mean pass rate of its percentage
rules, and one ratio for all ten assumed they ask the same shape of question.
Measured when D10 completed: record part **96.0**, KPI part **0.0** — so the
blend ALONE decided the score, 67.2 at 70/30 and 38.4 at 40/60. And the record
part was near-inert *by design*: consequence scoping correctly quiets a long tail
of unreferenced laptops, leaving a mean that barely moves, while the KPI half was
saying something stark and true. So the ratio now follows the shape of the
question — `record` 70/30 (completeness, correctness, uniqueness, lifecycle,
ownership), `mixed` 60/40 (relationships, freshness, identification,
reconciliation), `estate` 30/70 (consumption). This is consequence scoping one
level up: where a defect is near-universal and low-consequence per record, the
per-record mean stops being informative and the weight belongs with the measure
that still is. Live effect: **D10 67.2 → 28.8, D6 73.4 → 65.4, D7 46.6 → 42.0,
composite 81.1 → 77.0.** Each dimension publishes the blend it used, so a score
can be re-derived.

**CMDB-116 — one number, three qualifications.** The composite is the figure
somebody screenshots, so it is never shown alone. `composite.variants` publishes
the same arithmetic three ways — raw, coverage-qualified, gate-qualified — each
carrying the caveat of what it does NOT account for, and the **gate variant is
dominant**: when the trust gate is open it shows NO VALUE AT ALL, because the
other two are describing a number nobody should act on. Live on dev424910 the
gate variant is blank against 7 blockers while the raw figure reads 77.0. Still
`derived`, still deducting nothing — presentation, not scoring — and the
default-weight caveat the catalogue requires ships with it. **The All view shows
them too (17 Sep 2026).** It had shown the CMDB tile as "77% Mostly healthy" with the
gate open, because the tile took its word from the number alone and the variants
appeared only on the CMDB tab. The view that shows everything must also show
whether to believe it: the tile now carries the gate label, and the three variants
sit under the tiles.

**Group 13 — Scale and platform impact (platform indicator).** CMDB-124…130, in
`cmdb-scale.js`, on the `platform` track with no dimension: this group asks
whether the CMDB has grown into a shape the PLATFORM struggles with, a different
question with a different owner from whether the data is right. A perfectly
accurate CMDB can still be why a list view times out. **These rules are the most
likely to be superlinear themselves**, so each is written against counts and
aggregates, shares one pass over the CIs, and is individually timed into
`measures.scale_timings` — **2 ms total across all seven** on a 2,784-CI estate.
CMDB-124's expected edges-per-CI band is DERIVED from the estate's own class mix
and the derivation is printed in the finding, so a network-weighted estate is not
marked down for running denser than a server-weighted one. CMDB-125 and CMDB-128
ABSTAIN until they have 2 and 3 snapshots: "no growth observed" and "no growth"
are different findings. CMDB-127 declines outright because `sys_db_index` does
not exist on this version and `sys_index` is refused to admin — reporting "no
index" from a table we are forbidden to read would be reporting our own access as
an estate defect. `syslog_transaction` (292,530 rows) is opt-in for the same
reason `sys_audit` is.

**Two standing principles, stated once.** *A confident wrong percentage is worse
than an honest gap* (CMDB-119 declining to compute an overlap from a partial
attribute signature). And its twin: *a limitation of the measurement environment
is disclosed as SAOS's OWN gap and is never charged to the estate* (CMDB-127:
`sys_db_index` absent, `sys_index` refused to admin — "no supporting index" from
a table we may not read would bill the customer for our access). Every rule that
meets a forbidden, absent or unread table follows both.

**CMDB-124, per tier (Sep 2026).** The first version combined tiers weighted by
CI COUNT, and on dev424910 1,767 software packages at a default of one expected
edge set the estate's bar single-handed — the finding measured the parameter.
Now software and logical classes expect zero edges, each tier is judged against
its own expectation, the estate verdict weights tiers by EXPECTED EDGE MASS so a
large zero-expectation tier carries no weight, and the tier the verdict rests on
is named in the finding with the setting that decides it. **Endpoints expect zero
too (17 Sep 2026)**: with software at zero, 843 laptops at 0.5 edges each became
421.5 of 795.5 expected edges and flipped the verdict on their own (0.277 "far
below" with them, 0.575 in band without). Almost no estate maps laptop
relationships, and one that doesn't was never expected to (warranted expectation,
above). Every tier set to 0 is named in the result with the edges it carries
anyway: "raise the setting and re-run if you model them".

**A dimension discloses what its KPI half rests on.** `kpi_basis` on every
dimension lists the KPIs that measured, the ones that produced no measurement (`unmeasured`), the share of the
dimension they carry, and any that are also trust-gate blockers. On dev424910,
D10's KPI half is 70% of the dimension and rests on CMDB-141 alone while
CMDB-117/118 abstain below their volume floor — and CMDB-141 is also a gate
blocker, so the estate hears one signal twice. The caveat says so, so 28.8 is not
read as a broad consumption assessment. **The zero case too (CMDB checkpoint, 17 Sep 2026):** the
disclosure first fired only when at least one KPI measured, so D1, with CMDB-021
built and silent, read 73.8 as a complete score with no caveat while D7 and D10
disclosed a merely PARTIAL KPI half. A dimension now discloses an ABSENT KPI part,
and the mirror case: a KPI-only score while its record rules charged nothing.

**Group 14 — Drift and regression (trend track). The last CMDB group.**
CMDB-131…138 in `cmdb-drift.js`. Every rule compares THIS run with earlier ones,
never gates and never scores — with one deliberate exception to "never changes a
current finding": **CMDB-132 feeds the `recurred` escalator**. A finding seen,
verifiably closed and seen again is escalated one band, which raises its charge
and its priority. A closure only counts as verified when the finding's own rule
was still producing findings in the run where it was absent; otherwise the rule
may simply not have run.

*Comparability is the whole game.* dev424910's own history shows why: two
consecutive CMDB runs read 82.1 then 77.0 and held 11,618 then 20,954 findings —
all of it rule changes that week, none of it the estate. `scoringComparability`
(rules.js) hashes the rule-pack version (now 3.0.2), the implemented rule set,
every rule's scoring attributes, the dimension weights and the per-type blends,
and is stored in each manifest. Trend rules compare only snapshots with the same
key, say how many they set aside and why, and CMDB-137 names the naive comparison
it refuses. `RULE_VERSION` must be bumped when a rule's detection logic changes,
because the hash cannot see inside a rule.

*A real latent bug, found building this.* The history reader returned only
`duplicate_sets` and `relationship_counts`, so CMDB-096 (`class_growth`) and
CMDB-125/128/129 (`scale_snapshot`) could never leave abstention in production —
their fixture tests injected history directly and never touched the reader. The
reader is now `cmdb-history.js`, pure and tested: every trend measure is declared
once in `TREND_MEASURE_KEYS`, and a snapshot is only a CMDB snapshot if it is not
an ITSM-only scan, not a verification, not a degraded CMDB read and (for its
findings) not truncated — each of which would otherwise read as every defect
resolved.

*Verification runs both ways.* CMDB-131 counts a finding as RESOLVED only when its
rule still produced findings this run, and as CREATED only when its rule produced
findings on the earlier run. A rule that measured nothing before may not have been
measuring (below a volume floor, a table unread, findings dropped by routing), so
its findings are published as `newly_measured` and are not charged as new defects.
The cost is symmetric: a rule's genuinely first defect reads as newly measured.
The first build guarded only the resolved half, which could not flatter the net
position but could darken it.

*Findings and skips route to the same module.* `scopeOf` used to route a finding
by its domain, while a skip (which carries only a rule id) routed by rule prefix.
The Group 13 rules report through `performance_agent`, whose domain is Platform,
so on every CMDB-only scan their findings were filtered out and their skips kept:
live on dev424910, CMDB-124 was out of band and showed neither. The fixture tests
called the pack directly and never passed through `analyze()`'s module filter.
Findings now route by rule prefix first and by domain only for an id no prefix
claims; all 77 (rule, domain) pairs stored on the instance resolved identically
before the change. A test holds `scopeOf` equal to `scopeOfRule` for every
catalogue rule under any domain, and a regression test goes through `analyze()`.
This and the CMDB-131 change are the first `RULE_VERSION` bump under the
discipline above (3.0.0 → 3.0.1); no run keyed under 3.0.0 had been persisted.

*Comparability is a property of the MEASURE (17 Sep 2026).* The first build left
it to each rule, and two rules reading the same measure disagreed: CMDB-134
required the key for duplicate-set membership and CMDB-038 did not.
`MEASURE_COMPARABILITY` in `cmdb-history.js` now tags every stored measure:
- **raw:** a count the platform holds (relationship counts, CIs per class,
  creation dates). It is compared across rule versions.
- **derived:** a result our rules, thresholds or settings produced (duplicate
  sets, stale-CI lists, bulk-touch groups, attestation outcomes, findings,
  scores). It is compared only under the same key.

`comparableHistory` enforces the tag, and `EstateRules.history` is an accessor
that passes every assignment through it. So no rule can see a derived reading
from another model, and none can opt out; an untagged field never reaches a rule.
A source-scan test fails if any rule reads a history field no tag governs. When
unsure, a measure is derived: a wrong `derived` costs a baseline, a wrong `raw`
reports a rule change as estate change. It has the same shape as
`MODIFIER_FAMILY`: the property belongs to the thing, not the caller.
`TREND_RULE_INPUTS` maps each history-reading rule to its measure, so what a rule
change resets is derived, not listed by hand. CMDB-038, 131–135, 137 and the
`recurred` escalator reset. CMDB-056, 096, 125, 128, 129 and 136 read raw counts
and keep their baseline.

*A RETURNING-CUSTOMER CAPABILITY, NOT A FIRST-SCAN ONE.* The honest cost of
comparability is that every rule change resets the derived baseline. Recurrence
and the score trend need two earlier scans that READ the CMDB under the same rule
version, so the third such scan is the first where the layer can fully evaluate.
Until a rule version is frozen for an engagement, the layer is dark. A scan that
finds the CMDB unchanged is a verification: it reuses the last result and stores
no snapshot. A rule change alters the engine key and forces a full read. **Nobody
should expect drift detection in a first engagement.** `measures.trend_readiness`
states this on every run (dark / partial / live, how many comparable scans exist,
what resets). Every abstention waiting on comparable scans says it too, and so
does the README.

*The stable-estate replay is a permanent test*
(`health-cmdb-stable-replay.test.js`). It runs three real `runHealthCheck` scans
of one unchanged in-memory estate a day apart, each handed the history
`cmdbHistoryFromRuns` builds from the runs before it: the production path end to
end, minus the database write. It requires:
- no finding disappears;
- no drift finding, recurrence, created or resolved finding, or new duplicate set;
- a flat composite and flat dimensions.

The one legitimate addition is a history-reading measure reaching its snapshot
floor, and CMDB-131 must count that as newly measured. The test found its first
defect on its first run: CMDB-128 told an unchanged estate its relationships were
"growing at 0.0 rows/day". It now says flat is flat.

*Where a scan's time goes.* `manifest.phases.analyse_stages` times each rule pack
and lists the tables it read, beside the existing per-table read times (`coverage[t].ms`)
and per-metadata-read times (`meta.cmdb.reads[k].ms`). Measured on dev424910's
stored CMDB scan: of 480 s, table reads took 368 s, metadata reads 104 s and the
whole rule evaluation 2 s, so a slow scan is a reading problem before it is a rule
problem.

**Group 4 — Uniqueness (D3).** CIs sharing one exact identity value (serial, IP,
MAC, FQDN, correlation_id) form a duplicate set; sets sharing a member are one
identity cluster, and every finding about a cluster carries it as `dedupe_key`,
so a record caught by several rules pays one charge — the heaviest. CMDB-033
(one member related, another not) charges 5× and replaces the symmetric charge
through that key. CMDB-039 reports per discovery-source pair with an
`unscored_reason`. Guards are frequency-based where the catalogue says so: a
serial on more than 10 active CIs is a bad default, a name on more than 5 CIs of one class is
generic; address sets exclude loopback, link-local, 0.0.0.0, configured VIP ranges
and cluster / load-balancer / NAT / VM-object classes; CMDB-034 compares classes
in one branch under `cmdb_ci` (which itself extends `cmdb` on a real instance)
and skips directly related CIs. "Active" is `install_status` ≠ 7 in code: the
platform's `install_status!=7` query also drops CIs with an empty status (117 on
dev424910), so Aggregate cross-checks add `^ORinstall_statusISEMPTY`. De-duplication tasks
are `reconcile_duplicate_task`, their CIs `duplicate_audit_result.follow_on_task`.
CMDB-038 (posture) needs three snapshots of duplicate-set membership: each run
records `measures.duplicate_sets` in its manifest, and the route passes earlier
runs' measures in (`cmdbMeasureHistory`) — the rule pack stays pure. CMDB-043 is a
measure (`measures.open_dedup_tasks`), never a finding.

**Measured cost.** Each meta read records its duration. On dev424910 the identity
reads took 545 s of a 20-minute run because they covered every identification
entry; they are now limited to identifiers applying to a populated class's
lineage — the same run then took 690 s (from 1,184 s) with identical findings.

Findings carry the catalogue fields in `health_findings.scoring_json`
(migration 27, replay-safe). Runs recorded before it keep their pass-rate score.

### 16.8b Overall Health — the Full System Scan's one number (21 Sep 2026)

`health/overall-health.js`, model `overall-health/1`. It sits ABOVE the module
scoring layer and consumes nothing below a module's summary:

```
overall = Σ w_i × S_i ÷ Σ w_i     over the scored areas (CMDB, ITOM, ITSM); equal weights; Platform weight 0
```

**What it is.** The mean share of attainable health across the scored areas,
each area counting once in its own unit (a CI, a capability check, a work
record). **What it is not:** a finding count, a record percentage, a rule pass
rate, a risk score or a coverage score. A missing area is dropped and the rest
renormalised — never 0, never 100.

| beside the number | what it is | where it comes from |
|---|---|---|
| **status** | Not scanned → Score unavailable → **Assessment incomplete** → the band (Healthy / Mostly healthy / Needs attention / Needs work). *Assessment incomplete* — any scored area gated or withheld — REPLACES the health word, as it does on an area card | `scoreOverall` |
| **attribution** | when assessed, the worst area in a worse band than the estate, named ("ITSM needs work"); informational, never a rule | `scoreOverall` |
| **coverage** | assessed ÷ (assessed + instance-actionable gaps), per area under `instance-actionable/1` — CMDB measured dimension weight, ITOM checks lost to a read failure, ITSM rules the instance could have let run (`blocker.kind`), Platform tables read in full — rolled up with the same weights; never in the score | `moduleContract` |
| **systemic** | blockers (CMDB gate) · posture (CMDB posture kinds + all ITSM Systemic) · escalated_inside_score (already in the CMDB number); nothing is counted twice | `moduleContract` |
| **module_breakdown** | every area's score, declared and effective weight, band, assessment state, coverage, model key | `scoreOverall` |
| **scoring** | `{ model, weights, coverage_definition, status_rules, participants, module_keys, key }`; the key hashes all of them, so a weight change, a module model change or a fourth participant starts a new series and `store.trend()` breaks the line | `scoreOverall` |

Every area's summary now carries the module contract (`assessment`,
`coverage_share`, `coverage_detail`, `systemic`, `scoring`); a full scan's
manifest carries `scopes.all` with the overall, a module-limited scan's does
not, and `composedView()` computes the same thing over each area's latest
result. The page reads `scopes.all`; it never averages in React.

### 16.9 Module scans and the incremental change check

**A scan names its modules.** CMDB, ITOM, ITSM, Platform — or Full System Scan,
which is all four. Each module keeps its own latest result and time:
`health_runs.modules_json` says which modules a run holds results for (NULL for
runs recorded before this, which were full scans; `[]` for a run that only
verified). A module's current result is simply the newest finished run that
covers it, so an ITSM-only scan never replaces the CMDB result. The All view is
composed from the four (`GET /modules`), and its findings list reads each
module's findings from that module's own run, every row carrying its `run_id`.
A module-limited scan reads that module's declared tables plus `cmdb_ci` and
`cmdb_rel_ci`, runs only the rule families that can report for it, and drops
findings and skipped checks of modules it did not check. The CMDB governance
reads run only when CMDB is being read, and a scan without CMDB has no CMDB
number rather than one computed over the CIs it read for another module.

**Why not "fetch only `sys_updated_on > last scan`".** The rules judge whole
tables (duplicates, class sizes, relationship walks, the mean over every CI), and
no local copy of the records is kept — a decision of 15 Sep 2026. Changed rows
alone would be judged against nothing. So the unit of reuse is the module:

| step | what happens |
|---|---|
| rule out | no earlier result · rules, catalogue, settings or the module's accepted risks changed (engine key) · a different account · result older than 24 h · full re-read asked for |
| check | every input table of the module (declared, plus what its rules actually read last time — recorded while they ran, and charged to the module that declares the table when a rule family reports for several): one Aggregate call, row count + newest `sys_updated_on`; CMDB also checks its governance sources (`cmdbMetaSources`) |
| decide | all unchanged → the result stands, verified now, nothing read · anything changed → that module is read in full |

An insert or update moves the newest timestamp; a delete moves the count. For
tables the instance keeps a deletion log for (audited collections and
`glide.ui.audit_deleted_tables` — read from the instance each run) the check also
counts `sys_audit_delete` rows since the stamp. On dev424910 that is 16 of the 44
tables; `cmdb_ci` is not among them, so the count is compared for every table.

**The check asks the read's own question.** `sliceWhere` builds the whole
encoded query — the table's slice AND the cutoff bound — and the read and the
check both use it, each at its own moment. Measured on dev424910: one change
request carries `sys_updated_on` of 2035-08-22; a check that left the bound out
counted a record the read never saw, and `change_request` looked changed on every
run for ever, which kept CMDB and ITSM from ever being reused.

**Stamps are taken before the read and belong to the result.** The stamp is the
read's own count call (`changeStamp` returns the count and the newest update in
one request), made immediately before the page walk, so anything that changes
afterwards moves it — a false "changed" costs a re-read and a false "unchanged"
cannot happen. A module is compared against the stamps in the manifest of the
run that PRODUCED its result, never against a shared per-table timestamp: an
ITSM-only scan re-reads `cmdb_ci` too, and moving a shared stamp would let the
next CMDB check reuse a result computed from older rows. A read cut off by the
row limit carries no stamp; a read that walked to its end is stamped even when
row-level ACLs hide some rows (on dev424910 `sys_script` shows 5,729 of 5,796
every time — requiring completeness made Platform unreusable). A log table has no
`sys_updated_on` (`discovery_log` extends `syslog`), so its newest `sys_created_on`
is used. A table that failed is stamped with how it failed, so
"invalid table" on a PDI without Event Management stays unchanged until it stops.
Stamps, checks and verifications are recorded only after `completeRun` — a failed
or stopped scan leaves every earlier baseline exactly as it was.

**The configuration table.** `health_table_scan_state` (migration 28) holds, per
instance and table, whether change checking is on (off = always read in full),
the last complete read, its stamp, whether deletions are logged and the last
check's result — shown as *Scan state* on the page, toggled with
`PATCH /scan-state/:table`. `health_module_state` records when a module's result
was last verified unchanged and by which run. Pruning never removes a module's
current result, however many scans of other modules follow it.

**A degraded result is never kept.** A scan whose reads failed still produces
findings — fewer of them, because the rules that needed those reads skipped.
Measured on dev424910: a second full scan came back with 68 fewer findings and a
CMDB score eight points higher, because the instance had slowed to the point of
failing governance reads. Each module's result records which of its reads failed
(`manifest.degraded`), and a module with any is re-read rather than reused, so a
bad hour cannot be kept as good news. A table that is absent on the instance, or
whose rows an ACL hides, is not degradation — those are stable facts the findings
already state.

**What cannot be seen.** Time alone changes some findings (a CI crosses 90 days
untouched) with no row changing — hence the 24-hour limit. A record changed by a
script that suppresses system fields does not move `sys_updated_on`. Row-level
visibility changes for the same account are caught only when they move a count.
Each run's manifest carries per-phase and per-table timings, so the cost is
measured rather than guessed: on dev424910 a 500-row page of `cmdb_ci` takes about
8 s and a change check about 1.5 s.

---

## 17. The things that must stay true

If a change would break one of these, it is the wrong change:

1. **One** executor, **one** verifier, **one** approval gate, **one** evidence
   builder, **one** cancellation path, **one** redactor.
2. Nothing outside `servicenow/` talks to the instance.
3. The Experience layer reads; it never executes, approves or verifies.
4. A shipped migration is never edited; the schema is at **26**.
5. `prompts.js` is frozen.
6. An unclassified tool is a test failure, not a silent exclusion.
7. No component of the UI has success-shaped vocabulary of its own — "verified"
   is always the server's word, interpolated.
8. Capability `UNKNOWN` is never treated as available.
9. A refusal is never turned into a retry.
10. When the system cannot establish something, it says so. A confident answer
    that is not backed by evidence is the one failure mode this entire
    architecture exists to prevent.
