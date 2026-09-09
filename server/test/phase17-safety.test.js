/**
 * PHASE 17 — THE BOUNDARY, COUNTED RATHER THAN PROMISED.
 *
 * §68 names what NowTest must not own: a ServiceNow client, an executor, a
 * verifier, an approval gate, an evidence store, a redactor, a migration. Each
 * of those already exists exactly once in this build, and the danger this file
 * exists to catch is not that NowTest does something reckless with one of them.
 * It is that NowTest quietly grows a SECOND one.
 *
 * A second copy is invisible in behaviour, which is precisely what makes it
 * expensive. Both copies work. The copy that never got the write guard, the
 * fingerprint re-check or the redaction pass works right up until the day it
 * does not, and by then nobody remembers there are two. So every check below is
 * static: read the source off disk and count. No instance, no database, no
 * model, nothing that can be true on one machine and false on another.
 *
 * And because a guard nobody has seen fail is a guard nobody has tested, T13
 * runs every detector in this file against text that violates it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const NT = await import('../src/agent/test/index.js');

/* ------------------------------------------------------------------ *
 * The corpus
 * ------------------------------------------------------------------ */

const TEST_DIR = new URL('../src/agent/test/', import.meta.url);
const domainFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js'));
const domainSource = Object.fromEntries(
  domainFiles.map((f) => [f, fs.readFileSync(new URL(f, TEST_DIR), 'utf8')]),
);

/*
 * Comments are stripped before every content detector runs. This directory
 * explains itself at length — `index.js` says the words "provider", "memory/"
 * and "redaction" in its own boundary note — and a detector that fired on the
 * prose describing the rule would have to be weakened to shut it up, which is
 * how a guard stops guarding.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const domainCode = Object.fromEntries(
  Object.entries(domainSource).map(([name, src]) => [name, stripComments(src)]),
);

/** Every .js file under src/, keyed by its path relative to src/. */
const SRC_DIR = new URL('../src/', import.meta.url);
function walkSrc(dir = SRC_DIR, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) { out.push(...walkSrc(child, `${prefix}${entry.name}/`)); continue; }
    if (!entry.name.endsWith('.js')) continue;
    out.push([`${prefix}${entry.name}`, fs.readFileSync(child, 'utf8')]);
  }
  return out;
}
const srcFiles = walkSrc();

/* ------------------------------------------------------------------ *
 * The detectors
 *
 * Each is a [name, regex] pair rather than an inline literal, so that T13 can
 * run the SAME object over text that breaks the property. A detector written
 * twice — once for the source and once for its proof — is a detector whose
 * proof does not cover the source.
 * ------------------------------------------------------------------ */

/** Which detectors in a list fire on this text. */
const hits = (detectors, code) => detectors.filter(([, re]) => re.test(code)).map(([name]) => name);

