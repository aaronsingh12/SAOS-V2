/**
 * PHASE 3 — THE SERVICENOW SEMANTIC LAYER.
 *
 *   node --test server/test/
 *
 * The layer's whole value is that it refuses to fabricate. So the tests are
 * mostly about what it does when it does NOT know: a table it cannot read, a
 * reference with no target, a lookup that matched three groups, a field that
 * does not exist. Each of those has a distinct, explicit answer, and none of
 * them is a plausible-looking default.
 *
 * Offline in full. The live schema is injected through the same `schemaFor` /
 * `lookup` seams the production code uses, so these exercise the real
 * describe/resolve logic against controlled dictionary rows — no instance, no
 * model, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-sem-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'test', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
});

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const S = await import('../src/servicenow/semantic/index.js');
const { STATUS, SOURCES, LADDER, LADDER_RUNG } = S;
const { canAuthorize } = await import('../src/knowledge/precedence.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Fixtures — dictionary rows shaped exactly as getSchema returns them
 * ------------------------------------------------------------------ */

const f = (name, type, extra = {}) => ({
  name, label: name, type, reference: null, maxLength: null,
  mandatory: false, readOnly: false, defaultValue: null, definedOn: 'incident',
  choices: null, ...extra,
});

const INCIDENT_FIELDS = [
  f('number', 'string', { maxLength: 40, definedOn: 'task' }),
  f('caller_id', 'reference', { reference: 'sys_user' }),
  f('assignment_group', 'reference', { reference: 'sys_user_group', definedOn: 'task' }),
  f('assigned_to', 'reference', { reference: 'sys_user', definedOn: 'task' }),
  f('impact', 'integer', { definedOn: 'task', choices: [{ label: '1 - High', value: '1' }, { label: '2 - Medium', value: '2' }, { label: '3 - Low', value: '3' }] }),
  f('urgency', 'integer', { definedOn: 'task', choices: [{ label: '1 - High', value: '1' }, { label: '2 - Medium', value: '2' }, { label: '3 - Low', value: '3' }] }),
  f('priority', 'integer', { definedOn: 'task', choices: [{ label: '1 - Critical', value: '1' }, { label: '4 - Low', value: '4' }] }),
  f('state', 'integer', { definedOn: 'task', choices: [{ label: 'New', value: '1' }, { label: 'Closed', value: '7' }] }),
  f('short_description', 'string', { maxLength: 160, mandatory: true, definedOn: 'task' }),
  f('description', 'string', { maxLength: 4000, definedOn: 'task' }),
  f('work_notes', 'journal_input', { definedOn: 'task' }),
  f('sys_id', 'GUID'),
  f('opened_at', 'glide_date_time', { definedOn: 'task' }),
  f('active', 'boolean', { definedOn: 'task' }),
  // A reference whose target the dictionary does not carry — the case that must
  // become `unknown` rather than a guessed table.
  f('u_mystery_ref', 'reference', { reference: null }),
  // A type the vocabulary does not recognise.
  f('u_weird', 'some_future_type'),
];

const INCIDENT_SCHEMA = {
  table: 'incident',
  hierarchy: ['incident', 'task'],
  fields: INCIDENT_FIELDS,
};

const seams = (schema = INCIDENT_SCHEMA) => ({
  schemaFor: async () => schema,
  hierarchyFor: async () => schema.hierarchy,
  displayFieldFor: async () => 'number',
});

/* ------------------------------------------------------------------ *
 * Provenance and the truth hierarchy
 * ------------------------------------------------------------------ */

test('the seven sources are ordered strongest first, and each maps onto the existing ladder', () => {
  assert.deepEqual([...SOURCES], [
    'live_state', 'live_schema', 'managed_source', 'ledger', 'documentation', 'model_knowledge', 'llm_inference',
  ]);
  // Every source maps to a rung of the FOUR-rung ladder that already owns the
  // authorisation question. Phase 3 refines the vocabulary; it does not create
  // a second authority.
  for (const s of SOURCES) {
    assert.ok(LADDER.includes(LADDER_RUNG[s]), `${s} maps to "${LADDER_RUNG[s]}", which is not a ladder rung`);
  }
  assert.deepEqual([...LADDER], ['live_pdi', 'tool_capability', 'documentation', 'model_knowledge'],
    'the existing ladder was changed — Phase 3 must not redesign it');
});

