/**
 * PHASE 20 — REQUIREMENTS, ARCHITECTURE, DEPENDENCIES, CAPABILITY, VERIFICATION.
 *
 * §50's twenty-one areas, in the order a build meets them. Every test uses
 * injected collaborators — no database, no instance, no model — because the
 * whole point of the builder taking its world as parameters is that its
 * reasoning is checkable without any of it.
 *
 * THE TESTS THAT MATTER MOST are the ones where the CONVENIENT answer is the
 * wrong one: a component that could nearly be built, a name that nearly
 * validates, an artifact that nearly matches something already there. Each of
 * those is a place where a builder that wanted to be helpful would mutate a
 * real instance on a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as B from '../src/agent/appbuild/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PREFIX = 'x_2002152_';

/** The real scope rule: at most 18 characters in total. */
const validateScopeName = (name, prefix) => {
  const errors = [];
  if (!String(name).startsWith(prefix)) errors.push(`must begin with "${prefix}"`);
  if (String(name).length > 18) errors.push(`the scope name is ${String(name).length} characters; the platform maximum is 18`);
  return { ok: errors.length === 0, errors, scopeName: name, prefix };
};

const naming = { prefix: PREFIX, maxScope: 18, validateScopeName, maxNameLength: {} };
const FIELD_TYPES = new Set(['string', 'integer', 'boolean', 'reference', 'choice', 'glide_date_time']);

const capabilities = (over = {}) => ({
  capabilities: {
    record_create: { available: true, mechanism: 'rest', status: 'known' },
    catalog_authoring: { available: true, mechanism: 'rest', status: 'known' },
    sla_authoring: { available: true, mechanism: 'rest', status: 'known' },
    acl_authoring: { available: true, mechanism: 'rest', status: 'known', requiresElevation: true, elevationRole: 'security_admin' },
    table_create: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown', note: 'the SDK is not available here' },
    field_create: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown', note: 'the SDK is not available here' },
    flow_authoring: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown', note: 'the SDK is not available here' },
    application_authoring: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown', note: 'the SDK is not available here' },
    ...over,
  },
});

const component = (type, name, spec = {}, depends_on = []) => ({
  id: name, type, name, purpose: `${type} ${name}`, depends_on, spec,
});

const REQUIREMENTS = {
  name: 'Employee Equipment Request',
  purpose: 'Let employees request equipment.',
  actors: ['employee', 'manager'],
  data: ['equipment request'],
  processes: ['submit', 'approve'],
  security: ['employees create, managers approve'],
  interfaces: ['catalog request'],
  acceptance_criteria: ['Employee submits request', 'Manager approves', 'The app is intuitive'],
};

/* ================================================================== *
 * §4 — requirements
 * ================================================================== */

test('A1 — requirements are validated whatever produced them', () => {
  assert.equal(B.validateRequirements(REQUIREMENTS).ok, true);

  const noName = B.validateRequirements({ ...REQUIREMENTS, name: null });
  assert.equal(noName.ok, false);
  assert.ok(noName.problems.some((p) => p.code === 'no_name'));

  const nothing = B.validateRequirements({ ...REQUIREMENTS, data: [], processes: [], interfaces: [] });
  assert.equal(nothing.ok, false);
  assert.ok(nothing.problems.some((p) => p.code === 'nothing_requested'));
});

test('A2 — §35: a criterion describing a feeling is kept, marked, and never tested', () => {
  /*
   * "The app is intuitive" is a real thing the user asked for and nothing can
   * establish it. Dropping it silently would make the test plan look like it
   * covers the request; refusing the whole request over it would be worse.
   */
  const c = B.testableCriteria(REQUIREMENTS);
  assert.deepEqual(c.testable, ['Employee submits request', 'Manager approves']);
  assert.deepEqual(c.untestable, ['The app is intuitive']);
  assert.match(c.note, /describe a quality rather than an observation/);
});