/** Anything that would reach the network without going through an injected tool. */
const RAW_HTTP = Object.freeze([
  ['fetch(', /\bfetch\s*\(/],
  ['http.', /\bhttp\s*\./],
  ['https.', /\bhttps\s*\./],
  ['axios', /\baxios\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
]);

/*
 * SQL. `UPDATE` is matched case-sensitively because "update" is an ordinary
 * word in this domain's prose and in ServiceNow's own vocabulary ("update the
 * record", `update_record`); the SQL in `memory/db.js` is uppercase, so the
 * uppercase form is the one that means a statement.
 */
const SQL = Object.freeze([
  ['INSERT INTO', /\binsert\s+into\b/i],
  ['CREATE TABLE', /\bcreate\s+table\b/i],
  ['UPDATE ', /\bUPDATE\s+\w/],
]);

const SECOND_EXECUTOR = Object.freeze([['executeTool', /\bexecuteTool\b/]]);

const SECOND_VERIFIER = Object.freeze([
  ['verifyMutation', /\bverifyMutation\b/],
  ['diffWrite', /\bdiffWrite\b/],
]);

const SECOND_APPROVAL = Object.freeze([
  ['awaitApprovalDecision', /\bawaitApprovalDecision\b/],
  ['resolveApproval', /\bresolveApproval\b/],
  ['approvePlan', /\bapprovePlan\b/],
]);

const SECOND_EVIDENCE = Object.freeze([
  ['buildEvidence', /\bbuildEvidence\b/],
  ['getDb', /\bgetDb\s*\(/],
  ...SQL,
]);

const OWN_REDACTOR = Object.freeze([
  ['a redact function', /function\s+redact\b|const\s+redact\s*=/],
  ['a secret table', /SECRET_KEYS\s*=|const\s+REDACTED\b/],
  /* A regex literal that knows what a credential looks like is a redactor
   * whatever its author decided to call it. */
  ['a secret-matching regex', /\/[^\n/]*(password|secret|token|api[_-]?key|bearer|authorization)[^\n/]*\/[gimsuy]*/i],
]);

const SELF_ELEVATION = Object.freeze([
  ['security_admin', /security_admin/i],
  ['impersonat', /impersonat/i],
  ['elevat', /elevat/i],
]);

/*
 * The allowlist is a frozen literal, so a mutation throws at run time — but
 * only on the line that actually runs. These patterns find the attempt in
 * source, anywhere under src/, including on a path no test happens to execute.
 */
const ALLOWLIST_MUTATION = Object.freeze([
  ['DISPOSABLE_TABLES[...] =', /DISPOSABLE_TABLES\s*\[[^\]]*\]\s*=[^=]/],
  ['DISPOSABLE_TABLES.x =', /DISPOSABLE_TABLES\s*\.\s*\w+\s*=[^=]/],
  ['Object.assign onto it', /Object\.assign\s*\(\s*DISPOSABLE_TABLES\b/],
  ['delete from it', /\bdelete\s+DISPOSABLE_TABLES\b/],
  ['DISPOSABLE_LIST mutated', /DISPOSABLE_LIST\s*\.\s*(push|pop|splice|unshift|shift)\s*\(/],
]);

/*
 * §18 — the thing that must never appear. A delete whose locator is the marker
 * deletes whatever the marker happens to match, which includes another run's
 * leftovers and anything a person typed the marker into by hand.
 */
const DELETE_BY_MARKER = Object.freeze([
  ['a delete called with the marker', /\b(?:del|delete|remove|destroy|purge)\w*\s*\([^)]*\bmarker\b/i],
  ['a delete whose locator is a query on the marker', /\b(?:delete|remove)\w*[^;]{0,200}?\b(?:query|sysparm_query|encoded_query|condition)\b[^;]{0,200}?\bmarker\b/i],
  ['a delete keyed on the literal marker text', /\bNOWTEST\b[^\n]{0,100}?\b(?:delete|remove)\b/i],
]);

/**
 * Every module specifier this directory reaches for: static, dynamic, import
 * and re-export. Re-exports count — `export { x } from '...'` is an import
 * with a different consequence, and `index.js` is made entirely of them.
 */
function specifiersOf(sources) {
  const found = [];
  for (const [name, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.push([name, m[1]]);
    for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push([name, m[1]]);
    for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push([name, m[1]]);
  }
  return found;
}

/** The ones that leave the directory. */
const crossDirectory = (sources) => [
  ...new Set(specifiersOf(sources).filter(([, spec]) => !spec.startsWith('./')).map(([, spec]) => spec)),
].sort();

/** Which files under src/ carry a given declaration. */
const definers = (re) => srcFiles.filter(([, src]) => re.test(src)).map(([rel]) => rel);

/* ================================================================== *
 * T1 — §68 NO DIRECT SERVICENOW CLIENT, DATABASE OR PROVIDER
 * ================================================================== */

test('T1 — the whole import graph of agent/test/ is two reused parsers and nothing else', () => {
  /*
   * The strong form of this check is not a blocklist. A blocklist has to
   * anticipate the import somebody adds next year. An exact allowlist of every
   * specifier that leaves the directory fails on ANY new edge, including one
   * nobody thought to forbid.
   */
  assert.deepEqual(crossDirectory(domainSource), ['../lint/intent.js', '../lint/rules.js']);
});

test('T1 — and the specific things §68 forbids are absent by name', () => {
  const FORBIDDEN = [
    ['the ServiceNow client', /servicenow\/client\.js/],
    ['the ServiceNow schema layer', /servicenow\/schema\.js/],
    ['anything under servicenow/', /(?:^|['"/])servicenow\//],
    ['a provider', /providers?\//],
    ['the database', /memory\/db\.js/],
    ['anything under memory/', /(?:^|['"/])memory\//],
  ];
  for (const [name, src] of Object.entries(domainSource)) {
    for (const [, spec] of specifiersOf({ [name]: src })) {
      assert.deepEqual(hits(FORBIDDEN, spec), [], `${name} imports ${spec}`);
    }
  }
});

/* ================================================================== *
 * T2 — NO RAW HTTP
 * ================================================================== */

test('T2 — nothing under agent/test/ can reach the network on its own', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(RAW_HTTP, code), [], `${name} performs its own HTTP`);
  }
});

/* ================================================================== *
 * T3 — NO SECOND EXECUTOR
 * ================================================================== */

test('T3 — executePlan is defined exactly once, and NowTest calls it rather than copying it', () => {
  assert.deepEqual(definers(/export\s+async\s+function\s+executePlan\s*\(/), ['agent/plan/executor.js']);
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SECOND_EXECUTOR, code), [], `${name} runs a tool outside the executor`);
  }
});

/* ================================================================== *
 * T4 — NO SECOND VERIFIER
 * ================================================================== */

test('T4 — verifyMutation is defined exactly once, and NowTest does not re-decide a write', () => {
  assert.deepEqual(definers(/export\s+async\s+function\s+verifyMutation\s*\(/), ['agent/mutation-pipeline.js']);
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SECOND_VERIFIER, code), [],
      `${name} names the verifier — read-back belongs to the mutation pipeline`);
  }
});

/* ================================================================== *
 * T5 — NO SECOND APPROVAL
 * ================================================================== */

test('T5 — agent/test/ owns no approval; it receives one', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SECOND_APPROVAL, code), [], `${name} reaches into the approval engine`);
  }
  /*
   * And the alternative is present, which is what makes the absence above a
   * design rather than an oversight: the human decision arrives as `approve`,
   * and the binding of that decision to a fingerprint stays with the plan API.
   */
  const runner = domainCode['runner.js'];
  assert.ok(/\bapprove\s*=\s*null\b/.test(runner), 'the approval callback must be an injected parameter');
  assert.ok(/\bplanApi\.approve\s*\(/.test(runner), 'the fingerprint binding must stay in the plan API');
});

/* ================================================================== *
 * T6 — NO SECOND EVIDENCE STORE
 * ================================================================== */

test('T6 — buildEvidence is defined exactly once, and agent/test/ writes no SQL', () => {
  assert.deepEqual(definers(/export\s+function\s+buildEvidence\s*\(/), ['agent/evidence/builder.js']);
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SECOND_EVIDENCE, code), [],
      `${name} persists or projects evidence of its own`);
  }
});

