# Gate A — ACL authoring pre-flight (READ-ONLY Phase A; one fully-reverted write in Phase B)

Run **before** the ACL write tool is designed. Two lockout/wrong-scope classes had to be
measured first: (1) an ACL whose role-link write silently fails is an **empty ACL that denies
everyone**, and (2) an ACL that lands in the wrong `sys_scope` is a silent trap. No building,
no fixes, no tool registration. Every finding cites file:line or an exact API response and is
classified ESTABLISHED / FAILED / UNVERIFIED.

**VERDICT (one line):** Two hard design constraints are now measured. **A1 FAILED** —
`sys_security_acl_role` is **not** in the gate, yet its create/write/delete ACLs require
`security_admin` exactly as `sys_security_acl` does, so a role-link authored through today's
path would run un-elevated, silently no-op, and leave an **empty, deny-everyone ACL**.
**B ESTABLISHED** — the shim authors in **global scope, always**: an explicitly requested
`sys_scope` was **silently coerced to `global`**, so v1 is global-only and must fail closed on
any scoped-app target. A3 is clean and A2 is a partial yes.

Instance: `dev442675.service-now.com`, runner `admin` (`6816f79cc0a8016401c5a33be04be441`).

---

## 1. Verdict table

| probe | verdict | one-line evidence |
|---|---|---|
| **A1** role-link gating | **FAILED (design gap)** | `GATED` holds `sys_security_acl` only — [required-role-classifier.js:38-44](../server/src/servicenow/required-role-classifier.js#L38-L44). Executed: `classifyRequiredRole({table:'sys_security_acl_role',…})` → `gated=false, required_role=null` for create/update/delete, so `isGatedDescriptor` ([elevation-shim-client.js:54](../server/src/servicenow/elevation-shim-client.js#L54)) returns false. And the shim body is **single-record only** — one `table`, one `payload`, one `sysId` ([elevation-shim.js:90-117](../server/src/servicenow/elevation-shim.js#L90-L117)). |
| **A1b** is the gap real on the instance? | **ESTABLISHED (EXECUTED)** | Server-side resolve of the governing ACLs: `sys_security_acl_role` **create → `["security_admin"]`, write → `["security_admin"]`, delete → `["security_admin"]`**, all `admin_overrides=0` — identical to `sys_security_acl`'s own create/write/delete. The gap is not theoretical. |
| **A2** Access Analyzer presence | **ESTABLISHED (partial read surface)** | Installed: `sys_scope` → `{"scope":"sn_access_analyzer","name":"Access Analyzer","version":"6.0.6"}`. Six tables exist. `sn_access_analyzer_request` / `_access_result` / `_debug_log` are **REST-readable** (HTTP 200, 0 rows). `sn_access_analyzer_access_finding` is **403 over REST even for admin**. |
| **A3** REST-channel interference | **ESTABLISHED (none on the ACL tables)** | Both Table API access policies are **inactive**: `Table GET API Access Policy` (`010e53d3…`, `api_path: now/table`, `active:"false"`) and `Table POST…` (`114e17d3…`, `active:"false"`). The 2 active policies cover `sn_build_agent/build_agent_api` and `now/integration` — not `now/table`. 32 active `sys_security_data_filter` rows; **0** on `sys_security_acl`, `sys_security_acl_role`, `sys_user_role`, `sys_user_has_role`. |
| **A4** scope context | **ESTABLISHED (EXECUTED)** | Inside the shim's own execution: `session: "glide.scheduler.worker.7"`, `gs.getCurrentApplicationId() → "global"`, `gs.getCurrentScopeName() → "rhino.global"`. `gs.getSession().getCurrentApplicationId()` throws `java.lang.SecurityException: Illegal access`. The runner's `apps.current_app` preference is `global`. |
| **B** scope landing (one reverted write) | **ESTABLISHED (EXECUTED)** | B1, no `sys_scope` asserted → landed `sys_scope: global`, `sys_package: global`, tier **EXECUTED**. B2, `sys_scope` **explicitly requested** as `c44f3c6c…` (`x_2196302_nwforge`) → landed **`sys_scope: global`**, tier **COERCED** (`requested c44f3c6c…, actual global`). Both reverted, read-back-confirmed. |

---

## 2. What each answer feeds into the write tool's design

### A1 → the tool must gate and author ACL + role-link as ONE unit

`sys_security_acl_role` create/write/delete each require `security_admin`
(`admin_overrides=0`), but the classifier does not gate the table. So today:

```
role-link write → isGatedDescriptor = false → ordinary un-elevated tool path
                → GlideRecordSecure insert denied → silent no-op (WI-1's measured class)
                → ACL exists with NO role, NO condition → EMPTY → denies by default
```

That is the lockout the official docs warn about, reachable through a gap in our own gate.

**Required of the write tool:**
1. Add `sys_security_acl_role` create/update/delete to `GATED` with `security_admin` and an
   EXECUTED provenance line citing this gate (it now has the same measured tier as the
   `sys_security_acl` entry, so it is a legitimate constant by the module's own rule —
   [required-role-classifier.js:14-23](../server/src/servicenow/required-role-classifier.js#L14-L23)).
2. Author **ACL + role-link inside ONE elevated transaction**. The current shim cannot: it
   takes a single `(table, payload, sysId)`. Either extend `buildElevatedWriteBody` to a
   multi-record unit, or reuse the Phase-4 idiom already proven for this
   ([acl-authoring.js:284-306](../server/src/servicenow/acl-authoring.js#L284-L306) resolves
   the role **server-side by name** — mandatory, because REST cannot see `security_admin` on
   `sys_user_role`, Gate 0 D-2, and it is why our REST-side resolve above returned `[]`).
3. **Never leave a role-less ACL behind.** If the role-link half fails, the ACL half must be
   reverted (or never activated). A partial success here *is* the incident.
4. The tool's read-back must tier **both** records. An ACL that reads back EXECUTED while its
   role-link is absent is exactly the confidently-wrong green this repo exists to prevent.

### A4 / B → v1 is **global-only**, and must fail closed on scoped targets

The shim runs on a pooled scheduler worker whose current application is `global`
(`rhino.global`). Records it authors take that scope. Asserting a different `sys_scope` in the
payload does **not** work — it is accepted and silently rewritten to `global`.

Two consequences:

- **v1 can author global ACLs only.** A scoped-app ACL is not authorable through this
  transport at all. The tool must **validate the target and refuse** — a request whose target
  is a scoped table has no honest path here, and authoring a global ACL instead would be a
  silent wrong-scope write.
- **`sys_scope` must be an ASSERTED field on every write.** The coercion was only visible
  because B2 put `sys_scope` in the payload; the WI-4 projection guard then tiered it COERCED
  ([elevation-shim.js:211-247](../server/src/servicenow/elevation-shim.js#L211-L247)). B1
  omitted it and rendered a clean **EXECUTED** while landing in a scope nobody chose. Note
  that `assertScopeIntentHeld` ([client.js:230](../server/src/servicenow/client.js#L230)) does
  **not** cover this — it guards `table.create` over REST, and the shim does not go that way.

### A2 → the evaluate-half is read-only-honest, not drivable-yet

Access Analyzer 6.0.6 is installed with a real verdict surface:
`sn_access_analyzer_access_result` carries `acl_result`, `overall_access`,
`security_data_filter_result`, `datafiltration_result`, `admin_override_applied`, `insights`,
and a reference back to `access_analyzer_request`. It is **REST-readable**. The request table
is shaped to be driven (`resource_type`, `operations`, `analyze_by` mandatory; targets by
`target_table` / `target_record` / `target_field` / `target_rest_endpoint`; `resource_type`
choices include `record`, `rest_endpoint`, `ui_page`, `gen_ai_agent`).

But: 0 rows anywhere (never run here), driving it is unproven, and
`sn_access_analyzer_access_finding` is **403 over REST**. So the honest v1 default stands:
**"matching ACLs + run Access Analyzer in the UI"**, no live verdict claimed. Driving the
analyzer from NHA is a real follow-on with a readable result table — worth its own gate, not a
v1 assumption.

### A3 → no REST-channel trap on the ACL tables, but two 403 tables to remember

No API access policy and no security data filter shapes NHA's Table API calls to
`sys_security_acl` / `sys_security_acl_role`. Separately measured (same H6 class as Gate 0):
`sys_store_app` and `sn_access_analyzer_access_finding` return **403 for `admin` over REST**.
A tool that reads either must not read a 403 as "absent".

---

## 3. Phase B — the write, and its reversal

Both probes were **inactive** and named tables that **do not exist**, so neither could enforce
anything on anyone even if activated. Both were **valid, not empty** (data condition
`sys_idISNOTEMPTY^EQ`), per the stop rule forbidding an empty ACL even transiently. No
role-link was authored (that is A1's concern and the tool's job).

| step | result |
|---|---|
| B0 execution scope context (read-only op) | `current_app_id: "global"`, `current_scope_name: "rhino.global"`, worker `glide.scheduler.worker.7` |
| B1 create `u_nha_gatea_probe`, no `sys_scope` asserted | **EXECUTED**, `sys_id c3104b4c…`, landed `sys_scope: global` / `sys_package: global` |
| B2 create `x_2196302_nwforge_gatea_probe`, `sys_scope=c44f3c6c…` asserted | **COERCED**, `sys_id 9c208b4c…`, `sys_scope` **requested `c44f3c6c…` → actual `global`**; all 7 other fields matched |
| revert (elevated channel, swept by **name**) | both `gone: true`, `links_deleted: 0`, `update_xml_swept: 1` each |
| post-revert REST read-back (un-elevated) | `u_nha_gatea_probe` → 0 rows; `x_2196302_nwforge_gatea_probe` → 0 rows; `sys_update_xml` for both sys_ids → 0 rows |
| de-elevation | fresh worker `has_role: false`, `in_get_roles: false` |

The revert ran in a `finally` and swept **by name, not by nonce** — deliberately, because the
"Generate ACL Description on First Save" business rule can rewrite the marker, and an ACL that
landed but read back FAILED must still be removed. (Measured here: with a non-empty
`description` supplied, the rule did **not** fire — both descriptions read back byte-identical.
That refines the Phase-4 note, which saw the rewrite on a marker-only description.)

---

## 4. Instance hygiene note (pre-existing, not from this gate)

`sys_security_acl` `fefdc23383f20790b939cc65eeaad36d` — `name=incident`, `operation=read`,
**`active=false`**, condition `stateIN1,2,3^short_descriptionLIKEvpn^assigned_toISNOTEMPTY^EQ`,
one `sys_security_acl_role` link (`bafd0633…`) — is still on the instance. It is the
**intentionally kept** Phase-4 artifact ([role-elevation-phase4-result.md:235](role-elevation-phase4-result.md)),
not residue from this gate. It is worth flagging for one reason: its
`sys_scope` is **`73cd8416…` = `AGAMYA_TEST`**, an unrelated app — a scoped ACL on the
**global** `incident` table, authored when the harness's current application was not global.
That is the wrong-scope trap this gate exists to characterise, sitting on the instance as a
worked example. Inactive, so it enforces nothing.

---

## 5. Residual UNVERIFIED

- **`[A-runner]`** — still no non-admin `security_admin` user on this PDI. Everything above was
  measured with `admin`'s dormant `security_admin`. A dedicated integration user remains a
  production prerequisite and is provisioning-blocked here.
- **Un-elevated role-link write, measured.** A1b establishes that `sys_security_acl_role`
  create requires `security_admin`. That an un-elevated `GlideRecordSecure` insert there
  *silently no-ops* is **inferred** from WI-1's measured class on `sys_security_acl`, not
  re-measured on this table. The write tool's own gate should prove it once, A/B, the way WI-1
  did.
- **Scoped-app authoring, negative-only.** B proves the shim cannot honour a requested scope.
  It does **not** prove what happens when a *real* scoped table is the target — the
  `x_2196302_nwforge` app owns **no tables** (`sys_db_object` where `sys_scope=c44f3c6c…` → 0
  rows), so no same-scope object existed to author against. Both B probes named nonexistent
  tables. Whether the platform's own scope rule would additionally *reject* (rather than
  silently re-scope) an ACL on a real scoped table is untested. It does not change the design
  input — v1 is global-only and must fail closed either way.
- **Driving Access Analyzer.** Presence and a readable result table are established; creating a
  request and getting it to execute is not attempted and not assumed.
- **`sn_access_analyzer_access_finding` contents** — 403 over REST; unreadable from NHA's
  channel by any identity available here.

---

## 6. Trap-ledger entries

```json
{
  "gateA.shim_authors_global_only": {
    "rule": "the elevation shim runs on a pooled scheduler worker whose current application is global (gs.getCurrentApplicationId() -> 'global', gs.getCurrentScopeName() -> 'rhino.global'). Every record it authors lands in sys_scope=global. Asserting a different sys_scope in the payload is ACCEPTED and SILENTLY REWRITTEN to global.",
    "measured": "B2: requested sys_scope=c44f3c6c37c24793be9f8b759c7818e4 (x_2196302_nwforge), actual sys_scope=global, sys_package=global; tier COERCED",
    "consequence": "an ACL write tool must validate the target's scope and FAIL CLOSED on a scoped-app target; it must never author a global ACL as a substitute",
    "tier": "EXECUTED"
  },
  "gateA.sys_scope_must_be_asserted": {
    "rule": "sys_scope must be an ASSERTED field on every elevated write, or the coercion is invisible. B1 omitted it and rendered a clean EXECUTED while landing in a scope nobody chose; B2 asserted it and the WI-4 projection guard tiered it COERCED. assertScopeIntentHeld (client.js:230) does NOT cover this path — it guards table.create over REST, and the shim goes through sysauto_script.",
    "tier": "EXECUTED"
  },
  "gateA.role_link_table_is_gated_but_ungated_in_code": {
    "rule": "sys_security_acl_role create/write/delete each require security_admin with admin_overrides=0 — identical to sys_security_acl. The WI-2 classifier gates only sys_security_acl, so a role-link write routes un-elevated, silently no-ops, and leaves an ACL with no role: EMPTY, denies by default.",
    "measured": "server-side resolve of the governing ACLs (REST returns [] for these links because sys_user_role hides security_admin — Gate 0 D-2)",
    "consequence": "gate the role-link table AND author ACL + role-link as one elevated unit; revert the ACL half if the link half fails",
    "tier": "EXECUTED"
  },
  "gateA.acl_description_rule_only_fires_when_empty": {
    "rule": "the 'Generate ACL Description on First Save' business rule did NOT rewrite a description that was supplied non-empty — both Phase B probes read back byte-identical. Phase 4 saw the rewrite on a marker-only description. A nonce carried inside a real description survives; a bare marker may not. Revert sweeps should still go by NAME, not by nonce.",
    "tier": "EXECUTED"
  },
  "gateA.rest_403_tables": {
    "rule": "sys_store_app and sn_access_analyzer_access_finding return 403 to admin over the REST Table API (API-level ACL). Same H6 class as Gate 0: a 403 is not absence.",
    "tier": "EXECUTED"
  }
}
```

---

## 7. Confirmations

- Phase A: **no mutations**.
- Phase B: two ACLs, both **inactive**, both **valid** (never empty, not even transiently),
  both on **nonexistent** tables (no real users affected), both **reverted** with the revert
  **read-back-confirmed over a second transport**, `sys_update_xml` swept (1 each), no session
  left elevated (`has_role: false` on a fresh worker), **no ACL left behind**.
- No stop rule was crossed. A1's FAILED is a design finding, not a Phase-B dependency — Phase B
  explicitly authored no role-link.
