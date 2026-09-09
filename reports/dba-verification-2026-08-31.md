# DBA Module — Full Verification & Bug Hunt
**Instance:** dev428633.service-now.com · **Date:** 2026-08-31 · **Commit at start:** `e65c59e`

> **STATUS: all five findings are fixed.** See
> [`dba-fixes-2026-08-31.md`](./dba-fixes-2026-08-31.md) for the fixes, their
> independent verification, and the regression tests that hold them in place.
> This document is left as it was written — it is the record of what was found,
> not of what was done about it. One correction it earns: M-1's suspicion that
> the scheduler was not claiming the job was **wrong**. The job ran in five
> milliseconds; its return channel was silently discarded. The report was right
> to refuse to guess.

Every claim below was checked through an **independent path** — a raw
`/api/now/table/…` query via `client.js`, never the `dba_*` tool that made the
change. Where a tool and a raw query disagree, the raw query is the evidence.

---

## Summary

| Severity | Count |
|---|---|
| **Critical** | 1 |
| **High** | 2 |
| **Medium** | 2 |
| **Low** | 0 |
| Confirmed boundaries (correct behaviour, not bugs) | 7 |

**Automated suite:** 1115 pass / 0 fail. **No regressions.**

**Headline:** the module's own paging primitive silently loses rows and reports
the result as complete — the exact failure class the module was built to
prevent, sitting in its foundation.

---

## Critical

### C-1 — `metaQuery` treats a short page as end-of-results, and reports `truncated: false`

**Severity:** Critical — a silent undercount presented as a complete answer.

**Repro**
```js
const refs = await getReferences('sys_user');
// refs.inboundCount === 3999, refs.inboundTruncated === false
```

**Independent verification** (raw Table API, paged by hand):
```
offset    0: 1000 rows
offset 1000: 1000 rows
offset 2000: 1000 rows
offset 3000:  999 rows   <-- SHORT PAGE, and not the end
offset 4000:  402 rows
offset 5000:    0 rows
RAW TOTAL = 4401        aggregate /api/now/stats count = 4402
```

**Expected:** 4401/4402 inbound references, or an honest `truncated: true`.
**Actual:** 3999, with `truncated: false` — **403 rows (9.2%) lost and the
result asserted complete.**

The short page is stable and reproducible (999 on repeated attempts, with and
without extra `sysparm_fields`), and pages do not overlap — so this is the
platform genuinely returning one fewer row mid-result, not ordering instability.

**Suspected location:** `server/src/servicenow/dba-metadata.js`, `metaQuery`:
```js
if (page.length < limit) return Object.assign(out, { truncated: false });
```
A short page is not a reliable end-of-results signal on this API.

**Blast radius:** any paged read whose true size exceeds `PAGE` (1000).
Measured: `getReferences` inbound (4401 → 3999). `analyzeImpact` escaped only
because its lower `max: 1000` ceiling was hit first and it reported
`truncated: true` honestly. Small sets (e.g. the `incident` chain dictionary,
93 rows) are unaffected.

**Why this one matters most:** the whole module's contract is "a floor is never
reported as a total". This is that contract violated in the primitive every
other layer reads through.

**Suggested fix (not applied):** page until a page returns **zero** rows, or
bound the loop by the aggregate `/api/now/stats` count rather than by page
length. Both are cheap; the second also gives a real total to compare against.

---

## High

### H-1 — the static instance-literal scan is blind to any URL with a scheme

**Severity:** High — a guard reporting "clean" because it cannot see, giving
false assurance about the exact bug class that caused the dev442675 incident.

**Repro** — planted two literals in an executable line of `dba-metadata.js`:
```js
const QA_PLANTED_HOST = 'https://dev123456.service-now.com';
const QA_PLANTED_SYSID = 'deadbeefdeadbeefdeadbeefdeadbeef';
```
Ran `no-instance-literals.test.js`.

**Expected:** both scans fail the build.
**Actual:** the sys_id scan failed correctly; **the hostname scan passed.**

**Independent verification** — replaying the scanner's own line extraction:
```
planted line as the scanner sees it: "const QA_PLANTED_HOST = 'https:"
hostname matches: []
```

**Cause:** `executableLines()` strips `//` line comments with
`line.replace(/\/\/.*$/, '')`. `https://` contains `//`, so every URL is
truncated at the scheme before the hostname regex runs. The scan can only ever
catch a bare hostname with no scheme — and a hardcoded connection string always
has one.

