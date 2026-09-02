import { getDb } from './db.js';
import { getSettings } from '../config/store.js';
import { log } from '../logging.js';

/**
 * A-3/A-4 — the instance knowledge ledger.
 *
 * Everything this project learned the hard way lives in docs/fluent-research.md
 * §16, where a human can read it and the agent cannot. Each of those entries
 * cost a debugging cycle, and the agent rediscovers them from scratch in every
 * new session — or, more often, does not, and ships the confidently wrong
 * result the trap produces.
 *
 * So the ledger is seeded from those entries and injected into BOTH prompts
 * that matter: the agent's system prompt and the codegen context.
 *
 * Scope matters. A trap that is a property of the SDK or the platform holds
 * everywhere and is stored against `*`. A fact MEASURED on one instance
 * ("problem_id exists on no table here") is stored against that instance and
 * must never leak to another — a second PDI may well have the field, and a
 * confidently wrong "it does not exist" is exactly the kind of damage this
 * ledger is supposed to prevent.
 */

const UNIVERSAL = '*';
const now = () => new Date().toISOString();

export const FACT_KINDS = ['trap', 'mapping', 'decision', 'preference'];

export function currentInstance() {
  return (getSettings().connection.instanceUrl || '').replace(/\/+$/, '') || '(unbound)';
}

/**
 * Upsert. Confidence only ever moves UP for an unchanged value: a fact
 * re-observed is a fact confirmed. A changed value resets provenance, because
 * the old evidence no longer supports the new claim.
 */
export function recordFact({ instance, kind, key, value, provenance, confidence = 0.6 }) {
  if (!FACT_KINDS.includes(kind)) throw new Error(`Unknown fact kind "${kind}". Use one of: ${FACT_KINDS.join(', ')}`);
  if (!key || !value) throw new Error('A fact needs both a key and a value.');
  const db = getDb();
  const inst = instance || currentInstance();
  const existing = db.prepare('SELECT * FROM facts WHERE instance = ? AND kind = ? AND key = ?').get(inst, kind, key);

  if (existing && existing.value === String(value)) {
    const bumped = Math.min(0.99, Math.max(existing.confidence, confidence) + 0.05);
    db.prepare('UPDATE facts SET confidence = ?, ts = ? WHERE id = ?').run(bumped, now(), existing.id);
    return { ...existing, confidence: bumped, reconfirmed: true };
  }

  db.prepare(
    `INSERT INTO facts (instance, kind, key, value, provenance, confidence, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance, kind, key) DO UPDATE SET
       value = excluded.value, provenance = excluded.provenance,
       confidence = excluded.confidence, ts = excluded.ts`
  ).run(inst, kind, key, String(value), provenance || null, confidence, now());
  return db.prepare('SELECT * FROM facts WHERE instance = ? AND kind = ? AND key = ?').get(inst, kind, key);
}

/** Facts that apply here: this instance's own, plus the universal ones. */
export function listFacts({ instance, kind } = {}) {
  const inst = instance || currentInstance();
  const sql = kind
    ? 'SELECT * FROM facts WHERE (instance = ? OR instance = ?) AND kind = ? ORDER BY kind, key'
    : 'SELECT * FROM facts WHERE (instance = ? OR instance = ?) ORDER BY kind, key';
  const args = kind ? [inst, UNIVERSAL, kind] : [inst, UNIVERSAL];
  return getDb().prepare(sql).all(...args);
}

export function deleteFact(id) {
  return { deleted: getDb().prepare('DELETE FROM facts WHERE id = ?').run(id).changes > 0 };
}

/* ------------------------------------------------------------------ *
 * Seed — docs/fluent-research.md §16 and §19, verbatim in substance
 * ------------------------------------------------------------------ */

