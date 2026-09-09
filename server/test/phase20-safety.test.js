/**
 * PHASE 20 — THE THINGS THAT MUST BE IMPOSSIBLE.
 *
 * §51's seven properties and §63/§64's architecture boundary. Twenty-two
 * release blockers are listed in §68 and most reduce to one of two sentences:
 *
 *   nothing is written until the WHOLE architecture is validated
 *   nothing is written except through the existing executor
 *
 * Both are asserted structurally — against the import graph and the source
 * text — as well as behaviourally, because a boundary that holds only when the
 * code is called correctly is not a boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as B from '../src/agent/appbuild/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const DOMAIN = path.join(SRC, 'agent', 'appbuild');
const files = () => fs.readdirSync(DOMAIN).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(DOMAIN, f), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PREFIX = 'x_2002152_';
const validateScopeName = (name, prefix) => ({
  ok: String(name).startsWith(prefix) && String(name).length <= 18,
  errors: String(name).length > 18 ? ['too long'] : [],
});
const naming = { prefix: PREFIX, maxScope: 18, validateScopeName, maxNameLength: {} };
const component = (type, name, spec = {}, depends_on = []) => ({ id: name, type, name, purpose: '', depends_on, spec });

const CAPS = {
  capabilities: {
    record_create: { available: true, mechanism: 'rest', status: 'known' },
    catalog_authoring: { available: true, mechanism: 'rest', status: 'known' },
    table_create: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown' },
    flow_authoring: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown' },
    application_authoring: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown' },
    field_create: { available: false, mechanism: 'sdk', status: 'unknown', reason: 'mechanism_unknown' },
  },
};

const REQS = {
  name: 'Kit Requests', purpose: 'x', actors: ['a'], data: ['kit'], processes: ['submit'],
  security: [], interfaces: ['catalog'], acceptance_criteria: ['A request exists'],
};

/** A run whose model returns whatever architecture the test wants. */
async function runWith(components, over = {}) {
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return JSON.stringify(calls === 1 ? REQS : { components });
  };
  return B.buildApplication({
    request: 'Build a kit request app.',
    chat, discovered: CAPS, naming, fieldTypes: new Set(['string', 'reference']),
    probes: { tables: async () => [], roles: async () => [] },
    ...over,
  });
}

/* ================================================================== *
 * §51 — the seven properties
 * ================================================================== */

test('S1 — an unsupported component cannot execute: no plan is even produced', async () => {
  let planned = false;
  const r = await runWith(
    [{ type: 'table', name: `${PREFIX}kit`, depends_on: [], spec: { name: `${PREFIX}kit` } }],
    { plan: { generate: async () => { planned = true; return { ok: true, plan: { steps: [] } }; } }, run: async () => ({ ok: true }) },
  );
  assert.equal(r.outcome, B.OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED);
  assert.equal(planned, false, 'a plan was generated for an unbuildable architecture');
  assert.equal(r.created.length, 0);
});

test('S2 — a missing dependency cannot execute', async () => {
  const r = await runWith([
    { type: 'acl', name: 'rule', depends_on: [], spec: { table: 'ghost_table', operation: 'read', role: 'ghost_role' } },
  ]);
  assert.equal(r.outcome, B.OUTCOME.BLOCKED);
  assert.equal(r.stopped.reason, B.FAILURE.MISSING_DEPENDENCY);
  assert.equal(r.created.length, 0);
});

test('S3 — a duplicate artifact cannot execute', async () => {
  const r = await runWith(
    [{ type: 'role', name: `${PREFIX}req`, depends_on: [], spec: { name: `${PREFIX}req` } }],
    { probes: { roles: async () => [{ name: `${PREFIX}req`, sys_id: 'a'.repeat(32) }], tables: async () => [] } },
  );
  /*
   * An existing role that matches exactly is REUSED — and then there is nothing
   * left to build, which is the correct answer and not a mutation.
   */
  assert.equal(r.created.length, 0);
  assert.ok(r.architecture.reused.length === 1 || r.stopped, 'the existing artifact was neither reused nor refused');
});

test('S4 — §29: partial capability does not silently mutate', async () => {
  /* Two buildable components and one that is not. Nothing is built. */
  let executed = false;
  const r = await runWith([
    { type: 'role', name: `${PREFIX}a`, depends_on: [], spec: { name: `${PREFIX}a` } },
    { type: 'catalog', name: 'Kit request', depends_on: [], spec: { name: 'Kit request', short_description: 'x' } },
    { type: 'flow', name: 'Approve kit', depends_on: [], spec: { name: 'Approve kit', table: 'sc_request' } },
  ], {
    /* The flow's table already exists, so the run reaches the CAPABILITY gate
     * rather than stopping earlier on a missing dependency. Without this the
     * test passes for the wrong reason. */
    probes: { tables: async () => [{ name: 'sc_request' }], roles: async () => [] },
    plan: { generate: async () => ({ ok: true, plan: { steps: [] } }), save: () => ({ ok: true }), setState: () => {}, review: () => ({}), load: () => ({}) },
    run: async () => { executed = true; return { ok: true }; },
  });
  assert.equal(r.outcome, B.OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED);
  assert.equal(executed, false, 'the executor ran for a partially-supported architecture');
  assert.equal(r.capability.summary.executable, 2, 'the two buildable components ARE buildable — and were still not built');
});

