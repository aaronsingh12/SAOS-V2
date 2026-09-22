import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Bulk Fix — the client half, held to the same contract as the single drawer.
 *
 * Source-level assertions, like health-client-contract: the page and the two
 * drawers are read as text and checked for the properties that make the
 * feature safe — the card is rendered and answered through the one resolver,
 * the stream is abortable, an error frame is not thrown from inside the
 * handler, and the frames the drawer reads are frames the server emits.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(__dirname, '../../client/src');
const SERVER = path.resolve(__dirname, '../src');
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = read('pages/HealthAssist.jsx');
const BULK = read('components/BulkFixDrawer.jsx');
const SINGLE = read('components/RemediationDrawer.jsx');
const PARTS = read('components/RemediationParts.jsx');
const ROUTE = fs.readFileSync(path.join(SERVER, 'routes/health.js'), 'utf8');

/* ── The page ──────────────────────────────────────────────────────────── */

test('the page selects with checkboxes on BOTH findings tables, keyed on run + fingerprint', () => {
  const src = strip(PAGE);
  assert.equal((src.match(/\{selectAllBox\((searchedFindings|topFindings)\)\}/g) || []).length, 2, 'select-all is not on both tables');
  assert.equal((src.match(/\{selectBox\(f\)\}/g) || []).length, 2, 'the row checkbox is not on both tables');
  assert.match(src, /const selKey = \(f\) => `\$\{f\.run_id \|\| run\?\.id\}:\$\{f\.fingerprint\}`/, 'selection is not keyed on run + fingerprint');
  assert.match(src, /e\.stopPropagation\(\)/, 'ticking a row opens the finding instead');
});

test('only findings the SERVER says are fixable can be selected — the page invents no rule list', () => {
  const src = strip(PAGE);
  assert.match(src, /const selectable = \(f\) => Boolean\(f\.fixable\)/);
  assert.ok(!/FIX_FIELD|'CMDB-OWNER'|'CRED-INACTIVE'|'ITSM-INC-UNASSIGNED'/.test(src), 'the page names rules — fixability must come from the server');
  assert.match(ROUTE, /fixable: hasFieldFix\(f\.rule_id\)/, 'the server does not decorate rows with fixable');
});

test('the Bulk fix button is always present, disabled with nothing selected, and shows the count', () => {
  const src = strip(PAGE);
  assert.match(src, /disabled=\{selected\.size === 0 \|\| running\}/);
  assert.match(src, /Bulk fix\{selected\.size \? ` \(\$\{selected\.size\}\)` : ''\}/);
  assert.match(src, /Clear selection/);
  assert.match(src, /not in the current view/, 'a selection hidden by a filter is not counted');
});

test('the selection is cleared when the scope changes or a new run lands, and the cap comes from /meta', () => {
  const src = strip(PAGE);
  const pick = src.slice(src.indexOf('const pickScope'), src.indexOf('};', src.indexOf('const pickScope')));
  assert.match(pick, /setSelected\(new Map\(\)\)/, 'switching scope keeps a selection made against another scope');
  const view = src.slice(src.indexOf('useEffect(() => {\n    setSelected(new Map());'));
  assert.match(view, /\[viewKey, Boolean\(run\)\]/, 'a new run does not clear the selection');
  assert.match(src, /meta\?\.bulk\?\.max/, 'the batch cap is not read from the server');
});

test('the page streams nothing and opens the batch with a SNAPSHOT; the drawer does the work', () => {
  const src = strip(PAGE);
  assert.equal(/\bsse\(/.test(src), false);
  assert.ok(!/\/health\/bulk/.test(src), 'the page calls the bulk endpoints itself');
  assert.match(src, /setBulkItems\(\[\.\.\.selected\.values\(\)\]\)/, 'the drawer is handed live state, not a snapshot');
  assert.match(src, /<BulkFixDrawer/);
  assert.match(src, /onSettled=\{onBulkSettled\}/);
  const settled = src.slice(src.indexOf('const onBulkSettled'), src.indexOf('};', src.indexOf('const onBulkSettled')));
  assert.match(settled, /r\.status === 'applied'\) next\.delete/, 'applied findings stay selected after the batch');
});

/* ── The bulk drawer — the same contract as the single one ─────────────── */

test('the bulk drawer renders the executor\'s per-record card and answers it through the one resolver', () => {
  const src = strip(BULK);
  assert.match(src, /evt\.type === 'approval_required'/, 'the drawer ignores the executor\'s approval card');
  assert.match(src, /evt\.type === 'approval_resolved'/);
  assert.match(src, /api\.post\('\/agent\/approve'/, 'the card is not answered through POST /api/agent/approve');
  assert.match(src, /nonce: gate\.nonce/, 'the answer does not carry the card\'s nonce');
  assert.match(src, /evt\.sessionId/, 'the drawer does not take the session from the stream');
  assert.match(src, /sessions\.get\(evt\.item\)/, 'the card is not bound to ITS item\'s session — a batch would answer the wrong one');
  assert.match(src, /validation\.skipped/, 'a skipped validation would render as "Validation failed — 0 of 0"');
  assert.match(src, /signal: controller\.signal/, 'closing the drawer cannot stop a waiting gate');
  assert.match(src, /<WriteGateCard/, 'the bulk drawer draws its own card instead of the shared one');
});

test('no bulk stream handler signals failure by throwing — sse() swallows handler exceptions', () => {
  const src = strip(BULK);
  assert.ok(!/evt\.type === 'error'\)[^\n;]*throw /.test(src) && !/evt\.type === 'error'\) \{[^}]*throw /.test(src));
  assert.match(src, /else if \(evt\.type === 'done' \|\| evt\.type === 'error'\) terminal = evt;/, 'the terminal frame is not captured and acted on after the stream');
});

