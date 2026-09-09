# Archived Fluent sources

Sources moved out of `server/fluent-workspace/src/fluent/` so the build no
longer sees them. **Archiving is deletion**, and that is not a figure of
speech: the SDK's build marks a removed source `deleted: true` in
`generated/keys.ts` while keeping its sys_id, and the next `now-sdk install`
removes the record from the instance. There is no "keep it on the instance but
drop it from the build" option.

Restoring a file here to `src/fluent/flows/` and installing re-creates the
artifact **under its original sys_id**, because the key is retained. That is
why these are archived rather than deleted outright.

## 2026-09-09 — `daily-p1-digest.now.ts`

The C6 pilot for Session 2. One leaf experiment flow, chosen because nothing
calls it, removed to measure what a source deletion actually does on the bound
instance before doing it to thirty more.

Measured, on dev424910:

| | |
|---|---|
| client-side install | FAILED at 352 s — the SDK's fixed 300 s deployment abort |
| server-side | completed anyway, in three `sys_upgrade_history` chunks at 06:05:13, 06:05:46, 06:10:42 |
| the record | **gone** — the deletion landed roughly ten minutes after the client gave up |
| the golden pair | **reverted to draft** by the same install, and had to be re-published |

Two traps came out of it, both now in `docs/fluent-research.md`: an install
reverts published flows to draft, and a removal's effect is not visible when
the client returns.
