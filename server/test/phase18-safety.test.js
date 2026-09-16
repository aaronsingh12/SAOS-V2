/**
 * PHASE 18 — WHAT CHANGE INTELLIGENCE CANNOT DO, COUNTED RATHER THAN PROMISED.
 *
 * `agent/change/` answers one question — what is different between two states
 * of a flow, and what could it cost — and the whole design rests on it having
 * no way to do anything else. §32 says analysis is read-only. §59 says it never
 * deploys. §54 says the model does not decide a diff. §63.1 makes an invented
 * baseline a release blocker. Every one of those is a claim about ABSENCE, and
 * absence is the property that rots silently: the module that grows a
 * `deploy()` next spring will still pass every behavioural test in this build,
 * right up to the afternoon it writes to production.
 *
 * So the checks below read the source off disk and count. The pattern is Phase
 * 17's, deliberately: an exact allowlist of every edge that leaves the
 * directory fails on ANY new one, including the edge nobody thought to forbid,
 * where a blocklist only ever catches what its author already imagined.
 *
 * The handful of behavioural checks that follow are the ones a static read
 * cannot make — that a diff run twice is the same diff, that two states whose
 * keys were written in different orders hash the same, that `readState` refuses
 * a source nobody could read again. No instance, no database, no model: every
 * fact here is true on any machine that has the repository.
 *
 * And because a guard nobody has watched fail is a guard nobody has tested, T12
 * runs every detector in this file against text that violates its property AND
 * against real lines from `agent/change/` that must not trip it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CH = await import('../src/agent/change/index.js');

/* ------------------------------------------------------------------ *
 * The corpus
 * ------------------------------------------------------------------ */

const CHANGE_DIR = new URL('../src/agent/change/', import.meta.url);
const domainFiles = fs.readdirSync(CHANGE_DIR).filter((f) => f.endsWith('.js')).sort();
const domainSource = Object.fromEntries(
  domainFiles.map((f) => [f, fs.readFileSync(new URL(f, CHANGE_DIR), 'utf8')]),
);