**Suspected location:** `server/test/no-instance-literals.test.js`,
`executableLines()`.

**Note:** the tree really is clean (verified after removing the plants), so this
is false assurance rather than a missed live defect. The A3 self-check
("the scan can see a planted violation") did not catch it because its own probe
used a scheme-less hostname.

### H-2 — no path to MODIFY a column on an in-scope table

**Severity:** High — a capability dead-end, the third instance of this class
after add (§46) and remove (§47).

**Repro**
```js
Object.keys(dbaAuthoring).filter(k => /modify|alter|update|change/i.test(k)) // → []
await classifyOperation('modify_column')  // → { known: false, verdict: 'unknown' }
```

**Expected:** changing a column's label, hint, default or widening its
`maxLength` is additive and safe, and should route through the same
source-aware path as add and remove.
**Actual:** no `modifyField`/`alterColumn` exists, no tool is registered, and
`modify_column` is not in the operation matrix — so it is treated as
unclassified and refused as irreversible.

**Important distinction the fix must keep:** "modify" is not one operation.
- label / hint / default / **widening** `maxLength` → additive, safe, source edit
- **narrowing** `maxLength` → `decrease_column_width`, already correctly gated
- type change → `change_column_type`, already correctly gated

So the gap is only the *safe* half. The dangerous half is already handled — see
boundary B-4.

**Suspected location:** `server/src/servicenow/dba-authoring.js` (no
`modifyField`), `dba-impact.js` `OPERATIONS` (no additive modify entry),
`tools.js` (no tool).

---

## Medium

### M-1 — the execution-harness server-script path degrades under load, taking DB-engine detection and index listing with it

**Severity:** Medium — degrades **honestly and in the safe direction**, but the
user loses a real answer they had minutes earlier.

**Repro / evidence**
```
listIndexes('incident') → { available: false,
  reason: "The index read did not report back before the timeout." }
deleteRecord preview   → recovery.state = "unknown"   (was "partial" earlier the same session)
```

**Expected:** `state: "partial"` (Delete Recovery active, `com.snc.undelete`
inactive), and the documented `complete: false` index shape.
**Actual:** both degrade to unknown/unavailable when the harness round trip does
not return inside its timeout.

Both features share `runServerScript` (a one-shot `sysauto_script` polled through
a `sys_user_preference` sink). Isolated with a trivial script:

```
runServerScript({ body: "report.probe = 'ok';", timeoutMs: 90000 })
  → elapsed 93.7s  ok=false  timedOut=true  report=null
  → cleanup: { jobDeleted: true, sinkDeleted: true, leftovers: [] }
  → leftover harness jobs on the instance: 0
```

Measured at ~2s earlier in this project (§38). **Cleanup is correct** — nothing
leaks, and no orphaned jobs remain.

*Cause not isolated in this pass, and I am not going to guess.* What is known:
the instance answers REST normally, `syslog` shows platform activity within the
hour, and scheduled `sys_trigger` entries are present with future `next_action`
times — so the instance is alive, but the backdated one-shot job did not execute
within 90 seconds. Whether that is PDI scheduler throttling, a saturated worker
queue, or something in how the job is created is **unresolved** and needs its own
investigation before anyone changes the harness.

**Why it is Medium, not Critical:** every degradation is in the safe direction
and says so — `unknown` recoverability instructs the caller to treat a delete as
permanent, and the index tool reports unavailable rather than a false zero. No
wrong answer is produced. But a delete preview that cannot state the real
recovery position is materially less useful, and the flakiness is unexplained.

**Suspected location:** `server/src/servicenow/execution-harness.js`
(`runServerScript` poll/timeout), consumed by `dba-context.detectDbEngine` and
`dba-schema.listIndexes`.

### M-2 — `listIndexes` returns a different SHAPE on the unavailable path

**Severity:** Medium — a caller checking the documented field gets `undefined`.

**Repro**
```js
const idx = await listIndexes('incident');
Object.keys(idx) // → ["table","available","reason","note"]
idx.complete     // → undefined   (documented as always false)
idx.zeroMeans    // → undefined
```