test('live schema beats a ledger fact, and the disagreement is reported rather than hidden', () => {
  const r = S.reconcile([
    S.fact('sys_user_group', 'ledger'),
    S.fact('cmn_department', 'live_schema'),
  ], { question: 'what does assignment_group reference' });

  assert.equal(r.winner.value, 'cmn_department');
  assert.equal(r.winner.source, 'live_schema');
  assert.equal(r.conflicts.length, 1, 'the losing claim vanished instead of being reported');
  assert.match(r.conflicts[0].note, /ledger says/);
});

test('a ledger fact beats model knowledge, and inference is the weakest of all', () => {
  const r = S.reconcile([S.fact('a', 'model_knowledge'), S.fact('b', 'ledger')]);
  assert.equal(r.winner.value, 'b');
  assert.ok(S.sourceRank('ledger') < S.sourceRank('model_knowledge'));
  assert.ok(S.sourceRank('model_knowledge') < S.sourceRank('llm_inference'));
  assert.ok(S.sourceRank('live_state') < S.sourceRank('live_schema'));
});

test('an inferred value is visibly unverified and cannot authorise anything', () => {
  const inferred = S.fact('probably sys_user', 'llm_inference');
  assert.equal(inferred.verified, false);
  assert.equal(inferred.canAuthorize, false);
  assert.equal(S.factCanAuthorize(inferred), false);

  // And the same question, answered from the instance, can.
  const live = S.fact('sys_user', 'live_schema');
  assert.equal(live.verified, true);
  assert.equal(live.canAuthorize, true);
});

test('THE LEDGER INFORMS BUT NEVER AUTHORISES — it maps below the authorising rungs', () => {
  /*
   * A ledger fact is MEASURED, which makes it far better evidence than a
   * documentation page — and it is still not a live read. The instance can have
   * changed since; the fact carries a date for exactly that reason. Mapping it
   * to live_pdi would let a stored measurement authorise a mutation, which is
   * the failure the whole read-back discipline exists to prevent.
   */
  assert.equal(LADDER_RUNG.ledger, 'documentation');
  assert.equal(canAuthorize([LADDER_RUNG.ledger]), false);
  assert.equal(S.fact('x', 'ledger').canAuthorize, false);
  assert.equal(S.fact('x', 'ledger').verified, true, 'a ledger fact IS evidenced, even though it cannot authorise');

  assert.equal(canAuthorize([LADDER_RUNG.live_state]), true);
  assert.equal(canAuthorize([LADDER_RUNG.live_schema]), true);
  assert.equal(canAuthorize([LADDER_RUNG.managed_source]), true);
});

test('unknown stays unknown — it never acquires a value or authority', () => {
  const u = S.unknown('the schema could not be read');
  assert.equal(u.status, STATUS.UNKNOWN);
  assert.equal(u.value, null);
  assert.equal(u.verified, false);
  assert.equal(u.canAuthorize, false);

  // Reconciling unknowns yields an unknown, never the least-bad guess.
  const r = S.reconcile([S.unknown('a'), S.unknown('b')]);
  assert.equal(r.winner.status, STATUS.UNKNOWN);
  assert.equal(r.winner.value, null);
});

test('an unrecognised source or status is refused rather than stored', () => {
  assert.throws(() => S.fact('x', 'a-blog-post'), /unknown semantic source/);
  assert.throws(() => S.fact('x', 'live_schema', { status: 'probably' }), /unknown semantic status/);
});

/* ------------------------------------------------------------------ *
 * Incident semantics
 * ------------------------------------------------------------------ */