test('S5 — approval bypass is impossible: with no approval path, nothing runs', async () => {
  let executed = false;
  const r = await runWith(
    [{ type: 'role', name: `${PREFIX}a`, depends_on: [], spec: { name: `${PREFIX}a` } }],
    {
      plan: {
        generate: async (o) => ({ ok: true, plan: await o.propose(), discovered: CAPS }),
        save: () => ({ ok: true, fingerprint: 'f'.repeat(64) }),
        setState: () => {},
        review: () => ({ approvalRequired: true, steps: [], plannedChanges: [], destructive: [] }),
        load: () => ({ steps: [] }),
        approve: null,          /* no approval path supplied */
      },
      run: async () => { executed = true; return { ok: true }; },
    },
  );
  assert.equal(executed, false, 'the executor ran without an approval path');
  assert.equal(r.outcome, B.OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED);
});

test('S6 — a refused approval stops the build and creates nothing', async () => {
  let executed = false;
  const r = await runWith(
    [{ type: 'role', name: `${PREFIX}a`, depends_on: [], spec: { name: `${PREFIX}a` } }],
    {
      plan: {
        generate: async (o) => ({ ok: true, plan: await o.propose(), discovered: CAPS }),
        save: () => ({ ok: true, fingerprint: 'f'.repeat(64) }),
        setState: () => {},
        review: () => ({ approvalRequired: true, steps: [], plannedChanges: [], destructive: [] }),
        load: () => ({ steps: [] }),
        approve: async () => ({ ok: false, reason: 'rejected', note: 'The user said no.' }),
      },
      run: async () => { executed = true; return { ok: true }; },
    },
  );
  assert.equal(executed, false);
  assert.equal(r.outcome, B.OUTCOME.BLOCKED);
  assert.match(r.stopped.note, /said no/);
});

test('S7 — verification bypass is impossible: no read-back means no claim', async () => {
  const verified = await B.verifyComponents({ created: [{ component: 'a', type: 'role' }], readBack: null });
  assert.equal(verified[0].state, B.VERIFY.NOT_ATTEMPTED);
  assert.equal(verified[0].verified, false);

  const c = B.conclude({ components: [{ id: 'a' }], verified, test: null, behaviours: 1 });
  assert.notEqual(c.outcome, B.OUTCOME.APPLICATION_VERIFIED, 'an unverified build was reported verified');
});

/* ================================================================== *
 * §63 / §64 — the architecture boundary
 * ================================================================== */

test('S8 — §63: the builder imports no client, no HTTP, no SDK, no approval, no verifier', () => {
  const external = new Set();
  for (const f of files()) {
    for (const m of read(f).matchAll(/from\s+'([^']+)'/g)) {
      if (!m[1].startsWith('./')) external.add(m[1]);
    }
  }
  /*
   * The builder is a COMPOSER. It reaches nothing on its own: every
   * collaborator arrives as a parameter, which is why this list is one entry.
   */
  assert.deepEqual([...external].sort(), ['node:crypto']);

  for (const banned of [
    'servicenow/client', 'servicenow/fluent', 'memory/db', 'agent/orchestrator',
    'plan/executor', 'evidence/', 'providers/', 'elevation',
  ]) {
    assert.equal([...external].some((e) => e.includes(banned)), false, `the builder imports ${banned}`);
  }
});

test('S9 — §64: the builder contains no executor, no client call and no raw HTTP', () => {
  const banned = [
    'executeTool', 'table.create', 'table.update', 'table.remove', 'snowFetch',
    'fetch(', 'axios', 'XMLHttpRequest', 'https.request',
    'awaitApprovalDecision', 'resolveApproval', 'approvePlan(',
    'verifyMutation', 'buildEvidence', 'appendMutation',
  ];
  for (const f of files()) {
    const src = strip(read(f));
    for (const b of banned) {
      assert.equal(src.includes(b), false, `appbuild/${f} names ${b}`);
    }
  }
});

