# Gate S — ACL scope pre-flight

**Instance:** `dev442675.service-now.com` · Australia `glide-australia-02-11-2026__patch3-05-25-2026_06-12-2026_1106.zip`.
Diagnostic only — **no product code changed**. Tree clean, instance clean, nothing left behind.

---

## 0. Verdict table

| # | question | verdict | evidence |
|---|---|---|---|
| **S1** | what determines the created ACL's `sys_scope`? | **ESTABLISHED** | the session's current application, not the field. `gs.setCurrentApplicationId()` **is callable**; `GlideSession.setCurrentApplicationId()` is not |
| **S2** | the five doc restrictions as a deterministic checklist | **ESTABLISHED** | §3 |
| **S3** | is a legal scoped target constructible on this PDI? | **FAILED (blocked)** | `x_2196302_nwforge` owns **0 tables** and 0 real tables carrying a scoped column → no legal *record* target |
| **S4** | reference: existing non-global ACLs | **ESTABLISHED** | 8,746 exist; 13/14 sampled record-type are same-scope, the 14th is the docs' field-in-scope allowance |
| **B1** | **can the writer set and hold a non-global `sys_scope`?** | **ESTABLISHED — YES** | mechanism A held: `sys_scope` **and** `sys_package` both landed `c44f3c6c…` |
| **B2** | does the platform enforce the restrictions? | **ESTABLISHED — NO** | all five forbidden ops **ALLOWED**, no error, no coercion |

---

## 1. Make-or-break (B1) — **scope CAN be set and held**