test('INCIDENT — priority is DERIVED, and the derivation names its inputs and its evidence', async () => {
  const t = await S.describeTable('incident', seams());
  assert.equal(t.status, STATUS.KNOWN);

  const priority = t.fields.find((x) => x.name === 'priority');
  assert.ok(priority.derived, 'priority was not recognised as a derived field');
  assert.deepEqual(priority.derived.value.from, ['impact', 'urgency']);
  assert.equal(priority.derived.source, 'ledger');
  assert.equal(priority.derived.evidence.factKey, 'priority-is-calculated');
  assert.ok(priority.derived.evidence.provenance, 'the derivation is not traceable to a measured fact');
  assert.match(priority.derived.value.guidance, /Set impact and urgency/);

  // The dictionary is reported SEPARATELY and is not overwritten by the ledger:
  // priority is not marked read-only, and that is exactly why the trap exists.
  assert.equal(priority.readOnly.value, false);
  assert.equal(priority.readOnly.source, 'live_schema');
  assert.match(priority.derived.note, /dictionary does not mark it read-only/);

  // And the table-level summary carries it, so a planner does not have to walk
  // every field to find out.
  assert.deepEqual(t.derivedFields, [{ field: 'priority', from: ['impact', 'urgency'] }]);
});

test('INCIDENT — impact and urgency are ordinary writable choices, not derived', async () => {
  const t = await S.describeTable('incident', seams());
  for (const name of ['impact', 'urgency']) {
    const fld = t.fields.find((x) => x.name === name);
    assert.equal(fld.derived, null, `${name} must not be reported as derived`);
    assert.equal(fld.kind.value, 'choice', `${name} is stored as an integer but is a choice`);
    assert.equal(fld.choices.status, STATUS.KNOWN);
    assert.equal(fld.choices.value.length, 3);
  }
});

test('INCIDENT — reference fields carry their target table, from live schema', async () => {
  const t = await S.describeTable('incident', seams());
  const expect = { caller_id: 'sys_user', assignment_group: 'sys_user_group', assigned_to: 'sys_user' };
  for (const [field, target] of Object.entries(expect)) {
    const fld = t.fields.find((x) => x.name === field);
    assert.equal(fld.kind.value, 'reference');
    assert.equal(fld.reference.status, STATUS.KNOWN);
    assert.equal(fld.reference.value, target);
    assert.equal(fld.reference.source, 'live_schema');
  }
  assert.deepEqual(
    t.references.filter((r) => r.field in expect).sort((a, b) => a.field.localeCompare(b.field)),
    [
      { field: 'assigned_to', table: 'sys_user', source: 'live_schema' },
      { field: 'assignment_group', table: 'sys_user_group', source: 'live_schema' },
      { field: 'caller_id', table: 'sys_user', source: 'live_schema' },
    ],
  );
});

test('INCIDENT — a reference with no target is UNKNOWN, never a guessed table', async () => {
  const t = await S.describeTable('incident', seams());
  const mystery = t.fields.find((x) => x.name === 'u_mystery_ref');
  assert.equal(mystery.kind.value, 'reference');
  assert.equal(mystery.reference.status, STATUS.UNKNOWN);
  assert.equal(mystery.reference.value, null, 'a target was invented for a reference that has none');
  assert.match(mystery.reference.note, /Do not assume a table and do not invent a sys_id/);
  // And it is excluded from the confirmed reference list.
  assert.ok(!t.references.some((r) => r.field === 'u_mystery_ref'));
});

test('the semantic type vocabulary distinguishes the kinds a writer must treat differently', async () => {
  const t = await S.describeTable('incident', seams());
  const kind = (n) => t.fields.find((x) => x.name === n).kind.value;
  assert.equal(kind('short_description'), 'string');
  assert.equal(kind('active'), 'boolean');
  assert.equal(kind('opened_at'), 'datetime');
  assert.equal(kind('caller_id'), 'reference');
  assert.equal(kind('work_notes'), 'journal');
  assert.equal(kind('state'), 'choice');
  // A journal is not a string: it is invisible to a plain GET, so a writer that
  // treated it as one would verify a write it cannot see.
  assert.notEqual(kind('work_notes'), 'string');
});

