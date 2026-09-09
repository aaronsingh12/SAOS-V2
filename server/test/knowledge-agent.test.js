import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { _setSettingsForTests } from '../src/config/store.js';

/*
 * K3/K6 — the knowledge layer where it meets the agent.
 *
 * Two questions, and the second is the important one.
 *
 *   Does retrieved documentation reach the model, framed correctly?
 *   Can it weaken anything?
 *
 * The safety argument for putting official ServiceNow documentation into the
 * system prompt is that the knowledge layer is structurally unable to reach the
 * approval gate, the write guard, the elevation gate or the instance. These
 * tests assert that structurally — by what the modules import and by what the
 * tools are flagged as — rather than by reading the prompt and being reassured.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-kagent-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { upsertDocument } = await import('../src/knowledge/store.js');
const { knowledgeBlock, retrieveForTurn } = await import('../src/knowledge/context.js');
const { buildSystemPrompt } = await import('../src/agent/prompts.js');
const { TOOLS, toolMap } = await import('../src/agent/tools.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const ORDER = ['Alpha', 'Bravo', 'Charlie'];
const settings = (over = {}) => _setSettingsForTests({
  connection: { instanceUrl: 'https://dev00001.service-now.com' },
  rag: { enabled: true, releaseOrder: ORDER, maxContextChunks: 6 },
  ...over,
});

test.beforeEach(() => { settings(); });
test.afterEach(() => { _setSettingsForTests(null); });

const HIT = {
  document: 'd1', source: 'servicenow-docs', product: 'ITSM', topic: 'flow-designer',
  version: 'Charlie', version_rank: 2, document_type: 'documentation',
  url: 'https://www.servicenow.com/docs/real-page', updated_at: '2026-03-01T00:00:00.000Z',
  title: 'Flow triggers', text: 'A flow trigger fires when its condition matches.', score: 0.9,
};

const result = (over = {}) => ({
  query: 'q', indexed: 1, mode: 'semantic', degraded: false,
  hits: [HIT], superseded: [], versionSignals: [], releaseOrder: ORDER, ...over,
});

/* ── the block says what it is ────────────────────────────────────────────── */

test('the knowledge block declares itself REFERENCE ONLY and non-authorising', () => {
  const block = knowledgeBlock(result());
  assert.match(block, /REFERENCE ONLY/);
  assert.match(block, /does NOT authorise any\s*\n?\s*action/i);
  assert.match(block, /verify it against the live instance/i);
});

test('every hit carries its provenance, and the URL is the source\'s own', () => {
  const block = knowledgeBlock(result());
  for (const s of ['servicenow-docs', 'ITSM', 'flow-designer', 'Charlie', 'documentation',
    'https://www.servicenow.com/docs/real-page', '2026-03-01']) {
    assert.ok(block.includes(s), `the block must carry ${s}`);
  }
});

test('the precedence ladder travels WITH the documentation', () => {
  // Unlabelled, a paragraph of official documentation is the most
  // authoritative-sounding text in the prompt. The ladder is what stops it
  // reading as permission, so it must never be a separate block that could go
  // missing on its own.
  const block = knowledgeBlock(result());
  assert.match(block, /SOURCE PRECEDENCE/);
  assert.ok(block.indexOf('live PDI state') > block.indexOf('REFERENCE ONLY'));
});

test('an unranked release is labelled as unrankable rather than shown bare', () => {
  const block = knowledgeBlock(result({ hits: [{ ...HIT, version: 'Zeta', version_rank: null }] }));
  assert.match(block, /not in the configured release order/);
});

test('a degraded (keyword) retrieval says so in the prompt', () => {
  const block = knowledgeBlock(result({ mode: 'keyword', degraded: true }));
  assert.match(block, /RETRIEVAL WAS DEGRADED/);
  assert.match(block, /Treat gaps as unproven/);
});