**Expected:** the contract says `complete` is `false` **always**, so a caller can
rely on `idx.complete === false` without first checking `available`.
**Actual:** `complete` and `zeroMeans` exist only on the success path. A caller
testing `if (idx.complete === false)` on the timeout path gets `undefined`,
which is falsy — and could read as "complete".

**Suspected location:** `server/src/servicenow/dba-schema.js`, `listIndexes`
early-return branch.

---

## Confirmed boundaries — correct behaviour, do not re-file as bugs

| # | Behaviour | Evidence |
|---|---|---|
| B-1 | `listIndexes` refuses rather than returning a false zero | `available: false` + explicit reason; never `count: 0` presented as truth |
| B-2 | `drop_column` refused with no override | all four requirements reported unmet; refusal carries `doNotWorkAround` and contains **no** `.now.ts` steps |
| B-3 | `unmanaged_in_scope` refuses and offers adoption | simulated by hiding a source file; routed correctly, `addField` stopped at `stage: 'route'`, no `sys_dictionary` insert |
| B-4 | rename / retype / narrow / truncate gated | all five report `reversible: false` and demand the full confirmation set |
| B-5 | Ambiguous reference refuses **even with `confirm: true`** | `"a"` → refused, candidates returned; independent read shows the field still empty |
| B-6 | Record delete reports recovery honestly, no invented window | `windowDays: null` when the state is `partial` |
| B-7 | Reads write no ledger rows; mutations write exactly one, instance-stamped | ledger unchanged across read-only calls |

---

## Section results

### A — Schema Intelligence · 14 pass / 1 real fail (C-1) / 1 probe error
- `getTable.extends`, `.sys_id` — match raw `sys_db_object`.
- `listFields` — **92 fields, exactly equal** to a raw `sys_dictionary` query over
  the `incident,task` chain. No missing, no extra.
- `getField('incident','number')` — origin `task`, type `string`, both matching raw.
- `resolveReference('incident','caller_id')` → `sys_user`, matching raw.
- `getReferences('sys_user')` — **FAIL, see C-1.**
- `classify` — `incident` core-ootb, QA table custom-in-scope.
- `listChoices('incident','state')` — 6, matching raw `sys_choice`.
- `dotWalk` — valid 3-hop path resolves; bad hop fails at position 2.
- `resolveIdentifier(INC…)` — resolves to the same sys_id as a raw query.
- `getRelationships` — 0 explicit, matching raw `sys_relationship`.

*Probe error (mine, not the module's):* my `displayField` check asserted against
`sys_dictionary` `display=true` for `sys_user`, and **no such row exists** — the
tool's `name` comes from its documented fallback list. The tool is correct; the
assertion was wrong.

### B — Impact & Safety · 13/13 pass
All eight operation verdicts correct (`add_column`/`augment_column` additive and
reversible with `undo: drop_column`; drop/rename/retype/narrow/truncate
irreversible). Field impact on `incident.caller_id` found **11 ACLs, exactly
matching** a raw query, 29 dependents total, 5 blind spots declared. Preflight
permits add on in-scope and blocks drop with 3 confirmations. `checkIntegrity`
ran 10 real checks, bounded.

### C — Authoring routing · 5/5 pass
All four cases correct, including `unmanaged_in_scope` simulated by hiding the
source file (restored afterwards, verified).

### D — Mirror-verb sweep · add ✅ remove ✅ **modify ❌ (H-2)**

### E — Data operations · 4 pass / 1 fail (M-1)
Create, ambiguous-refusal, exact-resolve and delete all verified against raw
queries. Recovery statement degraded to `unknown` — M-1.

### F — Destructive gates · 7/7 pass

### G — Cross-cutting · 3 pass / 1 fail (H-1)
Guards fail closed (`assertAppBinding` → 409 on a host mismatch), tool-description
asymmetry holds, reads write no ledger rows. Static scan — H-1.

---

## Closing state

- **Audit ledger:** intact and instance-stamped throughout.
- **Escalation flag:** `{ allowIrreversible: false }` — verified at rest.
- **Probe artifacts:** the QA record created in section E was deleted and its
  absence confirmed by an independent query. The hidden source file was
  restored and its presence verified. Planted literals were removed and the
  scan re-run clean.
- **`incident` augment column** `x_2002152_nwforge_triage_note`: read only, never
  modified, as required.
- **Working tree:** clean; no fixes applied in this pass.