test('an unrecognised dictionary type becomes UNKNOWN and keeps its raw type', async () => {
  const t = await S.describeTable('incident', seams());
  const weird = t.fields.find((x) => x.name === 'u_weird');
  assert.equal(weird.kind.status, STATUS.UNKNOWN);
  assert.equal(weird.rawType, 'some_future_type');
  assert.match(weird.kind.note, /not in the semantic vocabulary/);
});

test('a table that cannot be read is UNKNOWN — never an empty field list', async () => {
  const failing = await S.describeTable('incident', { schemaFor: async () => { throw new Error('403'); } });
  assert.equal(failing.status, STATUS.UNKNOWN);
  assert.equal(failing.exists.status, STATUS.UNKNOWN);
  assert.deepEqual(failing.fields, []);
  assert.match(failing.exists.note, /could not be read/);

  const empty = await S.describeTable('nope', { schemaFor: async () => ({ table: 'nope', hierarchy: ['nope'], fields: [] }) });
  assert.equal(empty.status, STATUS.UNKNOWN);
  // The distinction that matters: "does not exist" and "not readable here" are
  // different, and neither is "it has no fields".
  assert.match(empty.exists.note, /may mean the table does not exist or that it is not/);

  const illegal = await S.describeTable('drop table users;--');
  assert.equal(illegal.status, STATUS.UNKNOWN);
});

test('a field that does not exist is a CONCLUSION, because the merged list is complete', async () => {
  const missing = await S.describeTableField('incident', 'u_not_a_field', seams());
  assert.equal(missing.status, STATUS.UNKNOWN);
  assert.equal(missing.exists.value, false);
  assert.equal(missing.exists.source, 'live_schema');
  assert.match(missing.exists.note, /complete across the hierarchy/);
  assert.match(missing.exists.note, /Do not create it and do not substitute/);

  const present = await S.describeTableField('incident', 'caller_id', seams());
  assert.equal(present.status, STATUS.KNOWN);
  assert.equal(present.reference.value, 'sys_user');
});

/* ------------------------------------------------------------------ *
 * Reference resolution and ambiguity
 * ------------------------------------------------------------------ */

test('AMBIGUITY IS PROPAGATED — the first result is never taken because it is convenient', async () => {
  /*
   * The SNADA invariant, and the ledger records what it cost to learn: a
   * contains-match on sys_user for "admin" returned "Certification Admin" while
   * the user whose user_name IS admin never surfaced, and two incidents were
   * created against the wrong caller.
   */
  const r = await S.resolveReference('sys_user_group', 'network', {
    lookup: async () => ([
      { sys_id: 'a'.repeat(32), name: 'Network', matchType: 'contains' },
      { sys_id: 'b'.repeat(32), name: 'Network Support', matchType: 'contains' },
      { sys_id: 'c'.repeat(32), name: 'Networking', matchType: 'contains' },
    ]),
  });
  assert.equal(r.status, STATUS.AMBIGUOUS);
  assert.equal(r.value, null, 'a candidate was selected from an ambiguous result');
  assert.equal(r.evidence.candidates.length, 3, 'the candidates were not carried up');
  assert.match(r.note, /must be shown to the user before it enters a mutation payload/);
  assert.equal(r.canAuthorize, false);
});

test('a single EXACT match resolves, and carries its weaker rivals as evidence', async () => {
  const one = await S.resolveReference('sys_user', 'abel.tuter', {
    lookup: async () => ([{ sys_id: 'd'.repeat(32), user_name: 'abel.tuter', matchType: 'exact' }]),
  });
  assert.equal(one.status, STATUS.KNOWN);
  assert.equal(one.source, 'live_state');
  assert.equal(one.value.user_name, 'abel.tuter');

  const withRivals = await S.resolveReference('sys_user', 'admin', {
    lookup: async () => ([
      { sys_id: 'e'.repeat(32), user_name: 'admin', matchType: 'exact' },
      { sys_id: 'f'.repeat(32), name: 'Certification Admin', matchType: 'contains' },
    ]),
  });
  assert.equal(withRivals.status, STATUS.KNOWN);
  assert.equal(withRivals.value.user_name, 'admin', 'the exact match lost to a contains match');
  assert.equal(withRivals.evidence.candidates.length, 1);
});