test('S10 — §49: the builder cannot elevate, impersonate or disable access', () => {
  /*
   * THE DETECTOR HAD TO LEARN A DISTINCTION. An earlier version banned the
   * string `security_admin` outright and fired on `architecture.js`, which
   * names it in BROAD_ROLES — the list of roles an application must NOT grant.
   * That is the opposite of an elevation, and banning the word would have
   * forced the deny list to be deleted to satisfy a safety test.
   *
   * So the verbs are banned, and the powerful role names are checked for the
   * CONTEXT they appear in: refusing them is required, granting them is not
   * possible.
   */
  for (const f of files()) {
    const src = strip(read(f));
    for (const verb of ['impersonat', 'elevateTo', 'setElevation', 'sys_user_has_role', 'runElevated']) {
      assert.equal(src.includes(verb), false, `appbuild/${f} names ${verb}`);
    }
  }

  /* `security_admin` may appear only in the deny list, and BROAD_ROLES must
   * actually contain it — a deny list that lost its most dangerous entry would
   * otherwise pass this silently. */
  const arch = strip(read('architecture.js'));
  const denyList = /const BROAD_ROLES = new Set\(\[([^\]]*)\]\)/.exec(arch);
  assert.ok(denyList, 'the broad-role deny list is gone');
  assert.ok(denyList[1].includes('security_admin'), 'security_admin is no longer refused');
  assert.ok(denyList[1].includes('admin'), 'admin is no longer refused');

  for (const f of files()) {
    const src = strip(read(f));
    const outside = src.replace(/const BROAD_ROLES = new Set\(\[[^\]]*\]\);/, '');
    assert.equal(outside.includes('security_admin'), false,
      `appbuild/${f} names security_admin outside the deny list`);
  }
});

test('S11 — §64: exactly one executePlan exists in the whole build, and not here', () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (/export async function executePlan/.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
  assert.deepEqual(found, [path.join('agent', 'plan', 'executor.js')]);
});

test('S12 — §65: no new table, and the DB version is untouched', () => {
  const migrations = fs.readFileSync(path.join(SRC, 'memory', 'db.js'), 'utf8');
  for (const word of ['appbuild', 'application_build', 'app_component', 'build_plan']) {
    assert.equal(migrations.includes(word), false, `a migration mentions ${word}`);
  }
  /* And the builder holds no state of its own. */
  for (const f of files()) {
    const src = strip(read(f));
    assert.equal(/getDb\(|INSERT\s+INTO|CREATE\s+TABLE/i.test(src), false, `appbuild/${f} touches a database`);
  }
});

/* ================================================================== *
 * §68 — the blockers that are not covered above
 * ================================================================== */

test('S13 — §68.10/§68.11: the model cannot invent a capability or an artifact', () => {
  /*
   * A component's status is read from discovery. A component that CLAIMS to be
   * supported gets no say — there is no field a proposal could set that this
   * would read.
   */
  const claimed = {
    ...component('table', `${PREFIX}t`, { name: `${PREFIX}t` }),
    status: 'SUPPORTED', executable: true, capability: 'record_create',
  };
  const r = B.resolveCapabilities({ components: [claimed], discovered: CAPS });
  assert.equal(r[0].status, B.STATUS.REQUIRES_SDK);
  assert.equal(r[0].executable, false);

  /* And a component type nothing models is UNSUPPORTED, not assumed fine. */
  const invented = B.resolveCapabilities({ components: [component('quantum_widget', 'q')], discovered: CAPS });
  assert.equal(invented[0].executable, false);
});

test('S14 — §68.2: a component that produced no step is accounted for, never dropped', () => {
  const orphan = component('catalog_variable', 'v', { name: 'v' }); /* no catalog_item */
  const { steps, folded } = B.buildPlan({ ordered: [orphan], requirements: REQS });
  assert.equal(steps.length, 0);
  assert.equal(folded.length, 1, 'a component vanished without being accounted for');
  assert.equal(folded[0].component, 'v');
});

test('S15 — §68.9: rollback is never claimed by default', () => {
  const p = B.partialState({ created: [{ component: 'a' }], planned: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(p.rolled_back, false);
  /* And the render says it too, so a reader cannot infer a rollback happened. */
  assert.match(p.note, /Nothing was rolled back/);
});

test('S16 — every detector in this file fires on a real violation', () => {
  /* A guard that cannot fail is not a guard. */
  assert.equal(strip('const x = executeTool(1);').includes('executeTool'), true);
  assert.equal(strip('/* executeTool is not called here */ const y = 1;').includes('executeTool'), false,
    'the comment stripper does not work, so every content detector is unreliable');
  assert.equal(/export async function executePlan/.test('export async function executePlan({}) {}'), true);
  assert.equal(B.resolveCapabilities({
    components: [component('table', 't', {})],
    discovered: { capabilities: { table_create: { available: true, mechanism: 'sdk' } } },
  })[0].executable, true, 'the capability resolver never returns executable, so S13 proves nothing');
});