const SEED = [
  // --- Universal: properties of the SDK and the platform ---
  { scope: UNIVERSAL, kind: 'trap', key: 'priority-is-calculated',
    value: 'On task tables (incident, problem, change_request, sc_task) `priority` is CALCULATED from `impact` and `urgency`. Writing it directly is silently overwritten on insert: {"priority":"1"} lands as 4 - Low. To reach Critical set impact=1 and urgency=1 and do not set priority at all.',
    provenance: 'fluent-research §16 trap 5; re-measured in the §20 setup', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'encoded-query-silent-drop',
    value: 'An encoded query naming a field that does not exist is silently DROPPED, not rejected. `^fooISNOTEMPTY` and `^fooISEMPTY` then both match the same record. Check every queried field against the live schema before trusting a locator — a condition on an unknown field certifies the absence of a bug rather than finding one.',
    provenance: 'fluent-research §16 trap 2 and §14 false green', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'unknown-field-writes-accepted',
    value: 'Writes to a field that does not exist are silently ACCEPTED. The flow completes, activation reports 10/10, and the effect never happens. Read the effect back off the instance; never infer it from a green deploy.',
    provenance: 'fluent-research §16 trap 3', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'sysparm-fields-drops-unknown',
    value: '`sysparm_fields` drops unknown names without complaint — request two fields, get one, no error. Compare returned keys against requested keys.',
    provenance: 'fluent-research §16 trap 4', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'trap', key: 'trigger-strategy-default-once',
    value: '`trigger_strategy` defaults to `once`, and `once` means once EVER for a record — a record that leaves the trigger condition and re-enters is never processed again. Set it explicitly on every updated/createdOrUpdated trigger. `unique_changes` is the per-transition form; `every` fires on every save while the condition holds and duplicates anything the flow creates.',
    provenance: 'fluent-research §16 trap 10, PROBE B2 in §17; enforced by guard A4', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'keys-ts-is-project-global',
    value: '`keys.ts` is a FLAT PROJECT-WIDE map from a Now.ID key to one sys_id. A key is not "an element in this flow" — it is a live record owned by whichever flow declared it first. Reusing one collides instead of creating a new element, and the build aborts naming a sys_id you never wrote. Prefix every key with a per-flow slug; never copy one from an example.',
    provenance: 'fluent-research §16 trap 1, CLASS C in §12', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'lookuprecord-miss-errors-flow',
    value: 'A `lookUpRecord` whose query matches nothing does NOT return empty — it ERRORS the whole flow at run time. Resolve every proper noun against the instance first; a miss is a loud failure, not a fallback, so a stale name left in a query is a flow that fails on every execution while the build stays green.',
    provenance: 'fluent-research §16 trap 6', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'journal-fields-invisible-to-get',
    value: 'Journal fields (work_notes, comments) are invisible to a plain GET — the record reads empty even when it has notes. Read `sys_journal_field` by `element_id` + `element` instead.',
    provenance: 'fluent-research §16 trap 7', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'install-ships-whole-application',
    value: '`now-sdk install` deploys the WHOLE application, not the one artifact requested: every artifact\'s `sys_updated_on` moves. Measure idempotency as "same sys_id, no new rows", never as unchanged timestamps.',
    provenance: 'fluent-research §16 trap 8', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'trigger-instance-v2-blob',
    value: '`sys_hub_trigger_instance_v2` has no `condition` or `table_name` columns — querying them returns a row of nulls. The trigger configuration is a gzip+base64 blob in `trigger_inputs`; decode it. The real columns are flow, trigger_type, trigger_definition, trigger_inputs.',
    provenance: 'fluent-research §16 trap 11', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'trap', key: 'schedules-stored-in-utc',
    value: 'Scheduled flow times are stored in UTC. A schedule that should read 07:00 IST is stored as 01:30 UTC. Convert before asserting a cadence, and state the timezone when reporting one.',
    provenance: 'fluent-research §8 capability matrix', confidence: 0.9 },

  { scope: UNIVERSAL, kind: 'trap', key: 'ollama-ignores-seed',
    value: 'Ollama accepts a `seed` and ignores it on *-cloud models, on both /v1 and the native /api/chat: three identically-seeded calls return three different completions. `temperature: 0` is only approximately stable — repeated calls share a prefix then diverge. Never assume a generation is reproducible.',
    provenance: 'fluent-research §19, measured 2026-08-18', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'decision', key: 'verify-locator-carries-proof',
    value: 'When an expected value is not knowable in advance (a generated PRB/INC number, a sys_id), do not guess it — move the proof into the LOCATOR. Locate with a query that can only match when the effect happened, then assert a field whose value you do know. A locator matching nothing is reported as a failed assertion. This only works when every field in the locator EXISTS.',
    provenance: 'fluent-research §14', confidence: 0.9 },

  // --- Track B: SLAs and access control (fluent-research §22) ---
  { scope: UNIVERSAL, kind: 'trap', key: 'task-sla-row-proves-nothing',
    value: 'A `task_sla` row on a record proves NOTHING about which SLA produced it. Out-of-box definitions attach to the same record, so "an SLA attached" is an assertion that passes with the definition under test deleted. Always filter by `task_sla.sla = <contract_sla sys_id>`, and when the expected one is missing, report which rivals DID attach — "nothing attached" and "three attached and ours was not one of them" are different diagnoses.',
    provenance: 'fluent-research §22 B-2; measured — one P1 incident attached three task_sla rows', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'contract-sla-duration-carries-days',
    value: '`contract_sla.duration` is a glide_duration stored as an OFFSET FROM 1970-01-01, with whole days carried in the DATE half: 4h is "1970-01-01 04:00:00" and 2 days is "1970-01-03 00:00:00". Reading the time half alone gives the right answer under a day and silently reports a 2-day SLA as zero.',
    provenance: 'fluent-research §22 B-1, read off the OOB definitions', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'sla-schedule-inert-without-source',
    value: 'A `contract_sla.schedule` is IGNORED unless `schedule_source` is "sla_definition". Setting the reference alone leaves the clock running 24x7 and nothing reports it. Measured: two definitions identical but for that field, same 4h duration, same incident — 4.00h wall-clock at "no_schedule" against 7.84h at "sla_definition". Verify against `task_sla.schedule` on the attached row, not against the definition.',
    provenance: 'fluent-research §22 B-1, two-definition probe', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'task-sla-times-are-utc',
    value: '`task_sla.start_time` and `planned_end_time` are stored in UTC, and the Table API renders `display_value` in the session timezone. On a US-Pacific session those differ by seven hours, so a breach clock checked against the display half reports a CORRECT SLA as broken. Parse the `value` half with an explicit Z; never compute on a display value.',
    provenance: 'fluent-research §22 B-2; the same instant read as 15:24:19 (value) and 08:24:19 (display)', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'acl-operation-sysids-inconsistent',
    value: '`sys_security_acl.operation` and `.type` are references whose sys_ids follow two conventions at once: the core operations have literal sys_ids ("read", "write", "create", "delete", "execute") while extended ones are ordinary 32-hex ("report_view" is 0997ab83733303005978e4b9cdf6a7b9), and `record` is its own sys_id on sys_security_type. A raw read produces a report that is half readable and half opaque, which looks like a data problem rather than a reading error. Resolve through display_value.',
    provenance: 'fluent-research §22 B-3, read off sys_security_operation', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'trap', key: 'acl-name-prefix-matches-siblings',
    value: 'Querying ACLs with `nameSTARTSWITH<table>` also matches sibling tables — `incident_task` has 43 ACLs of its own that all match "incident". Use `name=<t>^ORnameSTARTSWITH<t>.`: a name belongs to a table only if it equals it or starts with it plus a dot. ACLs are also INHERITED, so a table is governed by its parents rows too; walk the hierarchy and record which table defined each rule.',
    provenance: 'fluent-research §22 B-3, measured 43 contaminating rows', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'decision', key: 'acl-read-only-never-authored',
    value: 'NowHelpAssist READS and EXPLAINS access control and never writes it. There is no ACL authoring tool and none should be simulated with create_record on sys_security_acl — an ACL is the one artifact class where a confidently wrong write is a security incident rather than a bug. Two reporting rules follow: an empty ACL result may mean the tables are not readable on this connection rather than that no rules exist (the report carries a `visibility` field saying which, and it must be quoted), and a role diff shows which rules NAME each role, never what those users can do.',
    provenance: 'fluent-research §22 B-3, the scope decision for Track B', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'trap', key: 'admin-overrides-inverts-a-role-diff',
    value: 'admin_overrides on an ACL means the rule is SKIPPED for admin. Since most OOB rules set it (21 of 27 record ACLs on incident here), `admin` appears by name on almost none of them — and a role diff read naively concludes admin has LESS access than itil, which is backwards. Not being named is the grant.',
    provenance: 'fluent-research §22 B-3, admin vs itil on incident', confidence: 0.9 },

  { scope: UNIVERSAL, kind: 'trap', key: 'model-repetition-loop-at-http-200',
    value: 'A weak model can return HTTP 200 with correct prose that collapses into a repetition loop — measured on gpt-oss:120b-cloud, four role names cycling about sixty times inside one sentence. Printed beside an accurate structured report it reads as a finding about the instance rather than as the generation breaking down. Check generated text for consecutive n-gram loops and low lexical variety before showing it; retry once WITH the repeated fragment quoted as evidence, then refuse loudly.',
    provenance: 'fluent-research §22 B-3, the first live run of the ACL explanation', confidence: 0.9 },

  // --- Track C: catalog UI policies (fluent-research §23) ---
  { scope: UNIVERSAL, kind: 'trap', key: 'ui-policy-action-not-writable-over-rest',
    value: '`catalog_ui_policy_action` accepts a POST, returns 201, and SILENTLY DISCARDS `ui_policy` and `catalog_variable` — the two fields that attach the action to its policy and to its variable. Every other field lands, so you get a policy whose actions do nothing and no error anywhere. The cause is a field ACL on `sys_ui_policy_action.ui_policy` granting only the role `nobody` with admin_overrides OFF: the Table API DROPS a field the caller may not write rather than refusing. Reproduced through basic auth, a logged-in browser session, and the platform\'s own form (which renders the field read-only). Write catalog UI policies through the ServiceNow SDK instead; reads over the Table API are fine.',
    provenance: 'fluent-research §23, measured three ways on dev442675', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'dictionary-readonly-does-not-predict-rest-writes',
    value: 'The dictionary `read_only` flag does not tell you which fields a REST write will keep. On catalog_ui_policy_action, `variable` and `catalog_item` ARE read_only and store fine, while `ui_policy` and `catalog_variable` are NOT read_only and are dropped. Field ACLs decide. Test the write and read it back field by field.',
    provenance: 'fluent-research §23', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'trap', key: 'ui-policy-condition-is-io-prefixed-sysid',
    value: 'A catalog UI policy condition is NOT an encoded query on field names. `catalog_ui_policy.catalog_conditions` is a `variable_conditions` field addressing variables by sys_id with an `IO:` prefix, ending in `^EQ` — e.g. `IO:35c19214f7752110ed589ef0e3bfd6c3=true^EQ`. A condition written with field names saves and never matches. An action needs BOTH `variable` (the internal name) and `catalog_variable` (`IO:` + sys_id).',
    provenance: 'fluent-research §23, read off the OOB policies', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'ui-policy-action-states-default-to-ignore',
    value: '`visible`, `mandatory` and `disabled` on a UI policy action are STRINGS — "ignore", "true", "false" — not booleans, and "ignore" is the default meaning leave alone. An action that sets none of them saves cleanly and does nothing. Also: comparing a choice variable against its display LABEL instead of its stored VALUE produces a condition that can never be true.',
    provenance: 'fluent-research §23', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'trap', key: 'variable-type-codes-drift',
    value: 'Hardcoded catalog variable type codes go stale silently. On this instance 31 is "Requested For", 32 is "Rich Text Label" and 33 is "Attachment" — a common hardcoded list has 31 as Rich Text Label and 32 as Attachment, and omits 33 entirely. Read the choice list off `item_option_new.type` in sys_dictionary rather than trusting a table in code.',
    provenance: 'fluent-research §23, 26 hardcoded codes against 31 live ones', confidence: 0.9 },

  { scope: UNIVERSAL, kind: 'decision', key: 'edit-variables-in-place',
    value: 'Update a catalog variable in place; never delete and recreate it. A recreated variable gets a NEW sys_id, and every UI policy condition and action that named the old one keeps the reference and silently stops matching. The same applies to a choice: its `value` is what a policy condition compares against, so changing or deleting one can break a policy with no error.',
    provenance: 'fluent-research §23', confidence: 0.9 },

  { scope: UNIVERSAL, kind: 'decision', key: 'ui-policy-proven-only-by-the-form',
    value: 'A catalog UI policy is evaluated in the BROWSER, so no server-side read can prove it works — the record being correct and the form behaving are different claims. Related: setting the Angular model directly on a portal control changes the value WITHOUT re-evaluating the policy; only a real interaction does. Verify a policy by driving the form, never by reading the record back.',
    provenance: 'fluent-research §23, measured while driving /sp', confidence: 0.9 },

  // --- Track D: user impersonation (docs/impersonation-phase0-ledger.md) ---
  // These are the operating assumptions the M1 impersonation feature is built on.
  // Each is EXECUTED-tier: measured on the live instance, not read from documentation.
  { scope: UNIVERSAL, kind: 'trap', key: 'impersonation-predicates-are-constants',
    value: 'In a background (sysauto_script) execution the session is ALREADY `system` impersonating `admin`, so the impersonation predicates are constants and must never be branched on. `isImpersonating()` returns true before, during AND after an impersonation — it never flips. `canImpersonate()` returned true for an INACTIVE user and for a generated GUID matching zero sys_user rows, so it is not an eligibility gate. `gs.getUserID()` is the only trustworthy identity signal; assert on it before and after every switch.',
    provenance: 'impersonation-phase0-ledger D-1/D-2 (P0.0, P0.2, P0.3, P0.4)', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'impersonate-unknown-sysid-lands-on-guest',
    value: 'impersonate() with a well-formed sys_id that matches NO sys_user row does not fail and does not no-op — it silently switches the session to a DIFFERENT real user. Measured: a minted GUID landed on `guest` (active, zero roles), while canImpersonate() had already returned true for the same id. There is no error, no exception and no return value that distinguishes this from success, so code that trusts the requested target believes it is acting as that user while actually acting as guest. Always assert gs.getUserID() === the requested sys_id immediately after the switch and abort if it differs.',
    provenance: 'B1 proof gate T4, live on dev442675; extends impersonation-phase0-ledger D-2', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'gliderecordsecure-rowcount-lies',
    value: '`getRowCount()` on a GlideRecordSecure query does not report what you can read. Called before iterating it returns the UNFILTERED count (73 incidents, 3801 properties for a role-less user); called after iterating it returned 0 where 6 rows were genuinely readable. Trusting it produced a clean false "ACLs make no difference" pass. Count impersonated reads by iteration: while (gr.next()) n++.',
    provenance: 'impersonation-phase0-ledger §4 (P0.5/P0.5b)', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'plain-gliderecord-ignores-impersonation',
    value: 'Under impersonation a plain GlideRecord returns the ADMIN row set — it ignores the ACLs of the impersonated user entirely. Measured for a role-less user: 200/200/73/200 rows via GlideRecord vs 6/0/0/0 via GlideRecordSecure. Worse, `.get()` returned true and 9 rows iterated while `canRead()` on that same object returned false. The data is a false permission picture; the capability booleans are truthful. Use GlideRecordSecure on every impersonated path.',
    provenance: 'impersonation-phase0-ledger §4/§8 (P0.5b, P0.12b)', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'impersonated-denials-are-silent',
    value: 'NOTHING throws on a denial — not a denied read, not a denied write, not a cross-scope block. Ten such operations were attempted and every one returned normally. A denied GlideRecordSecure read returns boolean false; a denied update shows up as the row simply being absent from the result set, indistinguishable from "no such row". There is no exception to catch and no falsy return to test. Read canRead/canCreate/canWrite/canDelete BEFORE acting, and read the record back afterwards to confirm the effect.',
    provenance: 'impersonation-phase0-ledger §5/§8 (P0.6, P0.12)', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'es3-reserved-key-kills-job-silently',
    value: 'The platform script engine is ES3-era: a reserved word as an unquoted object key (`{ case: 1 }`) is a SYNTAX ERROR there but legal in modern JS. A sysauto_script containing one is accepted by the Table API, stored byte-identical, marked active=true — and never runs, with no syslog row and no error. The harness then misreports it as the scheduler not claiming the job. `new Function()` in Node does NOT catch this (V8 allows reserved words as property names), so validation needs an explicit ES3 reserved-word lint as well.',
    provenance: 'impersonation-phase0-ledger §11 trap A/D; re-measured in Node 24 while building B1', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'decision', key: 'impersonation-crash-safety-is-the-boundary',
    value: 'Crash safety for impersonation rests on the EXECUTION BOUNDARY, not on a finally block. A deliberate leak (impersonate, throw, no revert) was followed until a later execution landed on the SAME pooled worker session (glide.scheduler.worker.1) and it came up admin. Keep the finally as belt-and-suspenders for the rest of the current execution, but the boundary is the guarantee.',
    provenance: 'impersonation-phase0-ledger §6 (P0.10)', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'decision', key: 'impersonation-eligibility-is-nha-owned',
    value: 'RETRACTED: "canImpersonate() is the authoritative eligibility check". It is not, and it is not consulted anywhere in NHA. It approved an inactive user and a GUID matching zero sys_user rows, and impersonate() on that GUID silently became guest. Eligibility is decided by NHA against sys_user: the record exists (EXACTLY one row — this is the primary guard against the guest substitution, not hygiene), active is true, user_name is non-empty, the target is not the executor and not the integration account, and an admin-role target is a soft-deny requiring elevated human approval. Existence is re-verified at gate time even for a sys_id that came from discovery, because a sys_id can also arrive user-typed or model-produced. The platform will not stop any of these.',
    provenance: 'impersonation-phase0-ledger D-2 / B1 proof gate T4 / build pack B2', confidence: 0.95 },

  { scope: UNIVERSAL, kind: 'decision', key: 'impersonation-provenance-is-nha-sole',
    value: 'D5 is DEAD on this build: glide.audit.track_impersonation was created, set true and confirmed active, and sys_audit still recorded an identical session GUID with and without impersonation. The property stays ABSENT — enabling it buys nothing and implies an audit trail that does not exist. NowHelpAssist writes its own impersonation_audit row for every impersonated MUTATION and every mode transition (start/switch/end), and that table is the SOLE answer to "who really did this". Reads are deliberately not audited. The row is read back before it counts as recorded, and it carries no foreign key to the session, because deleting a conversation must not erase the only account of who caused a change still sitting on the instance.',
    provenance: 'impersonation-phase0-ledger D-4/D-5; build pack B5', confidence: 0.95 },

  { scope: 'instance', kind: 'mapping', key: 'impersonation-has-no-instance-audit',
    value: 'This instance keeps NO audit of impersonation. Zero Impersonate Begin/End rows in syslog and zero in sysevent — the events are not even registered in sysevent_register. `sys_user_impersonation` does not exist; `sys_user_impersonation_history` exists but holds 0 rows ever and captured none of the Phase 0 sessions. With glide.audit.track_impersonation set true and confirmed active, sys_audit.user held an IDENTICAL session GUID with and without impersonation, so the real performer is recorded nowhere — only the impersonated user, via sys_created_by. The NHA-side audit ledger is therefore the sole provenance for who really did an impersonated action.',
    provenance: 'impersonation-phase0-ledger D-3/D-4/D-5 (P0.7, P0.8, P0.9)', confidence: 0.99 },

  // --- Measured on THIS instance, and scoped to it ---
  { scope: 'instance', kind: 'mapping', key: 'incident.problem-link-absent',
    value: 'This instance has no `problem_id`, `rfc` or `caused_by` on incident, and NO field on incident/task references `problem` at all. A request to "link the problem back to the incident" cannot be satisfied here. The available task-to-task links are `incident.parent` and `problem.first_reported_by_task`.',
    provenance: 'fluent-research §15 audit and §20 re-measurement', confidence: 0.99 },

  { scope: 'instance', kind: 'mapping', key: 'hardware-group-has-no-manager',
    value: 'The Hardware group (sys_user_group 8a5055c9c61122780043563ef53438e3) has an EMPTY manager field. Any effect of the form "assign to the group\'s manager" produces nothing observable here. Never invent a placeholder name for it.',
    provenance: 'fluent-research §14 and §20, read off the instance', confidence: 0.95 },

  // --- The 2026-08-20/21 transcript hardening sprint (§36) ---
  { scope: UNIVERSAL, kind: 'trap', key: 'rest-silently-drops-field-writes',
    value: 'ServiceNow REST can accept a field write, return 200, and store nothing — the response carries the UNCHANGED record. Detect it by diffing every requested field against the response and by checking sys_mod_count and sys_updated_on: both frozen means nothing was stored. Known instance: sys_update_set.application is forced to the session current application scope on BOTH insert and update, so it cannot be set over REST at all.',
    provenance: 'fluent-research §36; reproduced live on 29b5648983be0f10b939cc65eeaad36b', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'sys-scope-insert-is-a-husk',
    value: 'Inserting into sys_scope over REST creates a HUSK, not an application: sys_class_name stays sys_scope instead of becoming sys_app, the technical scope name is empty, there is no version, and Studio will not list it. A real custom application is a sys_app record with an x_<vendor>_<name> scope, created through Studio or the SDK (now-sdk init). Use create_application.',
    provenance: 'fluent-research §36 E5; the husk 73cd84168376c750b939cc65eeaad3ff is still on this instance', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'lookup-contains-shadows-exact',
    value: 'A reference lookup that contains-matches the display field can shadow the exact key match — searching sys_user for "admin" returned "Certification Admin" while the user whose user_name IS admin never surfaced, and two incidents were created with the wrong caller. Rank exact key-field matches first and treat a non-exact top hit as ambiguous. Some sys_ids are literal words: the Global scope has sys_id "global".',
    provenance: 'fluent-research §36 E3', confidence: 0.99 },

  { scope: UNIVERSAL, kind: 'trap', key: 'incidents-are-data-not-config',
    value: 'Incidents, requests, tasks and every other table that does not extend sys_metadata are DATA. They are never captured by an update set and do not belong to an application scope. Update sets carry configuration only — catalog items, business rules, flows, UI policies, SLA definitions. Say so when a request implies otherwise.',
    provenance: 'fluent-research §36 E7', confidence: 0.99 },

];