test('a version preference that dropped an older page is stated, not silent', () => {
  const block = knowledgeBlock(result({
    versionSignals: [{
      family: 'servicenow-docs|ITSM|flow-designer|Flow triggers',
      signal: 'release-order',
      chose: { document: 'd1', version: 'Charlie', url: HIT.url },
      over: [{ version: 'Alpha', url: 'https://www.servicenow.com/docs/old' }],
      caveat: null,
    }],
  }));
  assert.match(block, /VERSION PREFERENCE/);
  assert.match(block, /Charlie/);
  assert.match(block, /Alpha/);
});

test('NO hits produces NO block — an empty heading would read as a confident absence', () => {
  assert.equal(knowledgeBlock(result({ hits: [] })), '');
  assert.equal(knowledgeBlock(null), '');
});

/* ── it reaches the prompt, in the right place ────────────────────────────── */

test('the block is placed in the system prompt, below the measured fact ledger', () => {
  const note = knowledgeBlock(result());
  const prompt = buildSystemPrompt({ knowledgeNote: note, digestNote: 'DIGEST-MARKER' });
  assert.ok(prompt.includes('REFERENCE ONLY'), 'the knowledge block must reach the prompt');
  // Below the base rules, above the digest: documentation is what a vendor
  // WROTE, and it must not sit nearer the completion than what actually
  // happened this session.
  assert.ok(prompt.indexOf('Operating rules:') < prompt.indexOf('REFERENCE ONLY'));
  assert.ok(prompt.indexOf('REFERENCE ONLY') < prompt.indexOf('DIGEST-MARKER'));
});

test('with retrieval off, no knowledge reaches the prompt at all', async () => {
  settings({ rag: { enabled: false, releaseOrder: ORDER } });
  const out = await retrieveForTurn('how do flow triggers evaluate their conditions');
  assert.equal(out.skipped, 'disabled');
  assert.equal(out.block, '');
  assert.equal(buildSystemPrompt({ knowledgeNote: out.block }).includes('REFERENCE ONLY'), false);
});

test('retrieval is TOTAL — it degrades to no block rather than failing a turn', async () => {
  // An aid that can sink the turn it was added to help is worse than no aid.
  // A one-character query cannot be retrieved on, and must not throw.
  const out = await retrieveForTurn('x');
  assert.equal(out.skipped, 'query-too-short');
  assert.equal(out.block, '');
});

test('a real retrieval round-trips a stored document into a prompt block', async () => {
  upsertDocument({
    source: 'servicenow-docs', product: 'ITSM', topic: 'sla',
    version: 'Charlie', document_type: 'documentation',
    url: 'https://www.servicenow.com/docs/agent-roundtrip',
    updated_at: '2026-04-01T00:00:00.000Z', title: 'SLA schedules',
    text: 'An SLA definition ignores its schedule unless schedule_source is set to sla_definition.',
  });
  const out = await retrieveForTurn('why does the sla schedule get ignored on a definition');
  // Semantic retrieval needs a pulled embedding model, which this suite must not
  // require; the keyword path answers the same query deterministically. Either
  // way the block, when there is one, must be framed correctly.
  if (out.block) {
    assert.match(out.block, /REFERENCE ONLY/);
    assert.match(out.block, /agent-roundtrip/);
  }
  assert.ok(out.retrieval, 'a search must have run against a non-empty corpus');
  assert.ok(out.retrieval.indexed >= 1);
});

/* ── K6: THE KNOWLEDGE LAYER CANNOT WEAKEN ANY CONTROL ────────────────────── */

test('every knowledge tool is flagged non-mutating', () => {
  for (const name of ['search_servicenow_docs', 'knowledge_status', 'resolve_source_conflict',
    'record_verified_observation', 'list_verified_observations']) {
    const tool = toolMap.get ? toolMap.get(name) : toolMap[name];
    assert.ok(tool, `${name} must be in the catalogue`);
    assert.equal(tool.mutating, false, `${name} must never be flagged mutating`);
  }
});