/* ================================================================== *
 * T7 — NO NEW MIGRATION
 * ================================================================== */

test('T7 — the database is unchanged: user_version is still 23 and no table knows about tests', async () => {
  /*
   * The same technique Phase 16 used: build a database from the REAL migration
   * list and ask it what version it reached. `user_version` is set to the index
   * of the last migration that ran, so this counts them too — a 24th migration
   * cannot be appended without moving this number.
   */
  const { getDb, migrate, _setDbForTests } = await import('../src/memory/db.js');
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os');
  const path = await import('node:path');
  _setDbForTests(migrate(new DatabaseSync(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p17db-')), 'd.db'),
  )));
  assert.equal(Object.values(getDb().prepare('PRAGMA user_version').get())[0], 23);

  const db = fs.readFileSync(new URL('../src/memory/db.js', import.meta.url), 'utf8');
  assert.ok(!/nowtest/i.test(db), 'a migration mentions NowTest');
  assert.ok(!/\btest_run\b/i.test(db), 'a migration mentions a test_run table');
  assert.ok(!/CREATE TABLE[^;]*\btest\b/i.test(db), 'Phase 17 added a test table');
});

/* ================================================================== *
 * T8 — NO NEW REDACTOR
 * ================================================================== */

test('T8 — agent/test/ defines no redactor and knows nothing about what a secret looks like', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(OWN_REDACTOR, code), [],
      `${name} redacts on its own — secrets belong to the evidence boundary`);
  }
});