**S1, the mechanism.** The shim authors through a one-shot `sysauto_script`
([elevation-shim.js:595](../server/src/servicenow/elevation-shim.js#L595) for the single-record
path, [:692](../server/src/servicenow/elevation-shim.js#L692) for the ACL unit;
[execution-harness.js:265](../server/src/servicenow/execution-harness.js#L265) for the harness).
Gate A measured that execution reporting `getCurrentApplicationId() → "global"`, and today the
writer hard-codes `sys_scope: 'global'` as an asserted field
([acl-spec.js:55](../server/src/servicenow/acl-spec.js#L55), [:296](../server/src/servicenow/acl-spec.js#L296)).
`assertScopeIntentHeld` ([client.js:230](../server/src/servicenow/client.js#L230)) guards REST
creates only — it never sees this channel.

**B0 — discovered, not assumed.** Reflection inside a live `sysauto_script` execution:

| symbol | result |
|---|---|
| `gs.setCurrentApplicationId` | **`function` — callable** |
| `gs.getCurrentApplicationScope` | `function` |
| `GlideSession#setCurrentApplicationId` | **`SecurityException: Illegal access**` (same block Gate A hit on the getter) |
| `GlideApplication` | `function`, constructible (`com.glide.sys.Application`) |
| `GlideAppLoader` / `GlideScopedApplication` / `GlideApplicationScope` / `GlideScopeManager` | `undefined` |

`gs.setCurrentApplicationId(nwforge)` moved the context `global → c44f3c6c…` and the restore put
it back (`restored_ok: true`). **The `gs` facade is permitted where the raw `GlideSession` method
is not.**

**B1 — two mechanisms, measured:**

| mechanism | result |
|---|---|
| **A** — `gs.setCurrentApplicationId(nwforge)` → `GlideRecordSecure.insert()` | **HELD.** `sys_scope: c44f3c6c…`, **`sys_package: c44f3c6c…`** — genuinely owned by the app |
| **B** — insert in global, then `setValue('sys_scope', nwforge)` + `update()` | **FAILED.** stayed `global` |

So scope is **stamped at insert from the current application**, and the `sys_scope` *field* is
inert at insert (Gate A B2) **and** at update (new here). The field was never the lever; the
session context is.

Teardown: both probes deleted and read-back-confirmed over a second transport, 3 `sys_update_xml`
rows swept, current application restored (`ok: true`), and a **separate** execution confirmed the
pooled worker still reports `global`.

---

## 2. The v2 shape this implies — **honor-or-refuse**

Scope-honoring is **possible on this channel**, so the doc-compliant v2 is *honor a requested
scope, or refuse it explicitly* — never accept-and-silently-rewrite (which is what happens today).

Three things the build must carry, each grounded in a measurement above:

1. **The lever is a session mutation on a POOLED worker.** Gate 4 already measured this pool
   carrying a non-Default update set (`9055f633…`, re-observed in B0) precisely because something
   left it behind. The switch must be set and restored **inside one execution, in a `finally`,
   and verified by reading it back** — the discipline B1 used. A worker left switched would
   silently stamp whatever ran on it next into someone else's application. This is the single
   biggest new risk scope-honoring introduces.
2. **`sys_scope` must stay an asserted field even though it is inert.** It is what makes the
   projection guard render COERCED instead of green when the landing scope is not the requested
   one (Gate A B1 vs B2). Assert the *requested* scope and compare — do not assert `'global'`.
3. **Every restriction is ours to enforce.** See §4: the platform enforces none of them on this
   path, so the checklist in §3 must be a deterministic pre-write refusal, before the approval
   card, exactly like WI-ACL-1's empty/invalid checks.

**No channel change is required.** (For the record, had mechanism A failed, the alternative would
have been moving the write off `sysauto_script` onto a scoped execution channel — a scoped
Scripted REST resource or a job record created *in* the target app — which is a much larger
change. That is not needed.)

---

## 3. The restriction checklist (S2) — the fail-closed spec for v2

Inputs: `target_scope` (the scope the ACL is to be authored in), `object` (name + type),
`object_scope`, `script`, `roles[]`. Every rule is **refuse-by-default**: if an input cannot be
*read*, refuse — never assume it passes.

| # | rule (from the docs) | condition | outcome |
|---|---|---|---|
| **R1** | an ACL may only be created for an object in the **same scope**, or a table with **≥1 field in that scope** | `object_scope === target_scope` → allow. Else if `∃ sys_dictionary` row with `name = <table>` ∧ `sys_scope = target_scope` ∧ `element` non-empty → allow. Else → **refuse** `cross_scope_object` | the field-in-scope branch is real — `cmdb_software_instance` (§5) is a live example |
| **R2** | a **different-scope** table may not carry a **script** condition | `object_scope !== target_scope` ∧ `script` non-empty → **refuse** `cross_scope_script` | R1's field-in-scope branch makes "different scope" reachable while still legal, so R2 is not subsumed by R1 |
| **R3** | **wildcard table** rules (`*`) only in **global** scope | `table === '*'` ∧ `target_scope !== 'global'` → **refuse** `wildcard_table_scoped` | v1 already refuses `*` outright ([acl-spec.js `composeAclName`](../server/src/servicenow/acl-spec.js)); v2 keeps that and this is the narrower rule if it is ever relaxed |
| **R4** | a **role** may not be added to an ACL in a **different scope** than the selected app | `acl_scope !== target_scope` → **refuse** `cross_scope_role_link`. Because the unit is atomic, this reduces to: author the ACL and its role links in one execution **with the current application set to the ACL's own scope** | measured allowed by the platform (§4 C5) — so this is entirely ours |
| **R5** | **wildcard field** rules (`table.*`) only for **same-scope** tables | `field === '*'` ∧ `object_scope !== target_scope` → **refuse** `wildcard_field_cross_scope` | strictly narrower than R1; applies where R1's field-in-scope branch would otherwise allow |

**Ordering:** R1 first (it is the precondition the rest qualify), then R3/R5 (shape), then R2/R4
(content). All of them before the approval card, per WI-ACL-1's rule that a human is never asked
to approve something already destined to refuse.

**Fail-closed additions carried from v1:** unknown/unreadable target table → refuse; scope read
error → refuse; non-record ACL type → refuse as unproven.

---

## 4. Forbidden-op behaviour (B2) — the platform enforces **none** of it

Authored from a `nwforge` current-application context against a throwaway **global** table
(`u_nha_gates_tbl`, created and dropped for this probe). Every probe ACL **inactive**.

| case | doc rule | platform behaviour |
|---|---|---|
| **C1** ACL in `nwforge` on a **global** table | R1 | **ALLOWED** — landed `sys_scope: c44f3c6c…` |
| **C2** same, **with a script** | R2 | **ALLOWED** — script stored **verbatim**, not stripped |
| **C3** wildcard table `*` in a **non-global** scope | R3 | **ALLOWED** |
| **C4** wildcard field `u_nha_gates_tbl.*` on a different-scope table | R5 | **ALLOWED** |
| **C5** role link added while current app (`global`) ≠ ACL scope (`nwforge`) | R4 | **ALLOWED** — the link landed |

**Not one hard-errored. Not one silently coerced. All five simply worked.** These are
authoring-time (UI/Studio) restrictions; the server-side scripted path applies none of them.

This is the strongest possible argument for the gate's own instruction that v2 enforce every
restriction deterministically pre-write: there is nothing to fall back on. It is also *better*
than silent coercion would have been — an allowed write is at least visible in the read-back,
whereas a coerced one is the class that reads as success.

---

## 5. Reference shapes (S4)

8,746 non-global ACLs exist. Sampling 14 record-type ones and comparing each ACL's scope to its
target table's scope:

- **13 SAME-SCOPE** — `x_tepv_ts_dms_mdf_request`, `sn_cmdb_ws_class_icon`, `mdm_product_data`, …
  the R1 primary branch, which is what the platform's own shipped content follows.
- **1 DIFFERENT-SCOPE** — `cmdb_software_instance`: ACL in *CMDB Workspace* (`c8ab7682…`) on a
  **global** table. This is R1's second branch (a scoped app extending a global table with its own
  column), and it is why R1 cannot be simplified to "same scope only".
- All **10** non-global record ACLs carrying a script are same-scope — consistent with R2.
- Three non-global `*` ACLs exist, but all are `ux_route` / `client_callable_script_include`
  types, **not record** — so no counterexample to R3, which is a record-table rule.

---

## 6. Residuals

- **`[scoped-app-empty]`** — `x_2196302_nwforge` owns **0 tables**. It does own 73 scoped
  dictionary columns, but every one is on a `var__m_sys_hub_flow_*` flow-variable pseudo-table and
  **0 of those appear in `sys_db_object`** — so R1's field-in-scope branch yields no legal target
  either. **A live positive proof of a doc-legal scoped RECORD ACL is blocked on this PDI.**
  B1 proved the *scope-landing mechanism* (its probe named a nonexistent table); it did not and
  could not prove *legality*, which is entirely ours to enforce anyway (§4).
  - The app *does* own 19 flows, so a `flow`-type ACL would be a legal same-scope target — but
    non-record types are unproven and refused, so this does not unblock a record-ACL proof.
  - To unblock: create a table inside the scoped app (Studio/SDK), or install a scoped app that
    ships one.
- **`[A-runner]`** — unchanged. Still `admin`'s dormant `security_admin`; no non-admin integration
  user on this PDI.
- **`[pool-switch-risk]`** — UNVERIFIED: whether a `sysauto_script` execution that dies *between*
  `setCurrentApplicationId` and its restore leaves the pooled worker switched. B1 and B2 both
  restored cleanly via `finally`, and separate follow-up executions both reported `global`, but
  the crash path was not induced. The v2 build should treat this as the risk to design against.
- **`GlideApplication`** — constructible but its API surface was not enumerated; not needed, since
  `gs.setCurrentApplicationId` answers the question. UNVERIFIED as an alternative lever.

---

## 7. Confirmations

- **Phase A: no mutations.** All S1–S4 findings are code reads and REST queries.
- **Phase B:** every probe ACL **inactive** and either on a nonexistent table or on a throwaway
  global table created and dropped for the probe. No table real users depend on was touched.
- All 6 probe ACLs deleted, read-back-confirmed on a second transport; 11 `sys_update_xml` rows
  swept; scratch table dropped and confirmed gone.
- **No persisted current-application switch:** restored in a `finally` in both B1 and B2
  (`restore.ok: true`), and confirmed from **separate** executions afterwards —
  `current_app: "global"`, `scope: "rhino.global"`.
- No session left elevated: fresh-worker `has_role: false`, `in_get_roles: false`.
- Final REST sweep: `u_nha_*` ACLs `[]`, probe sys_ids `[]`, scratch tables `[]`, ACLs in the
  nwforge scope `[]`, orphan role links `[]`.
- Tree clean; no product code changed.

**STOP** — the make-or-break is answered. The fix is not designed in this pass.