test('A3 — §4: the model reads the request; the platform validates the reading', async () => {
  const chat = async () => JSON.stringify({ ...REQUIREMENTS, name: 'Kit Requests' });
  const r = await B.readRequirements({ request: 'Build a kit request app', chat });
  assert.equal(r.ok, true);
  assert.equal(r.requirements.name, 'Kit Requests');
  assert.equal(r.by, 'model');

  /* A reading that fails validation is refused, not returned. */
  const bad = await B.readRequirements({ request: 'x', chat: async () => JSON.stringify({ name: null }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'insufficient');
});

test('A4 — with no reader available, nothing is guessed from the title', async () => {
  const r = await B.readRequirements({ request: 'Build an equipment app', chat: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_reader');
  assert.match(r.note, /does not guess/);
});

/* ================================================================== *
 * §16–§25 — the architecture rules
 * ================================================================== */

test('A5 — §16: a field type the dictionary does not have is refused', () => {
  const components = [component('field', 'weight', { table: 't', name: 'weight', type: 'quantum_float' })];
  const v = B.validateArchitecture({ components, naming, fieldTypes: FIELD_TYPES });
  assert.equal(v.ok, false);
  assert.ok(v.fatal.some((p) => p.code === 'field_type_unknown'));
});

test('A6 — §21: a reference with no target, or an unknown target, is refused', () => {
  const dangling = B.validateArchitecture({
    components: [component('field', 'owner', { table: 't', name: 'owner', type: 'reference' })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.ok(dangling.fatal.some((p) => p.code === 'reference_target_missing'));

  const unknown = B.validateArchitecture({
    components: [component('field', 'owner', { table: 't', name: 'owner', type: 'reference', reference: 'nowhere' })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.ok(unknown.fatal.some((p) => p.code === 'reference_target_unknown'));

  /* A target that already exists on the instance satisfies it. */
  const ok = B.validateArchitecture({
    components: [component('field', 'owner', { table: 't', name: 'owner', type: 'reference', reference: 'sys_user' })],
    naming, fieldTypes: FIELD_TYPES, existing: new Set(['sys_user']),
  });
  assert.equal(ok.fatal.some((p) => p.code.startsWith('reference_target')), false);
});

test('A7 — §22: a choice must carry an explicit label', () => {
  const v = B.validateArchitecture({
    components: [component('field', 'state', {
      table: 't', name: 'state', type: 'choice', choices: [{ value: 'pending' }],
    })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.ok(v.fatal.some((p) => p.code === 'choices_invalid'));
  assert.match(v.fatal.find((p) => p.code === 'choices_invalid').message, /assuming the label equals the value/);
});

test('A8 — §23: a broad platform role is refused; a scoped one is not', () => {
  const broad = B.validateArchitecture({ components: [component('role', 'admin', { name: 'admin' })], naming, fieldTypes: FIELD_TYPES });
  assert.ok(broad.fatal.some((p) => p.code === 'broad_role'));

  const scoped = B.validateArchitecture({
    components: [component('role', `${PREFIX}requester`, { name: `${PREFIX}requester` })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.equal(scoped.ok, true);
});

test('A9 — §17: the SCOPE rule governs scopes, not every scoped artifact', () => {
  /*
   * FOUND BY THE FIRST END-TO-END RUN, and it is §17's own warning in mirror
   * image. `validateScopeName` caps a name at 18 characters because that is the
   * limit on an application SCOPE. Applying it to a table refused
   * `x_2002152_equip_request` — an entirely ordinary scoped table name.
   */
  const app = B.validateArchitecture({
    components: [component('application', 'x_2002152_equipment_management', { scope: 'x_2002152_equipment_management' })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.ok(app.fatal.some((p) => p.code === 'naming_invalid'), 'an over-long SCOPE must still be refused');

  const table = B.validateArchitecture({
    components: [component('table', `${PREFIX}equip_request`, { name: `${PREFIX}equip_request`, label: 'Equipment Request' })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.equal(table.ok, true, 'a normal scoped table name was refused by the scope rule');

  /* The one thing that IS universally true of a scoped artifact. */
  const unscoped = B.validateArchitecture({
    components: [component('table', 'equip_request', { name: 'equip_request' })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.ok(unscoped.fatal.some((p) => p.code === 'naming_invalid'));
});

test('A10 — §18: a name already on the instance stops the build', () => {
  const v = B.validateArchitecture({
    components: [component('role', `${PREFIX}requester`, { name: `${PREFIX}requester` })],
    naming, fieldTypes: FIELD_TYPES, existing: new Set([`${PREFIX}requester`]),
  });
  assert.ok(v.fatal.some((p) => p.code === 'name_collision'));
});

test('A11 — §25: the security model reports the gaps, it does not hide them', () => {
  const components = [
    component('table', `${PREFIX}req`, { name: `${PREFIX}req` }),
    component('acl', 'read_rule', { table: `${PREFIX}req`, operation: 'read', role: `${PREFIX}requester` }),
  ];
  const model = B.securityModel(components);
  const read = model.find((m) => m.operation === 'read');
  const del = model.find((m) => m.operation === 'delete');

  assert.equal(read.restricted, true);
  assert.deepEqual(read.roles, [`${PREFIX}requester`]);
  assert.equal(del.restricted, false);
  assert.match(del.note, /no ACL in this architecture covers this operation/);

  /* And a table with no ACL at all is flagged rather than left silent. */
  const v = B.validateArchitecture({ components: [components[0]], naming, fieldTypes: FIELD_TYPES });
  assert.ok(v.problems.some((p) => p.code === 'table_without_acl' && p.fatal === false));
});

test('A12 — §24: an ACL with no role applies to everyone, and says so', () => {
  const v = B.validateArchitecture({
    components: [component('acl', 'open', { table: 't', operation: 'read' })],
    naming, fieldTypes: FIELD_TYPES,
  });
  assert.ok(v.problems.some((p) => p.code === 'acl_without_role'));
  assert.equal(v.ok, true, 'it is a warning, not a refusal — but it must be visible');
});

/* ================================================================== *
 * §9–§11 — the dependency graph
 * ================================================================== */

test('A13 — §9: semantic edges come from the artifact, not from a rule of thumb', () => {
  const field = component('field', 'owner', { table: 'req', name: 'owner', type: 'reference', reference: 'sys_user' });
  const edges = B.semanticEdges(field);
  const targets = edges.map((e) => e.to);
  assert.ok(targets.includes('req'), 'a field depends on its table');
  assert.ok(targets.includes('sys_user'), 'a reference field depends on the table it points AT');

  /* A non-reference field does not acquire a target it never named. */
  const plain = B.semanticEdges(component('field', 'note', { table: 'req', name: 'note', type: 'string' }));
  assert.deepEqual(plain.map((e) => e.to), ['req']);
});

test('A14 — §10: a cycle is detected and named', () => {
  const components = [
    component('table', 'a', { name: 'a' }, ['b']),
    component('table', 'b', { name: 'b' }, ['a']),
  ];
  const graph = B.buildGraph(components);
  const v = B.validateGraph({ components, graph });
  assert.equal(v.ok, false);
  const cycle = v.problems.find((p) => p.code === 'dependency_cycle');
  assert.ok(cycle, 'no cycle was reported');
  assert.ok(cycle.components.includes('a') && cycle.components.includes('b'));
});

test('A15 — §10: a dependency on nothing is refused; on something existing, satisfied', () => {
  const components = [component('acl', 'r', { table: 'ghost', operation: 'read', role: 'ghost_role' })];
  const graph = B.buildGraph(components);

  const missing = B.validateGraph({ components, graph });
  assert.ok(missing.problems.some((p) => p.code === 'missing_dependency'));

  const satisfied = B.validateGraph({ components, graph, existing: new Set(['ghost', 'ghost_role']) });
  assert.equal(satisfied.problems.some((p) => p.code === 'missing_dependency'), false);
});

test('A16 — §10: two components claiming one identity is refused', () => {
  const components = [
    component('role', 'r1', { name: `${PREFIX}dup` }),
    component('role', 'r2', { name: `${PREFIX}dup` }),
  ];
  const v = B.validateGraph({ components, graph: B.buildGraph(components) });
  assert.ok(v.problems.some((p) => p.code === 'duplicate_artifact'));
});

test('A17 — §11: build order respects dependencies and is deterministic', () => {
  const components = [
    component('acl', 'acl_read', { table: 'req', operation: 'read', role: 'role_a' }),
    component('field', 'owner', { table: 'req', name: 'owner', type: 'reference', reference: 'req' }),
    component('table', 'req', { name: 'req' }),
    component('role', 'role_a', { name: 'role_a' }),
  ];
  const graph = B.buildGraph(components);
  const order = B.buildOrder({ components, graph });
  assert.equal(order.ok, true);

  const at = (id) => order.order.indexOf(id);
  assert.ok(at('req') < at('owner'), 'a field was ordered before its table');
  assert.ok(at('req') < at('acl_read'), 'an ACL was ordered before its table');
  assert.ok(at('role_a') < at('acl_read'), 'an ACL was ordered before its role');

  /* Same architecture, different input order → same build order. */
  const shuffled = [components[2], components[3], components[1], components[0]];
  const again = B.buildOrder({ components: shuffled, graph: B.buildGraph(shuffled) });
  assert.deepEqual(again.order, order.order);
});

/* ================================================================== *
 * §12 / §29 — capability
 * ================================================================== */

test('A18 — §12: a component\'s status comes from discovery, never from its description', () => {
  const components = [
    component('table', `${PREFIX}t`, { name: `${PREFIX}t` }),
    component('role', `${PREFIX}r`, { name: `${PREFIX}r` }),
  ];
  const r = B.resolveCapabilities({ components, discovered: capabilities() });
  const table = r.find((x) => x.type === 'table');
  const role = r.find((x) => x.type === 'role');

  assert.equal(table.status, B.STATUS.REQUIRES_SDK);
  assert.equal(table.executable, false);
  assert.equal(role.status, B.STATUS.SUPPORTED);
  assert.equal(role.executable, true);
});

test('A19 — §29: one blocked component blocks the WHOLE build', () => {
  /*
   * The rule that keeps a real instance from holding half an application.
   * Everything here is buildable except one table, and the answer is that
   * nothing is built.
   */
  const components = [
    component('role', `${PREFIX}r`, { name: `${PREFIX}r` }),
    component('catalog', 'Request kit', { name: 'Request kit', short_description: 'x' }),
    component('table', `${PREFIX}t`, { name: `${PREFIX}t` }),
  ];
  const g = B.gate({ components, discovered: capabilities() });
  assert.equal(g.executable, false);
  assert.equal(g.blocked.length, 1);
  assert.equal(g.summary.executable, 2, 'the other two ARE executable — and are still not built');
  assert.match(g.note, /NOTHING is built/);
});

test('A20 — a capability that is available through a tool this build lacks is UNSUPPORTED', () => {
  const registry = new Map([['create_record', {}]]);  /* no create_catalog_item */
  const r = B.resolveCapabilities({
    components: [component('catalog', 'x', { name: 'x' })],
    discovered: capabilities(),
    registry,
  });
  assert.equal(r[0].status, B.STATUS.UNSUPPORTED);
  assert.match(r[0].why, /not in this build's registry/);
});

test('A21 — an elevated capability is executable, and says it will elevate', () => {
  /* §49 — the builder never elevates itself; the existing gate decides. */
  const r = B.resolveCapabilities({
    components: [component('acl', 'a', { table: 't', operation: 'read', role: 'r' })],
    discovered: capabilities(),
  });
  assert.equal(r[0].status, B.STATUS.REQUIRES_ELEVATION);
  assert.equal(r[0].executable, true);
  assert.match(r[0].why, /never elevates itself/);
});

/* ================================================================== *
 * §6 / §7 — discovery and reuse
 * ================================================================== */

test('A22 — §7: a matching name with different contents is INSPECT, not reuse', () => {
  const c = component('table', 'req', { name: 'req', fields: [{ name: 'state' }, { name: 'owner' }] });
  const verdict = B.compare({ component: c, existing: { kind: 'table', name: 'req', fields: [{ name: 'state' }] } });
  assert.equal(verdict.verdict, 'inspect');
  assert.match(verdict.why, /matching name is not evidence/);
  assert.equal(verdict.differences.length, 1);
});

test('A23 — §6: an existing artifact that satisfies the requirement is reused, not rebuilt', () => {
  const c = { ...component('role', `${PREFIX}r`, { name: `${PREFIX}r` }), identity: `${PREFIX}r` };
  const out = B.reconcile({
    components: [c],
    discovered: { roles: [{ name: `${PREFIX}r`, sys_id: 'a'.repeat(32) }], tables: [], applications: [], flows: [], catalog: [] },
  });
  assert.equal(out.build.length, 0, 'the component was rebuilt despite already existing');
  assert.equal(out.reused.length, 1);
});

test('A24 — §80-style: a surface that could not be READ is not an empty instance', async () => {
  const d = await B.discover({
    probes: { tables: async () => { throw new Error('ACL denied'); }, roles: async () => [] },
  });
  assert.equal(d.complete, false);
  assert.equal(d.unreadable[0].surface, 'tables');
  assert.match(d.unreadable[0].reason, /ACL denied/);
});

/* ================================================================== *
 * §13 / §14 — the plan and the fingerprint
 * ================================================================== */

test('A25 — §13: a build is an ordinary plan, and a composite step folds its children', () => {
  const item = component('catalog', 'Request kit', { name: 'Request kit', short_description: 'Ask for kit' });
  const variable = component('catalog_variable', 'kit_type', {
    catalog_item: 'Request kit', name: 'kit_type', label: 'Kit type', type: 6,
  }, ['Request kit']);

  const { plan, steps, folded } = B.buildPlan({ ordered: [item, variable], requirements: REQUIREMENTS });
  assert.equal(steps.length, 1, 'the variable must not become its own step');
  assert.equal(steps[0].tool, 'create_catalog_item');
  assert.equal(steps[0].inputs.variables.length, 1);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].built_by, 'Request kit');

  /* Every mutating step carries what the plan validator requires. */
  for (const s of steps) {
    assert.ok(s.capability, `${s.id} names no capability`);
    assert.ok(s.expected_effects.length, `${s.id} promises nothing`);
    assert.ok(s.verification.asserts.length >= s.expected_effects.length, `${s.id} under-asserts`);
  }
  assert.match(plan.goal, /Build the "Employee Equipment Request" application/);
});

test('A26 — §22: a choice reaches the tool as {value,text}, never label-as-value', () => {
  const item = component('catalog', 'Kit', { name: 'Kit', short_description: 'x' });
  const v = component('catalog_variable', 'kind', {
    catalog_item: 'Kit', name: 'kind', type: 5, choices: [{ value: 'lap', label: 'Laptop' }],
  }, ['Kit']);
  const { steps } = B.buildPlan({ ordered: [item, v], requirements: REQUIREMENTS });
  assert.deepEqual(steps[0].inputs.variables[0].choices, [{ value: 'lap', text: 'Laptop' }]);
});

test('A27 — §14: the fingerprint covers the design and excludes the run', () => {
  const components = [component('role', `${PREFIX}r`, { name: `${PREFIX}r` })];
  const edges = [];
  const a = B.architectureFingerprint({ requirements: REQUIREMENTS, components, edges });
  const b = B.architectureFingerprint({ requirements: { ...REQUIREMENTS }, components: [...components], edges: [] });
  assert.equal(a, b, 'the same architecture produced two fingerprints');

  const changed = B.architectureFingerprint({
    requirements: REQUIREMENTS,
    components: [component('role', `${PREFIX}r`, { name: `${PREFIX}other` })],
    edges,
  });
  assert.notEqual(a, changed, 'a changed component did not move the fingerprint');

  /* Spec key order is not part of the design. */
  const reordered = B.architectureFingerprint({
    requirements: REQUIREMENTS,
    components: [component('role', `${PREFIX}r`, { description: undefined, name: `${PREFIX}r` })],
    edges,
  });
  assert.equal(a, reordered);
});

/* ================================================================== *
 * §30 / §31 / §44 / §46 — verification
 * ================================================================== */

test('A28 — §44: a component that cannot be read back is not verified', async () => {
  const created = [
    { component: 'a', type: 'role', sys_id: 'a'.repeat(32) },
    { component: 'b', type: 'role', sys_id: 'b'.repeat(32) },
  ];
  const verified = await B.verifyComponents({
    created,
    readBack: async (e) => (e.component === 'a' ? { sys_id: e.sys_id } : null),
  });
  assert.equal(verified[0].state, B.VERIFY.VERIFIED);
  assert.equal(verified[1].state, B.VERIFY.FAILED);
  assert.match(verified[1].note, /cannot be read back/);
});

test('A29 — a read-back that THREW is unknown, not failed', async () => {
  const verified = await B.verifyComponents({
    created: [{ component: 'a', type: 'role' }],
    readBack: async () => { throw new Error('timeout'); },
  });
  assert.equal(verified[0].state, B.VERIFY.NOT_ATTEMPTED);
  assert.match(verified[0].note, /not established/);
});

test('A30 — §46: components verified and behaviour not is PARTIALLY VERIFIED, never PASS', () => {
  const c = B.conclude({
    components: [{ id: 'a' }],
    verified: [{ component: 'a', state: B.VERIFY.VERIFIED }],
    test: null,
    behaviours: 2,
  });
  assert.equal(c.outcome, B.OUTCOME.APPLICATION_PARTIALLY_VERIFIED);
  assert.equal(c.partial, true);
  assert.equal(c.behaviour.state, B.VERIFY.NOT_ATTEMPTED);
  assert.match(c.behaviour.note, /none of the stated behaviours was established/i);
});

test('A31 — everything verified AND the flow passing is the only VERIFIED', () => {
  const c = B.conclude({
    components: [{ id: 'a' }],
    verified: [{ component: 'a', state: B.VERIFY.VERIFIED }],
    test: { status: 'PASS' },
    behaviours: 1,
  });
  assert.equal(c.outcome, B.OUTCOME.APPLICATION_VERIFIED);

  /* An INCONCLUSIVE test never becomes a pass. */
  const inconclusive = B.conclude({
    components: [{ id: 'a' }],
    verified: [{ component: 'a', state: B.VERIFY.VERIFIED }],
    test: { status: 'INCONCLUSIVE' },
    behaviours: 1,
  });
  assert.equal(inconclusive.outcome, B.OUTCOME.APPLICATION_PARTIALLY_VERIFIED);
});

test('A32 — §30/§31: a partial build reports exactly what exists and claims no rollback', () => {
  const p = B.partialState({
    created: [{ component: 'role_a', type: 'role', sys_id: 'a'.repeat(32) }],
    planned: [{ id: 'role_a' }, { id: 'catalog_b' }],
    failedAt: 'step_2_catalog_b',
  });
  assert.equal(p.state, B.OUTCOME.PARTIAL_BUILD);
  assert.deepEqual(p.not_created, ['catalog_b']);
  assert.equal(p.rolled_back, false);
  assert.match(p.note, /Nothing was rolled back/);
});

test('A33 — §31: rollback needs ownership, an id, the capability AND policy', () => {
  const base = { created_by_this_build: true, sys_id: 'a'.repeat(32) };
  const caps = { record_delete: { available: true } };

  assert.equal(B.rollbackEligibility({ entry: base, capabilities: caps, policyAllows: true }).eligible, true);

  for (const [entry, capsOverride, policy, expect] of [
    [{ ...base, created_by_this_build: false }, caps, true, /did not create it/],
    [{ ...base, sys_id: null }, caps, true, /sys_id was never recorded/],
    [base, { record_delete: { available: false } }, true, /not available/],
    [base, caps, false, /policy does not permit/],
  ]) {
    const r = B.rollbackEligibility({ entry, capabilities: capsOverride, policyAllows: policy });
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.some((x) => expect.test(x)), `expected ${expect} in ${JSON.stringify(r.reasons)}`);
  }
});

/* ================================================================== *
 * §28 — the whole run, blocked
 * ================================================================== */

test('A34 — §28: an unbuildable application is designed in full and written not at all', async () => {
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return JSON.stringify(calls === 1 ? REQUIREMENTS : {
      components: [
        { type: 'table', name: `${PREFIX}req`, purpose: 'requests', depends_on: [], spec: { name: `${PREFIX}req`, label: 'Req' } },
        { type: 'role', name: `${PREFIX}requester`, purpose: 'requesters', depends_on: [], spec: { name: `${PREFIX}requester` } },
      ],
    });
  };

  const r = await B.buildApplication({
    request: 'Build an Employee Equipment Request application.',
    chat, discovered: capabilities(), naming, fieldTypes: FIELD_TYPES,
    probes: { tables: async () => [], roles: async () => [] },
  });

  assert.equal(r.outcome, B.OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED);
  assert.equal(r.created.length, 0, 'a blocked build created something');
  assert.equal(r.plan, null, 'a blocked build produced a plan');
  assert.ok(r.architecture.components.length === 2, 'the architecture must still be complete');
  assert.ok(r.fingerprint, 'the architecture still has an identity');
  assert.match(r.markdown, /ARCHITECTURE READY — BUILD BLOCKED/);
  assert.match(r.markdown, /No changes were made/);
  assert.ok(r.remediation.some((x) => x.status === B.STATUS.REQUIRES_SDK));
});

test('A35 — §38: the change summary is a lookup, and a table or ACL makes it HIGH', () => {
  const low = B.changeSummary({ components: [component('catalog', 'x', { name: 'x' })] });
  assert.equal(low.risk, 'LOW');

  const high = B.changeSummary({ components: [component('table', 't', { name: 't' })] });
  assert.equal(high.risk, 'HIGH');
  assert.match(high.why, /hardest to undo/);

  const medium = B.changeSummary({ components: [component('flow', 'f', { name: 'f', table: 't' })] });
  assert.equal(medium.risk, 'MEDIUM');
});


/* ================================================================== *
 * REGRESSIONS — every one found by the real PDI run, not by review
 * ================================================================== */

test('A36 — a step that FAILED after creating something is still owned', async () => {
  /*
   * FOUND BY THE PDI. The catalog step's write landed — a real record existed —
   * and the step was then marked failed. Ownership was read from `completed`
   * steps only, so the record was absent from `created`, absent from cleanup,
   * and left behind. §30 asks what EXISTS, not what succeeded.
   *
   * Asserted through the public build, because the accounting only matters
   * where cleanup reads it.
   */
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return JSON.stringify(calls === 1 ? REQUIREMENTS : {
      components: [{ type: 'role', name: `${PREFIX}r`, depends_on: [], spec: { name: `${PREFIX}r` } }],
    });
  };
  const r = await B.buildApplication({
    request: 'Build it.', taskId: 't', chat, discovered: capabilities(), naming, fieldTypes: FIELD_TYPES,
    probes: { roles: async () => [], tables: async () => [] },
    plan: {
      generate: async (o) => ({ ok: true, plan: await o.propose(), discovered: capabilities() }),
      save: () => ({ ok: true, fingerprint: 'f'.repeat(64) }),
      setState: () => {},
      review: () => ({ approvalRequired: true, steps: [], plannedChanges: [], destructive: [] }),
      approve: async () => ({ ok: true }),
      /* A step that wrote a record and then failed its read-back. */
      load: () => ({
        steps: [{
          id: 'step_1_x', state: 'failed',
          result: { sys_id: 'a'.repeat(32) },
          inputs: { table: 'sys_user_role' },
        }],
      }),
    },
    run: async () => ({ ok: false, reason: 'partial', note: 'the write did not verify' }),
  });

  assert.equal(r.created.length, 1, 'an artifact that landed was not recorded as owned');
  assert.equal(r.created[0].sys_id, 'a'.repeat(32));
  assert.equal(r.created[0].step_succeeded, false, 'it must be marked as existing WITHOUT the step succeeding');
  assert.equal(r.outcome, B.OUTCOME.PARTIAL_BUILD);
});

test('A37 — a step with no identity in its result is not claimed as owned', () => {
  /* The mirror of A36. Deleting on a guess is how a build removes somebody
   * else's record, so "no sys_id" means "not ours". */
  assert.equal(
    B.rollbackEligibility({ entry: { created_by_this_build: true, sys_id: null }, capabilities: { record_delete: { available: true } }, policyAllows: true }).eligible,
    false,
  );
});

test('A38 — a folded component is accounted for by its parent, not counted missing', () => {
  /*
   * FOUND BY THE PDI. A catalog variable is created by the same call that
   * creates its item, so it has no step and no read-back of its own. Counting
   * it as missing turned a complete, fully verified build into PARTIAL_BUILD —
   * a state §30 reserves for an instance holding half an application.
   */
  const components = [{ id: 'Item' }, { id: 'var_a' }];
  const verified = [{ component: 'Item', state: B.VERIFY.VERIFIED }];

  const wrong = B.conclude({ components, verified, test: null, behaviours: 0 });
  assert.equal(wrong.outcome, B.OUTCOME.PARTIAL_BUILD, 'without the folded list it must still be partial');

  const right = B.conclude({
    components, verified, test: null, behaviours: 0,
    folded: [{ component: 'var_a', built_by: 'Item' }],
  });
  assert.equal(right.outcome, B.OUTCOME.APPLICATION_PARTIALLY_VERIFIED);
  assert.deepEqual(right.components.missing, []);
});

test('A39 — a fold with no parent is NOT accounted for', () => {
  /* Only a component something else actually built is covered. A component
   * that produced no step and has no parent is genuinely missing. */
  const r = B.conclude({
    components: [{ id: 'orphan' }],
    verified: [],
    folded: [{ component: 'orphan', built_by: null }],
  });
  assert.deepEqual(r.components.missing, ['orphan']);
  assert.equal(r.outcome, B.OUTCOME.PARTIAL_BUILD);
});


test('A40 — §17: the PLATFORM names scoped artifacts; the model supplies the label', () => {
  /*
   * FOUND BY THE REAL-MODEL EVALUATION. Asked for an equipment-request
   * application, the model proposed a table called "Equipment Request" and
   * roles called "Employee" and "Manager" — exactly right as labels, and not
   * names a scoped artifact can have. Every such architecture was refused for a
   * naming violation, so the builder designed a good application and then
   * declined to build it on a technicality of its own making.
   */
  const out = B.applyNaming([
    component('table', 'Equipment Request', { name: 'Equipment Request' }),
    component('role', 'Employee', { name: 'Employee' }),
    component('role', `${PREFIX}already_named`, { name: `${PREFIX}already_named` }),
  ], { prefix: PREFIX });

  const table = out.components.find((c) => c.type === 'table');
  assert.equal(table.name, `${PREFIX}equipment_request`);
  assert.equal(table.spec.label, 'Equipment Request', 'the label a person sees must survive');
  assert.equal(out.renamed.length, 2, 'an already-scoped name must not be renamed');
  assert.ok(out.components.some((c) => c.name === `${PREFIX}already_named`));

  /* Deterministic: the same architecture always produces the same names, or the
   * fingerprint would move for no reason. */
  const again = B.applyNaming([component('table', 'Equipment Request', { name: 'Equipment Request' })], { prefix: PREFIX });
  assert.equal(again.components[0].name, table.name);
});

test('A41 — a reference by label resolves to the component it names', () => {
  /*
   * FOUND BY THE REAL-MODEL EVALUATION and it was the single biggest cause of a
   * refused architecture — nine of twenty requests. The model names a table
   * "Equipment Request" and then writes a field whose table is
   * "equipment_request", or an ACL whose role is "Employee" against a role
   * component called "employee". Every one is unmistakably the same artifact,
   * and no exact match finds it.
   */
  const out = B.applyNaming([
    component('table', 'Equipment Request', { name: 'Equipment Request' }),
    component('role', 'Employee', { name: 'Employee' }),
    component('acl', 'acl1', { table: 'equipment_request', operation: 'read', role: 'employee' }),
  ], { prefix: PREFIX });

  const acl = out.components.find((c) => c.type === 'acl');
  assert.equal(acl.spec.table, `${PREFIX}equipment_request`);
  assert.equal(acl.spec.role, `${PREFIX}employee`);

  const graph = B.buildGraph(out.components);
  assert.equal(B.validateGraph({ components: out.components, graph }).ok, true,
    'a reference by label was reported as a missing dependency');
});

test('A42 — slug resolution never invents a target that is not in the architecture', () => {
  /* The other half. A reference to something nobody is building must STAY
   * unresolved so the validator can refuse it. */
  const out = B.applyNaming([
    component('field', 'owner', { table: 'nothing_like_this', name: 'owner', type: 'string' }),
  ], { prefix: PREFIX });
  assert.equal(out.components[0].spec.table, 'nothing_like_this');

  const graph = B.buildGraph(out.components);
  assert.equal(B.validateGraph({ components: out.components, graph }).ok, false);
});

test('A43 — §21: a reference to a live platform table resolves against the dictionary', () => {
  /*
   * FOUND BY THE REAL-MODEL EVALUATION. Discovery only sees this application's
   * own scope, so `existing` holds scoped tables and nothing else — and a
   * reference to `sys_user`, the commonest reference an application makes, was
   * refused as pointing at a table "not present on this instance".
   */
  const components = [component('field', 'owner', {
    table: 't', name: 'owner', type: 'reference', reference: 'sys_user',
  })];

  const withoutDictionary = B.validateArchitecture({ components, naming, fieldTypes: FIELD_TYPES });
  assert.ok(withoutDictionary.fatal.some((p) => p.code === 'reference_target_unknown'),
    'with no dictionary it must still refuse — nothing established that the table exists');

  const withDictionary = B.validateArchitecture({
    components, naming, fieldTypes: FIELD_TYPES, tableExists: (t) => t === 'sys_user',
  });
  assert.equal(withDictionary.fatal.some((p) => p.code === 'reference_target_unknown'), false);
});
