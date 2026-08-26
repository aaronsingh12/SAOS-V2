# Phase 4 — EXECUTED result: the A/B, and what the guard caught

Run `NHA-P43-MT9T2QUW` on `dev442675` / `Australia`, 2026-08-26. Both halves of the A/B
were run in the same session against the same payload through the same source.

**Verdict: the capability is proven.** The unelevated control refused; the elevated author
persisted; every field the write controls re-read correctly on a second transport. One
field was rewritten by the platform, the guard caught it, and the cause was corroborated
rather than assumed.

---

## 1. The A/B

| | 4.2 control (unelevated) | 4.3 author (elevated) |
|---|---|---|
| worker | `glide.scheduler.worker.5` | `glide.scheduler.worker.6` |
| `hasRole(security_admin)` before | `false` | `false` |
| `hasRole` during | — (never elevated) | **`true`** |
| `preflight.canCreate` | **`false`** | **`true`** |
| `preflight.canRead` | `true` | `true` |
| `GlideRecordSecure.insert()` | **`"null"`** | **`fefdc23383f20790b939cc65eeaad36d`** |
| `dispatched` | `false` | `true` |
| read-back as admin | not found | **found, fields correct** |
| residue on marker | **0** | 1 (the intended row) |
| role association | none attempted | **`bafd063383f20790b939cc65eeaad309`**, read back |
| `hasRole` after | `false` | **`false`** (`deelevated_ok: true`) |

`liveness: CONFIRMED` on both, so each is a measured outcome rather than a script that
failed to run.

**Elevation lifecycle:** `before.has_role false → during.has_role true → after.has_role
false`, `deelevated_ok: true`, `assessElevation → held: true`. Timeline:
`ELEVATE_START` → `ELEVATED` (16ms) → `ELEVATE_END` (653ms later).

**The exact-match check held live in both runs.** `in_get_roles` was `false` before and
after and `true` only during — on a worker whose role list contains `agent_security_admin`.
`indexOf` would have reported `true` throughout.

---

## 2. The authored artifact

```
sys_id      fefdc23383f20790b939cc65eeaad36d
name        incident
operation   read
type        record
active      false          <- kept inactive, as agreed; not activated
condition   stateIN1,2,3^short_descriptionLIKEvpn^assigned_toISNOTEMPTY^EQ
role        itil (282bf1fac6112285017366cb5f867469) via sys_security_acl_role
            bafd063383f20790b939cc65eeaad309   (sys_name "incident.itil")
sys_scope   73cd84168376c750b939cc65eeaad3ff (global)
```

The condition was composed from three request-context clauses, each traced to the input
that produced it, and all three field roots validated against the live `incident`
dictionary before the write (`unknown: []`, `unparsed: []`).

The artifact is **kept** (4.5) and **inactive**. It was not activated.

---

## 3. The confabulation guard fired — and it was right to

The first `verifyAclLive` on the live record returned **`verified: false`**,
`reason: field_mismatch`:

```
description  requested: "NowHelpAssist role-elevation demo — dynamic ACL authored from request context. NHA-P43-MT9T2QUW"
             live:      "Allow read for records in incident, for users with role itil, and if the ACL
                         condition (stateIN1,2,3^short_descriptionLIKEvpn^assigned_toISNOTEMPTY^EQ) evaluates to true."
```

This is the guard doing exactly the job it exists for: the script's own read-back reported
the description we asked for, and the second transport disagreed. Had the guard trusted the
script, the run would have reported a clean success over a field the platform had silently
replaced.

**The cause was then corroborated, not guessed.** `sys_script` where
`collection=sys_security_acl` holds an ACTIVE business rule:

| name | when | order | insert | update | references `description` |
|---|---|---|---|---|---|
| **Generate ACL Description on First Save** | `after` | 1000 | 1 | 0 | **yes** |

and the record's `sys_mod_count` is **1** immediately after creation — inserted, then
modified once. Two independent signals for the same conclusion.

### What changed in the code as a result

`description` on `sys_security_acl` is now declared **platform-computed**, with the rule
named as the evidence, and a differing value is reported as **`transformed`** rather than
as a mismatch — the distinction write-verify.js already draws between "the platform
computed this" and "our value was silently discarded".

The reclassification is deliberately narrow, and two tests hold the line:

- an **empty** live value where text was requested is still a **drop**, and still fails;
- a rewritten **`condition`** is never excused — only fields measured to be platform-owned
  are.

Re-run against the live record after the fix:

```
verified: true, mismatches: [], transformed: [description → "Generate ACL Description on First Save"]
roleLink: { verified: true, liveRole: 282bf1fac6112285017366cb5f867469 }
```

### The knock-on, stated plainly

The run marker lives in `description`, so it does **not survive** on a successfully created
ACL. The residue check still does its job — its job is to prove a *denied* insert created
nothing, and when nothing is created there is nothing for the rule to rewrite — but **any
later lookup of a kept artifact must go by sys_id, never by the marker.** This is recorded
in the code at the residue check rather than left to be rediscovered. It is also why §2
above quotes a sys_id and not a marker query.

---

## 4. Verification point 1 — the worker's update set was restored