test('a miss is a miss — no sys_id is ever invented', async () => {
  const none = await S.resolveReference('sys_user_group', 'no such group', { lookup: async () => [] });
  assert.equal(none.status, STATUS.UNKNOWN);
  assert.equal(none.value, null);
  assert.match(none.note, /A miss is not a licence to invent one/);

  const failed = await S.resolveReference('sys_user', 'x', { lookup: async () => { throw new Error('403'); } });
  assert.equal(failed.status, STATUS.UNKNOWN);
  assert.equal(failed.value, null);

  const noTable = await S.resolveReference('', 'x');
  assert.equal(noTable.status, STATUS.UNKNOWN);
  assert.match(noTable.note, /Do not invent a sys_id/);
});

/* ------------------------------------------------------------------ *
 * Artifact semantics
 * ------------------------------------------------------------------ */

test('every modelled artifact declares a table, a mechanism and a verification path', () => {
  const MECH = new Set(['rest', 'sdk', 'harness']);
  const VER = new Set(['read_back', 'semantic', 'none']);
  assert.ok(S.ARTIFACT_KINDS.length >= 11, `only ${S.ARTIFACT_KINDS.length} artifacts are modelled`);
  for (const kind of S.ARTIFACT_KINDS) {
    const a = S.ARTIFACTS[kind];
    assert.ok(a.table, `${kind} declares no table`);
    assert.ok(MECH.has(a.mechanism), `${kind} declares mechanism "${a.mechanism}"`);
    assert.ok(VER.has(a.verification), `${kind} declares verification "${a.verification}"`);
    assert.ok(['data', 'configuration'].includes(a.classification), `${kind} is neither data nor configuration`);
    // Every model must be traceable to the code that implements it, so a
    // fabricated relationship has nowhere to hide.
    assert.ok(a.evidence && a.evidence.length > 10, `${kind} carries no evidence pointer`);
  }
  // The domains Part 8 requires.
  for (const kind of ['incident', 'catalog_item', 'request', 'requested_item', 'flow', 'subflow',
    'sla_definition', 'acl', 'table', 'application', 'update_set']) {
    assert.ok(S.ARTIFACTS[kind], `${kind} is not modelled`);
  }
});