/**
 * Idempotent seed, run on boot. Uses the same upsert as any other write, so
 * re-seeding a live database re-confirms rather than duplicating, and a fact
 * the user has since corrected by hand is overwritten only if its key matches.
 */
export function seedLedger({ instance } = {}) {
  const inst = instance || currentInstance();
  let written = 0;
  for (const f of SEED) {
    recordFact({
      instance: f.scope === 'instance' ? inst : UNIVERSAL,
      kind: f.kind,
      key: f.key,
      value: f.value,
      provenance: f.provenance,
      confidence: f.confidence,
    });
    written += 1;
  }
  return { seeded: written, instance: inst };
}

/* ------------------------------------------------------------------ *
 * Read path — the block injected into both prompts
 * ------------------------------------------------------------------ */

const KIND_HEADING = {
  trap: 'TRAPS — behaviours that produce a confidently WRONG result rather than an error',
  mapping: 'THIS INSTANCE — measured facts about what exists here',
  decision: 'ESTABLISHED DECISIONS — how this project has settled these questions',
  preference: 'USER PREFERENCES',
};

/**
 * The ceiling on how many facts one block may carry.
 *
 * WI-BUDGET-1 — this was 40, against a ledger of 56, and the cut was SILENT.
 *
 * `listFacts` orders by (kind, key), so kinds sort decision, mapping,
 * preference, trap and a `.slice(0, 40)` took every decision and mapping and
 * then stopped 20 traps into an alphabetical list. Measured 2026-09-02: 16
 * traps were absent from every system prompt this project has ever sent, and
 * they were the back half of the alphabet rather than the unimportant half —
 * `priority-is-calculated` (the fact plan-check.js exists to enforce, and the
 * one that spent two live approvals on 2026-08-24), `rest-silently-drops-
 * field-writes`, `unknown-field-writes-accepted`, `sys-scope-insert-is-a-husk`
 * (the basis of operating rule 21) and `ui-policy-action-not-writable-over-
 * rest` (the basis of rule 14) among them.
 *
 * That is the ledger's own failure mode turned on the ledger: an absence that
 * reads as "not measured". The block asserts these facts "override your priors
 * … none of them will produce an error to warn you when violated", which is
 * a promise the truncation quietly broke.
 *
 * 200 is a bound, not a target — it exists so a runaway ledger cannot silently
 * become the whole request. When it DOES bite it is loud in two places: a line
 * inside the block, so the model knows the list it is reading is partial, and
 * a warning in the log, so a human does. Never a bare slice again.
 */
