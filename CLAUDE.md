# CLAUDE.md

## Project: NowForge

NowForge is an agentic AI platform for ServiceNow development ("Claude Code for ServiceNow").
React frontend (`client/`), Node backend (`server/`), and agent tools that act on the PDI.

### Environment facts
Verified 2026-09-24 (Job 1.1) unless marked UNVERIFIED.
- Connected instance: `dev366630` (server `data/settings.json` → `server/data/`, gitignored).
  The brief said `dev442675`; that PDI is UNVERIFIED / not the one connected.
- Workspace scope: `x_2002152_nwforge` ("NowForge Flows") — in `server/fluent-workspace/now.config.json`
  and the only NowForge scope on dev366630. `x_2196302_nwforge` does NOT exist on dev366630.
- SDK: workspace pins `@servicenow/sdk` `^4.12.2`; the server reports CLI 4.12.2 (not 4.10.1).
- Base feature branch `fluent-live-flow-authoring`: does not exist in this repo (local or origin).
  Job branches have been cut from `fixes_existing`.
- Chat model: Ollama `gpt-oss:120b-cloud`.
- The connection user is shared with interactive browser use and runs scheduled jobs, so
  "records changed by the connection user" is noisy — scope change checks by table, not by user.
- Flow Designer uses the `*_v2` tables. Verified in sys_dictionary:
  - `sys_hub_flow` (extends `sys_hub_flow_base` < `sys_hub_flow_block`): `type` = flow | subflow,
    `internal_name`, `status`, `active`, `latest_snapshot`
  - `sys_hub_trigger_instance_v2`: `trigger_type`, `trigger_definition`, `trigger_inputs` (encoded)
  - `sys_hub_action_instance_v2` / `sys_hub_flow_logic_instance_v2` / `sys_hub_sub_flow_instance_v2`
    (extend `sys_hub_flow_component`): `flow`, `order` (int), `ui_id`, `parent_ui_id`, `values` /
    `subflow_inputs` (encoded)
  - `sys_hub_flow_input` / `_output` / `_variable` (extend `var_dictionary`): keyed by `model`
- Step config blobs are gzip+base64 JSON (also plain base64 / plain JSON). Data pills reference a
  step by its `ui_id` (hyphenated sys_id) and the trigger as `<Trigger>_1`.
- A subflow call's `subflow` column points at a `sys_hub_flow_snapshot`; its `parent_flow` is the subflow.
- A record-triggered FLOW has `sys_hub_flow_input` rows (current, table_name…): trigger data, not inputs.
- Tool results are cut at 8,000 chars by the orchestrator (`RESULT_CHAR_LIMIT`) — size tool output to fit.
- `gs.dateGenerate` in encoded queries did not match UTC values over REST; use
  `RELATIVEGE@minute@ago@N` for "changed recently" checks.
- `now-sdk build` runs offline and type-checks (TS6133 unused locals/params, TS2769 wrong input types)
  — but it does NOT check table names or data-pill output names: both compile and install (Job 1.2).
- `now-sdk install` deploys the WHOLE workspace app (8 flow sources + DBA tables + catalog policies here).
  With default activation it publishes EVERY flow in the app, drafts included (seen 2026-09-20);
  with `--skip-flow-activation` published flows revert to draft (trap #129). Scoped activation
  (skip, then re-publish exactly what was published) is what create_flow_live / edit_flow now do.
  A whole-app install + scoped re-publish takes ~20 min on dev366630.
- now-sdk CLI flag casing is MIXED — `--skip-flow-activation` is kebab-case, `--demoData` camelCase.
  Check `--help`; do not assume camelCase.
- `now-sdk transform --table sys_hub_flow --id <sys_id>` pulls a UI-built flow into Fluent, but also
  emits raw Record() files tied to its published snapshot; not used automatically.
- ts-morph (TS 5.6.2) ships inside `server/fluent-workspace/node_modules` via the SDK.
- `now-sdk explain` is more reliable than the docs (UNVERIFIED this session)
- keys.ts ids == the live sys_ids of installed steps (verified on 5/5 steps), so step ↔ source is exact.
- The dev server runs `node --watch src/index.js`: saving ANY server/src file restarts it and kills an
  in-flight edit/install. Never change server code while a live install is running.
  The server also restarted once mid-edit for an unexplained reason (Job 1.2) — edit_flow keeps a
  journal (`server/data/flow-edit-journal.json`); if one is left behind, edits are refused until
  `restore_flow` on that flow has finished the recovery.
- Flow edit backups live in `server/data/flow-backups/<host>/<flow sys_id>/<timestamp>/` (gitignored).
- Trap #131 (seen live): after a flow EXECUTES, its header's `latest_snapshot` can point at an unreadable
  record, so `publishedProof` says UNKNOWN (null) while the header says active+published. Treat
  "unknown + live header" as live, or an install will leave the flow a draft.
- Only flows declared in the workspace's Fluent source are touched by an install; only those may be
  re-published. "DEMO Flow" (built in Flow Designer, no source) must never be activated by our tools.
- The chat model (gpt-oss) tends to send tool calls in the OUTPUT shape of the matching read tool
  (e.g. get_flow's {kind, name}); edit_flow normalises the unambiguous forms before validating.
- Tool selection is keyword-based (`server/src/agent/context-selection.js`): a request that never names
  the domain ("add a step to <flow name>") only gets that domain's tools if a signal matches it.
- Live tests are driven through the chat API with approvals sent to `/api/agent/approve` (see Job 1.2
  report); a whole-app install + re-publish takes ~20–25 min, so plan tests accordingly.
- Agent flow read tools are `list_flows` and `get_flow` (fixed in Job 1.1). `list_live_flows` lists
  only Fluent-source flows, not everything on the instance.

## How we work: jobs

Work is done in small "jobs". Follow these rules for EVERY job:

1. **Inspect before coding.** Query the real instance (the actual tables and `sys_dictionary`)
   instead of assuming table or field names. Write down what you verified.
2. **Stay in scope.** Build only what the job asks. No extra features, no refactors outside scope.
3. **Expose it as a tool.** Every new capability must be a proper agent tool (clear name,
   input schema, description) so the chat agent can call it.
4. **Gate writes.** Any tool that writes to the instance must go through the existing approval gate.
5. **Test for real.** Test on the live PDI, not just with mocks. Also add automated tests where practical.
6. **Branch per job.** Commit on a new branch per job named `job-<phase>-<number>-<short-name>`.
7. **Report.** Finish every job with a report in EXACTLY this format:

```
JOB REPORT
- Job: <id and name>
- What I built: <files + tools, 3-6 lines>
- What I verified on the instance: <tables/fields actually checked>
- Test results: <each acceptance test: PASS/FAIL + one line of evidence>
- Problems / surprises: <anything odd, or "none">
- Open questions for Rahul: <or "none">
```
