/**
 * PHASE 16 — THE RELEASE BLOCKERS.
 *
 * §33, §55, §60, §63 and the sixteen conditions in §65. The ones this phase
 * introduces are about a linter's particular way of being dangerous: it does
 * not act, so none of the execution gates apply to it, and its whole output is
 * assertions about somebody's production configuration.
 *
 * Which makes the failure mode obvious once stated. A linter cannot delete your
 * data. It can tell you your working flow is broken until you break it trying
 * to fix it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const L = await import('../src/agent/lint/index.js');
const { toolMap } = await import('../src/agent/tools.js');

const LINT_DIR = new URL('../src/agent/lint/', import.meta.url);
const lintFiles = fs.readdirSync(LINT_DIR);
const lintSource = Object.fromEntries(
  lintFiles.map((f) => [f, fs.readFileSync(new URL(f, LINT_DIR), 'utf8')]),
);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ================================================================== *
 * §33 / §65.8-9 — LINT CANNOT MUTATE
 * ================================================================== */

test('§33 the lint domain contains no mutation of any kind', () => {
  for (const [name, src] of Object.entries(lintSource)) {
    const code = stripComments(src);
    for (const forbidden of [
      /table\.(update|create|remove|insert|del)\s*\(/,
      /executeTool/,
      /\bupdate_record\b/,
      /\bcreate_record\b/,
      /\bdelete_record\b/,
      /createLiveFlow|deleteLiveFlow/,
    ]) {
      assert.ok(!forbidden.test(code), `${name} can reach a mutation: ${forbidden}`);
    }
  }
});

test('§33 the lint domain performs no I/O of its own — every answer is injected', () => {
  for (const [name, src] of Object.entries(lintSource)) {
    const code = stripComments(src);
    assert.ok(!/\bfetch\s*\(/.test(code), `${name} performs HTTP`);
    assert.ok(!/getDb\s*\(/.test(code), `${name} reaches the database`);
  }
});

test('§63 the lint domain owns no ServiceNow client, executor, verifier or approval', () => {
  const external = [];
  for (const [name, src] of Object.entries(lintSource)) {
    for (const m of src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)) {
      if (!m[1].startsWith('./')) external.push(`${name} -> ${m[1]}`);
    }
  }
  assert.deepEqual(external.filter((e) => !/node:crypto/.test(e)), [],
    `lint/ must consume injected abstractions, not import them: ${external.join(', ')}`);
});

test('§65.10-12 no second executor, verifier, approval or evidence projection', () => {
  const names = [];
  for (const src of Object.values(lintSource)) {
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.push(m[1]);
  }
  for (const n of names) {
    assert.ok(!/^lint(Executor|Verify|Verifier|Approval|Mutation)/i.test(n), `a parallel system appeared: ${n}`);
    assert.ok(!/^(executePlan|buildEvidence|approvePlan|resolveApproval)$/.test(n), `${n} is redefined in lint/`);
  }
  /* And the originals are still the only ones. */
  const root = new URL('../src/', import.meta.url);
  const found = { buildEvidence: [], executePlan: [] };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(child, 'utf8');
      if (/export\s+function\s+buildEvidence\s*\(/.test(src)) found.buildEvidence.push(entry.name);
      if (/export\s+async\s+function\s+executePlan\s*\(/.test(src)) found.executePlan.push(entry.name);
    }
  };
  walk(root);
  assert.deepEqual(found.buildEvidence, ['builder.js']);
  assert.deepEqual(found.executePlan, ['executor.js']);
});

/* ================================================================== *
 * §30 / §65.3 — THE MODEL IS NOT AN AUTHORITY
 * ================================================================== */

test('§30 no rule consults a model for any of the facts §30 reserves', () => {
  const rules = lintSource['rules.js'];
  const code = stripComments(rules);
  for (const forbidden of [/chatOnce/, /chatTurn/, /\bprompt\b/i, /providers\//]) {
    assert.ok(!forbidden.test(code), `rules.js reaches a model: ${forbidden}`);
  }
});

test('§30 every finding a rule can emit cites a platform source, never an opinion', () => {
  const MODEL_SOURCES = ['model', 'llm', 'inference', 'opinion', 'heuristic'];
  for (const s of L.EVIDENCE_SOURCE_LIST) {
    assert.ok(!MODEL_SOURCES.some((m) => s.includes(m)),
      `"${s}" is not a platform authority and must not be an evidence source`);
  }
});

/* ================================================================== *
 * §39 / §65.6-7 — UNKNOWN IS NEITHER PASS NOR FAIL
 * ================================================================== */

test('§65.6 an UNKNOWN check never becomes a clean result', () => {
  assert.equal(L.summarise([], [{ rule_id: 'FLOW001', reason: 'dictionary unreadable' }], ['FLOW001']).clean, false);
});

test('§65.7 an UNKNOWN check never becomes a finding', () => {
  const s = L.summarise([], [{ rule_id: 'FLOW001', reason: 'unreadable' }], ['FLOW001']);
  assert.equal(s.total, 0, 'an unanswered check is not a problem found');
  assert.equal(s.confirmed, 0);
  assert.equal(s.unknown, 1);
});

test('§39 an UNKNOWN check must say why it could not run', () => {
  assert.equal(L.isUnknownCheck({ rule_id: 'FLOW001', reason: 'the dictionary was unreadable' }), true);
  assert.equal(L.isUnknownCheck({ rule_id: 'FLOW001' }), false, 'a reason is required');
  assert.equal(L.isUnknownCheck({ reason: 'because' }), false);
});

/* ================================================================== *
 * §20 / §65.5 — A PLATFORM LIMITATION IS NOT A FLOW DEFECT
 * ================================================================== */

test('§65.5 platform limitations are a distinct KIND and cannot read as defects', () => {
  assert.ok(L.KIND_LIST.includes('PLATFORM_LIMITATION'));
  assert.ok(L.KIND_LIST.includes('DEFECT'));
  assert.ok(L.KIND_LIST.includes('RISK'));
  assert.ok(L.KIND_LIST.includes('BEST_PRACTICE'));
  assert.notEqual('PLATFORM_LIMITATION', 'DEFECT');
});

/* ================================================================== *
 * §60 / §65.13 — SECRETS
 * ================================================================== */

test('§60 the lint domain defines no redactor of its own', () => {
  for (const [name, src] of Object.entries(lintSource)) {
    assert.ok(!/function\s+redact\b|SECRET_KEYS\s*=|const\s+REDACTED\b/.test(src),
      `${name} defines its own redaction`);
  }
});

test('§60 a credential inside a flow value is redacted by the existing redactor', async () => {
  const { redact } = await import('../src/agent/evidence/redact.js');
  /* A flow input can hold anything a person typed, including this. */
  const finding = L.makeFinding({
    rule_id: 'FLOW005',
    flow_sys_id: 'f'.repeat(32),
    severity: L.SEVERITY.MEDIUM,
    status: L.STATUS.CONFIRMED,
    kind: L.KIND.DEFECT,
    confidence: L.CONFIDENCE.HIGH,
    title: 'Input is not declared',
    description: 'The step supplies connection=host;password=hunter2 which the action does not declare.',
    evidence: [{
      source: L.EVIDENCE_SOURCE.LIVE_FLOW, step: 'Call REST',
      detail: 'value: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 / api_key=sk-live-abc123',
    }],
    affected: { step: 'Call REST', input: 'connection' },
  });
  const cleaned = JSON.stringify(redact(finding));
  for (const secret of ['hunter2', 'eyJhbGciOiJIUzI1NiJ9', 'sk-live-abc123']) {
    assert.ok(!cleaned.includes(secret), `a secret survived redaction: ${secret}`);
  }
  assert.ok(cleaned.includes('Call REST'), 'redaction must not destroy the finding');
});

/* ================================================================== *
 * §57 — ARTIFACT-SCOPED, NEVER AN INSTANCE SCAN
 * ================================================================== */

test('§57 nothing in lint enumerates the instance', () => {
  const code = Object.values(lintSource).map(stripComments).join('\n');
  /* Every read the context performs is keyed to a named table or record. A
   * query with an empty condition would be a scan. */
  assert.ok(!/query\s*\(\s*['"]sys_hub_flow['"]\s*,\s*\{\s*query:\s*['"]{2}/.test(code),
    'lint must not enumerate flows');
  assert.ok(!/limit:\s*(?:[5-9]\d{2,}|\d{4,})/.test(code), 'lint must not request unbounded pages');
});

test('§58 every context read is bounded and cached', () => {
  const idx = stripComments(lintSource['index.js']);
  const limits = [...idx.matchAll(/limit:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(limits.length > 0, 'the context performs reads');
  assert.ok(limits.every((n) => n <= 100), `an unbounded read: ${limits.join(', ')}`);
  for (const cache of ['schemaCache', 'choiceCache', 'tableCache', 'existsCache', 'matchCache']) {
    assert.ok(idx.includes(cache), `${cache} is missing — repeated reads would be unbounded in practice`);
  }
});

/* ================================================================== *
 * §36 — NO AUTO-FIX IN THIS PHASE
 * ================================================================== */

test('§36 autofixable is a label, and nothing in lint acts on it', () => {
  const code = Object.values(lintSource).map(stripComments).join('\n');
  assert.ok(code.includes('autofixable'), 'findings may be labelled fixable');
  /* But nothing branches on it to do anything. */
  assert.ok(!/if\s*\([^)]*autofixable[^)]*\)\s*\{[\s\S]{0,200}?(execute|apply|mutate|create|update)/i.test(code),
    'nothing may act on the autofixable label');
});

/* ================================================================== *
 * The registry is untouched
 * ================================================================== */

test('Phase 16 added no mutating tool', () => {
  const mutating = [...toolMap.values()].filter((t) => t.mutating).map((t) => t.name);
  for (const name of mutating) {
    assert.ok(!/lint/i.test(name), `a mutating lint tool exists: ${name}`);
  }
});

test('§62 the database is unchanged', async () => {
  const { getDb, migrate, _setDbForTests } = await import('../src/memory/db.js');
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os');
  const path = await import('node:path');
  _setDbForTests(migrate(new DatabaseSync(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p16db-')), 'd.db'),
  )));
  assert.equal(Object.values(getDb().prepare('PRAGMA user_version').get())[0], 29);
  const db = fs.readFileSync(new URL('../src/memory/db.js', import.meta.url), 'utf8');
  assert.ok(!/CREATE TABLE[^;]*lint/i.test(db), 'Phase 16 added a lint table');
});