export const FACT_BLOCK_LIMIT = 200;

/**
 * The fact block. `kinds` lets the codegen path take the subset that is
 * actionable while writing a flow, without the conversational preferences.
 *
 * NOT retrieval-selected, deliberately — see WI-BUDGET-1 T3. Selecting facts
 * by lexical overlap with the turn was built and measured against seven
 * realistic prompts and did not hold: "Add a field called warranty_expiry to
 * the incident table" ranked two ACL traps top and surfaced none of the three
 * field-write traps that request is actually about, and no single threshold
 * both kept ACL traps out of a catalog turn and returned anything at all for
 * an impersonation turn. Dropping a trap the model needed costs more than the
 * tokens, so the ledger ships whole until a selector can be shown to keep the
 * relevant fact.
 */
export function factBlock({ instance, kinds = FACT_KINDS, limit = FACT_BLOCK_LIMIT } = {}) {
  const eligible = listFacts({ instance }).filter((f) => kinds.includes(f.kind));
  const facts = eligible.slice(0, limit);
  const omitted = eligible.length - facts.length;
  if (!facts.length) return '';

  const byKind = new Map();
  for (const f of facts) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }

  const parts = [
    'INSTANCE KNOWLEDGE LEDGER — facts this project has MEASURED, not guessed.',
    'Each one cost a real debugging cycle. Treat them as established: they override your priors about how ServiceNow "usually" behaves, and none of them will produce an error to warn you when violated.',
  ];
  /*
   * IN-BAND, because the model is the one reasoning off this list. A truncated
   * ledger that presents itself as whole invites exactly the inference the
   * ledger exists to prevent — "this behaviour is not in the traps, so it is
   * not a trap". Said out loud, absence stops being evidence.
   */
  if (omitted > 0) {
    log.warn('memory',
      `fact ledger TRUNCATED: ${omitted} of ${eligible.length} fact(s) were cut by the ${limit}-fact limit and are `
      + 'not in this prompt. Raise FACT_BLOCK_LIMIT or prune the ledger — a silently short ledger reads as a short '
      + 'list of traps.');
    parts.push(
      `
TRUNCATED: ${omitted} further fact(s) exist in this ledger and are NOT shown here. This list is `
      + 'INCOMPLETE — a behaviour missing from it has not been ruled out, and absence here is not evidence.',
    );
  }
  for (const kind of FACT_KINDS) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    parts.push(
      `\n${KIND_HEADING[kind]}:\n` +
        list.map((f) => `  - [${f.key}] ${f.value}`).join('\n')
    );
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Write paths
 * ------------------------------------------------------------------ */

