# SAOS-V2 — Project Report

*How the project is built, how its parts connect, and how they work together.*
*Prepared 23 Sep 2026 against branch `agamya_SAOS` at commit `07dd936`. Every
number here was read from the code or measured on this checkout. Where the
existing docs disagree with the code, §15 lists the difference.*

---

## Contents

1. [What this project is](#1-what-this-project-is)
2. [At a glance](#2-at-a-glance)
3. [Repository map](#3-repository-map)
4. [System architecture](#4-system-architecture)
5. [Startup and runtime](#5-startup-and-runtime)
6. [Server: the ServiceNow layer (`servicenow/`)](#6-server-the-servicenow-layer)
7. [Server: the agent kernel (`agent/`)](#7-server-the-agent-kernel)
8. [Server: plans and the seven domains](#8-server-plans-and-the-seven-domains)
9. [Server: storage and memory (`memory/`)](#9-server-storage-and-memory)
10. [Server: Health Assist (`health/`)](#10-server-health-assist)
11. [Server: knowledge, meetings, routes](#11-server-knowledge-meetings-and-routes)
12. [Client (React)](#12-client-react)
13. [The two Python sub-projects](#13-the-two-python-sub-projects)
14. [End-to-end walkthroughs](#14-end-to-end-walkthroughs)
15. [Findings: risks, gaps and doc drift](#15-findings-risks-gaps-and-doc-drift)
16. [Testing and validation](#16-testing-and-validation)
17. [The rules the design depends on](#17-the-rules-the-design-depends-on)
18. [Glossary](#18-glossary)

---

## 1. What this project is

An **agentic studio for ServiceNow**. You connect a ServiceNow instance
(usually a free Personal Developer Instance, a "PDI"). Then you work on it in
two ways:

- **Module consoles.** Regular UI pages for incidents, service catalog, Flow
  Designer, SLAs, ACLs, tables, applications, update sets and audit.
- **An AI agent.** You say what you want in plain language. The agent inspects
  the instance and proposes each change, then **stops at an approval card
  before any write**. After a write it reads the record back to prove the
  change landed.

On top of that sit three larger capabilities:

- **Health Assist.** A read-only estate health checker for CMDB, ITOM, ITSM and
  Platform. It uses deterministic rule catalogues (143 CMDB rules, 139 ITSM
  rules), scores each area and offers AI-proposed fixes that a human must
  approve.
- **Live flow authoring.** The model generates ServiceNow SDK ("Fluent")
  TypeScript. It is compiled offline, installed with the official `now-sdk` CLI,
  read back, and optionally proven by firing it on a real record.
- **Meeting Intelligence.** A Windows capture agent records meetings and a local
  Whisper sidecar transcribes them. The model extracts findings, which can be
  handed to the agent to build.

The project's central principle, stated in `ARCHITECTURE.md`:

> A successful tool call is never equivalent to a successful outcome.

ServiceNow often returns `201 Created` for writes it silently discarded, so
nothing trusts HTTP status. Every mutation is read back, and the UI shows the
read-back verdict.

**Names.** The same product has three names in this repo:

- `NowForge`: git history, `ARCHITECTURE.md`, `CONTRIBUTING.md`, the SDK app name.
- `NowHelpAssist`: `README.md`, the package names, the server banner.
- `SAOS`: the current UI title ("SAOS — Agentic ServiceNow Studio").

`SAOS` is also the name of the separate Python service in
`SAOS_functionalities/`, whose rules Health Assist was ported from.

---

## 2. At a glance

| Part | Tech | Size (this checkout) | Port |
|---|---|---|---|
| `server/` API | Node ≥ 22.5 (tested 24.18), Express 4, `node:sqlite`, ESM | 281 `.js` files, ~105k lines | 4000 (loopback only) |
| `client/` UI | React 18, Vite 5, react-router 6, react-markdown | 77 files, ~23k lines | 5173 (proxies `/api` → 4000) |
| `server/test/` | `node:test`, offline, no instance | 209 files, ~71k lines, **3,859 tests** | — |
| `server/scripts/` | live-PDI validations + model evaluations | 44 scripts | — |
| `server/fluent-workspace/` | ServiceNow SDK 4.12 app, scope `x_tepv_nwforge` | 25 managed `.now.ts` sources | — |
| `SAOS_functionalities/saos/` | Python FastAPI service (legacy/parallel) | 45 files, ~4.1k lines | 8000 |
| `meeting-agent/` | Python, Windows-only audio capture + Whisper | ~2.1k lines | STT on 4600 |

**Runtime dependencies are deliberately minimal.** The server's only npm
dependencies are `express` and `cors`. Storage, HTTP, crypto and process control
all come from Node built-ins.

**LLM providers:** Anthropic (default model `claude-sonnet-4-6`), plus an
OpenAI-compatible adapter that serves OpenAI (`gpt-4o`), Ollama (`llama3.1`),
OpenRouter (no default; you must pick one) and `opencode`. The docs report
building and measuring against `gpt-oss:120b-cloud` through Ollama.

**Git:** 230 commits between 17 Aug and 22 Sep 2026. Authors: Aaron Singh
(190), "NowForge" (21), Agamya Tanwar (10), ani-44 (9). The remote is
`github.com/aaronsingh12/nowforge`.

---

## 3. Repository map

```
SAOS-V2/
├── package.json            root: `npm run dev` starts both halves (scripts/dev.mjs)
├── scripts/dev.mjs         launcher: spawns server+client, prefixes output, watches /api/system/health
├── setup-mac.sh            one-shot macOS installer (brew, node 24, clone, deps, start)
├── start-mac.command       double-click launcher for macOS
├── README.md               product/feature documentation (805 lines)
├── ARCHITECTURE.md         the architecture map and invariants (1,979 lines)
├── CHANGELOG.md            the "hardening sprint" write-integrity guarantees
├── CONTRIBUTING.md         branch/PR workflow
│
├── client/                 React UI
│   └── src/
│       ├── App.jsx         router + shell (sidebar, toasts, confirm dialog, meeting dock)
│       ├── api.js          request() + sse() — the SSE reader that enforces a terminal frame
│       ├── pages/          14 pages (see §12)
│       ├── components/     41 .jsx components + 15 plain .js helper modules
│       ├── hooks/          useHealth, useBinding, useScopeLabels
│       └── styles.css / experience.css
│
├── server/
│   ├── src/
│   │   ├── index.js        boot: migrations → ledger seed → SDK probe → meetings requeue → listen
│   │   ├── logging.js      one log stream (server + forwarded browser logs), key-based redaction
│   │   ├── config/store.js settings.json (connection · llm · agent · dba · rag · skills)
│   │   ├── servicenow/     46 modules — the ONLY code that talks to the instance
│   │   ├── agent/          the turn loop, 117 tools, providers, plans, 7 domains, skills
│   │   ├── memory/         SQLite storage: 29 migrations, sessions, ledger, audit, recall
│   │   ├── health/         Health Assist: extraction, rule packs, scoring, remediation
│   │   ├── knowledge/      documentation corpus ingestion + retrieval
│   │   ├── meetings/       meeting capture, transcription queue, understanding, handoff
│   │   └── routes/         17 Express routers, ~230 endpoints
│   ├── test/               offline suite (+ fixtures recorded from real instances)
│   ├── scripts/            *-pdi.mjs (live), *-model-eval.mjs (real model), ITSM catalogue tools
│   ├── fluent-workspace/   the SDK application (flows, catalog UI policies, DBA tables, keys.ts)
│   ├── fluent-workspace-archive/  archived sources (archiving = deletion on next install)
│   └── data/               gitignored: settings.json, nowhelpassist.db, meeting audio
│
├── SAOS_functionalities/saos/  Python FastAPI CMDB/ITOM analysis service (origin of Health Assist)
├── meeting-agent/          Python Windows capture agent + Whisper STT sidecar
├── docs/                   research ledger (fluent-research.md, 6,234 lines), diagnostics, demos
├── reports/                DBA module verification and fixes (31 Aug 2026)
├── tmp-guide/              an unzipped .docx (SDK deployment runbook) — scratch
└── tmp-nowforge-init/      an SDK init scratch folder — scratch
```

---

## 4. System architecture

### 4.1 The whole system

```
 ┌─────────────────────────── Browser (localhost:5173) ───────────────────────────┐
 │  React SPA: module pages · Agent workspace · Health Assist · Meetings · Audit   │
 │  api.js: request() for JSON, sse() for streams (throws if no terminal frame)   │
 └───────────────┬─────────────────────────────────────────────────────────────────┘
                 │ /api/*  (Vite proxy)
 ┌───────────────▼──────────────── Node server (127.0.0.1:4000) ─────────────────┐
 │ routes/ (17 routers) ──► agent/ ──► servicenow/ ──► ServiceNow instance         │
 │        │                  │            │    ├─ REST Table / Aggregate API       │
 │        │                  │            │    ├─ now-sdk CLI (build / install)    │
 │        │                  │            │    └─ execution harness (server script)│
 │        │                  ▼            │                                        │
 │        │              providers/ ──────┼──► LLM (Anthropic / OpenAI / Ollama /  │
 │        │                               │         OpenRouter)                    │
 │        ├──► health/ (reads only; writes go through the plan executor)          │
 │        ├──► meetings/ ◄── meeting-agent (heartbeat, segments) ; ──► STT :4600  │
 │        └──► memory/  ──► server/data/nowhelpassist.db (SQLite, WAL)             │
 └─────────────────────────────────────────────────────────────────────────────────┘

 Separate and not wired to the Node app:
   SAOS_functionalities/saos  (FastAPI :8000, Postgres/SQLite, Redis, its own SN client)
```

### 4.2 The layered write path

This diagram is the core of the design (from `ARCHITECTURE.md` §2, checked
against the code):

```
  Agent Workspace (React)        reads + invokes; owns nothing operational
          │ POST → SSE
  Agent kernel                   orchestrator.js runTurn() — the turn loop
          │
  Planner (optional)             plan/ — canonical plan, $ref dataflow, fingerprint
          │
  Policy / Gate                  approval nonce + provenance, write-guard, sys_id
          │                      provenance, plan-time trap check, capability discovery
  ONE executor                   executeTool() — refuses a mutation without a resolved approval
          │
  ServiceNow                     REST · SDK · harness
          │
  Read-back / verify             mutation-pipeline.js → write-verify.js (field diff)
          │
  Evidence                       mutation_ledger, tool_events, evidence builder (redacted)
```

Every arrow points one way. Architecture tests check the import graph:

- `health/` never imports the table client's write methods.
- The Experience layer (`agent/activity`, `agent/skills`) imports no executor.
- The 20 safety-critical modules never name an LLM vendor.

### 4.3 The three transports to ServiceNow

The platform forces a choice of transport for each operation:

| Transport | Used for | Scope of what it creates | How it becomes portable |
|---|---|---|---|
| **REST Table / Aggregate API** (`servicenow/client.js`) | records, schema, ACL reads, catalog, SLA, counts | always **global** (a `sys_scope` on insert is accepted and silently ignored) | update-set "sweep" (`transport.js`) |
| **ServiceNow SDK** `now-sdk` 4.x (`servicenow/fluent.js`) | flows, subflows, catalog UI policies, scoped tables/columns | the app's own scope | the scoped app itself |
| **Execution harness** (`servicenow/execution-harness.js`) | run a server-side script once (call a subflow, elevated/impersonated writes) | n/a | n/a |

---

## 5. Startup and runtime

### 5.1 Starting the app

- `npm run dev` at the root runs `scripts/dev.mjs`. It spawns `npm run dev` in
  both `server/` and `client/` through a shell (Windows `.cmd` shims need one),
  prefixes each line with `server │` or `client │`, and shuts both down if
  either exits. On Windows it uses `taskkill /T` so no orphan keeps port 4000.
- It polls `GET /api/system/health` every 3 s and prints a loud
  `API │ … NOT RESPONDING` line if the server dies. `node --watch` parks rather
  than exits, so exit codes alone would not catch that.
- Server: `node --watch src/index.js`. Client: `vite` on 5173, proxying `/api`
  to `localhost:4000`.

### 5.2 Server boot sequence (`server/src/index.js`)

1. Mount `cors()`, `express.json({limit: '2mb'})` and the request logger, then
   the 17 routers under `/api/*`, then a JSON error handler (`SnowError` keeps
   its HTTP status).
2. **Refuse any non-loopback `HOST`.** The server has no authentication, holds
   admin credentials, and `/api/agent/approve` authorises writes, so it exits
   unless bound to `127.0.0.1`, `localhost` or `::1`.
3. `getDb()` runs any pending SQLite migrations **before** listening, so a
   broken database stops boot instead of failing the first chat.
4. `seedLedger()` loads the per-instance "trap" facts.
5. `primeCapability()` starts the SDK capability probe in the background (about
   8 s of CLI startup). Until it finishes, SDK capability is honestly `UNKNOWN`.
6. `closeOrphanedRecordings()` and `requeuePending()` recover meetings a crash
   left half-done.
7. Listen, retrying `EADDRINUSE` 10 × 250 ms (the `--watch` restart handoff).
   Signal handlers call `closeAllConnections()` so the next process can bind
   at once.

Two modules are imported for their side effects:

- `instance-binding.js` registers the instance-switch hook: saving a new
  connection flushes every per-instance cache.
- `post-install-state.js` hooks the post-install reconciler into every SDK
  deploy.

### 5.3 Configuration (`server/src/config/store.js`)

One file, `server/data/settings.json` (gitignored, plaintext). There is no
`.env` for the Node app.

| Section | Keys | Notes |
|---|---|---|
| `connection` | `instanceUrl`, `authType` (`basic`/`oauth`), `username`, `password`, `clientId`, `clientSecret` | Trimmed on save. Paste mistakes (spaces, smart quotes) show up as warnings. |
| `llm` | `provider`, `apiKey`, `baseUrl`, `model`, `embedModel` | Provider names are known only inside `agent/providers/`. |
| `agent` | `autoApprove` (false), `holdMutationsOnQuestion` (true), `liveHosts` ([]) | Auto-approve only works for hosts named in `liveHosts`. |
| `dba` | `allowIrreversible` (false) | Only the Settings route writes it. No agent tool can reach `saveSettings`. |
| `rag` | `enabled`, `corpusDir`, `maxContextChunks` (6), `releaseOrder`, `allowedHosts` | Knowledge retrieval settings. |
| `skills` | `installed`, `disabled` | The skill registry lives here, not in a table. |

`publicSettings()` redacts secrets before sending settings to the browser.
`clearConnection()` (logout) also triggers `memory/instance-purge.js`, which
deletes every row filed under that instance.

---

## 6. Server: the ServiceNow layer

`server/src/servicenow/` has 46 modules and is **the only code that talks to
the instance**.

### 6.1 Transport core

- **`client.js`**
  - Auth is Basic, or an OAuth password grant with a token cache. Refresh
    tokens are not implemented.
  - `snowFetch()` is the throwing wrapper; `instanceRequest()` is the
    non-throwing transport (needed for the flow-activation processor).
  - `diagnoseFailure()` turns a 401/403/404 into a specific cause: a
    business-rule abort (names the rule), a table-level ACL, a row-level ACL,
    "missing or hidden", or credentials. The credential advice differs for a
    PDI (`devNNNN`) and a corporate instance (MFA, SSO, missing REST role).
  - `table.{query, get, create, update, remove, count, changeStamp, countBy,
    aggregate}`. Every read uses `sysparm_display_value=all`, so each field is
    `{value, display_value}`.
  - `assertScopeIntentHeld()` sits at the single create funnel. If a create
    asked for a scope and the platform demoted it to global, it fails loudly.
- **`schema.js`**: walks `sys_db_object.super_class`, merges `sys_dictionary`
  (most-derived wins), attaches `sys_choice` and reference targets, detects each
  table's display field, and provides `referenceLookup` and `tableLookup` for
  typeahead.
- **`instance-binding.js`**: one UI-owned source of truth for "which instance".
  It builds the SDK's auth environment variables from `settings.json` on every
  call, so the CLI's stored alias is inert and the REST and SDK tiers cannot
  point at different instances. Per-instance caches register here and are
  flushed on a switch.
- **`write-verify.js`** (pure): `diffWrite()` compares requested fields with the
  record the platform returned and classifies the write as `ok`, `no-op`,
  `partial`, `transformed` or `unverified`. A frozen
  `sys_mod_count`/`sys_updated_on` means nothing was written.

### 6.2 Feature modules

| Module(s) | What it does |
|---|---|
| `catalog.js`, `catalogPolicy.js` | catalog items, variables (live type codes with a fallback), choices, variable sets, order guides, record producers; **catalog UI policies authored through the SDK**, because `catalog_ui_policy_action` silently drops its two key fields over REST |
| `flows.js`, `flow-artifact.js`, `flow-design.js`, `subflows.js` | read flows/subflows (`_v2` tables), decode the compressed `trigger_inputs` blob, activate, design blueprints; static analysis of Fluent source (triggers, actions, subflow contracts, reuse, dependency graph `calls`/`calledBy`) |
| **`fluent.js`** (4,761 lines) | the live-authoring pipeline (see §14.2): capability probe, codegen, static gates, offline `now-sdk build` with up to 3 diagnostic-fed retries, one serialized install queue, read-back, `verify()` / `verifySubflow()` / `verifySchedule()` |
| `codegen-guards.js` | guards A2–A5: pinned artifact names, promised literals, `trigger_strategy` lint, `RetryLedger` (refuses a byte-identical re-ask), blueprint fidelity |
| `sdk-setup.js`, `sdk-catalogue.js`, `workspaces.js`, `post-install-state.js` | install/bootstrap the SDK workspace; read the SDK's built-in action catalogue; find workspaces (any dir with `now.config.json`); republish flows after an install reverts them to draft |
| `sla.js`, `conditions.js` | SLA definitions: duration encoding, encoded-query field checking (an unknown field is *dropped* by the platform), calculated-field derivation (`priority` ← `impact`+`urgency`), live breach-clock verification |
| `acl.js`, `acl-spec.js`, `acl-authoring.js` | ACL report across the inheritance chain, two-role diff, plain-language explanation (with degenerate-repetition detection); ACL authoring specs, normally unreachable except through elevation |
| `diagnostics.js` | flow execution states, waits, record audit/journal/SLA/CI-relationship readers used by Doctor and NowTest |
| `transport.js`, `transport-export.js` | update-set capture by **sweep**: after each mutating call, re-parent the resulting `sys_update_xml` rows into `NHA · <session> · <scope>` sets, grouped by the row's own application; XML export built from Table API reads, with parity checks |
| `applications.js`, `app-create.js`, `business-rules.js`, `notifications.js` | list scopes (read through `sys_scope`, since `sys_store_app` is 403 over REST); create real scoped apps through the SDK (validates vendor prefix and the 18-char limit); business rules; notifications |
| `dba-*.js` (8 modules) | Database Administration: context (engine, recovery plugins, rollback retention), metadata with keyset paging, schema intelligence, impact/preflight, **table/column authoring through the SDK**, data ops with an irreversible-operation gate (snapshot + typed confirmation phrase + `allowIrreversible`) |
| `execution-harness.js`, `script-liveness.js` | run a server-side script once via a one-shot `sysauto_script`, confirm it actually ran (sentinel), read outputs; call subflows through `sn_fd.FlowAPI` |
| `role-elevation.js`, `role-model.js`, `elevation-gate.js`, `elevation-shim*.js`, `required-role-classifier.js` | **Elevation**: raise the runner's role (e.g. `security_admin`) for one atomic, approved operation. Eligibility fails closed. |
| `impersonation.js`, `impersonation-target.js` | **Impersonation**: perform a write *as another user*, with eligibility checks and its own audit table |
| `semantic/` | semantic types, derived fields, artifact kinds, and a provenance ladder (`fact` / `unknown` / `ambiguous` / `unsupported` / `unavailable`) |
| `binding-status.js` | compares managed sources to the instance; drives the header status |

---

## 7. Server: the agent kernel

### 7.1 The turn loop (`agent/orchestrator.js`, 3,051 lines)

**One HTTP request is one user turn, one task and one SSE stream.**

`POST /api/agent/chat` (`routes/agent.js`) does the following:

- rejects a session that belongs to another instance (409);
- opens an SSE response and calls `beginTurn()` (task tracker);
- sends a keep-alive every 15 s;
- ties an `AbortController` to the client disconnecting;
- calls `runTurn(sessionId, message, emit, {signal, taskId})`.

Inside `runTurn`:

1. **Impersonation task-boundary check.** If impersonation is active and the new
   request is not clearly the same task, the loop stops and asks.
2. **Skills.** Disabled skills subtract tools from the surface
   (`toolsForSkills`).
3. **Context engine** (`context-engine.js`, `context-selection.js`,
   `context-capabilities.js`). The request is classified into capabilities and
   only that slice of tools, rules and facts is sent. Doubt resolves toward
   *more*. If the model calls a tool outside the slice, the profile widens and
   it is told so. A narrower list is never a refusal.
4. **Knowledge retrieval** (`knowledge/context.js`). Documentation chunks go into
   the prompt as context, never as authority.
5. **Iterations** (`MAX_ITERATIONS = 30`, 4,096 output tokens, temperature 0.2):
   - **Budget and compaction** (`memory/budget.js`, `compaction.js`). If history
     would overflow, earlier turns fold into structured digests.
   - **Model call**: `providers/index.js chatTurn()` returns
     `{text, toolCalls, stopReason}`, with bounded retry on 5xx/429/drops.
   - **Turn-control guards**:
     - question + mutation in one breath → hold the calls and ask (`mutations_held`);
     - a stalled "Shall I…?" turn → one nudge;
     - unexplained mutations → bounced;
     - ambiguous targets → ask.
   - **For each tool call:**
     - not mutating → execute and emit `tool_result`;
     - mutating → the full gate (§7.2), then execute, verify, record in the
       ledger and capture.
6. **Close.** The harness (not the model) renders the **mutation report** from
   the ledger. Then exactly one terminal frame: `done`, `error` or `cancelled`.

**SSE frames the loop emits:** `meta`, `budget`, `knowledge`, `skills_active`,
`assistant_text`, `tool_use`, `tool_result`, `tool_blocked`,
`tool_not_in_context`, `approval_required`, `approval_resolved`,
`approval_cancelled`, `mutations_held`, `mutation_bounced`, `calls_discarded`,
`nudged`, `guard_forced`, `stalled_turn_ended`, `awaiting_user`, `compacted`,
`remembered`, `impersonation_*`, `done`, `error`, `cancelled`. The route adds
`task_started`.

**Cancellation.** There is no cancel endpoint. The client aborts its fetch; the
server sees the disconnect and stops at the next safe boundary. A tool already
running finishes and is recorded, and nothing is rolled back.

### 7.2 The mutation gate, in order

For every mutating tool call:

| # | Check | Module | On failure |
|---|---|---|---|
| 1 | Is the target sys_id one this session actually **observed** (tool result, user text, ledger)? | `memory/provenance.js checkWriteTarget` | hard block *before* the card; the model is told |
| 2 | Has this exact write already been **proven** a no-op this session? | `write-guard.js checkBeforeGate` | block; names the override paths (business rule / ACL / harness) |
| 3 | Plan-time trap check (e.g. writing `priority` directly) | `plan-check.js` | warning attached to the card (does not block) |
| 4 | Elevation required? | `elevation-shim-client.js` | routed to the gated-elevation path |
| 5 | **Approval card**: 32-byte CSPRNG nonce, 5-min timeout | `awaitApproval` | `approval_required` frame, wait for `POST /api/agent/approve` |
| 6 | `executeTool(tool, input, approval, provenance)` | orchestrator | refuses unless approval is `approved`+`user_click`, or `auto`+`auto_approve`+autoApprove on+host in `liveHosts` |
| 7 | `snapshotBefore` → execute → `verifyMutation` (field diff) | `mutation-pipeline.js` | `no-op`/`partial` is reported as a **failed** write in the tool result |
| 8 | `appendMutation` to `mutation_ledger` | `memory/ledger.js` | compaction cannot reach this table |
| 9 | `captureAfterTool`: update-set sweep | `capture.js` | capture failures never fail the turn; non-config writes say "data, not configuration" |

The nonce is compared with `timingSafeEqual`. Only a user click, a timeout or a
cancellation settles a wait, and those three are recorded separately: a timeout
is not recorded as a rejection.

### 7.3 Tools (`agent/tools.js` + `tools-extended.js`)

**117 tools, 44 of them mutating** (counted by loading the registry). Each tool
is `{name, description, inputSchema, mutating, execute, describeWrite}`. Groups:

- **Instance / schema:** `test_connection`, `get_table_schema`, `lookup_reference`, `lookup_table`, `query_records`, `get_record`
- **Generic CRUD:** `*create_record`, `*update_record`, `*delete_record`, `*run_server_script`
- **Diagnostics reads:** `find_flow_executions`, `get_flow_execution`, `wait_for_flow_execution`, `get_record_audit`, `get_record_journal`, `get_record_slas`, `get_ci_relationships`
- **Incidents / catalog:** `*create_incident`, `*create_catalog_item`, `*create_record_producer`, `get_catalog_item`, `*add_catalog_variable`, `*update_catalog_variable`, catalogs, categories, variable sets (`*create_/attach_/detach_…`)
- **UI policies:** `list_ui_policies`, `*create_ui_policy`, `*update_ui_policy`, `*delete_ui_policy`
- **Flows:** `list_flows`, `get_flow`, `design_flow_blueprint`, `flow_authoring_capability`, `*create_flow_live`, `*activate_flow`, `list_live_flows`, `*delete_live_flow`, `*verify_flow_live`, `*smoke_test_flow`
- **SLA:** `list_slas`, `get_sla`, `sla_meta`, `*create_sla`, `*verify_sla_live`
- **ACL:** `acl_report`, `acl_diff`, `explain_acls`, `*create_acl`, `*update_acl`, `*delete_acl` (the write bodies throw by design; they are reachable only through the elevation path)
- **Memory / knowledge:** `recall_memory`, `list_instance_facts`, `remember_fact`, `search_servicenow_docs`, `knowledge_status`, `resolve_source_conflict`, `record_verified_observation`, `list_verified_observations`
- **Apps / transport:** `list_applications`, `*create_application`, `*create_custom_application`, `check_scope_name`, `list_captured_sets`
- **Impersonation:** `*impersonation_start`, `*impersonation_switch`, `impersonation_end`, `impersonation_status`, `impersonation_provenance`
- **DBA (30 tools):** `dba_*` reads, analysis, preflight, and `*dba_create_table`, `*dba_add_field`, `*dba_modify_field`, `*dba_drop_field`, `*dba_augment_table`, `*dba_set_field_value`, `*dba_create_record`, `*dba_delete_record`, `*dba_execute_irreversible`
- **Other:** business rules, notifications, `list_agent_capabilities` (in every profile, so "what can you do" is answered from the whole registry)

(`*` = mutating.) Adding a tool also means classifying it in
`context-capabilities.js`. An unclassified tool fails a test.

### 7.4 Providers (`agent/providers/`)

- `index.js` is the only door to a model: `chatTurn()` and `chatOnce()`. It
  checks credentials per provider and resolves the default model.
- `anthropic.js` uses the Messages API and drops `seed` (unsupported).
- `openaiCompat.js` serves OpenAI, Ollama, OpenRouter and opencode. It detects
  reasoning models that burn `max_tokens` on hidden reasoning and return empty
  content, and reports a specific error for it.
- `retry.js` retries 5xx, 429, dropped connections and Ollama cold starts, with
  a bound. It does not retry 4xx.
- `contract.js` writes down the provider interface so a test can check new
  adapters against it.
- `decoding.js` (A1): temperature 0 plus a fingerprint-derived seed for
  structured generation. The docs measured that `gpt-oss` ignores `seed`, so no
  guard assumes reproducible output.

### 7.5 The other kernel modules

| Module | Role |
|---|---|
| `prompts.js` | the system prompt and operating rules; **frozen**, with a hash-guarded test. Also tells the model its iteration budget. |
| `task-tracker.js` | projects the frame stream onto `agent_tasks`/`agent_task_steps`; `runTurn` itself knows nothing about tasks |
| `task-boundary.js`, `impersonation-ops.js`, `impersonated-write.js`, `impersonation-render.js` | impersonation mode: start/switch/end, write-ahead intent, per-task boundary questions, the approval chip naming whose authority is borrowed |
| `playbooks.js` | turns a business-rule abort into the actual rule (condition, sys_id) plus four options for the user, instead of silently dropping fields forever |
| `capability-discovery.js` | "can **this** instance do X through a supported mechanism?" Deterministic, no model. `UNKNOWN` never counts as available. |

### 7.6 Skills (`agent/skills/`)

A skill is **data**: a named bundle of existing capabilities and tools. It
contains no code, URLs or credentials.

- There are 7 built-ins (in code) and user installs via `POST /api/skills`
  (stored in `settings.json`).
- Permissions are **computed** from capabilities and the `mutating` flags. A
  manifest whose declared permissions disagree is blocked.
- Disabling subtracts only capabilities that no enabled skill still claims.
- A task records its skill set when it starts.

---

## 8. Server: plans and the seven domains

### 8.1 Plans (`agent/plan/`)

A plan is a **task with steps**, stored on the same `agent_tasks` tables. It is
the other way to drive the executor, beside the chat loop:

- **`planner.js`**: the model *proposes*; the output goes straight to the
  validator.
- **`validator.js`** (deterministic): refuses capabilities this build does not
  model (treated as hallucinations), writes to derived fields, and `$ref`s to
  undeclared outputs.
- **`dataflow.js`**: `$ref` lets `step_2.result.sys_id` resolve from a
  *declared* output of step 2.
- **`canonical.js`**: one canonical form for `target` and `inputs`.
- **`fingerprint.js`**: SHA-256 over the canonical plan. Approval binds to it and
  it is re-checked before every step.
- **`states.js`**: the only edge into `executing` is from `awaiting_approval`.
- **`executor.js`**: owns ordering only. It calls the same `executeTool`,
  read-back, ledger and capture as the chat loop.
- **`review.js`** / **`store.js`**: the review projection and persistence.

`POST /api/agent/plan` creates and executes plans over SSE. Plan approval cards
resolve through the same `POST /api/agent/approve`.

### 8.2 Recovery (`agent/recovery/`)

Classify the failure (evidence first) → is it idempotent? → does policy allow it
(one table row per failure kind, no default branch)? → budget → **reconcile**
(did the effect already happen?) → hand the *identical* operation back to the
plan executor → the verifier decides.

### 8.3 Evidence and activity (read models)

- **`agent/evidence/`** builds "what actually happened, and how do we know" from
  durable rows only. No model, no network. Its rule: a plan is not a result.
  The final status comes from a pure rule.
- **`agent/activity/`** is the workspace timeline:
  - `normalize.js`: a *total* map from SSE frame to activity row, or explicitly none;
  - `status.js`: status from state with a fixed precedence;
  - `project.js`: rebuilds the timeline from the database.

  Live and durable timelines are never merged; refreshing replaces the list.

### 8.4 The seven domains

Each is a pure pipeline over reads with its own `schemas.js`, `intent.js` and
`render.js`, entered through `routes/plan.js`. Each emits exactly one terminal
frame (`<domain>_complete` or `plan_failed`).

| Domain | Entry | Question | Key rule |
|---|---|---|---|
| Incident Operations | chat / plan | change something safely | every mutation gated, read back |
| **Doctor** (`doctor/`) | `POST /plan/diagnose` | why did this happen? | read-only plan; only `diagnosis.js` (arithmetic over citations) may say "root cause"; the timeline never implies causality |
| **NowLint** (`lint/`) | `POST /plan/lint` | is this flow risky? | 12 deterministic rules over a live flow; each may say it could not check |
| **NowTest** (`test/`) | `POST /plan/test` | does the flow actually work? | fixture allowlist; an assertion may not read a value the setup wrote; 5 outcomes |
| **Change Intelligence** (`change/`) | `POST /plan/change` | what changed, what breaks? | needs two re-readable authoritative states; the diff is arithmetic, significance is a table lookup |
| **Knowledge** (`knowledge/`) | `POST /plan/knowledge` | what do we know? | live facts and retrieved docs are separate arrays; `authorises: false` |
| **Application Builder** (`appbuild/`) | `POST /plan/build` | build this app | discovery first (no duplicates); one unbuildable component blocks the whole build |

---

## 9. Server: storage and memory

### 9.1 The database

One file, `server/data/nowhelpassist.db`, opened with **`node:sqlite`
`DatabaseSync`** (WAL). This is why Node ≥ 22.5 is mandatory: the module was
added in 22.5.0. The same file provides float32 BLOB vectors and FTS5, so there
are no native dependencies.

Migrations live in `memory/db.js` `MIGRATIONS[]`, keyed on `PRAGMA
user_version`, idempotent, and run before listen. **A shipped migration is never
edited.** The current schema version is **29**.

| # | Adds |
|---|---|
| 1 | `sessions`, `messages`, `tool_events` |
| 2 | `facts`: the per-instance knowledge ledger ("traps") |
| 3 | `chunks`, `embeddings`, `chunks_fts`: recall |
| 4 | `digests`: compaction |
| 5 | `build_runs`, `build_events`: UI-driven audit |
| 6 | `capture_state`, `capture_sets`: update-set capture |
| 7 | `mutation_ledger` |
| 8 | approval provenance on tool events |
| 9 | `sysid_provenance` |
| 10–13 | `impersonation_mode`, task-boundary question, `impersonation_audit`, write-ahead provenance |
| 14 | split the audit trail from history: `tool_events_audit`, `sysid_provenance_audit` (deleting a chat keeps the record of what was done) |
| 15–19 | `meetings`, `meeting_segments`, `meeting_findings`, `meeting_evidence`, `meeting_plans`, chat origin |
| 20 | `kb_documents`, `kb_chunks`, `kb_embeddings`, `kb_chunks_fts`, `snada_observations` |
| 21 | `agent_tasks`, `agent_task_steps` |
| 22 | plan columns on the task tables |
| 23 | `task_id` on `mutation_ledger`/`tool_events` (exact correlation) |
| 24 | `health_runs`, `health_findings` |
| 25 | `health_proposals` |
| 26 | `health_finding_state` (acknowledged / muted / accepted) |
| 27 | CMDB quality `scoring_json` on findings |
| 28 | `health_table_scan_state`, `health_module_state` (incremental scans) |
| 29 | `health_itsm_parameters` (per-instance ITSM thresholds) |

### 9.2 Memory modules

| Module | Role |
|---|---|
| `sessions.js` | chat persistence, written through on every append; survives restarts |
| `compaction.js` | folds old turns into structured digests; if the summariser throws, returns nothing or is cut off, it discards nothing and says so |
| `budget.js`, `tokens.js` | measures the prompt actually sent and derives the budget from the model's real context window |
| `sanitize.js` | degenerate-request guard (blank turns, runaway digests) |
| `facts.js` | the instance knowledge ledger, seeded from `docs/fluent-research.md`'s trap ledger; injected into prompts and codegen |
| `recall.js` | semantic recall through a local Ollama embedding model (default `nomic-embed-text`); falls back to FTS5 keyword search **loudly** |
| `provenance.js` | where every sys_id in a session came from |
| `ledger.js` | the mutation ledger and the harness-rendered mutation report |
| `audit.js` | the Audit page's merged timeline (tool events + build runs), sys_id harvesting, CSV export with formula-injection escaping |
| `tasks.js` | the durable task/step substrate |
| `impersonation-mode.js`, `impersonation-audit.js` | per-session impersonation state and "who really did this" |
| `redact.js` | the **one** redactor: case-insensitive substring match on secret-like keys, at any depth |
| `instance-purge.js` | logging out deletes every row filed under that instance |

---

## 10. Server: Health Assist

`server/src/health/` has ~40 modules plus the `itsm/` engine. It is a port of
the SAOS Python service's analysis, folded into Node so there is only one path
to the instance, one credential store and one model config.

### 10.1 The pipeline

```
POST /api/health/runs {modules}          (SSE; the run belongs to the SERVER, not the page)
  │
  ├─ incremental.js   per module: engine key unchanged? account same? < 24 h? every input
  │                   table's (count, newest sys_updated_on) unchanged? → reuse, "verified"
  │
  ├─ extract.js       reads ONLY allow-listed tables (tables.js: 66 specs, some opt-in like
  │                   sys_audit and syslog_transaction), keyset paging (sys_id > watermark),
  │                   coverage per table: rows_complete, missing_fields, unavailable vs forbidden
  │
  ├─ rules.js + cmdb-*.js   deterministic, PURE rule packs (no imports of client/db/model)
  │   itsm/runner.js        ITSM: 139 catalogue rules → 10 engines via declarative JSON configs
  │
  ├─ scopes.js        CMDB / ITOM / ITSM / Platform summaries, each scored its own way
  │   cmdb-quality.js, itsm-quality.js, overall-health.js
  │
  ├─ explain.js       OPTIONAL model prose, keyed by opaque fingerprints; a reply naming an
  │                   unsent id is discarded whole
  │
  └─ store.js         health_runs / health_findings (per instance; findings kept for newest 5 runs)
```

### 10.2 Scoring by area

| Area | Score |
|---|---|
| **CMDB** | "CMDB Quality" from the SAOS catalogue (`catalogue/cmdb.json`, 143 rules, 10 weighted dimensions D1–D10). **Trust gate**: open Systemic `config_absence`/`measured_kpi` findings mark the score "Provisional — not trustworthy". Record score = `max(0, 100 − Σw)`, w = 40/15/5/1 by severity; dimensions blend record means with KPI pass rates (70/30, 60/40 or 30/70 by dimension type). Severity is base + context modifiers (production, business-critical, shared infrastructure, materiality, recurrence). |
| **ITSM** | ITSM Quality over open-or-recent incidents/changes/problems (same 40/15/5/1 deductions), blended 60/40 with the pass rate of estate-level catalogue rules |
| **ITOM** | share of *applicable* capability checks that pass (MID server, Discovery, credentials, service mapping, ECC queue, outages); an unreadable table is `not_applicable`, never a pass |
| **Platform** | deliberately **no score** (no shared denominator) |
| **Overall** | Full System Scan only: equal-weight mean over scored areas; "Assessment incomplete" replaces the band if any area is gated or withheld; never averaged in React |

**The ITSM engine** (`health/itsm/`) has ten engines: record-predicate,
aggregate, reference-integrity, linkage, configuration, relationship-graph,
temporal-correlation, audit-history, text-analysis and composite. Rule
parameters come from `rules/itsm/parameters.json` (108 parameters, 47 of them
`UNDEFINED`, with no invented defaults) and can be overridden per instance
(`PUT /api/health/itsm/parameters/:ruleId/:key`). The catalogue is
**generated** from `SAOS_Health_Rules_Tracker_ITSM.xlsx` by
`scripts/import-itsm-catalogue.mjs`.

### 10.3 Remediation (propose → review → approve → execute → validate)

1. `POST …/findings/:fp/proposal` (`proposal.js`). The model proposes values
   **only for the field the rule names**, only for the finding's own sys_ids.
   A reply naming an unsent record is discarded whole. Names are resolved
   through `referenceLookup`; ambiguity leaves the value blank and lists the
   candidates. Judgement calls carry an assumption and a confidence.
2. The human edits in `RemediationDrawer` (reusing `RecordDrawer`). The
   proposal is content-hashed.
3. `POST /proposals/:id/approve {fingerprint}`. A stale hash is refused.
   `routes/health.js applyProposal()` runs, in order:
   - `prepareRemediation`;
   - `observeTargets` re-reads targets in the remediation's session, which
     registers sys_id provenance;
   - `approvePlan` binds the plan fingerprint;
   - `runRemediation` executes through the **ordinary plan executor**, which
     still raises a per-record approval card.
4. Results are reported per record (`applied`/`partial`/`no-op`/…), then
   validated by re-reading each record against the **approved** value.
5. **Bulk Fix** (`bulk.js`) runs that same single flow once per ticked finding,
   one after another. There is no batch approval.

`health/` itself **cannot write**: its two instance seams (`extract.js`,
`instance-read.js`) are reads, and a test asserts no `table.create/update/remove`
calls exist there.

### 10.4 Lifecycle and production features

- **Finding states** are acknowledged / muted / accepted-risk, keyed on the
  finding fingerprint (`sha256(rule + table + sorted sys_ids)`). Muting hides a
  finding from view but never deletes it. Muted and accepted need a reason.
  Snoozes expire at read time.
- **One run per instance.** A `running` row not owned by this process is closed
  as *interrupted*. Stop is `POST /runs/:id/cancel` and is honoured between
  tables. The run keeps going if the page is left (`GET /runs/active`,
  `/runs/:id/stream`).
- **Trend.** Withheld scores are drawn as gaps. A comparability key (rule
  version, weights, blends) splits series when scoring changes. Drift and
  recurrence rules need three comparable scans.
- CSV export uses the audit module's single `csvCell` escaper.

---

## 11. Server: knowledge, meetings and routes

### 11.1 `knowledge/`: documentation retrieval

- **Ingestion** (`ingest.js`, `fetch-docs.js`, `sources.js`, `schema.js`)
  validates documents before they enter the corpus. Only the vendor's domain
  (plus operator-declared `allowedHosts`) counts as official. Secrets are
  redacted at ingestion. `scripts/ingest-servicenow-docs.mjs` loads from
  `servicenow-docs.urls`.
- **Store** (`store.js`): `kb_documents`/`kb_chunks`, embeddings plus FTS5, and
  version-aware ranking through the operator-supplied `releaseOrder`.
- **Precedence** (`precedence.js`): live instance state > live schema > managed
  source > verified ledger fact > documentation > model knowledge.
- **Observations** (`observations.js`): SNADA's own verified results, kept
  separate from documentation.
- **`context.js`** returns text only and cannot authorise anything.

### 11.2 `meetings/`: Meeting Intelligence (server side)

| Module | Role |
|---|---|
| `store.js`, `audio-store.js` | meeting rows; WAVs under `server/data/audio/<id>/` (gitignored); deletion verified on the filesystem |
| `queue.js` | one-at-a-time transcription queue (CPU-bound); re-queued on boot |
| `stt.js` | the one seam to the Whisper sidecar (`NHA_STT_URL`, default port 4600) |
| `supervisor.js` | starts/stops the two Python processes from the UI (`meeting-agent/.venv` only); cooperative stop via heartbeat |
| `understanding.js`, `model-json.js` | rolling model pass every ~90 s of speech → proposed findings; robust JSON extraction |
| `evidence.js` | **evidence guard**: a finding must quote text that actually appears in the transcript |
| `findings.js` | human review: confirm / correct / reject / add |
| `handoff.js` | hands confirmed findings to the **agent** as a new chat (replacing an old second orchestrator) |

### 11.3 Routes: the HTTP surface (17 routers)

| Router | Endpoints | Highlights |
|---|---|---|
| `/api/system` | 12 | `health` (the binding poll), `binding`, `settings`, `connection/test`, `connection/disconnect`, `sdk/setup` (SSE), `schema/:table`, `hierarchy/:table`, `reference/:table`, `tables` |
| `/api/agent` | 17 | `chat` (SSE), `approve`, sessions CRUD, `memory/status`, `memory/search`, facts CRUD/seed, `openrouter/models` |
| `/api/agent/plan` | 15 | plan create/execute (SSE), `/validate`, `/:taskId`, `/:taskId/evidence`, `/:taskId/activity`, `/history/:sessionId`, domain entries `/diagnose` `/lint` `/test` `/change` `/knowledge` `/build` |
| `/api/incidents` | 7 | list/filters, stats (Aggregate API), CRUD |
| `/api/catalog` | 40 | catalogs, categories, items, variables (reorder, choices), UI policies (SSE, SDK build + install), variable sets, order guides, record producers |
| `/api/flows` | 11 | list, detail, executions, design, `live` (SSE build), `live/verify`, `live/smoke`, `live/capability`, `live/catalog`, `DELETE live/:name` (409 if callers exist) |
| `/api/sla` | 8 | meta, validate (dry run), CRUD, verify (SSE) |
| `/api/access` | 3 | `acl/:table`, `diff/:table?a=&b=`, `explain` |
| `/api/dba` | 19 | table/field/hierarchy/reference/relationship/classify/choices/indexes/map reads; `action` + `action/:jobId`; `snapshot` |
| `/api/health` | 39 | runs (SSE), active/stream/cancel, modules, scan-state, findings, proposals, bulk, states, trend, ITSM parameters, CSV |
| `/api/audit` | 3 | merged timeline, run detail, CSV |
| `/api/applications` | 6 | list/get, workspaces, scope labels, plan/create custom app |
| `/api/transport` | 6 | capture on/off per session, table classification, sets, export |
| `/api/knowledge` | 8 | status, search, documents, ingest, reindex, observations |
| `/api/meetings` | 28 | agent heartbeat, segment ingest, stream, findings, understand, brief, handoff, confirm, process supervisor, STT status |
| `/api/skills` | 5 | list, get, install, enable/disable, remove |
| `/api/logs` | 1 | browser → server terminal logging |

Streaming routes use **SSE over POST**, because they carry a body.

---

## 12. Client (React)

### 12.1 Shell (`App.jsx`)

- A `BrowserRouter` with a `Sidebar` and a title bar. Each routed page is
  wrapped in an `ErrorBoundary` keyed on the path.
- **`RequiresInstance`** is a *route wrapper*. Pages that need an instance are
  never mounted while disconnected, so their load effects cannot fire and fail.
  Dashboard, Agent, Settings, Meetings and Audit are not gated.
- **`AgentChat` is always mounted** in a hidden `agent-host` div, so a running
  turn keeps streaming while you browse other pages.
- App-wide singletons: `Toasts`, `ConfirmDialog` (replaces `window.confirm`;
  shows the exact sys_id and the consequence), `MeetingDock` (capture pill on
  every page), `SAOSLoadingScreen` (a startup overlay), and
  `discoverHealthRun()` (reattaches to a running health check).

### 12.2 Pages (14)

| Route | Page | Lines | Purpose |
|---|---|---|---|
| `/` | Dashboard | 384 | connect instance, test connection, SDK setup, overview |
| `/agent` | AgentChat | 2,076 | the agent workspace: composer, transcript (markdown), approval cards, activity dock, plan/domain panels (Doctor, Lint, Test, Change, Knowledge, AppBuild), skills, sources, task history |
| `/incidents` | Incidents | 268 | schema-driven CRUD with reference pickers |
| `/catalog` | Catalog | 900 | items/variables, variable sets, order guides, record producers, `PolicyBuilder`, `VariableEditor` |
| `/flows` | Flows | 1,006 | read flows/subflows/executions, live build (SSE), verify, blueprint design |
| `/sla` | Sla | 466 | SLA definitions, condition check, verify |
| `/access` | Access | 366 | ACL report, two-role diff, AI explanation |
| `/health` | HealthAssist | 2,658 | scope switch, scorecard, severity/domain bars, coverage, findings, two-pane finding view, remediation, bulk fix, scan state, trend |
| `/tables` | Tables | 570 | Database Administration (schema intelligence, actions) |
| `/meetings` | Meetings | 525 | meeting list, transcript, findings review, handoff |
| `/applications` | Applications | 231 | scopes, managed flag, create custom app |
| `/transport` | Transport | 168 | captured update sets, export |
| `/audit` | Audit | 348 | session/mutation filters, approvals, sys_ids, CSV |
| `/settings` | Settings | 265 | LLM provider/model/key, agent options, preferences, notifications |

### 12.3 Client plumbing

- **`api.js`**: `api.get/post/patch/delete` plus `sse()`. `sse()` **throws if a
  stream ends without a terminal frame** (`done`/`error`/`cancelled`), so a
  crashed server never looks like a finished turn. The plan domains end with
  `<domain>_complete`/`plan_failed`, which `AgentChat` handles itself.
- **Hooks**: `useHealth` (one shared poller of `/api/system/health`),
  `useBinding`, `useScopeLabels`.
- **Plain `.js` helpers** (`writeOutcome.js`, `elevationOutcome.js`,
  `activity.js`, `tableForms.js`, `healthRun.js`, `startupProgress.js`, …) are
  `.js` rather than `.jsx` so the server's offline suite can import them. This
  is how UI logic is tested without a DOM.
- `logging.js` forwards navigation, console errors, uncaught exceptions and
  failed API calls to `POST /api/logs`.
- UI text follows one rule: no component invents success wording; "verified"
  is always the server's word.

---

## 13. The two Python sub-projects

### 13.1 `SAOS_functionalities/saos/`: the original SAOS service

A **separate, standalone** FastAPI app. The Node server does not call it; Health
Assist is a port of its analysis. `setup-mac.sh --with-python` can install it.

- **Stack:** FastAPI + Jinja templates + vanilla JS dashboard (`static/app.js`),
  SQLAlchemy async, Alembic (3 migrations), PostgreSQL (docker-compose, with
  Redis) or SQLite for dev, JWT auth in HttpOnly cookies with RBAC and login
  throttling, `httpx` for ServiceNow, and Ollama `gpt-oss:120b-cloud` for
  explanations.
- **Flow:**
  - read-only extraction of allow-listed tables (`servicenow/tables.py`,
    `read_client.py`);
  - rows stored as `servicenow_data_chunks`;
  - `orchestration/worker.py` claims jobs from a durable queue with leases;
  - `agents/domain_analysis.py` applies deterministic rules to a versioned
    estate snapshot;
  - findings, evidence, impacts, root causes and remediation plans are
    persisted;
  - the dashboard renders from the database.
- **Pages:** dashboard, findings, remediation, agents, audit, cmdb, itom,
  settings, estate, executions.
- **Write paths exist despite the README.** The README says "target writes are
  disabled"; the code disagrees. `api/chat.py` can create incidents, problems
  and changes (it requires the `can_execute` role). `api/remediation.py
  /remediation/{id}/execute` creates a change request and PATCHes CIs with an
  LLM-built payload. See §15.1.

### 13.2 `meeting-agent/`: Windows meeting capture

Two processes, both reporting to the Node server:

| Process | Command | Job |
|---|---|---|
| capture agent | `python -m meeting_agent` | detect a meeting (any process holding an **active microphone session**, minus a deny-list), record **two tracks** (WASAPI loopback = others, mic = you), Silero VAD (ONNX) cuts utterances, POST each to `/api/meetings/:id/segment` |
| STT sidecar | `python -m meeting_agent.stt_server` | `faster-whisper` `base.en`, int8 CPU, port 4600; auto-downgrades to `tiny.en` when the backlog passes 30 s; drops Whisper hallucinations using `no_speech_prob`, `avg_logprob` and chars/sec |

It is Windows-only (`pycaw`, `PyAudioWPatch`, COM in the multi-threaded
apartment). The UI's capture pill can start and stop both processes through
`meetings/supervisor.js`, which requires `meeting-agent/.venv`. `selftest` and
`diagnose` modules check a machine before real use.

---

## 14. End-to-end walkthroughs

### 14.1 "Assign INC0010038 to Abel Tuter" (agent write)

1. The browser POSTs `/api/agent/chat` and holds the SSE stream open. A task
   row is created and `task_started` is sent.
2. `runTurn` builds a context profile (incident capability), retrieves
   knowledge, measures the budget, and calls the model.
3. The model calls `query_records` (find the incident), then `lookup_reference`
   on `sys_user` (resolve "Abel Tuter"). Exact key matches rank first, and a
   non-exact top hit is marked `ambiguous`. Both sys_ids now have provenance.
4. The model calls `update_record {assigned_to: <sys_id>}`:
   - provenance check passes;
   - write-guard check passes;
   - plan-time trap check runs;
   - the `approval_required` card is sent with a nonce.
5. The user clicks Approve. `POST /api/agent/approve` sends `{approvalId, nonce}`
   with `source=user_click`.
6. `executeTool` runs: snapshot, PATCH, read-back diff. The verdict is `ok`, or
   for example `no-op` if a business rule discarded it. Then
   `appendMutation` → ledger, and `captureAfterTool` reports "data, not
   configuration".
7. The model summarises. The harness appends the ledger-rendered mutation report
   and sends `done`.
8. The whole turn is visible on the Audit page and in the task's evidence.

### 14.2 "Build a flow that…" (live authoring through the SDK)

```
spec → extractIntent (LLM, JSON: trigger table, artifact kind, promised effects/literals)
     → buildLiveContext: getSchema(table) with value=label choice pairs; referenceLookup for named records
     → generate (LLM + cheatsheet + SDK action catalogue + existing-subflow contracts + trap ledger)
     → STATIC GATES (all at once): promised literals · blueprint fidelity · artifact type / subflow
       contract · subflow reuse · trigger strategy · $id identity · flow-design read
     → now-sdk build (offline; ≤3 retries fed with compiler diagnostics; on failure delete candidate + rebuild)
     → now-sdk install (serialized queue; deploys the WHOLE app; post-install reconciler republishes flows)
     → read back flows.detail() → {sys_id, active, link}
     → VERIFY (separate button + separate approval): create a trigger-matching record → wait on
       sys_flow_context → assert effects → resume approvals → cleanup in finally
```

Identity comes from the **request** (a deterministic filename and a `Now.ID` key
in `keys.ts`), never from the model's chosen name. Regenerating the same spec
updates the same record. If the SDK cannot run, the agent reports
`REQUIRES_MANUAL_ACTION`. Nothing is substituted: the Business Rule fallback was
removed on 2026-09-08.

### 14.3 Health scan → fix

This is §10.1 then §10.3. The key point: the scan is read-only and belongs to
the server, and a fix travels through the same plan executor and per-record
approval cards as any agent write.

### 14.4 Meeting → build

1. The capture agent detects the call and posts utterances.
2. The queue transcribes them through the sidecar.
3. `understanding.js` proposes findings every ~90 s; `evidence.js` rejects any
   finding without a real quote.
4. The human confirms or corrects the findings.
5. `POST /:id/handoff` opens an agent chat seeded with them. From there it is
   §14.1, with every write gated.

---

## 15. Findings: risks, gaps and doc drift

These came up while reading the code for this report. They are ordered by
importance. Each was checked on this checkout.

### 15.1 Security and safety

1. **The SAOS Python service can write to ServiceNow with only a login check.**
   - `POST /api/remediation/{plan_id}/execute` (`SAOS_functionalities/saos/app/api/remediation.py`)
     calls `_execute_auto_fix`. That function creates a `change_request` and
     PATCHes CI records using a payload the LLM generated.
   - The handler requires only an authenticated user. Unlike `chat.py`, it does
     **not** check `user.can_execute`.
   - `ApprovalGuard` ("THE most critical security component… cannot be
     bypassed") is **never called** on this path. Only its
     `compute_plan_hash` helper is used, in `worker.py`.
   - The SAOS README says target writes are disabled. This arrived in commit
     `795ae14` ("integrtion aand fix the FIXING WITH AI"). The Node app's gate
     does not protect this service.
2. **Open CORS on an unauthenticated local server.** `server/src/index.js` uses
   `cors()`, which allows any origin. Loopback binding keeps other *machines*
   out, but a web page open in the same browser can still send requests to
   `http://127.0.0.1:4000`. That includes `POST /api/agent/approve` and
   `POST /api/system/settings`. The README states "CORS open" as a known local
   dev limitation. Restricting `cors({origin: 'http://localhost:5173'})` would
   close most of this cheaply.
3. **Credentials are stored in plaintext** in `server/data/settings.json`. This
   is documented and gitignored.

### 15.2 Repository hygiene

4. **A whole Python virtualenv is committed.** 9,990 of the repo's 10,950
   tracked files are under `SAOS_functionalities/saos/venv/`, plus 3,866
   `__pycache__`/`.pyc` files. `.gitignore` lists `venv/`, but ignoring does not
   untrack files that are already committed. The venv was added in `795ae14`
   (11 Sep). `git rm -r --cached SAOS_functionalities/saos/venv` (plus the
   pycache) would fix it.
5. **Scratch files are tracked:**
   - `tmp-guide/`: an unzipped `.docx`, the "NowForge Flows" SDK deployment
     runbook;
   - `tmp-nowforge-init/`: its `now.config.json` carries a `scopeId`. The
     `.gitignore` comment says such a file must never be committed, because a
     scope sys_id is instance-local;
   - an empty file literally named `SAOS_functionalities/saos/({text`.
6. **Test and demo tables ship on every install.**
   `fluent-workspace/src/fluent/dba/` includes `x_tepv_nwforge_aaron_test`,
   `…_test_demo`, `…_net_inc_demo`, `…_x_2196302_sn` and others. Everything
   under `src/fluent` is deployed by `now-sdk install`. If they are not meant to
   ship, move them to `staged/`, remembering that archiving is deletion on the
   next install.

### 15.3 Functional gaps

7. **`meeting-agent/requirements.txt` is missing the transcription packages.** It
   still holds the phase-1 list, but `stt_server.py` imports `faster_whisper`.
   A fresh setup from `requirements.txt` gets a sidecar that fails at its first
   transcription.
8. **The default model setup leaves no room for conversation history.**
   - The fixed part of every request (system prompt + 117 tool schemas)
     measures **37,991 tokens**. Output headroom adds 6,144.
   - `memory/budget.js computeBudget()` gets the model's context size from
     `probeContextWindow(llm.model)`, but returns a **32,768-token fallback**
     when:
     - `llm.model` is blank, which is the default ("blank = provider default"); or
     - the model is not in the `DOCUMENTED_CONTEXT` table and no Ollama
       `/api/show` answers. The default Anthropic model, `claude-sonnet-4-6`,
       is **not** in that table.
   - In those cases 37,991 + 6,144 is over the ceiling. The budget is logged as
     `BUDGET STARVED` and conversation history runs on the 4,000-token floor.
   - An Ollama model that answers `/api/show` with 131k gets a 60,000 ceiling
     and is fine.
   - Fix: resolve the provider's default model before probing, add current
     models to `DOCUMENTED_CONTEXT`, and/or cut down the tool schemas.
   - The same gap makes 3 tests in `budget.test.js` depend on the machine
     (§16.2).
9. **Unbound sessions never appear on the Audit page.** The two modules use
    different markers for "no instance":
    - `memory/sessions.js` files a session under the literal `'(unbound)'`
      when no instance is connected;
    - `memory/audit.js currentActor()` uses `null` and `auditSessions()`
      filters `WHERE s.instance IS NULL`.

    Chats run before connecting an instance never show in the Audit session
    list. This is the `audit.test.js` failure. The test does not pin a
    connection, so it passes only where `settings.json` has an instance.
10. The page title for `/health` falls back to "SAOS", because `TITLES` in
   `App.jsx` has no `/health` entry.

### 15.4 Documentation that no longer matches the code

| Claim in docs | Code today |
|---|---|
| README: "37 tools", ARCHITECTURE: "97 tools, 30 mutating" | **117 tools, 44 mutating** |
| README: agent loop "max 15/turn" | `MAX_ITERATIONS = 30` |
| ARCHITECTURE §7/§17: "schema version 26" | **29 migrations** |
| README: "25 allow-listed tables"; ARCHITECTURE §16: "15 tables" | `health/tables.js` has **66** specs |
| README/ARCHITECTURE: scope `x_2002152_nwforge` | `now.config.template.json`: **`x_tepv_nwforge`** |
| CHANGELOG: 511 tests; ARCHITECTURE: 151 files / 3,013 tests | **209 files / 3,859 tests** |
| ARCHITECTURE: "13 pages" | 14 page components |
| Product name | NowForge / NowHelpAssist / SAOS used interchangeably (§1) |

---

## 16. Testing and validation

### 16.1 The four layers

| Layer | What it proves | Where |
|---|---|---|
| Offline suite | contracts, state machines, import-graph architecture rules, every guard, client helpers (imported from `client/src`) | `server/test/*.test.js`, `npm test` |
| Live PDI scripts | the real instance behaves as assumed | `server/scripts/*-pdi.mjs`, `*-acceptance.mjs`, `*-dod.mjs` |
| Real-model evaluations | the model does not defeat the guards | `server/scripts/*-model-eval.mjs` |
| Client contract tests | every field a panel reads exists; every emitted status is recognised | part of the offline suite |

Fixtures for key defects are **recorded from live instances** (for example
`test/fixtures/flow-corpus/`). There is no DOM test harness, by design.

### 16.2 Test run on this checkout (Node 24.18.0)

With server and client dependencies installed, `node --test test/*.test.js`
gives **3,935 tests: 3,931 pass, 4 fail, 0 skipped** (83 s). An earlier run
without `node_modules` also failed 42 tests on missing `express`/`react`; those
are gone.

All 4 remaining failures pass or fail depending on the machine. The tests read
the developer's real `server/data/settings.json` instead of pinning it with
`_setSettingsForTests`, and this checkout has no settings file:

| Test | Why it fails here | Real bug behind it? |
|---|---|---|
| `budget.test.js` — T4 live prompt leaves room for history | no `llm.model` → 32,768 fallback; fixed prompt is 37,991 | **yes**, §15.3 #8 |
| `budget.test.js` — LIVE artifacts are not starved | same | **yes**, §15.3 #8 |
| `budget.test.js` — a small model caps the budget | blank model skips the probe, so the 8k mock is never read (gets 32,768) | test isolation only |
| `audit.test.js` — session picker offers only active sessions | no instance → `'(unbound)'` vs `NULL` mismatch | **yes**, §15.3 #9 |

Pinning `llm.model` (budget) and a connection (audit) in these tests would make
the suite deterministic. The product bugs still need their own fixes.

---

## 17. The rules the design depends on

From `ARCHITECTURE.md` §17, all confirmed in code. Breaking one means the change
is wrong:

1. **One** executor, verifier, approval gate, evidence builder, cancellation
   path and redactor.
2. Nothing outside `servicenow/` talks to the instance.
3. The Experience layer reads; it never executes, approves or verifies.
4. A shipped migration is never edited. (The docs say the schema is at 26; it is
   at 29.)
5. `prompts.js` is frozen.
6. An unclassified tool is a test failure, not a silent exclusion.
7. The UI has no success wording of its own.
8. Capability `UNKNOWN` never counts as available.
9. A refusal is never turned into a retry.
10. When the system cannot establish something, it says so.

**Extension recipes** (ARCHITECTURE §15):

- **Tool:** add it to `TOOLS` and classify it in `context-capabilities.js`.
- **Provider:** one file in `agent/providers/`, registered in `index.js`.
- **Skill:** a data manifest posted to `/api/skills`.
- **Domain:** `schemas/intent/render/index.js`, an entry on `routes/plan.js`, a
  panel, and tests.
- **Migration:** append to `MIGRATIONS`.

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **PDI** | ServiceNow Personal Developer Instance (`devNNNNNN.service-now.com`) |
| **sys_id** | 32-hex primary key of any ServiceNow record; instance-local |
| **Fluent / now-sdk** | ServiceNow's TypeScript DSL and CLI for authoring app metadata as source |
| **Approval card / gate** | the amber UI card a mutating tool waits on; resolved via `POST /api/agent/approve` |
| **Read-back** | re-reading a record after a write and diffing requested vs stored fields |
| **Provenance** | the recorded origin of a sys_id (tool result, user, ledger) or of an approval (user_click, auto_approve) |
| **Mutation ledger** | the table of every executed write; compaction cannot touch it |
| **Trap / fact ledger** | measured platform pitfalls per instance, injected into prompts (`memory/facts.js`) |
| **Sweep** | re-parenting a call's `sys_update_xml` rows into the session's update set |
| **Elevation** | temporarily raising the runner's role for one approved operation |
| **Impersonation** | performing a write as another user, with its own audit trail |
| **Coverage** | per-table account of how completely Health Assist read it; absence rules need complete coverage |
| **Trust gate** | Systemic CMDB findings that mark the quality score "not trustworthy" |
| **Fingerprint** | SHA-256 identity of a plan, a proposal or a finding (rule + table + sys_ids) |
| **SNADA** | the name the knowledge layer uses for the agent's own verified observations |
| **SSE terminal frame** | the one closing event of every stream: `done` / `error` / `cancelled` / `<domain>_complete` / `plan_failed` |
