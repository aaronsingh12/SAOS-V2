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
│   │   │                         rule pack · manifest · store · remediation (§16)
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

**Current schema version: 25.**

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

Estate health: read an allow-listed slice of the instance, run a deterministic
rule pack over it, and report findings. Ported from SAOS, a separate Python
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
without the approval gate, without the read-back and without the audit trail;
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

**No second approval card.** The plan route raises one because its plan came
from a sentence the human has not seen. Here they have just read the exact
change list and pressed Approve and apply — that *is* the approval, with
`user_click` provenance. Re-prompting would train people to click through the
gate. A global auto-approve preference is deliberately **not** threaded through
either: a session-wide setting must not widen what one specific approval covered.

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

---

## 17. The things that must stay true

If a change would break one of these, it is the wrong change:

1. **One** executor, **one** verifier, **one** approval gate, **one** evidence
   builder, **one** cancellation path, **one** redactor.
2. Nothing outside `servicenow/` talks to the instance.
3. The Experience layer reads; it never executes, approves or verifies.
4. A shipped migration is never edited; the schema is at **25**.
5. `prompts.js` is frozen.
6. An unclassified tool is a test failure, not a silent exclusion.
7. No component of the UI has success-shaped vocabulary of its own — "verified"
   is always the server's word, interpolated.
8. Capability `UNKNOWN` is never treated as available.
9. A refusal is never turned into a retry.
10. When the system cannot establish something, it says so. A confident answer
    that is not backed by evidence is the one failure mode this entire
    architecture exists to prevent.