/* ================================================================== *
 * T9 — THE DISPOSABLE ALLOWLIST IS FROZEN AND SMALL
 * ================================================================== */

test('T9 — the allowlist is exactly two frozen tables and nothing in src/ can extend it', () => {
  assert.ok(Object.isFrozen(NT.DISPOSABLE_TABLES), 'the allowlist must be frozen');
  assert.deepEqual(Object.keys(NT.DISPOSABLE_TABLES), ['incident', 'chg_mgt_worker']);
  assert.deepEqual([...NT.DISPOSABLE_LIST], ['incident', 'chg_mgt_worker']);
  assert.ok(Object.isFrozen(NT.DISPOSABLE_LIST));
  for (const [name, entry] of Object.entries(NT.DISPOSABLE_TABLES)) {
    assert.ok(Object.isFrozen(entry), `${name}'s entry must be frozen too`);
    assert.ok(String(entry.why ?? '').length > 20, `${name} must say why it is disposable`);
  }

  /* Frozen is not a comment: a module is strict, so the attempt throws. */
  assert.throws(() => { NT.DISPOSABLE_TABLES.task = { table: 'task', why: 'no' }; }, TypeError);
  assert.equal(NT.isDisposable('task'), false);
  assert.equal(NT.isDisposable('change_request'), false);
  assert.equal(NT.isDisposable('incident'), true);

  /* And no file anywhere tries. */
  for (const [rel, src] of srcFiles) {
    assert.deepEqual(hits(ALLOWLIST_MUTATION, src), [], `${rel} mutates the disposable allowlist`);
  }
});

/* ================================================================== *
 * T10 — CLEANUP DELETES ONLY BY sys_id
 * ================================================================== */

test('T10 — no deletion is ever located by the marker', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(DELETE_BY_MARKER, code), [],
      `${name} could delete records it did not create`);
  }

  /*
   * The one delete this domain plans names a single record. The marker appears
   * only in the prose a person reads before approving it, never in the locator.
   */
  const plan = NT.cleanupPlan({ table: 'incident', sysId: 'a'.repeat(32), marker: '[NOWTEST:task-1]' });
  assert.equal(plan.steps.length, 1);
  const [step] = plan.steps;
  assert.equal(step.tool, 'delete_record');
  assert.equal(step.target.sys_id, 'a'.repeat(32));
  assert.equal(step.inputs.sys_id, 'a'.repeat(32));
  for (const locator of [step.target, step.inputs]) {
    const text = JSON.stringify(locator);
    assert.ok(!/NOWTEST/i.test(text), `the locator carries the marker: ${text}`);
    assert.ok(!/query/i.test(text), `the locator is a query, not a record: ${text}`);
  }
});

