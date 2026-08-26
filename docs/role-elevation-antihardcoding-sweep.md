# Anti-hardcoding sweep — role / ACL / security paths (Phase 5)

Inventory across `server/src` and `client/src`, in the form `file:line → finding →
disposition`. Taken at commit `bb5099a`, **before** any Phase 2–4 code exists, so this is
the baseline the elevation work must not regress.

**Headline: the security-relevant decision paths are already dynamic.** Every 32-hex
literal in the codebase is in a comment, a docstring, or the knowledge-fact store — none is
in a role, ACL or security decision path. There are no static op→role maps. The two real
findings are a role name used as a policy anchor and one table-name literal pair, and both
are argued below rather than waved through.

---

## 5.1 Literal role names in logic

| file:line | finding | disposition |
|---|---|---|
| [impersonation-target.js:137-138](server/src/servicenow/impersonation-target.js#L137) | `table.query('sys_user_role', { query: 'name=admin' })` — the literal `admin` anchors the SOFT_DENY policy gate | **KEEP, with the pattern noted.** The role *name* is the policy statement ("NHA will not impersonate an administrator without explicit approval"), and the **sys_id is resolved live** from it — never spliced. This is the correct idiom and the one Phase 1.4 should copy. Verified live: `name=admin` is REST-visible (`2831a114c611228501d4ea6c309d626d`, `elevated_privilege=false`). |
| [impersonation.js:269,340](server/src/servicenow/impersonation.js#L269) | `gs.hasRole('admin')` in generated script bodies | **KEEP.** Diagnostic identity reporting, not a decision. The value is *reported* to the caller; nothing branches on it. |
| [acl.js:414](server/src/servicenow/acl.js#L414) | `if (role === 'admin' && overrides)` | **KEEP.** `role` here is a user-supplied role name being compared against the platform's own `admin_overrides` semantics, which are defined in terms of the literal role `admin`. Comparing to anything else would be wrong. |
| — | **no hardcoded `security_admin` anywhere in product code** | **BASELINE TO HOLD.** Phase 2 must not introduce one — see the forward rules below. |

## 5.2 Hardcoded sys_ids (32-hex literals) in security / role / ACL paths

**Zero findings in decision code.** All eleven 32-hex literals in `server/src` are
non-executable:

| file:line | context | disposition |
|---|---|---|
| [acl.js:22](server/src/servicenow/acl.js#L22) | docstring — example of an extended operation sys_id | **KEEP** (documentation) |
| [orchestrator.js:732](server/src/agent/orchestrator.js#L732), [playbooks.js:21](server/src/agent/playbooks.js#L21), [provenance.js:262](server/src/memory/provenance.js#L262), [write-verify.js:5](server/src/servicenow/write-verify.js#L5), [catalogPolicy.js:21](server/src/servicenow/catalogPolicy.js#L21) | docstrings citing measured evidence | **KEEP** (documentation) |
| [facts.js:151,180,248,254,258](server/src/memory/facts.js#L248) | the seeded knowledge-fact store, each carrying a `provenance` field | **KEEP.** These are *recorded observations about this instance*, which is what the fact store is for. They are data with provenance, not logic. |

The existing enforcement is already stronger than a sweep: [impersonation.js:52](server/src/servicenow/impersonation.js#L52)
`assertSysId()` refuses any sys_id that is not a live-resolved 32-hex value, and it is
called on every identity spliced into a generated script.

## 5.3 Hardcoded table names in decision code

| file:line | finding | disposition |
|---|---|---|
| [acl.js:37-38](server/src/servicenow/acl.js#L37) | `ACL_TABLE = 'sys_security_acl'`, `ACL_ROLE_TABLE = 'sys_security_acl_role'` | **KEEP — 5.6 constant.** These are platform identifiers, not targets. The table *under analysis* is the parameter; these name where ACLs live. Verified REST-readable this run. |
| [capture.js:37](server/src/agent/capture.js#L37) `TOOL_TABLE_HINT` | maps tool → table, e.g. `create_incident: () => 'incident'` | **KEEP.** Each entry names the table that tool exists to write; the generic tools (`create_record`/`update_record`/`delete_record`) correctly read `input.table`. Not a decision map — a capture hint. |
| [tools.js:34](server/src/agent/tools.js#L34) `UNCREATABLE_TABLES` | `sys_scope`, `sys_app` | **KEEP.** A refusal list of two platform tables where REST insert produces a husk. Naming them is the point. |

## 5.4 Static required-role / op→role maps

**Zero findings.** No `REQUIRED_ROLE`, `OP_TO_ROLE`, `ROLE_MAP` or equivalent exists. Role
resolution today goes through the live M2M:
[acl.js:221](server/src/servicenow/acl.js#L221) reads `sys_security_acl_role`
(`fields: 'sys_security_acl,sys_user_role'`) rather than assuming which role an operation
needs. Phase 1.4 extends this path; it does not have to displace a static map.

## 5.5 Hardcoded ACL conditions / scripts

**Zero findings** — necessarily, because [acl.js:7](server/src/servicenow/acl.js#L7) states
the module *"reads what is there and says what it means"* and never authors. There is no
ACL-writing code to hold a template. Phase 4 creates this surface for the first time, so
this line item converts from an audit into a **constraint on new code** (below).

## 5.6 Legitimately-constant platform identifiers

Distinguished from "should-be-dynamic" by one test: **would this string ever differ between
two instances, or between two requests?** If no, it is a platform identifier.

| identifier | where | why constant |
|---|---|---|
| `sys_security_acl`, `sys_security_acl_role`, `sys_user_role`, `sys_user_has_role`, `sys_user_grmember`, `sys_group_has_role`, `sys_user_role_contains` | acl.js, impersonation-target.js | platform table names, fixed by the product |
| `elevated_privilege` | Phase 1.1 discovery | a platform *field name* on `sys_user_role`. The field name is constant; the **set of roles it selects is not**, and that set must be queried, never listed |
| `admin_overrides`, `operation`, `type`, `condition`, `script`, `active` | acl.js `WANTED_FIELDS` | platform field names, already guarded — [acl.js:41](server/src/servicenow/acl.js#L41) compares requested fields against what came back, because `sysparm_fields` drops unknown names silently (trap #4) |
| `read` / `write` / `create` / `delete` / `execute` | acl.js | the core operations have *literal short sys_ids equal to their names*; extended operations have ordinary 32-hex ids and are resolved through the live reference map ([acl.js:16-25](server/src/servicenow/acl.js#L16)) |
| `sysauto_script`, `sys_user_preference`, `sys_flow_context`, `sys_update_xml` | execution-harness.js | the harness's own mechanism, measured and documented in §32 |
| `admin` (role name) | impersonation-target.js | NHA's own policy anchor — see 5.1 |
| `glide.scheduler.worker.N` | observed, not coded | the execution context's session id shape |

---

## Forward rules — what Phases 2–4 must not do

These are the sweep's real output, because the code they govern does not exist yet. Each
one is a live Phase 0 measurement, not a style preference.

1. **Never hardcode `security_admin`.** Derive the elevatable-role set from
   `sys_user_role` where `elevated_privilege = true`, and **run that query server-side.**
   Phase 0 D-2 measured that the REST Table API returns four roles and silently omits
   `security_admin` — the demo's own role — as an *empty result with no error*. A REST
   discovery hardcodes by omission.
2. **Never substring-match `getRoles()`.** `agent_security_admin` and
   `ais_high_security_admin` both contain `security_admin` (D-3). Use `gs.hasRole(role)`,
   or exact-match after splitting the bracketed list on `', '`.
3. **Never branch on `enableElevatedRole` / `disableElevatedRole` return values.** They are
   `undefined` and `"true"` respectively (trap H) — asymmetric and meaningless.
4. **Derive the required role for `(table, operation)` live** via the 1.4 precedence walk
   (`table.field` → `table.*`/`table.None` → `table`) resolved through
   `sys_security_acl_role`. Do not assume `security_admin`; Phase 0 D-1 proves the
   assumption is wrong for the write path anyway. Both ACL tables are REST-readable, so
   this derivation may use the existing REST path.
5. **Compose ACL conditions from request context.** A fixed condition template is the 5.5
   finding this sweep exists to prevent, and it is also the difference between the
   condition-driven ACL the sprint asks for and a static role-only one.
6. **Every returned sys_id gets read back against the live record** before it is reported —
   the existing `assertSysId` + read-back discipline, applied to the ACL row and its role
   M2M. With the governance gates off this is the only defence against a fabricated hex.
7. **Sweep `sys_update_xml` after authoring.** Phase 0 trap I: deleting an ACL leaves its
   configuration rows behind, and this run left five on `dev442675`.

---

## Method

`server/src` and `client/src`, excluding `node_modules`, `dist`, `fluent-workspace/dist`
(generated XML) and `server/test`. Patterns: `[0-9a-f]{32}`; quoted role names
(`admin|itil|security_admin|catalog_admin|user_admin|…`); `^const [A-Z_]+ = [{[]`;
`REQUIRED_ROLE|OP_TO_ROLE|ROLE_MAP|roleFor`; and the platform table names above. Each hit
was opened and read in context rather than dispositioned from the match line.
