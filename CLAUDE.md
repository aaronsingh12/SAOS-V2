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
- `now-sdk build` runs offline, so it is free validation (UNVERIFIED this session)
- `now-sdk install` deploys the WHOLE workspace app, not just the files you changed (UNVERIFIED this session)
- now-sdk CLI flags are camelCase (UNVERIFIED this session)
- `now-sdk explain` is more reliable than the docs (UNVERIFIED this session)
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