test('T10 — the ownership ledger records a sys_id or nothing at all', () => {
  /* The guard is in the source, so an edit that drops it is visible... */
  const fixture = domainCode['fixture.js'];
  assert.ok(/\/\^\[0-9a-f\]\{32\}\$\/i/.test(fixture),
    'claim() must validate a 32-hex sys_id before recording it');

  /* ...and it behaves, so a guard that is present but bypassed is visible too. */
  const owned = NT.ownership();
  for (const bad of [null, undefined, '', 'incident', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 'sys_id', '../..']) {
    assert.equal(owned.claim({ table: 'incident', sys_id: bad }), false, `claim accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(owned.size, 0, 'a rejected claim must leave the ledger empty');

  const real = 'a'.repeat(32);
  assert.equal(owned.claim({ table: 'incident', sys_id: 'A'.repeat(32), marker: '[NOWTEST:t]' }), true);
  assert.equal(owned.claim({ table: 'incident', sys_id: 'A'.repeat(32) }), false, 'the same record twice is one record');
  assert.equal(owned.size, 1);
  assert.deepEqual(owned.outstanding().map((r) => r.sys_id), [real]);
});

/* ================================================================== *
 * T11 — THE MODEL CANNOT DECIDE PASS
 * ================================================================== */

test('T11 — the verdict arithmetic cannot see a model', () => {
  for (const name of ['result.js', 'assertions.js']) {
    const code = domainCode[name];
    for (const [, spec] of specifiersOf({ [name]: domainSource[name] })) {
      assert.ok(!/providers?\//.test(spec), `${name} imports a provider: ${spec}`);
    }
    assert.ok(!/\bchat\b/i.test(code), `${name} mentions a chat turn`);
    assert.ok(!/chatOnce|chatTurn|completion|inference/i.test(code), `${name} reaches a model`);
  }
});

test('T11 — decideResult is a pure function of what was read back', () => {
  const passing = () => ({
    contract: { fixture: { table: 'incident' } },
    coverage: { complete: true, uncovered: [], unobservable: [] },
    fixture: { created: true, sys_id: 'a'.repeat(32), table: 'incident' },
    triggerCheck: { satisfied: true, note: 'The record matches the trigger condition.' },
    execution: {
      found: true, settled: true, state: NT.EXECUTION_STATE_NAMES.COMPLETE, waited_ms: 4000, timeout_ms: 90_000,
    },
    assertions: [{ id: 'a1', type: 'equals', status: 'PASS', actual: 'resolved' }],
    cleanup: { status: NT.CLEANUP.PASS },
    cancelled: false,
  });

  const first = NT.decideResult(passing());
  const second = NT.decideResult(passing());
  assert.equal(first.status, NT.RESULTS.PASS);
  assert.deepEqual(first, second, 'the same evidence must give the same verdict every time');

  /*
   * And there is no back door. A caller — or a model whose prose reached a
   * caller — may hand `decideResult` anything it likes alongside the evidence;
   * the status still comes from the assertion outcomes and nowhere else.
   */
  const failing = {
    ...passing(),
    assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: 'new', expected: 'resolved' }],
    status: NT.RESULTS.PASS,
    verdict: 'PASS',
    model_says: 'this looks fine to me',
    summary: 'PASS',
  };
  assert.equal(NT.decideResult(failing).status, NT.RESULTS.FAIL);

  /* An empty assertion list is the cheapest possible false PASS. */
  assert.equal(NT.decideResult({ ...passing(), assertions: [] }).status, NT.RESULTS.INCONCLUSIVE);
});

/* ================================================================== *
 * T12 — NO SELF-ELEVATION
 * ================================================================== */

test('T12 — agent/test/ cannot ask for a role, an impersonation or an elevation', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SELF_ELEVATION, code), [],
      `${name} touches identity — a test runs as whoever asked for it`);
  }
});

/* ================================================================== *
 * T13 — THE DETECTORS THEMSELVES
 *
 * Every guard above is a regex over source text, and a regex that matches
 * nothing passes forever. Each one is run here against text that breaks the
 * property it defends, and against text that does not.
 * ================================================================== */

test('T13 — every detector in this file fires when its property is broken', () => {
  const fires = (label, detectors, violation) => {
    assert.ok(hits(detectors, violation).length > 0, `${label} does not detect: ${violation}`);
  };
  const silent = (label, detectors, benign) => {
    assert.deepEqual(hits(detectors, benign), [], `${label} false-positives on: ${benign}`);
  };

  /* T1 — the import walker sees every form an edge can take. */
  const smuggled = {
    'x.js': "import { client } from '../../servicenow/client.js';\nexport { q } from '../memory/db.js';\n",
  };
  assert.deepEqual(crossDirectory(smuggled), ['../../servicenow/client.js', '../memory/db.js']);
  assert.notDeepEqual(crossDirectory(smuggled), ['../lint/intent.js', '../lint/rules.js']);
  assert.deepEqual(
    crossDirectory({ 'y.js': "const c = await import('../../servicenow/client.js');\n" }),
    ['../../servicenow/client.js'],
  );
  assert.deepEqual(crossDirectory({ 'z.js': "import { a } from './schemas.js';\n" }), []);

  /* T2 */
  fires('RAW_HTTP', RAW_HTTP, 'const r = await fetch(base + "/api/now/table/incident");');
  fires('RAW_HTTP', RAW_HTTP, "import https from 'node:https'; https.request(opts);");
  fires('RAW_HTTP', RAW_HTTP, 'const { data } = await axios.post(url, body);');
  silent('RAW_HTTP', RAW_HTTP, 'const fetched = await readArtifact(sysId);');

  /* T3 / T4 / T5 */
  fires('SECOND_EXECUTOR', SECOND_EXECUTOR, 'const out = await executeTool("delete_record", inputs);');
  silent('SECOND_EXECUTOR', SECOND_EXECUTOR, 'const out = await run({ taskId, plan });');
  fires('SECOND_VERIFIER', SECOND_VERIFIER, 'const v = await verifyMutation({ descriptor, result });');
  fires('SECOND_VERIFIER', SECOND_VERIFIER, 'const d = diffWrite(before, after);');
  silent('SECOND_VERIFIER', SECOND_VERIFIER, 'const v = evaluate(assertion, cellValue(record, field));');
  for (const bad of [
    'const d = await awaitApprovalDecision(taskId);',
    'resolveApproval(taskId, true);',
    'if (approvePlan(taskId, fingerprint)) run();',
  ]) fires('SECOND_APPROVAL', SECOND_APPROVAL, bad);
  silent('SECOND_APPROVAL', SECOND_APPROVAL, 'const decision = await approve({ taskId, fingerprint, review });');

  /* T6 */
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, 'const ev = buildEvidence(taskId);');
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "getDb().prepare('SELECT 1').get();");
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "db.exec('INSERT INTO nowtest_runs (id) VALUES (?)');");
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "db.exec('CREATE TABLE test_run (id TEXT PRIMARY KEY)');");
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "db.prepare('UPDATE agent_tasks SET metadata_json = ?').run(x);");
  silent('SECOND_EVIDENCE', SECOND_EVIDENCE, 'record?.({ taskId, result });');

  /* T8 */
  fires('OWN_REDACTOR', OWN_REDACTOR, 'function redact(value) { return value; }');
  fires('OWN_REDACTOR', OWN_REDACTOR, 'const SECRET_KEYS = new Set(["pw"]);');
  fires('OWN_REDACTOR', OWN_REDACTOR, 'const looksLikeSecret = /(password|api_key)=\\S+/gi;');
  silent('OWN_REDACTOR', OWN_REDACTOR, 'const marker = /\\[NOWTEST:([^\\]]{1,64})\\]/;');

  /* T9 */
  fires('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, "DISPOSABLE_TABLES['task'] = { table: 'task' };");
  fires('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, "DISPOSABLE_TABLES.change_request = { why: 'it seemed fine' };");
  fires('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, 'Object.assign(DISPOSABLE_TABLES, extra);');
  fires('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, 'delete DISPOSABLE_TABLES.incident;');
  fires('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, "DISPOSABLE_LIST.push('task');");
  silent('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, 'why_disposable: DISPOSABLE_TABLES[trigger.table].why,');
  silent('ALLOWLIST_MUTATION', ALLOWLIST_MUTATION, 'if (DISPOSABLE_TABLES[name] === undefined) return false;');

  /* T10 */
  fires('DELETE_BY_MARKER', DELETE_BY_MARKER, 'await deleteRecords({ table, marker });');
  fires('DELETE_BY_MARKER', DELETE_BY_MARKER, 'await del(table, { query: "short_descriptionLIKE" + marker });');
  fires('DELETE_BY_MARKER', DELETE_BY_MARKER, "tool: 'delete_record', inputs: { table, sysparm_query: markerQuery(marker) }");
  fires('DELETE_BY_MARKER', DELETE_BY_MARKER, "const q = 'short_descriptionLIKE[NOWTEST:'; await remove(table, q);");
  silent('DELETE_BY_MARKER', DELETE_BY_MARKER, "inputs: { table, sys_id: sysId }, tool: 'delete_record',");
  silent('DELETE_BY_MARKER', DELETE_BY_MARKER, 'const built = cleanupPlan({ table: row.table, sysId: row.sys_id, marker: row.marker });');

  /* T12 */
  fires('SELF_ELEVATION', SELF_ELEVATION, "await grantRole(user, 'security_admin');");
  fires('SELF_ELEVATION', SELF_ELEVATION, 'const h = impersonationHeaders(target);');
  fires('SELF_ELEVATION', SELF_ELEVATION, 'if (needsElevation) elevate();');
  silent('SELF_ELEVATION', SELF_ELEVATION, 'const owned = ownership(); owned.claim({ table, sys_id });');
});