/*
 * Comments are stripped before every content detector runs, and this directory
 * needs it more than Phase 17's did: `index.js` spends a paragraph explaining
 * that it owns no executor, no verifier and no approval gate and does not
 * deploy, and `intent.js` explains at length where a deployment DOES happen. A
 * detector that fired on the prose describing the rule would have to be
 * weakened to shut it up, which is exactly how a guard stops guarding.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const domainCode = Object.fromEntries(
  Object.entries(domainSource).map(([name, src]) => [name, stripComments(src)]),
);

/** Every line in the domain, trimmed — T12's false-positive corpus. */
const domainLines = new Set(
  Object.values(domainSource).flatMap((src) => src.split(/\r?\n/).map((l) => l.trim())),
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
 * Each is a [name, regex] pair rather than an inline literal, so that T12 can
 * run the SAME object over text that breaks the property. A detector written
 * twice — once for the source and once for its proof — is a detector whose
 * proof does not cover the source.
 * ------------------------------------------------------------------ */

/** Which detectors in a list fire on this text. */
const hits = (detectors, code) => detectors.filter(([, re]) => re.test(code)).map(([name]) => name);

/** Anything that would reach an instance without going through an injected reader. */
const RAW_HTTP = Object.freeze([
  ['fetch(', /\bfetch\s*\(/],
  ['http.', /\bhttp\s*\./],
  ['https.', /\bhttps\s*\./],
  ['axios', /\baxios\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
]);

/*
 * §32 / §59 — the writes.
 *
 * `deploy` is matched only where it is CALLED, and `deployment` is excluded by
 * name. That is not a softening: this domain's entire deployment story is
 * `deploymentHandoff()` returning a sentence for the ordinary planner, so the
 * word is unavoidable in the identifiers that hand it over. What must never
 * appear is `deploy(...)` — the word in the position where it does something.
 */
const MUTATION = Object.freeze([
  ['executeTool', /\bexecuteTool\b/],
  ['executePlan', /\bexecutePlan\b/],
  ['table.create', /\btable\s*\.\s*create\b/],
  ['table.update', /\btable\s*\.\s*update\b/],
  ['table.remove', /\btable\s*\.\s*remove\b/],
  ['create_record', /\bcreate_record\b/],
  ['update_record', /\bupdate_record\b/],
  ['delete_record', /\bdelete_record\b/],
  ['deploy as a call', /\bdeploy(?!ment)\w*\s*\(/i],
]);

const SECOND_APPROVAL = Object.freeze([
  ['awaitApprovalDecision', /\bawaitApprovalDecision\b/],
  ['resolveApproval', /\bresolveApproval\b/],
  ['approvePlan', /\bapprovePlan\b/],
]);

/*
 * SQL. `UPDATE` is matched case-sensitively because "update" is an ordinary
 * word in this domain — `Update Record` is the name of a ServiceNow action and
 * appears in fixtures and in rendered prose. The SQL in `memory/db.js` is
 * uppercase, so the uppercase form is the one that means a statement.
 */
const SQL = Object.freeze([
  ['INSERT INTO', /\binsert\s+into\b/i],
  ['CREATE TABLE', /\bcreate\s+table\b/i],
  ['UPDATE ', /\bUPDATE\s+\w/],
]);

const SECOND_VERIFIER = Object.freeze([
  ['verifyMutation', /\bverifyMutation\b/],
  ['diffWrite', /\bdiffWrite\b/],
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

/*
 * §54 — the model may not decide a diff.
 *
 * Applied to the three files that produce the answer. `index.js` legitimately
 * accepts a `chat` callback and passes it to the Phase 16 resolver that turns a
 * name into a sys_id, which is a question about WHICH artifact and not about
 * what changed inside it — so the boundary is drawn at the arithmetic, where it
 * means something, rather than at the directory, where it would only be a
 * slogan the resolver had to be smuggled past.
 */
const MODEL_IN_THE_PATH = Object.freeze([
  ['a provider path', /providers?\//],
  ['a chat turn', /\bchat\b/i],
  ['a completion', /\bchatOnce\b|\bchatTurn\b|\bcompletion\b|\binference\b/i],
  ['a model or a prompt', /\bllm\b|\bprompt\b|\bmodel\b/i],
]);

/*
 * §3 / §63.1 — a baseline is read, never made.
 *
 * The names below are what a reconstructed "before" would be called. None is
 * hypothetical: every one is the obvious next helper for somebody holding a
 * comparison that stopped at NO_BASELINE and a chat transcript describing what
 * the flow used to do.
 */
const INVENTED_BASELINE = Object.freeze([
  ['fromDescription', /fromDescription/i],
  ['fromModel', /fromModel/i],
  ['fromText', /fromText/i],
  ['fromConversation', /fromConversation/i],
  ['synthes', /synthes/i],
  ['a reconstruction call', /\breconstruct\w*\s*\(/i],
]);

/*
 * §55 — no self-elevation.
 *
 * `security_admin` and `elevat` must not appear at all: this domain has no
 * business naming a role or an escalation in any position whatsoever.
 *
 * `impersonat` is different, and the difference is why the detector is written
 * this way. `diff.js` matches input names beginning `run_as`, `impersonat`,
 * `role` or `acl` in order to CATEGORISE such a change as SECURITY — that is
 * Change Intelligence recognising an authority change, which is the opposite of
 * asking for one. So the detector fires on the word in an ACTING position:
 * called, assigned, or set as a key. T11 additionally counts every occurrence
 * of the bare word, so a second one anywhere is still caught.
 */
const SELF_ELEVATION = Object.freeze([
  ['security_admin', /security_admin/i],
  ['elevat', /elevat/i],
  ['an impersonation in an acting position', /\bimpersonat\w*\s*[(:=]/i],
  ['a role grant', /\b(?:grant|assign|add)Role\w*\s*\(/i],
  ['the role tables', /\bsys_user_(?:has_)?role\b/i],
]);

/*
 * §58 — the collaborators this domain must reach through an injection rather
 * than an import. Checked against every module specifier and never against a
 * file body, so a name that appears in a rendered sentence cannot trip it.
 */
const FORBIDDEN_IMPORT = Object.freeze([
  ['the ServiceNow client', /servicenow\/client\.js/],
  ['the ServiceNow schema layer', /servicenow\/schema\.js/],
  ['anything under servicenow/', /(?:^|['"/])servicenow\//],
  ['a provider', /providers?\//],
  ['the database', /memory\/db\.js/],
  ['anything under memory/', /(?:^|['"/])memory\//],
  ['the plan executor', /plan\/executor\.js/],
]);

/**
 * Every module specifier this directory reaches for: static, dynamic, import
 * and re-export. Re-exports count — `export { x } from '...'` is an import with
 * a different consequence, and half of `index.js` is made of them.
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

/* ------------------------------------------------------------------ *
 * Fixtures
 *
 * One flow, written two ways, in the shape `readFlowArtifact` returns.
 * `shuffled` reverses every collection the platform is free to order however it
 * likes — the action rows, and the input rows within each action — and writes
 * the header's keys in the opposite order, WITHOUT changing a single value.
 * That is precisely the difference §11 says must never be visible.
 *
 * `rowIdentity: 'snapshot'` changes only the fields that describe the ROW —
 * sys_id, status, updated_on — which is the live/snapshot control the instance
 * established: on dev424910, forty flows and their published snapshots differ
 * in exactly those fields and hash identically.
 * ------------------------------------------------------------------ */

const FLOW_NAME = 'Assign software request items';
const FLOW_DESC = 'Routes each requested item to the fulfilment group.';
const LIVE_SYS_ID = 'f'.repeat(32);
const SNAPSHOT_SYS_ID = '9'.repeat(32);

function rawFlow({ shuffled = false, rowIdentity = 'live', triggerKind = 'record_update' } = {}) {
  const order = (list) => (shuffled ? [...list].reverse() : list);

  const lookupInputs = order([
    { name: 'table_name', supplied: 'sc_req_item', display: 'Requested Item', type: 'table', reference: null, is_pill: false, mandatory: true },
    { name: 'conditions', supplied: 'active=true', display: 'Active is true', type: 'conditions', reference: null, is_pill: false, mandatory: false },
  ]);
  const updateInputs = order([
    { name: 'record', supplied: 'a'.repeat(32), display: 'RITM0010001', type: 'reference', reference: 'sc_req_item', is_pill: false, mandatory: true },
    { name: 'values', supplied: 'state=2^assignment_group=network', display: null, type: 'field_values', reference: null, is_pill: false, mandatory: false },
  ]);

  const actions = order([
    { ui_id: 'ui_lookup', parent_ui_id: null, order: 0, type_name: 'Look Up Records', inputs_readable: true, inputs: lookupInputs },
    { ui_id: 'ui_update', parent_ui_id: null, order: 1, type_name: 'Update Record', inputs_readable: true, inputs: updateInputs },
  ]);

  const row = rowIdentity === 'snapshot'
    ? { sys_id: SNAPSHOT_SYS_ID, status: 'snapshot', updated_on: '2026-08-11 17:22:41' }
    : { sys_id: LIVE_SYS_ID, status: 'published', updated_on: '2026-09-01 09:00:00' };

  const flow = shuffled
    ? { type: 'flow', scope: 'global', active: 'true', description: FLOW_DESC, name: FLOW_NAME, ...row }
    : { ...row, name: FLOW_NAME, description: FLOW_DESC, active: 'true', type: 'flow', scope: 'global' };

  return {
    flow,
    triggers: [{
      type: triggerKind,
      table: 'sc_req_item',
      condition_query: 'active=true^state=1',
      strategy: 'once',
      table_label: 'Requested Item',
    }],
    actions,
    gaps: [],
  };
}

const PROVENANCE = { source: CH.SOURCES.LIVE, read_at: '2026-09-07T00:00:00Z' };
const normalized = (opts = {}, provenance = PROVENANCE) => CH.normalizeFlow(rawFlow(opts), provenance);

/* ================================================================== *
 * T1 — §58 NO SERVICENOW ACCESS, NO DATABASE, NO PROVIDER, NO EXECUTOR
 * ================================================================== */

test('T1 — the whole import graph of agent/change/ is five reused pieces and one hash', () => {
  /*
   * The strong form of this check is not a blocklist. A blocklist has to
   * anticipate the import somebody adds next year. An exact allowlist of every
   * specifier that leaves the directory fails on ANY new edge:
   *
   *   ../lint/schemas.js   the STATUS/SEVERITY vocabulary, so that a change
   *                        finding and a lint finding sort by the same rule
   *   ../lint/index.js     the DESTRUCTIVE pattern, reused rather than copied
   *   ../lint/intent.js    the flow resolver, so two phases cannot disagree
   *                        about which flow a request names
   *   ../test/trigger.js   Phase 17's encoded-query parser, for §15
   *   ../evidence/redact.js  the EXISTING secret-key list. §57 forbids a
   *                        second redactor, so a credential in a flow input is
   *                        masked using the list the rest of the build already
   *                        uses rather than one this domain invented.
   *   node:crypto          sha256, and nothing else
   *
   * Every ServiceNow read, every persisted byte and every model turn arrives as
   * an injected function instead — which is why this list is this short.
   */
  assert.deepEqual(crossDirectory(domainSource), [
    '../evidence/redact.js',
    '../lint/index.js',
    '../lint/intent.js',
    '../lint/schemas.js',
    '../test/trigger.js',
    'node:crypto',
  ]);

  /* And the directory is the nine modules it is supposed to be. A tenth that
   * nobody discussed is a boundary decision made by accident. */
  assert.deepEqual(domainFiles, [
    'baseline.js', 'diff.js', 'impact.js', 'index.js', 'intent.js',
    'normalize.js', 'render.js', 'schemas.js', 'significance.js',
  ]);
});

test('T1 — and the specific things §58 forbids are absent by name', () => {
  for (const [name, src] of Object.entries(domainSource)) {
    for (const [, spec] of specifiersOf({ [name]: src })) {
      assert.deepEqual(hits(FORBIDDEN_IMPORT, spec), [], `${name} imports ${spec}`);
    }
  }
});

/* ================================================================== *
 * T2 — NO RAW HTTP
 * ================================================================== */

test('T2 — nothing under agent/change/ can reach an instance on its own', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(RAW_HTTP, code), [], `${name} performs its own HTTP`);
  }
});

/* ================================================================== *
 * T3 — §32 / §59 NO MUTATION AT ALL
 * ================================================================== */

test('T3 — the domain has no capacity to write, to deploy, or to approve', () => {
  /*
   * §32 is "analysis is read-only" and §59 is "never directly deploy", and
   * neither is enforced here as a policy the code follows. There is simply no
   * call anywhere in the directory that could change anything: no executor, no
   * table verb, no record verb, no deploy, no approval primitive. The strongest
   * form of a rule is one you could not break.
   */
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(MUTATION, code), [], `${name} can change something`);
    assert.deepEqual(hits(SECOND_APPROVAL, code), [], `${name} reaches into the approval engine`);
  }
});

test('T3 — a deployment leaves this domain as a sentence, not as a plan', () => {
  /*
   * The absence above is a design rather than an oversight only because the
   * alternative is present and works: a request to deploy produces a GOAL for
   * the planner everything else already goes through. A string cannot execute.
   */
  const comparison = {
    artifact: { type: 'flow', name: FLOW_NAME },
    summary: { total: 2, trigger_changes: 1, behavioral_changes: 1, dependency_changes: 0 },
    complete: true,
    stopped: null,
    risk: CH.RISK.HIGH,
    current: { version: { id: 'abc123abc123' } },
    baseline: { version: { id: 'def456def456' } },
  };

  const handoff = CH.deploymentHandoff(comparison);
  assert.equal(handoff.available, true);
  assert.deepEqual(Object.keys(handoff).sort(), ['available', 'goal', 'note']);
  assert.equal(typeof handoff.goal, 'string');
  assert.ok(handoff.goal.includes(FLOW_NAME));
  assert.match(handoff.note, /does not deploy/);

  /* §33 — and it refuses to describe a change it does not know. */
  assert.throws(() => CH.deploymentGoal({ ...comparison, complete: false }), /complete comparison/);
  assert.throws(() => CH.deploymentGoal({ ...comparison, summary: { total: 0 } }), /nothing to deploy/);
  assert.equal(CH.deploymentHandoff({ ...comparison, complete: false }).goal, null);
});

/* ================================================================== *
 * T4 — NO SECOND EXECUTOR, VERIFIER OR EVIDENCE STORE
 * ================================================================== */

test('T4 — each of the three exists exactly once in src/, and none of them under change/', () => {
  const executors = definers(/export\s+async\s+function\s+executePlan\s*\(/);
  const verifiers = definers(/export\s+async\s+function\s+verifyMutation\s*\(/);
  const evidence = definers(/export\s+function\s+buildEvidence\s*\(/);

  assert.deepEqual(executors, ['agent/plan/executor.js']);
  assert.deepEqual(verifiers, ['agent/mutation-pipeline.js']);
  assert.deepEqual(evidence, ['agent/evidence/builder.js']);

  for (const rel of [...executors, ...verifiers, ...evidence]) {
    assert.ok(!rel.startsWith('agent/change/'), `${rel} defines a second one inside the change domain`);
  }

  /* And no module here names them, persists anything, or writes SQL: a
   * comparison lives on the task record the plan store already owns. */
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SECOND_VERIFIER, code), [],
      `${name} names the verifier — read-back belongs to the mutation pipeline`);
    assert.deepEqual(hits(SECOND_EVIDENCE, code), [],
      `${name} persists or projects evidence of its own`);
  }
});

/* ================================================================== *
 * T5 — NO NEW MIGRATION
 * ================================================================== */

test('T5 — the database is unchanged: user_version is still 28 and no table knows about diffs', async () => {
  /*
   * The technique Phase 16 and Phase 17 used: build a database from the REAL
   * migration list and ask it what version it reached. `user_version` is set to
   * the index of the last migration that ran, so this counts them too — a 24th
   * migration cannot be appended without moving this number.
   *
   * Phase 18 stores a comparison and a captured baseline on the existing
   * `agent_tasks.metadata_json`, which is why there is nothing to migrate.
   */
  const { getDb, migrate, _setDbForTests } = await import('../src/memory/db.js');
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os');
  const path = await import('node:path');
  _setDbForTests(migrate(new DatabaseSync(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p18db-')), 'd.db'),
  )));
  assert.equal(Object.values(getDb().prepare('PRAGMA user_version').get())[0], 28);

  const db = fs.readFileSync(new URL('../src/memory/db.js', import.meta.url), 'utf8');
  assert.ok(!/\bbaseline\b/i.test(db), 'a migration mentions a baseline');
  assert.ok(!/\bdiffs?\b/i.test(db), 'a migration mentions a diff');
  assert.ok(!/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?\w*(?:change|diff|baseline)\w*/i.test(db),
    'Phase 18 added a table');

  /* The plan store gained three functions and no schema. */
  const store = fs.readFileSync(new URL('../src/agent/plan/store.js', import.meta.url), 'utf8');
  assert.ok(!/\b(?:CREATE TABLE|ALTER TABLE|CREATE INDEX)\b/i.test(store),
    'the plan store issues DDL of its own');
  for (const fn of ['recordChange', 'loadChange', 'loadCapturedBaseline']) {
    assert.ok(new RegExp(`export function ${fn}\\s*\\(`).test(store), `${fn} is missing from the plan store`);
  }
});

/* ================================================================== *
 * T6 — §57 NO NEW REDACTOR
 * ================================================================== */

test('T6 — agent/change/ defines no redactor and knows nothing about what a secret looks like', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(OWN_REDACTOR, code), [],
      `${name} redacts on its own — secrets belong to the evidence boundary`);
  }
});

/* ================================================================== *
 * T7 — §54 THE MODEL CANNOT DECIDE A DIFF
 * ================================================================== */

test('T7 — the three files that produce the answer cannot see a model', () => {
  for (const name of ['diff.js', 'normalize.js', 'significance.js']) {
    assert.deepEqual(hits(MODEL_IN_THE_PATH, domainCode[name]), [],
      `${name} can reach a model — a diff is arithmetic`);
    for (const [, spec] of specifiersOf({ [name]: domainSource[name] })) {
      assert.ok(!/providers?\//.test(spec), `${name} imports a provider: ${spec}`);
    }
  }
});

test('T7 — diffFlows is a pure function of the two states it was handed', () => {
  const before = normalized();
  const after = normalized({ triggerKind: 'record_create' });
  const beforeCopy = structuredClone(before);
  const afterCopy = structuredClone(after);

  const first = CH.diffFlows(before, after);
  const second = CH.diffFlows(before, after);

  /* Not vacuous: there IS something here to get wrong. */
  assert.ok(first.changes.length > 0, 'the fixtures must actually differ');
  assert.deepEqual(first.changes.map((c) => c.path), ['trigger.kind']);
  assert.deepEqual(first, second, 'the same two states must give the same diff every time');

  /* And nothing was consumed on the way through. */
  assert.deepEqual(before, beforeCopy, 'diffFlows mutated the baseline it was given');
  assert.deepEqual(after, afterCopy, 'diffFlows mutated the current state it was given');
});

/* ================================================================== *
 * T8 — §11 DETERMINISM
 * ================================================================== */

test('T8 — key order is not content: the same flow written two ways hashes the same', () => {
  const straight = normalized({}, PROVENANCE);
  const shuffled = normalized(
    { shuffled: true },
    { source: CH.SOURCES.CAPTURED_ARTIFACT, read_at: '2019-01-01T00:00:00Z' },
  );

  /* The two really were built differently... */
  assert.notDeepEqual(
    Object.keys(rawFlow().flow),
    Object.keys(rawFlow({ shuffled: true }).flow),
    'the fixture must actually reorder something',
  );

  /* ...and normalisation makes them one artifact. The provenance differs and is
   * excluded from the hash, which is §30's rule and the reason a captured
   * baseline can be compared against a live read at all. */
  assert.equal(CH.hashArtifact(straight), CH.hashArtifact(shuffled));
  assert.equal(CH.canonicalString(straight), CH.canonicalString(shuffled));
  assert.deepEqual(CH.diffFlows(straight, shuffled).changes, []);
  assert.equal(CH.diffFlows(straight, shuffled).complete, true);

  /*
   * The live/snapshot control, in a unit test. On dev424910 a flow and its
   * published snapshot differ in the flow's sys_id, its status and its
   * timestamps and in nothing else — and they hash identically. A hash that
   * moved here would report every published flow on the instance as changed.
   */
  const snapshot = normalized({ rowIdentity: 'snapshot' });
  assert.notEqual(straight.artifact.sys_id, snapshot.artifact.sys_id);
  assert.notEqual(straight.artifact.status, snapshot.artifact.status);
  assert.equal(CH.hashArtifact(straight), CH.hashArtifact(snapshot));
  assert.deepEqual(CH.diffFlows(straight, snapshot).changes, []);

  /* A hash is not a constant: something semantic still moves it. */
  assert.notEqual(CH.hashArtifact(straight), CH.hashArtifact(normalized({ triggerKind: 'record_create' })));
});

/* ================================================================== *
 * T9 — §24 / §63.6 THE RISK TABLE IS DATA, NOT OPINION
 * ================================================================== */

test('T9 — risk is a frozen table and a frozen rule list, not a view', () => {
  assert.ok(Object.isFrozen(CH.CATEGORY_RISK), 'the category table must be frozen');
  assert.throws(() => { CH.CATEGORY_RISK[CH.CATEGORIES.COSMETIC] = CH.RISK.CRITICAL; }, TypeError);

  /* Every category has a row, so nothing falls through the table by accident,
   * and every value is a member of the vocabulary rather than a number. */
  assert.deepEqual([...Object.keys(CH.CATEGORY_RISK)].sort(), [...CH.CATEGORY_LIST].sort());
  for (const [category, risk] of Object.entries(CH.CATEGORY_RISK)) {
    assert.ok(Object.values(CH.RISK).includes(risk), `${category} maps to ${risk}, which is not a risk`);
  }

  /*
   * The path rules are not exported — `riskOf` is the only way to reach them —
   * so they are checked in the source. What matters is that each is a LITERAL:
   * an id, a risk named from the enum, and a sentence a person can argue with.
   */
  const sig = domainCode['significance.js'];
  assert.ok(/const RULES = Object\.freeze\(\[/.test(sig), 'the rule list must be a frozen literal');
  const block = sig.slice(sig.indexOf('const RULES = Object.freeze(['), sig.indexOf('export function riskOf'));
  const ids = [...block.matchAll(/\bid: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 14, 'the rule count changed — read the new rule before moving this number');
  /* 14 since `flow_renamed` was added: a rename does not change what the flow
   * does and can stop everything that calls it by name from reaching it. */

  /*
   * DEEP, not shallow. `Object.freeze` on the array left every rule object
   * writable, so a caller could have rewritten a risk in place and the table
   * would still have looked frozen. The rules are module-private, so this is a
   * source assertion — which is also the only place the hole was visible.
   */
  assert.match(sig, /\]\.map\(Object\.freeze\)\)/,
    'the rule objects are no longer deep-frozen; RULES[0].risk = ... would silently succeed');
  assert.equal(new Set(ids).size, ids.length, 'two rules share an id');
  assert.equal([...block.matchAll(/\brisk: RISK\.[A-Z]+/g)].length, ids.length,
    'every rule must name its risk from the enum, as a literal');
  assert.equal([...block.matchAll(/\bwhy: /g)].length, ids.length,
    'every rule must say why — a risk nobody can check is an opinion');
  for (const [label, re] of [['an await', /\bawait\b/], ['randomness', /Math\.random/], ['a clock', /\bDate\b/]]) {
    assert.ok(!re.test(block), `the rule list contains ${label}`);
  }
});

test('T9 — riskOf is pure, and nothing a caller supplies can move it', () => {
  const triggerChange = Object.freeze({
    kind: CH.KINDS.CHANGED,
    path: 'trigger.kind',
    element: CH.ELEMENTS.TRIGGER,
    categories: Object.freeze([CH.CATEGORIES.TRIGGER, CH.CATEGORIES.BEHAVIORAL]),
    status: CH.STATUS.CONFIRMED,
  });

  /* A frozen input is half the check: a function that wrote to it would throw. */
  const first = CH.riskOf(triggerChange);
  assert.deepEqual(CH.riskOf(triggerChange), first, 'the same change must give the same risk every time');
  assert.equal(first.risk, CH.RISK.HIGH);
  assert.equal(first.rule, 'trigger_kind');
  assert.ok(first.why.length > 20, 'a risk must come with its reason');

  /*
   * The back door §63.6 exists to close. A caller — or a model whose prose
   * reached a caller — may hand `riskOf` a risk it likes alongside the change;
   * the answer still comes from the table and nowhere else.
   */
  const cosmetic = {
    kind: CH.KINDS.CHANGED,
    path: 'header.description',
    element: CH.ELEMENTS.HEADER,
    categories: [CH.CATEGORIES.COSMETIC],
    status: CH.STATUS.CONFIRMED,
    risk: CH.RISK.CRITICAL,
    rule: 'the model thought so',
    why: 'this looks dangerous to me',
  };
  assert.equal(CH.riskOf(cosmetic).risk, CH.RISK.LOW);
  assert.equal(CH.assess([cosmetic])[0].risk, CH.RISK.LOW);

  /* §24 — a shape no rule recognises is UNKNOWN, never LOW. "Nothing here
   * recognises it" and "it is harmless" are different answers. */
  const unrecognised = CH.riskOf({
    kind: CH.KINDS.CHANGED, path: 'something.new', element: 'nothing_known',
    categories: [], status: CH.STATUS.CONFIRMED,
  });
  assert.equal(unrecognised.risk, CH.RISK.UNKNOWN);
  assert.equal(unrecognised.rule, 'unrecognised');
});

/* ================================================================== *
 * T10 — §3 / §63.1 NO INVENTED BASELINE
 * ================================================================== */

test('T10 — nothing here can build a state out of text', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(INVENTED_BASELINE, code), [],
      `${name} can manufacture a "before" — a baseline must be readable again`);
  }

  /* baseline.js exports five functions, and every one of them either reads a
   * state, stores one that was read, or checks that a stored one still says
   * what it said. None of them makes one. */
  const exported = [...domainCode['baseline.js'].matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
    .map((m) => m[1]).sort();
  assert.deepEqual(exported, [
    'baselineIsIntact', 'captureBaseline', 'findBaseline', 'readState', 'restoreBaseline',
  ]);
});

test('T10 — readState refuses a source nobody could read again, before it reads anything', async () => {
  let reads = 0;
  const readArtifact = async () => { reads += 1; return rawFlow(); };

  for (const invented of ['THE_USER_DESCRIBED_IT', 'MODEL', 'CHAT', 'RECONSTRUCTED', 'live', '', null, undefined]) {
    await assert.rejects(
      () => CH.readState({ sysId: LIVE_SYS_ID, source: invented, readArtifact }),
      /is not a baseline source this build has/,
      `readState accepted the source ${JSON.stringify(invented)}`,
    );
  }
  assert.equal(reads, 0, 'the source must be checked BEFORE anything is read');

  /* And every source that IS real works, keeping the provenance the caller
   * stated rather than one inferred from the content. */
  for (const source of CH.SOURCE_LIST) {
    const state = await CH.readState({ sysId: LIVE_SYS_ID, source, readArtifact });
    assert.equal(state.ok, true, `${source} should be readable`);
    assert.equal(state.source, source);
  }
  assert.equal(reads, CH.SOURCE_LIST.length);

  /* §4 — with no snapshot and nothing captured, the answer is NO_BASELINE.
   * There is deliberately no fourth branch that reconstructs one. */
  const none = await CH.findBaseline({
    flowSysId: LIVE_SYS_ID, findSnapshot: async () => [], captured: async () => null, readArtifact,
  });
  assert.equal(none.ok, false);
  assert.equal(none.reason, CH.STOPS.NO_BASELINE);
  assert.match(none.note, /will not be reconstructed/);
});

/* ================================================================== *
 * T11 — §55 NO SELF-ELEVATION
 * ================================================================== */

test('T11 — agent/change/ cannot ask for a role, an impersonation or an elevation', () => {
  for (const [name, code] of Object.entries(domainCode)) {
    assert.deepEqual(hits(SELF_ELEVATION, code), [],
      `${name} touches identity — a comparison runs as whoever asked for it`);
  }

  /*
   * The one legitimate mention, counted rather than waved through. `diff.js`
   * names `impersonat` inside the pattern that CATEGORISES an input change as
   * SECURITY, which is this domain recognising an authority change rather than
   * requesting one. It occurs exactly once in the whole directory; a second
   * occurrence anywhere is a new fact somebody has to read.
   */
  const mentions = Object.entries(domainCode)
    .flatMap(([name, code]) => [...code.matchAll(/impersonat/gi)].map(() => name));
  assert.deepEqual(mentions, ['diff.js']);
  assert.ok(
    domainLines.has('if (/^(run_as|impersonat|roles?|acl)/i.test(name)) out.push(CATEGORIES.SECURITY);'),
    'the one mention is no longer the SECURITY classifier — re-read it',
  );
});

/* ================================================================== *
 * T12 — THE DETECTORS THEMSELVES
 *
 * Every guard above is a regex over source text, and a regex that matches
 * nothing passes forever. Each is run here against text that breaks the
 * property it defends, and against text that does not — including real lines
 * lifted from agent/change/, which are asserted to still be in the source so
 * that a stale proof announces itself instead of quietly passing.
 * ================================================================== */

test('T12 — every detector in this file fires when its property is broken, and not before', () => {
  const fires = (label, detectors, violation) => {
    assert.ok(hits(detectors, violation).length > 0, `${label} does not detect: ${violation}`);
  };
  const silent = (label, detectors, benign) => {
    assert.deepEqual(hits(detectors, benign), [], `${label} false-positives on: ${benign}`);
  };
  /** A benign line that is REALLY in the domain, so the proof cannot go stale. */
  const real = (line) => {
    assert.ok(domainLines.has(line), `this proof cites a line no longer in agent/change/: ${line}`);
    return line;
  };

  /* T1 — the import walker sees every form an edge can take. */
  const smuggled = {
    'x.js': "import { client } from '../../servicenow/client.js';\nexport { getDb } from '../memory/db.js';\n",
  };
  assert.deepEqual(crossDirectory(smuggled), ['../../servicenow/client.js', '../memory/db.js']);
  assert.notDeepEqual(crossDirectory(smuggled), crossDirectory(domainSource));
  assert.deepEqual(
    crossDirectory({ 'y.js': "const p = await import('../providers/index.js');\n" }),
    ['../providers/index.js'],
  );
  assert.deepEqual(crossDirectory({ 'z.js': "import { KINDS } from './schemas.js';\n" }), []);

  for (const spec of [
    '../../servicenow/client.js', '../../servicenow/schema.js', '../../servicenow/flows.js',
    '../memory/db.js', '../memory/sessions.js', '../providers/index.js', '../plan/executor.js',
  ]) fires('FORBIDDEN_IMPORT', FORBIDDEN_IMPORT, spec);
  for (const spec of [
    '../evidence/redact.js',
    '../lint/index.js', '../lint/intent.js', '../lint/schemas.js', '../test/trigger.js',
    './schemas.js', './normalize.js', 'node:crypto',
  ]) silent('FORBIDDEN_IMPORT', FORBIDDEN_IMPORT, spec);

  /* T2 */
  fires('RAW_HTTP', RAW_HTTP, 'const r = await fetch(base + "/api/now/table/sys_hub_flow");');
  fires('RAW_HTTP', RAW_HTTP, "import https from 'node:https'; https.request(opts);");
  fires('RAW_HTTP', RAW_HTTP, 'const { data } = await axios.get(url);');
  fires('RAW_HTTP', RAW_HTTP, 'const x = new XMLHttpRequest();');
  silent('RAW_HTTP', RAW_HTTP, real('const raw = diffFlows(baseline.normalized, current.normalized);'));

  /* T3 — the mutations, and the four ways `deploy` legitimately appears here. */
  fires('MUTATION', MUTATION, 'const out = await executeTool("update_record", inputs);');
  fires('MUTATION', MUTATION, 'const done = await executePlan({ taskId, plan });');
  fires('MUTATION', MUTATION, 'await table.update(sysId, { active: false });');
  fires('MUTATION', MUTATION, "await table.create('sys_hub_flow', body);");
  fires('MUTATION', MUTATION, 'await table.remove(sysId);');
  fires('MUTATION', MUTATION, "steps.push({ tool: 'delete_record', inputs });");
  fires('MUTATION', MUTATION, "steps.push({ tool: 'create_record', inputs });");
  fires('MUTATION', MUTATION, 'await deploy(comparison);');
  fires('MUTATION', MUTATION, 'await deployFlow(sysId, snapshot);');
  fires('MUTATION', MUTATION, 'return deployToInstance(payload);');
  silent('MUTATION', MUTATION, real('comparison.deployment = deploymentHandoff(comparison);'));
  silent('MUTATION', MUTATION, real('export function deploymentGoal(comparison) {'));
  silent('MUTATION', MUTATION, real('if (WANTS_DEPLOY.test(text)) return MODES.PREPARE_DEPLOYMENT;'));
  silent('MUTATION', MUTATION, real("L.push('No changes have been deployed.');"));
  silent('MUTATION', MUTATION,
    real("if (name === 'values' || name === 'table_name' || name === 'table' || name === 'record') out.push(CATEGORIES.DATA);"));

  for (const bad of [
    'const d = await awaitApprovalDecision(taskId);',
    'resolveApproval(taskId, true);',
    'if (approvePlan(taskId, fingerprint)) run();',
  ]) fires('SECOND_APPROVAL', SECOND_APPROVAL, bad);
  silent('SECOND_APPROVAL', SECOND_APPROVAL,
    "note: 'the ordinary planner, which builds it, waits for your approval, and reads the result back.',");

  /* T4 */
  fires('SECOND_VERIFIER', SECOND_VERIFIER, 'const v = await verifyMutation({ descriptor, result });');
  fires('SECOND_VERIFIER', SECOND_VERIFIER, 'const d = diffWrite(before, after);');
  silent('SECOND_VERIFIER', SECOND_VERIFIER, real('const raw = diffFlows(baseline.normalized, current.normalized);'));
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, 'const ev = buildEvidence(taskId);');
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "getDb().prepare('SELECT 1').get();");
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "db.exec('INSERT INTO change_runs (id) VALUES (?)');");
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "db.exec('CREATE TABLE change_baselines (id TEXT PRIMARY KEY)');");
  fires('SECOND_EVIDENCE', SECOND_EVIDENCE, "db.prepare('UPDATE agent_tasks SET metadata_json = ?').run(x);");
  silent('SECOND_EVIDENCE', SECOND_EVIDENCE, real("if (typeof record === 'function') record(taskId, comparison);"));
  silent('SECOND_EVIDENCE', SECOND_EVIDENCE, "type_name: 'Update Record', order: 2,");

  /* T6 */
  fires('OWN_REDACTOR', OWN_REDACTOR, 'function redact(value) { return value; }');
  fires('OWN_REDACTOR', OWN_REDACTOR, 'const SECRET_KEYS = new Set(["pw"]);');
  fires('OWN_REDACTOR', OWN_REDACTOR, 'const looksLikeSecret = /(password|api_key)=\\S+/gi;');
  silent('OWN_REDACTOR', OWN_REDACTOR, real('const SYS_ID_RE = /^[0-9a-f]{32}$/i;'));
  silent('OWN_REDACTOR', OWN_REDACTOR, real('const SYS_ID = /\\b([0-9a-f]{32})\\b/i;'));

  /* T7 */
  fires('MODEL_IN_THE_PATH', MODEL_IN_THE_PATH, "import { chat } from '../providers/index.js';");
  fires('MODEL_IN_THE_PATH', MODEL_IN_THE_PATH, 'const verdict = await chatOnce({ system, messages });');
  fires('MODEL_IN_THE_PATH', MODEL_IN_THE_PATH, 'const risk = await askModel(prompt);');
  silent('MODEL_IN_THE_PATH', MODEL_IN_THE_PATH, real('const b = bById.get(s.id);'));
  silent('MODEL_IN_THE_PATH', MODEL_IN_THE_PATH,
    real('const highest = floors.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a));'));

  /* T10 */
  fires('INVENTED_BASELINE', INVENTED_BASELINE, 'export function baselineFromDescription(text) { return parse(text); }');
  fires('INVENTED_BASELINE', INVENTED_BASELINE, 'const prior = await fromModel(transcript);');
  fires('INVENTED_BASELINE', INVENTED_BASELINE, 'const state = fromText(userDescription);');
  fires('INVENTED_BASELINE', INVENTED_BASELINE, 'const guess = synthesiseBaseline(flow);');
  fires('INVENTED_BASELINE', INVENTED_BASELINE, 'return reconstructBaseline(flow, history);');
  silent('INVENTED_BASELINE', INVENTED_BASELINE, real('export function restoreBaseline(record) {'));
  silent('INVENTED_BASELINE', INVENTED_BASELINE, real('const hash = hashArtifact(normalized);'));

  /* T11 */
  fires('SELF_ELEVATION', SELF_ELEVATION, "await grantRole(user, 'security_admin');");
  fires('SELF_ELEVATION', SELF_ELEVATION, 'const headers = { impersonate: target };');
  fires('SELF_ELEVATION', SELF_ELEVATION, 'const h = impersonationHeaders(target);');
  fires('SELF_ELEVATION', SELF_ELEVATION, 'if (needsElevation) elevate();');
  fires('SELF_ELEVATION', SELF_ELEVATION, "await client.read('sys_user_has_role', { user });");
  silent('SELF_ELEVATION', SELF_ELEVATION,
    real('if (/^(run_as|impersonat|roles?|acl)/i.test(name)) out.push(CATEGORIES.SECURITY);'));
});