| signal | value |
|---|---|
| previous set captured before anything | `9055f6338c9503100a22deb6dd2b4ead` |
| matches the Gate 4 expectation | **yes** |
| disposable set created | `befdc23383f20790b939cc65eeaad369`, `state: in progress`, `application: global` |
| current after `set()` | `befdc23383f20790b939cc65eeaad369` (`set_ok: true`) |
| current after restore | **`9055f6338c9503100a22deb6dd2b4ead`** (`restore_ok: true`) |
| **independent read-back, fresh execution** | **`9055f6338c9503100a22deb6dd2b4ead`** |

Restored, and confirmed twice — once inside the run's own `finally`, and once from a
separate execution that had no knowledge of the first. The pooled worker is back where it
was.

---

## 5. Verification point 2 — the update-set cascade DOES clear its children

The open question from Gate 4 is answered, and the answer is the good one.

Before deleting `befdc233…`, it held two children:

| sys_update_xml | target_name | type |
|---|---|---|
| `7afdc23383f20790b939cc65eeaad372` | `incident` | Access Control |
| `4ffd063383f20790b939cc65eeaad313` | `incident.itil` | Access Roles |

After `deleteRecord()` on the set: `set_deleted: true`, **`orphan_count: 0`**,
`cascade_clears_children: true`.

So **deleting a `sys_update_set` DOES remove its `sys_update_xml` rows on this instance.**
Set-level teardown is a working remedy for trap I, and the stop-and-record path was not
needed. Nothing beyond the set itself was deleted — the teardown source contains exactly
one `deleteRecord()` call and a test enforces that.

**And the artifact survived the teardown.** Deleting the update set removes the *record of*
the change, not the change. Confirmed on both transports after the delete: the ACL and its
role association are both present, `sys_mod_count: 1`.

Worth keeping in view: the kept ACL is now captured in **no** update set. That is the
intended hygiene outcome for a demo artifact, and the wrong outcome if this ACL were ever
meant to be transported.

---

## 6. The claim, stated at the width the evidence supports

**Supported:**

> Elevating `security_admin` is what allowed this ACL to be authored **through
> `GlideRecordSecure`**: the identical payload through the identical code refused to insert
> unelevated (`canCreate=false`, `insert` returned `"null"`, residue 0) and inserted once
> elevated.

**Explicitly not claimed:**

> "Elevation enabled the write." Phase 0 probe 0.5 measured a plain `GlideRecord` insert
> into `sys_security_acl` persisting with no elevation at all, on this instance. Elevation
> governs the secure API's capability predicate, not the platform's willingness to store
> the row.

`describeEffect` emits the refusal on every run, including clean ones, so the narrower
claim cannot drift into the broader one in a later retelling.

The Gate 0 stop condition (`canCreate` true, `insert` still null) did **not** trigger —
`predicateOutcomeSplit: false`. It is implemented, tested, and names the specific wrong
response so it cannot be reached for absent-mindedly: no path in the module falls back to a
plain `GlideRecord`, and a test greps the module to keep it that way.

---

## 7. Ledger

```json
{
  "elev.phase4.ab": {
    "control": { "canCreate": false, "insert_return": "null", "dispatched": false, "residue": 0 },
    "elevated": { "canCreate": true, "insert_return": "fefdc23383f20790b939cc65eeaad36d", "dispatched": true },
    "elevation_held": true, "deelevated_ok": true,
    "claim": "elevation enabled the SECURE write; NOT the write in general (0.5)",
    "tier": "EXECUTED"
  },
  "elev.trap.acl_description_rewritten": {
    "table": "sys_security_acl", "field": "description",
    "rule": "Generate ACL Description on First Save",
    "when": "after", "order": 1000, "action_insert": 1, "action_update": 0,
    "sys_mod_count_after_create": 1,
    "impact": "a run marker placed in description does not survive creation; later lookups must use sys_id",
    "classification": "transformed, not dropped",
    "tier": "EXECUTED"
  },
  "elev.updateset.cascade": {
    "question": "does deleting sys_update_set clear its sys_update_xml children?",
    "children_before": 2, "orphans_after": 0, "cascade_clears_children": true,
    "artifact_survives_teardown": true,
    "consequence": "set-level teardown is a working remedy for trap I (deleting an ACL leaves its update_xml)",
    "tier": "EXECUTED"
  },
  "elev.updateset.restore": {
    "previous": "9055f6338c9503100a22deb6dd2b4ead",
    "restored_in_finally": true,
    "confirmed_by_independent_execution": true,
    "tier": "EXECUTED"
  }
}
```

---

## 8. Instance state after this phase

**Kept, intentionally:**

- ACL `fefdc23383f20790b939cc65eeaad36d` on `incident`, record `read`, **inactive**.
- Role association `bafd063383f20790b939cc65eeaad309` → `itil`.

**Cleaned, verified:**

- disposable update set `befdc233…` — deleted, and its 2 `sys_update_xml` children went
  with it (0 orphans).
- `sysauto_script` jobs and `sys_user_preference` sinks — the harness's own proven path.
- The 4.2 control wrote nothing (residue 0).

**Still parked** (unchanged, pre-capture hygiene pass): the 5 loose `sys_update_xml`
"Access Control" rows from Phase 0 §11.

**Test delta: 793 → 840 (+47), 0 failing.**