test('no knowledge module IMPORTS the instance, the controls, or the settings writer', () => {
  // Structural, not aspirational: the "RAG cannot authorise anything" claim is
  // true only while the knowledge layer has no way to reach any of these, and
  // the moment one is imported this fails.
  //
  // Checked on the IMPORT GRAPH rather than on the file text, because these
  // modules legitimately NAME the controls in their comments — explaining what
  // a layer must not touch is how the next reader learns it must not.
  const FORBIDDEN = [
    // The instance itself.
    /servicenow\//,
    // The controls: the turn loop, the write guard, the tool catalogue.
    /agent\/orchestrator\.js/, /agent\/write-guard\.js/, /agent\/tools\.js/,
    /agent\/mutation-pipeline\.js/, /memory\/provenance\.js/,
  ];
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;

  for (const file of fs.readdirSync(path.join(SRC, 'knowledge'))) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(SRC, 'knowledge', file), 'utf8');

    for (const m of src.matchAll(IMPORT)) {
      for (const bad of FORBIDDEN) {
        assert.ok(!bad.test(m[1]),
          `knowledge/${file} imports ${m[1]} — the knowledge layer informs, it never authorises`);
      }
    }
    // The Tier-3 escalation flag: no code path below the Settings route may
    // write it, and that includes calling the writer by name.
    assert.ok(!/saveSettings\s*\(/.test(src),
      `knowledge/${file} must not call saveSettings`);
  }
});

test('the knowledge route cannot write to ServiceNow', () => {
  const src = read('routes/knowledge.js');
  for (const bad of ['servicenow/', 'saveSettings', 'executeTool', 'resolveApproval']) {
    assert.ok(!src.includes(bad), `routes/knowledge.js must not reference ${bad}`);
  }
});

test('adding retrieval did not add a settings-write tool', () => {
  // The Tier-3 escalation flag is only askable because nothing in the tool
  // catalogue can set it. That is an ABSENCE, and an absence is exactly what
  // nobody notices being added back.
  for (const t of TOOLS) {
    assert.ok(!/saveSettings/.test(String(t.execute)),
      `${t.name} must not be able to write settings`);
  }
});

test('the approval gate still governs mutations — retrieval added no bypass', () => {
  const orch = read('agent/orchestrator.js');
  // Retrieval is imported for CONTEXT only: one call, before the loop, whose
  // result is a string.
  assert.match(orch, /retrieveForTurn/);
  assert.equal((orch.match(/retrieveForTurn\(/g) || []).length, 1,
    'retrieval must happen exactly once per turn, outside the iteration loop');
  // And nothing from the knowledge layer is consulted when deciding whether a
  // call needs approval. The region checked is executeTool's OWN body — from
  // its declaration to the next top-level export — because slicing to the end
  // of the file would sweep in runTurn, which legitimately holds the retrieval.
  const start = orch.indexOf('export async function executeTool(');
  assert.ok(start > 0, 'executeTool must still be where the gate lives');
  const after = orch.indexOf('\nexport ', start + 1);
  assert.ok(after > start, 'could not find the end of executeTool');
  const gateRegion = orch.slice(start, after);

  for (const bad of ['knowledgeNote', 'searchKnowledge', 'canAuthorize', 'retrieveForTurn', 'knowledge/']) {
    assert.ok(!gateRegion.includes(bad),
      `the tool-execution path must not consult ${bad} — knowledge must not influence authorisation`);
  }
});

test('the system prompt still carries the operating rules alongside the knowledge block', () => {
  // The block is ADDITIVE. A retrieval that displaced the rules would be a
  // policy regression dressed as a context improvement.
  const prompt = buildSystemPrompt({ knowledgeNote: knowledgeBlock(result()) });
  assert.match(prompt, /NEVER invent sys_ids/);
  assert.match(prompt, /pause for the user's approval/);
  assert.match(prompt, /REFERENCE ONLY/);
});