test('FLOW — trigger, actions, execution context and semantic verification', async () => {
  const a = await S.describeArtifact('flow', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  assert.deepEqual(a.parts.value, ['trigger', 'conditions', 'actions', 'inputs', 'execution_context']);
  const st = a.structure.value;
  assert.equal(st.trigger.table, 'sys_hub_trigger_instance_v2');
  // The measured shape: the configuration is an encoded blob, not columns.
  assert.match(st.trigger.note, /encoded blob in trigger_inputs/);
  assert.equal(st.trigger.strategyDefault, 'once');
  assert.equal(st.execution_context.table, 'sys_flow_context');
  assert.ok(st.execution_context.states.includes('WAITING'), 'a paused flow state is not modelled');
  // A flow is authored by the SDK and proven semantically.
  assert.equal(a.mechanism.value, 'sdk');
  assert.equal(a.verification.value, 'semantic');
  assert.equal(a.capturedByUpdateSet.value, true);
});

test('SUBFLOW — no trigger; it is invoked through the harness', async () => {
  const a = await S.describeArtifact('subflow', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  assert.ok(!a.parts.value.includes('trigger'), 'a subflow was modelled with a trigger');
  assert.equal(S.ARTIFACTS.subflow.invocationMechanism, 'harness');
  assert.match(a.structure.value.invocation.api, /sn_fd\.FlowAPI/);
  assert.equal(a.structure.value.outputs.table, 'sys_flow_runtime_value');
});

test('SLA — duration and clock semantics, and the schedule that is inert without its source', async () => {
  const a = await S.describeArtifact('sla_definition', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  const st = a.structure.value;
  assert.match(st.duration.note, /offset from 1970-01-01/);
  assert.deepEqual(st.schedule.requires, { schedule_source: 'sla_definition' });
  assert.match(st.schedule.note, /24x7/);
  assert.equal(st.clock.table, 'task_sla');
  assert.match(st.clock.note, /UTC/);
  assert.equal(a.verification.value, 'semantic');
  assert.match(a.verification.note, /out-of-box SLAs attach to the same record/);
});

test('ACL — table, operation, roles, script, and the elevation requirement', async () => {
  const a = await S.describeArtifact('acl', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  for (const part of ['operation', 'active', 'roles', 'condition', 'script']) {
    assert.ok(a.parts.value.includes(part), `an ACL must model ${part}`);
  }
  // An ACL is TWO records, and that is the thing a planner most needs to know.
  assert.deepEqual(a.structure.value.unit.tables, ['sys_security_acl', 'sys_security_acl_role']);
  assert.equal(a.requiresElevation.value, true);
  assert.equal(a.requiresElevation.evidence.role, 'security_admin');
  // Described only. Nothing in the semantic layer can perform it.
  assert.match(read('servicenow/semantic/artifacts.js'), /requiresElevation/);
});

test('CATALOG — the item, its variables, and what ordering produces', async () => {
  const a = await S.describeArtifact('catalog_item', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  const rel = S.ARTIFACTS.catalog_item.relationships;
  assert.ok(rel.some((r) => r.to === 'item_option_new'), 'variables are not related to the item');
  assert.ok(rel.some((r) => r.to === 'sc_request' && r.nature === 'produces'));
  assert.ok(rel.some((r) => r.to === 'sc_req_item' && r.nature === 'produces'));
  // The measured exception: the policy ACTIONS cannot go over REST.
  assert.equal(a.mechanism.value, 'rest');
  assert.equal(S.ARTIFACTS.catalog_item.mechanismNotes.ui_policy_actions, 'sdk');
  assert.match(a.verification.note, /evaluated in the browser/);

  // RITM links both ways.
  const ritm = S.ARTIFACTS.requested_item.relationships;
  assert.ok(ritm.some((r) => r.field === 'cat_item' && r.to === 'sc_cat_item'));
  assert.ok(ritm.some((r) => r.field === 'request' && r.to === 'sc_request'));
});

test('data and configuration are distinguished, because update-set capture depends on it', async () => {
  const inc = await S.describeArtifact('incident', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  assert.equal(inc.classification.value, 'data');
  assert.equal(inc.capturedByUpdateSet.value, false);
  const flow = await S.describeArtifact('flow', { describe: async () => ({ status: STATUS.KNOWN, references: [] }) });
  assert.equal(flow.classification.value, 'configuration');
  assert.equal(flow.capturedByUpdateSet.value, true);
});

test('LIVE SCHEMA CORRECTS THE MODEL — a declared reference that drifted is overridden and reported', async () => {
  const a = await S.describeArtifact('incident', {
    describe: async () => ({
      status: STATUS.KNOWN,
      // This instance says assignment_group points somewhere else.
      references: [{ field: 'assignment_group', table: 'cmn_department', source: 'live_schema' }],
    }),
  });
  const rel = a.relationships.find((r) => r.field === 'assignment_group');
  assert.equal(rel.confirmed.value, 'cmn_department', 'the declared model beat the live dictionary');
  assert.equal(rel.confirmed.source, 'live_schema');
  assert.deepEqual(rel.confirmed.evidence, { declared: 'sys_user_group', live: 'cmn_department' });

  // A declared reference the dictionary does not carry is UNCONFIRMED, not repeated.
  const caller = a.relationships.find((r) => r.field === 'caller_id');
  assert.equal(caller.confirmed.status, STATUS.UNKNOWN);
  assert.match(caller.confirmed.note, /Treat the declaration as unconfirmed/);
});

test('an unmodelled artifact is UNKNOWN — nothing is assumed about it', async () => {
  const a = await S.describeArtifact('widget');
  assert.equal(a.status, STATUS.UNKNOWN);
  assert.match(a.note, /not a modelled artifact/);
  assert.equal(S.artifactForTable('sys_hub_flow').kind, 'flow');
  assert.equal(S.artifactForTable('no_such_table'), null);
});

/* ------------------------------------------------------------------ *
 * Safety and architecture
 * ------------------------------------------------------------------ */

test('SAFETY — the semantic layer cannot mutate, elevate, approve or execute', () => {
  /*
   * The security property of the phase. A read-only layer that could reach the
   * write client, the elevation shim or the approval executor would be one edit
   * away from deciding with them.
   */
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const FORBIDDEN = [
    /servicenow\/client\.js/,              // table.create / update / remove
    /execution-harness/, /elevation-shim/, /role-elevation/, /impersonat/,
    /agent\/orchestrator\.js/, /agent\/write-guard\.js/, /agent\/mutation-pipeline\.js/,
    /memory\/ledger\.js/, /memory\/provenance\.js/, /memory\/tasks\.js/, /task-tracker/,
    /memory\/compaction\.js/, /agent\/providers\//, /servicenow\/write-verify\.js/,
    /servicenow\/transport\.js/, /servicenow\/fluent\.js/, /dba-authoring/, /dba-data/,
    /acl-authoring/, /catalogPolicy/, /app-create/,
  ];
  const files = fs.readdirSync(path.join(SRC, 'servicenow', 'semantic')).filter((x) => x.endsWith('.js'));
  assert.ok(files.length >= 4, 'the semantic layer files were not found');
  for (const file of files) {
    const src = read(`servicenow/semantic/${file}`);
    for (const m of src.matchAll(IMPORT)) {
      for (const bad of FORBIDDEN) {
        assert.ok(!bad.test(m[1]),
          `semantic/${file} imports ${m[1]} — the semantic layer is read-only and must not reach that`);
      }
    }
    // Nor may it CALL a writer, which would catch a dynamic import.
    for (const bad of [/\btable\.(create|update|remove|del)\s*\(/, /\brunServerScript\s*\(/,
      /\binstallWorkspace\s*\(/, /\bexecuteTool\s*\(/, /\bresolveApproval\s*\(/,
      /\brunGatedWrite\s*\(/, /\bappendMutation\s*\(/, /\brecordFact\s*\(/]) {
      assert.doesNotMatch(src, bad, `semantic/${file} calls ${bad} — it describes, it never acts`);
    }
  }
});

test('SAFETY — nothing below the semantic layer imports it', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  for (const dir of ['memory', 'knowledge']) {
    for (const file of fs.readdirSync(path.join(SRC, dir))) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(SRC, dir, file), 'utf8');
      for (const m of src.matchAll(IMPORT)) {
        assert.doesNotMatch(m[1], /semantic\//,
          `${dir}/${file} imports the semantic layer — the dependency arrow must point down`);
      }
    }
  }
});

test('SAFETY — the semantic layer consults no model', () => {
  for (const file of fs.readdirSync(path.join(SRC, 'servicenow', 'semantic')).filter((x) => x.endsWith('.js'))) {
    const src = read(`servicenow/semantic/${file}`);
    for (const bad of [/\bchatTurn\s*\(/, /\bchatOnce\s*\(/, /providers\//]) {
      assert.doesNotMatch(src, bad, `semantic/${file} reaches a model — Phase 3 must be deterministic`);
    }
  }
});

test('DETERMINISM — the same inputs produce the same description', async () => {
  const a = await S.describeTable('incident', seams());
  const b = await S.describeTable('incident', seams());
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});