/**
 * A verification that FAILED is the single most valuable thing this agent
 * learns about an instance, and it used to die with the session. Records the
 * failed assertions of a `verify_flow_live` result as instance facts.
 */
export function recordVerificationFailure(toolName, result) {
  if (toolName !== 'verify_flow_live' || !result || typeof result !== 'object') return null;
  const failed = (result.assertions || []).filter((a) => a && a.pass === false);
  if (!failed.length) return null;

  const recorded = [];
  for (const a of failed) {
    const key = `verify-failed:${a.table}.${a.field}`;
    recorded.push(
      recordFact({
        kind: 'mapping',
        key,
        value:
          `Asserting ${a.table}.${a.field} did not hold on this instance` +
          (a.want !== undefined ? ` (expected "${a.want}", read "${a.got ?? ''}")` : '') +
          (a.note ? ` — the promise was: ${a.note}` : '') +
          '. Check whether the field exists and can hold this value here before promising it again.',
        provenance: `verify_flow_live on "${result.flow || result.name || 'a flow'}"`,
        confidence: 0.7,
      })
    );
  }
  return recorded;
}

/**
 * Schema discovery records calculated/read-only fields, which are the ones that
 * accept a write and then quietly ignore it (trap #5's whole family).
 */
export function recordCalculatedFields(tableName, schema) {
  if (!schema?.fields?.length) return [];
  const computed = schema.fields.filter((f) => f.calculated || f.readOnly || f.read_only);
  if (!computed.length) return [];
  return [
    recordFact({
      kind: 'mapping',
      key: `calculated-fields:${tableName}`,
      value:
        `On ${tableName} these fields are calculated or read-only and cannot be set directly — ` +
        `a write is accepted and then discarded: ${computed.map((f) => f.name).join(', ')}. ` +
        `Drive the inputs they are computed from instead.`,
      provenance: `get_table_schema on ${tableName}`,
      confidence: 0.8,
    }),
  ];
}

/** The chat affordance: "remember: <something>" becomes a durable preference. */
export function rememberFromChat(text) {
  const m = String(text || '').match(/^\s*remember\s*[:\-—]\s*(.+)$/is);
  if (!m) return null;
  const value = m[1].trim();
  if (!value) return null;
  // Keyed on the leading words so a restated preference updates rather than
  // accumulating near-duplicates the model then has to reconcile.
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-') || 'note';
  return recordFact({ kind: 'preference', key, value, provenance: 'the user asked to remember this', confidence: 0.9 });
}
