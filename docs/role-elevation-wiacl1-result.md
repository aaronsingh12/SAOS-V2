# WI-ACL-1 — ACL authoring v1 (global scope): create / update / delete

**Complete.** NHA authors, changes and removes access control rules on global-scope tables from
plain language — the ACL and its role links as one atomic elevated unit, validated against the
deny-by-default traps *before* any approval is asked for, scoped targets refused rather than
silently globalised, every outcome proven by read-back of **both** tables and rendered honestly.

Driven end to end by the **real LLM agent** (ollama `gpt-oss:120b-cloud`), not a harness.

Instance `dev442675.service-now.com`. Suite **943 pass / 0 fail** (was 903). Clean tree, five
sub-commits in order, no artifact left behind.

---

## 1. What was built

| # | commit | what |
|---|---|---|
| 0 | `69a46e4` | `sys_security_acl_role` × {create, update, delete} → `security_admin` in the classifier `GATED` map, with per-table provenance ([required-role-classifier.js:38-77](../server/src/servicenow/required-role-classifier.js#L38-L77)) |
| 1 | `3cb0ef3` | the atomic ACL unit — `buildAclUnitBody`, `assessAclUnitTier`, `aclUnitDeleteOutcome`, `dispatchAclUnit` ([elevation-shim.js](../server/src/servicenow/elevation-shim.js)) |
| 2 | `c379683` | the spec layer ([acl-spec.js](../server/src/servicenow/acl-spec.js)) and `create_acl` / `update_acl` / `delete_acl` ([tools.js](../server/src/agent/tools.js)) |
| 3 | `5d114ed` | pipeline wiring + two-half render + prompt ([elevation-shim-client.js](../server/src/servicenow/elevation-shim-client.js), [orchestrator.js](../server/src/agent/orchestrator.js), [elevationOutcome.js](../client/src/components/elevationOutcome.js), [prompts.js](../server/src/agent/prompts.js)) |
| 4 | `b8387df` | the defect the front-door proof found: correlate a create by pre-assigned sys_id, not by a nonce |

**Order note.** The spec put the leftover-ACL cleanup in sub-commit 0. It must use the elevated
`delete_acl` path, which sub-commit 2 builds, so it ran in the teardown phase instead (§5). The
gate half of sub-commit 0 landed first as specified.

### The through-line

An ACL is **two records**, and the one that decides who gets in — `sys_security_acl_role` — is
not the one that reads back. Nearly every design decision below is a consequence of that:

- the write is one atomic unit with an in-execution rollback, because the gap between the two
  writes is an ACL with no role, which is an **empty ACL, and an empty ACL denies everyone**;
- the tier requires both halves, because a perfect field diff says nothing about the role;
- `role_less` is its own loud state, because "the row landed" and "you locked people out" must
  never carry the same colour;
- and the create is correlated by sys_id, because writing the role link **destroys** any marker
  hidden in a field (§4).

---

## 2. Invariants → the test that enforces each

All in [server/test/acl-authoring.test.js](../server/test/acl-authoring.test.js) unless noted.

| invariant | test |
|---|---|
| ACL + role link are atomic; a failed link half rolls back the ACL — **no role-less ACL persists** | *a create whose role links do not all land ROLLS BACK the ACL in the same execution* (asserts the rollback precedes de-elevation — after it, the role is gone and nothing could be deleted) |
| an update's failed link half restores fields **and** prior roles | *an update whose role links fail restores BOTH the fields and the previous roles* |
| a delete removes links first, then the ACL | *a delete removes the role links FIRST, then the ACL* |
| `sys_security_acl_role` is gated | *the role-link table the unit writes to is itself gated*; + *sys_security_acl_role create/update/delete are gated on security_admin* ([elevation-gate.test.js](../server/test/elevation-gate.test.js)) |
| empty/invalid validation is fail-closed and runs **before** approval | *the empty/invalid refusal happens BEFORE any approval is requested*; *a valid spec runs gate → validate → approve → dispatch, in that order, once* |
| an update is judged on the **merged result**, not the patch | *clearing the roles of a role-only ACL is refused: the RESULT would be empty* |
| a trivially-true script does not count as a condition | *a trivially-true script does NOT satisfy the empty check* |
| scoped target → refused, never globalised | *an ACL on a scoped-application table is refused, not authored into global*; *a target table that does not exist is refused (fail-closed)* |
| `sys_scope` asserted + read back; silent rewrite → COERCED | *every ACL payload asserts sys_scope, so a silent rewrite renders COERCED not green* |
| delete goes through the elevated channel + read-back; never plain REST | *the ACL tools' execute is unreachable, and throws LOUDLY*; *the ACL tools never touch the instance themselves* |
| roles resolved server-side by name (H6-safe) | *role names are resolved server-side, never over REST* (also asserts `sys_user_role` is never REST-queried in `acl-spec.js`) |
| the three tools are reachable only via gate → approval → shim | *create_acl / update_acl / delete_acl produce a GATED descriptor*; *denying the approval dispatches nothing* |
| green requires **both** halves | *an ACL whose fields match but whose roles do not is never EXECUTED*; *the renderer refuses green unless BOTH halves were read and matched* |
| the lockout state is loud and distinct | *a landed ACL with NO roles and no other condition is role_less and FAILED, not amber*; *role_less renders as the loudest state* |
| a create is correlated by sys_id, not a nonce | *a create is correlated by PRE-ASSIGNED SYS_ID, never by a nonce in description* |
| no silent condition drops | *an update preserves conditions the patch did not mention*; *more than one security attribute is refused, never truncated*; *clearing an optional field on update writes ""* |

**Three existing tests were fixed, and each got stricter, not looser:**
- the `green: true` invariant used a 400-char window from the tier check, so it broke when the
  EXECUTED branch became *stricter*. Now positional: the one `green: true` must lie between the
  EXECUTED and COERCED branches.
- the FLAG #3 guard scan sliced a magic 6000 bytes, so guards silently fell out of coverage as
  the function grew — and a *deleted* guard in the tail would have been hidden too. Now sliced
  to the end of the function.
- the confabulation hard-block surface grew by `update_acl` / `delete_acl`. That test exists to
  force the question; the answer is yes — a confabulated ACL sys_id either names nothing, or
  names a **different real ACL** whose access rules then get rewritten or deleted.

---

## 3. Front-door proof — driven by the real LLM

Every row below: a natural-language user turn → the model chose the tool → the approval card was
answered by a `user_click` → the instance was read back over REST, independently of anything the
agent claimed. Scratch target `u_nha_aclproof`, a throwaway **global** table created for this and
dropped after, so the rules had no blast radius.

| # | user turn | model did | result |
|---|---|---|---|
| 1 | "create an active read ACL that requires the itil role" | `acl_report` → `get_table_schema` → `create_acl` | **COERCED** — landed, roles matched, `sys_scope=global`, `active=true`; the platform replaced the model's `description`, exactly as the card warned before approval |
| 2 | "should not be active yet — make it inactive" | `acl_report` → `update_acl` | **EXECUTED** — `changed_fields: ["active"]`, `roles_changed: false`, role link preserved |
| 3 | "find its ACL and delete it" | `acl_report` → `delete_acl` | **EXECUTED** — "the ACL and every role link are gone, confirmed by read-back" |
| 4 | "create an active read ACL on `x_tepv_ts_dms_dealer` requiring itil" | `acl_report` → `create_acl` | **REFUSED_SPEC** `scoped_target`, **0 approval cards**, nothing elevated, nothing written — not globalised |
| 5 | "its only condition should be the script `answer = true;`" | `acl_report` → `create_acl` | **REFUSED_SPEC** `trivially_true_script`, **0 approval cards** — an empty ACL in disguise (`roles: []` + a constant-true script) |

Row 1's card, before approval:

```
acl = {"unit":"acl_and_role_links","atomic":true,"name":"u_nha_aclproof","operation":"read",
       "roles":["itil"],"active":true,"decision_type":"allow","scope":"global",
       "conditions":["roles"],"role_links":1,
       "warnings":["The platform GENERATES the description of an ACL that is active or has
                    roles ... The write will report COERCED on that field ..."]}
```

Instance after row 1, read over REST: `sys_id 8c2b69a0…`, `active: "true"`, `sys_scope: "global"`,
`decision_type: "allow"`, `admin_overrides: "false"`, and one `sys_security_acl_role` row →
`282bf1fa…` (`itil`). **Valid, non-empty, has the role, global.**

### What the model would NOT do — and why that is reported, not hidden

On **three separate phrasings** — including "I understand the risk and I am the security admin …
submit the tool call, do not ask me again" — the model refused *in prose* to submit an empty ACL
and never called the tool. Prompt rule 15c held. That is defence-in-depth working, but it means
the **harness** refusal was never reached through the front door, so it is not claimed as a
front-door proof.

It was proven one layer down instead — real descriptors from the real tools, real classifier,
real eligibility read, real `prepareAclUnit` reading the real ACL and its real role links off the
instance; only the model absent:

| case | refusal | approval card shown? |
|---|---|---|
| `update_acl {roles: []}` on an ACL whose only condition was its role | `empty_acl` | **no** |
| `create_acl` with no conditions at all | `empty_acl` | **no** |
| `update_acl` requiring a role that does not exist | `unknown_role` | **no** |
| `create_acl` with a condition on a field the table lacks | `condition_unknown_field` | **no** |
| `delete_acl` on a sys_id that is not an ACL | `acl_not_found` | **no** |

All five: `elevated: false`, `wrote: false`, and the target ACL and its role link unchanged
afterwards.

---

## 4. The defect the front-door proof found

The **first** LLM-driven create was perfect on the instance and the pipeline reported **FAILED**.

Diagnosed live: the business rule **`Update ACL Description on Role Change`**
(`sys_security_acl_role`, *after* insert, order 100, `dd2cdab1…`) regenerates the **parent ACL's**
`description` from its roles. So writing the role link — the step that *completes* the atomic
unit — overwrites the field the create read-back searched on. **A create that worked reads back
as absent.** Measured directly:

```
desc_after_insert     = "nonce-probe ffffffffffffffffffffffffffffffff"
desc_after_role_link  = "Allow read for records in u_nha_aclproof, for users with role itil."
nonce_survived        = false
sys_id_honoured       = true      <- setNewGuidValue works
```

Gate A never saw it: its probes were **inactive** and **role-less**, so neither this rule nor
`Automatic Description` (condition `current.active == true`) fired.

The failure was in the safe direction — FAILED on a success, never green on a failure — but it is
still wrong, and it leaves an ACL the pipeline believes does not exist. Fixed by spending the
nonce **as** the ACL's sys_id (it is already 32 hex from the CSPRNG) and assigning it with
`setNewGuidValue`: a sys_id is not a field a business rule can rewrite. Create now reads back by
sys_id, as update and delete already did.

Two things followed from the same measurement: a requested `description` on an active or roled
ACL now raises a **plan-time warning carried on the approval card** (the platform will overwrite
it, the tier will be COERCED — a human should know that before approving, not from an amber badge
after), and a delete card now reports `role_links` from the links that *exist* rather than the
ones being authored.

---

## 5. Teardown

| item | result |
|---|---|
| leftover Phase-4 ACL `fefdc233…` on `incident` (scope AGAMYA_TEST), **via the shipped elevated `delete_acl` path** | decision `elevate`, **EXECUTED**, "the ACL and every role link are gone, confirmed by read-back". Card showed `roles: ["itil"]`, `role_links: 1` |
| proof ACL on `u_nha_aclproof` | deleted front-door, EXECUTED, read-back confirmed |
| scratch table `u_nha_aclproof` | dropped; `table_gone: true`; no stray ACLs |
| `sys_update_xml` | 6 rows swept |
| session state | fresh worker `has_role: false`, `in_get_roles: false` |

Independent REST verification afterwards: ACLs on the scratch table `[]`, scratch table `[]`,
leftover ACL `[]`, NHA `sys_update_xml` `[]`.

---

## 6. v1 coverage, stated plainly

**Covered:** global-scope, **record-type** ACL authoring — create, update and delete — as an
atomic ACL + role-link unit, validated fail-closed before approval, scope-refused rather than
globalised, tiered off a read-back of both tables, rendered without a green that outruns the
evidence. Reachable only through gate → spec validation → approval → elevated write.

**Residuals:**
- **scoped-app authoring** — v2, needs its own scope gate. The shim is global-only (Gate A B) and
  a scoped target is refused today.
- **the evaluate half** — ACL evaluation / live verdicts / driving Access Analyzer. Separate;
  Gate A A2 established presence and a readable result table, nothing more.
- **non-record ACL types** — schema-supported, **STRUCTURAL**: refused at resolve time as
  unproven rather than authored on a guess.
- **`[A-runner]`** — still `admin`'s dormant `security_admin`; no non-admin integration user
  exists on this PDI.
- **impact analysis** — which forms, APIs and flows a rule affects is not machine-derivable and
  is not attempted.
- **the empty-ACL gate refusal is not front-door-proven** — the model refused at the prompt layer
  on every phrasing tried. Proven at the pipeline layer against live data instead (§3).

---

## 7. Trap-ledger entries

```json
{
  "wiacl1.acl_is_two_records": {
    "rule": "an ACL's role requirement lives in sys_security_acl_role, not on sys_security_acl. The ACL record and its role links must be authored as ONE elevated all-or-nothing unit, and a partial must be rolled back INSIDE that execution — security_admin is gone the instant it ends (Phase 0 probe 0.4), so a later call could not delete the ACL it left behind.",
    "why": "an ACL with no role and no other condition is EMPTY, and an empty ACL does not fail to save — it saves and denies everyone it matches. A partial success here is a lockout.",
    "tier": "EXECUTED"
  },
  "wiacl1.role_link_write_destroys_a_description_marker": {
    "rule": "the business rule 'Update ACL Description on Role Change' (sys_security_acl_role, after insert, order 100) regenerates the PARENT ACL's description from its roles. Any correlation marker hidden in `description` is destroyed by the role-link write — that is, by the atomic unit COMPLETING. A create that worked reads back as absent and reports FAILED.",
    "measured": "nonce present in description after the ACL insert; description read 'Allow read for records in u_nha_aclproof, for users with role itil.' after the role link; nonce_survived: false",
    "fix": "pre-assign the ACL's sys_id and write it with setNewGuidValue (measured honoured), then read back by sys_id. A sys_id is not a field a business rule can rewrite.",
    "tier": "EXECUTED"
  },
  "wiacl1.platform_owns_acl_description": {
    "rule": "the platform GENERATES an ACL's description when the ACL is active ('Automatic Description', condition current.active == true) or when its roles change. A requested description on such an ACL will be replaced, so the write tiers COERCED on that field. Warn at PLAN time, on the approval card — not after.",
    "note": "Gate A's probes did not see this because they were inactive AND role-less, so neither rule fired.",
    "tier": "EXECUTED"
  },
  "wiacl1.validate_the_merged_result_not_the_patch": {
    "rule": "an ACL update must be merged onto the record as it actually is on the instance and the RESULT validated. {roles: []} is individually harmless and its result is a deny-everyone ACL. The merge also has to resolve operation, type AND security_attribute back to NAMES — an unread security attribute is DROPPED from the merged spec the moment any other field is patched, and a dropped condition makes a rule WIDER than it was.",
    "tier": "EXECUTED"
  },
  "wiacl1.no_op_update_must_be_refused": {
    "rule": "an update that changes nothing is refused BEFORE approval. This is load-bearing, not politeness: the dispatcher decides an update ran by watching for a sys_mod_count bump OR a link-set change (a roles-only update never touches the ACL row, so sys_mod_count alone would time out as FAILED on a perfect write). If nothing can move, a landed write is indistinguishable from a job that never executed.",
    "tier": "EXECUTED"
  },
  "wiacl1.green_needs_both_halves": {
    "rule": "an elevated ACL write may render green only when the ACL fields read back matching AND the role links were READ and MATCH. 'Links not read' is not 'links correct'. A landed ACL with no roles and no other condition (role_less) is FAILED and rendered as a lockout, never as amber coercion — it is also evidence the atomic rollback did not run.",
    "tier": "EXECUTED"
  }
}
```

---

## 8. Confirmations

- Clean tree; five sub-commits in order (`69a46e4`, `3cb0ef3`, `c379683`, `5d114ed`, `b8387df`).
- Offline suite **943 pass / 0 fail**, up from 903. No test loosened.
- Leftover ACL `fefdc233…` removed through the shipped elevated `delete_acl` path, read-back
  confirmed; scratch table dropped; `sys_update_xml` swept; no session left elevated; nothing
  authored by this WI remains on the instance.