test('the frames the bulk drawer reads are frames the server emits, and vice versa', () => {
  const route = strip(ROUTE);
  for (const type of ['bulk_started', 'item_started', 'item_proposed', 'item_skipped', 'item_done', 'done']) {
    assert.match(route, new RegExp(`type: '${type}'`), `routes/health.js no longer emits ${type}`);
  }
  const src = strip(BULK);
  for (const type of ['item_proposed', 'item_skipped', 'item_done', 'targets_observing', 'plan_created', 'execution_started', 'execution_complete']) {
    assert.match(src, new RegExp(`evt\\.type === '${type}'`), `the drawer does not read ${type}`);
  }
  /* Every inner frame is tagged with its item on the server, and the drawer routes on that tag. */
  assert.match(route, /write\(\{ \.\.\.e, item: proposalId \}\)/, 'inner frames are not tagged with their item');
  assert.match(src, /byProposal\.get\(evt\.item\)/);
});

test('the bulk drawer sends the fingerprint of EACH version it showed, saving edits first', () => {
  const src = strip(BULK);
  assert.match(src, /api\.patch\(`\/health\/proposals\/\$\{r\.proposalId\}`/, 'an edited proposal is not saved before approval');
  assert.match(src, /fp = res\.fingerprint/, 'the NEW fingerprint after a save is not the one sent');
  assert.match(src, /items: toSend\.map\(\(\{ proposalId, fingerprint \}\) => \(\{ proposalId, fingerprint \}\)\)/);
  assert.ok(!/autoApprove/.test(src), 'the drawer threads auto-approve through');
  assert.ok(!/\/health\/proposals\/[^`]*\/approve/.test(src), 'the bulk drawer calls the single approve route — the batch must be the server\'s sequence');
});

test('the bulk drawer reaches only Health Assist endpoints and the one resolver', () => {
  const calls = [...strip(BULK).matchAll(/(?:api\.(?:get|post|patch|del)|sse)\(\s*[`']([^`'$]*)/g)].map((m) => m[1]);
  assert.ok(calls.length > 0);
  const escapees = calls.filter((c) => !c.startsWith('/health/') && c !== '/agent/approve');
  assert.deepEqual(escapees, [], `the bulk drawer calls outside /health/: ${escapees.join(', ')}`);
});

test('every status the server can put on an item has a label in the drawer', async () => {
  const { BULK_ITEM_STATUS } = await import('../src/health/bulk.js');
  const src = strip(BULK);
  for (const s of Object.values(BULK_ITEM_STATUS)) {
    assert.match(src, new RegExp(`^\\s*${s}: \\{ label:`, 'm'), `no label for status ${s}`);
  }
});

test('a finding already fixed in this run is FLAGGED and left out by default, never hidden', () => {
  const src = strip(BULK);
  assert.match(src, /included: it\.status === 'proposed' && !it\.priorProposal/);
  assert.match(src, /Already fixed once in this run/);
  assert.match(ROUTE, /priorProposal = \{ id: prior\.id, status: prior\.status/);
});

/* ── One editor, one card ──────────────────────────────────────────────── */

test('the single drawer and the bulk drawer share ONE change editor and ONE gate card', () => {
  for (const [name, src] of [['RemediationDrawer', SINGLE], ['BulkFixDrawer', BULK]]) {
    assert.match(src, /from '\.\/RemediationParts\.jsx'/, `${name} does not use the shared parts`);
    assert.match(src, /<ProposalChangeList/, `${name} does not render the shared change list`);
    assert.match(src, /<WriteGateCard/, `${name} does not render the shared gate card`);
    assert.ok(!/approval-card rm-gate/.test(src), `${name} draws its own gate card`);
    assert.ok(!/<ReferenceField/.test(src), `${name} draws its own reference picker`);
  }
  assert.match(PARTS, /<ReferenceField/, 'the shared editor lost the reference picker — a sys_id typed by hand');
  assert.match(PARTS, /Deletion cannot be undone/);
  assert.match(PARTS, /YYYY-MM-DD HH:MM:SS \(UTC\)/);
});

test('the single drawer still generates, edits, approves and answers exactly as before', () => {
  const src = strip(SINGLE);
  assert.match(src, /api\.post\(`\/health\/runs\/\$\{runId\}\/findings\/\$\{finding\.fingerprint\}\/proposal`\)/);
  assert.match(src, /sse\(`\/health\/proposals\/\$\{row\.id\}\/approve`, \{ fingerprint: fp \}/);
  assert.match(src, /const fp = dirty \? await save\(\) : fingerprint;/);
  assert.match(src, /Approve and apply \{executable\.length > 0/);
});
