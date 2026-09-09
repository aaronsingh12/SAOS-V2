# Gate 4 — the plan, and the unelevated control that has to fail first

Phases 1, 2 and 3 are implemented and green. Phase 4 is implemented but **only 4.1 and
4.2 have been run against the instance**; 4.3 (the live elevated author) is held at this
gate as instructed.

Measured on `dev442675` / `Australia`, 2026-08-26. Every claim below is EXECUTED unless
labelled otherwise.

---

## 1. What was built

| phase | module | shape |
|---|---|---|
| 1.1 / 1.2 / 1.3 / 1.4 | [role-model.js](server/src/servicenow/role-model.js) | server-side discovery only — no Table API anywhere in the role path |
| 2 | [role-elevation.js](server/src/servicenow/role-elevation.js) | the atomic lifecycle; one execution, `hasRole`-asserted, de-elevation in a `finally` |
| 3 | [role-elevation.js](server/src/servicenow/role-elevation.js) `timelineSource` | `ELEVATE_START` / `ELEVATED` / `ELEVATE_END` events on the result |
| 4 | [acl-authoring.js](server/src/servicenow/acl-authoring.js) | condition composition, the author source, the confab guard, the claim |
| — | [acl.js](server/src/servicenow/acl.js#L7) | the B-3 reversal, recorded in the file it reverses |

**Test delta: 793 → 829 (+36), 0 failing.** The one most worth having:
`THE trap: no generated elevation body may substring-search getRoles()`, which pins D-3
against the real role-set shape rather than a synthetic one.

### Phase 3, and why it does not write `tool_events`

`tool_events` is keyed to a session and a tool call, and role elevation is neither yet —
it is a server-side mechanism with no tool in front of it. The lifecycle emits exactly the
rows a caller would persist, as structured data on the result, rather than inventing a
session to hang them on. The seam is the shape of the record, not the table it lands in.
Live sample from the 4.2 run:

```json
[ { "event": "CONTROL_START", "at": 1787728631532, "role": "security_admin", "has_role": false },
  { "event": "CONTROL_END",   "at": 1787728631618, "role": "security_admin" } ]
```

---

## 2. Phase 1 — live results

**1.1 elevatable roles (server-side GlideRecord):** five, and `security_admin` is among
them — the row the Table API omits. Constraint 2 held in practice, not just in comment.

```
ais_high_security_admin, ai_security_admin, data_privacy_admin, security_admin, workspace_list_admin
```

**1.2 effective roles for the executor** (`admin`, `6816f79c…`): 126 direct, 0 via group,
0 via containment, 2 group memberships, containment walk terminated at depth 1 without
hitting its bound. `security_admin` is held **directly** — dormant until elevated, exactly
as the sprint pack predicted.

The zeros are worth stating rather than glossing: `sys_user_has_role` materialises
inherited grants, so everything reachable had already been counted in `direct` before the
group and containment walks ran. The walks are not dead code — they name the *path*, which
the materialised row does not — but on this user they add nothing, and reporting them as
"0" is the honest result.

**1.3 eligibility:** `advisory: true`, `enforced: false`, `platformMarksElevatable: true`,
`userHoldsRole: true`, `heldVia: "direct"`, no notes. Gates nothing, and says so in the
payload rather than only in a comment.

---

## 3. 4.1 — the required role was DERIVED, not assumed

This is the result that makes the derivation worth having, because it could easily have
come back unresolved and been quietly patched with a guess.

Derivation for `(sys_security_acl, create)`:

| tier | names | matched |
|---|---|---|
| wildcard | `sys_security_acl.*`, `sys_security_acl.None` | 0 |
| **record** | `sys_security_acl` | **3** |

Of the three active record-tier ACLs governing `create`, **two name `security_admin`** and
one requires no role. Verdict: `resolved: true`, tier `record`, roles `[security_admin]`.

So `security_admin` fell out of a live ACL walk. Nothing in the code named it — a test
enforces that no module in the role path contains the string outside a comment.

---

## 4. 4.2 — the unelevated control, EXECUTED, and it failed

Composed from request context (three clauses, each traced to the input that produced it):

```
stateIN1,2,3^short_descriptionLIKEvpn^assigned_toISNOTEMPTY^EQ
```

All three field roots validated against the live `incident` dictionary — `unknown: []`,
`unparsed: []`. A condition addressing a field that is not there saves happily and matches
nothing, so this is checked before the write rather than discovered after.

**The control run** — identical payload, identical source, no elevation:

| signal | value | reading |
|---|---|---|
| `preflight.canCreate` | **`false`** | the secure API refuses |
| `preflight.canRead` | `true` | table readable; this is the Layer-1/Layer-2 discriminator holding |
| `preflight.canWrite` / `canDelete` | `false` | — |
| `insert_return` | **`"null"`** | `GlideRecordSecure.insert()` returned null |
| `dispatched` | **`false`** | — |
| `readback.found` | `false` | — |
| **`residue.counted`** | **`0`** | **nothing landed** — verified by query, not assumed |
| `role_link` | `null` | no association attempted on a failed insert |

`liveness: CONFIRMED` on `glide.scheduler.worker.5`, so this is a measured refusal and not
a script that failed to run.

**A blocked `GlideRecordSecure` insert leaves no residue.** That was an open question in
the sprint text and it is now answered: the guard the residue check exists for did not
fire, and we know that because it ran, not because nothing was noticed.

### D-3 confirmed live, in passing

The control reported `in_get_roles: false` for `security_admin` both before and after —
while the executor's role list demonstrably contains `agent_security_admin`. The exact
matcher gets it right where `indexOf` would have returned `true` on a completely unelevated
worker.

---

## 5. New instance findings (ledger)

```json
{
  "elev.derivation.acl_create": {
    "table": "sys_security_acl", "operation": "create",
    "winning_tier": "record", "acls_matched": 3, "roleless_acls": 1,
    "derived_roles": ["security_admin"], "resolved": true,
    "note": "security_admin is DERIVED from the live ACL walk, never named in code",
    "tier": "EXECUTED"
  },
  "elev.control.secure_insert_denied": {
    "api": "GlideRecordSecure.insert() on sys_security_acl, unelevated",
    "canCreate": false, "canRead": true,
    "insert_return": "null", "dispatched": false, "residue_rows": 0,
    "verdict": "a denied secure insert leaves NO residue on this instance",
    "tier": "EXECUTED"
  },
  "elev.updateset.available": {
    "typeof_GlideUpdateSet": "function",
    "current_update_set_at_probe_time": "9055f6338c9503100a22deb6dd2b4ead",
    "harness_scope": "73cd84168376c750b939cc65eeaad3ff (global)",
    "note": "the worker's current update set is NOT Default; 4.3 must restore it",
    "tier": "EXECUTED"
  },
  "elev.executor.role_shape": {
    "direct": 126, "via_group": 0, "via_containment": 0, "groups": 2,
    "containment_depth": 1, "containment_exhausted": false,
    "holds_security_admin": true, "held_via": "direct",
    "note": "sys_user_has_role materialises inherited grants, so direct is already a superset",
    "tier": "EXECUTED"
  }
}
```

---

## 6. The plan for 4.3 — what will run when this gate opens

One bounded execution, in this order:

1. **Create a disposable update set** server-side (`sys_update_set`, `state=in progress`,
   name carrying the run marker), read it back, and `new GlideUpdateSet().set(id)`.
   `GlideUpdateSet` is confirmed available (`typeof "function"`). **The worker's current
   set is `9055f633…`, not Default** — it is captured first and restored in the `finally`,
   because leaving a scheduler worker pointed at a disposable set would silently capture
   unrelated later work.
2. **Elevate** `security_admin` → assert `hasRole` true. The op does not run otherwise.
3. **Author** the same payload through `GlideRecordSecure` — the identical source the
   control ran.
4. **Read back** as admin via plain `GlideRecord`, plus the residue query on the marker.
5. **Associate the role** — role sys_id resolved server-side by name (D-2), M2M row read
   back.
6. **De-elevate** in the `finally`, assert `hasRole` false, restore the previous update set.
7. **From Node, over the Table API** — `verifyAclLive` re-reads the sys_id on a second
   transport and compares all eight fields plus the role association. A sys_id that does
   not re-read is reported unverified, never as written.
8. **`describeEffect`** states the narrow claim and explicitly refuses the broad one.

**Open question 4.3 will answer** (new finding either way): does deleting a
`sys_update_set` clear its child `sys_update_xml` rows on this instance? Trap I says the
rows outlive their record; the set-level teardown is the proposed remedy and it is
untested. If the cascade does not happen, that goes to the ledger and the teardown story
changes rather than being quietly declared done.

### Two decisions I made that you may want to overrule

**`active: false` on the authored ACL.** The claim 4.2/4.3 proves is about whether the
*insert is permitted*; `active` has no bearing on it. But an active ACL changes who can see
what on a running instance, and 4.5 keeps the artifact rather than reverting it — so the
version that is safe to keep is the inactive one. The condition, the role association and
the composed provenance are all real and all visible on the record. Flipping it to `true`
is a one-argument change (`buildAclPayload({ active: true })`) and should be a deliberate
call, not a default.

**Target `incident`, record-level `read`.** Real table, obviously legible in a demo, and
additive rather than restrictive at the record tier. If you would rather the demo authored
against something with no production-shaped meaning, say which table and it is a parameter.

---

## 7. Status

- 4.2 (control fails): **EXECUTED, green** — `canCreate` false, insert null, zero residue.
- 4.3 (elevated author persists): **NOT RUN — held at this gate.**
- The capability is therefore **not yet declared**. Half an A/B is not a result.

Instance residue from this gate's runs: **none**. The control wrote nothing, and the
`sysauto_script` / sink cleanup is the harness's own proven path. The five loose
`sys_update_xml` rows from Phase 0 remain parked for the pre-capture hygiene pass, as
agreed.
