/**
 * PHASE 18 — CHANGE INTELLIGENCE.
 *
 *   node --test server/test/phase18-change.test.js
 *
 * Offline in full: captured artifacts, no instance, no model, no network. The
 * real instance is exercised by `scripts/phase18-pdi.mjs`, and the two are
 * different jobs — this file proves the diff is RIGHT, that one proves it is
 * right about something real.
 *
 * ═══ THE TWO WAYS THIS PHASE CAN LIE, AND WHICH TESTS COVER WHICH ═══
 *
 * A FALSE POSITIVE says something changed that did not, and §63.2 makes it a
 * blocker. The F-numbered tests below are that half, and they are modelled on
 * the shape the instance actually produces: a live flow and its published
 * snapshot differ in every sys_id, in the class name, in the timestamps and in
 * the version, and are the same flow.
 *
 * A FALSE NEGATIVE says nothing changed when something did, and §63.3 makes it
 * a blocker too. The N-numbered tests are that half — one per kind of change a
 * flow can actually undergo — and they are the more important half, because a
 * false positive costs an afternoon and a false negative costs a release.
 *
 * THE FIXTURES ARE MEASURED. `LIVE` and `SNAPSHOT` below are the two states of
 * "Change - Refresh Impacted Services" as dev424910 returns them, including the
 * fact that the snapshot's row ids differ throughout while every `ui_id` is
 * identical. 205 such pairs were compared on that instance and all 205 are
 * semantically identical, which is what makes them a control rather than a
 * hopeful example.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowforge-p18-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const C = await import('../src/agent/change/index.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');

/* ================================================================== *
 * FIXTURES — the two real states, as the instance returns them
 * ================================================================== */

const LIVE_ID = '99865a72b7ac721013d4807cae11a950';
const SNAP_ID = 'aff99af6b7ac721013d4807cae11a9ee';

/* The ui_ids are the real ones, and they are IDENTICAL in both states. */
const UI = Object.freeze({
  first: '37522929-721e-4d75-ba99-c52fbb9f2331',
  middle: '4fb1c8ec-eee8-4fb0-8605-903bce30334b',
  last: 'f56c46da-1f00-45a2-b51c-1910af1879bc',
});

const input = (name, supplied, over = {}) => ({
  name, label: null, type: over.type ?? 'string', mandatory: over.mandatory ?? false,
  read_only: false, reference: over.reference ?? null, depends_on: null,
  supplied, display: over.display ?? null,
  is_pill: /^\{\{.*\}\}$/.test(String(supplied).trim()),
  empty: String(supplied).trim() === '', declared: true, children: [],
});

const action = (o) => ({
  sys_id: o.sys_id, order: o.order, type_sys_id: o.type_sys_id ?? 'a'.repeat(32),
  type_name: o.type_name, comment: null,
  ui_id: o.ui_id, parent_ui_id: o.parent_ui_id ?? null,
  inputs: o.inputs ?? [], inputs_readable: o.inputs_readable ?? true,
});

/**
 * The flow as it is live. `rowIds` lets a caller mint the same artifact with
 * DIFFERENT row identities — which is exactly what a snapshot is.
 */
function refreshFlow({ sysId = LIVE_ID, rowIds = ['1', '2', '3'], over = {} } = {}) {
  const a = {
    flow: {
      sys_id: sysId,
      name: over.name ?? 'Change - Refresh Impacted Services',
      description: over.description ?? 'Manages the process of Refreshing Impacted Services',
      active: over.active ?? true,
      type: 'flow',
      status: over.status ?? 'published',
      scope: 'Global',
      updated_on: over.updated_on ?? '2026-09-01 23:58:02',
    },
    triggers: [{
      sys_id: `${rowIds[0]}t`.repeat(4),
      type: over.triggerKind ?? 'record_create',
      name: 'Created',
      config: { table: 'Change Management Worker', condition: over.condition ?? 'type=refresh_services^source_table=change_request' },
      table_label: 'Change Management Worker',
      table: over.triggerTable ?? 'chg_mgt_worker',
      condition: over.condition ?? 'type=refresh_services^source_table=change_request',
      condition_query: over.condition ?? 'type=refresh_services^source_table=change_request',
      strategy: over.strategy ?? null,
    }],
    actions: [
      action({
        sys_id: rowIds[0].repeat(32).slice(0, 32), order: 1, ui_id: UI.first, type_name: 'Update Record',
        inputs: [
          input('record', '{{Created_1.current}}', { type: 'document_id' }),
          input('table_name', 'chg_mgt_worker', { type: 'table_name' }),
          input('values', over.firstValues ?? 'state=2', { type: 'template_value' }),
        ],
      }),
      action({
        sys_id: rowIds[1].repeat(32).slice(0, 32), order: 2, ui_id: UI.middle,
        type_name: over.middleType ?? 'Change Request - Refresh Impacted Services',
        parent_ui_id: over.middleParent ?? null,
        inputs: [input('task_sysid', '{{Created_1.current.source_record}}', { type: 'document_id' })],
      }),
      action({
        sys_id: rowIds[2].repeat(32).slice(0, 32), order: 3, ui_id: UI.last, type_name: 'Update Record',
        inputs: [
          input('record', '{{Created_1.current}}', { type: 'document_id' }),
          input('table_name', 'chg_mgt_worker', { type: 'table_name' }),
          input('values', over.lastValues ?? 'state=3', { type: 'template_value' }),
        ],
      }),
    ],
    logic: [], subflow_calls: [], callers: [], source_tables: null, gaps: over.gaps ?? [],
  };
  if (over.mutate) over.mutate(a);
  return a;
}

/** The same artifact as the platform's published copy: every row id differs. */
const snapshotOf = (over = {}) => refreshFlow({ sysId: SNAP_ID, rowIds: ['7', '8', '9'], over });

const norm = (artifact, source = 'LIVE') => C.normalizeFlow(artifact, { source, read_at: 'x' });

/** Diff two artifacts, assessed and ranked exactly as `compareFlow` does. */
function compare(beforeArtifact, afterArtifact) {
  const b = norm(beforeArtifact, 'PUBLISHED_SNAPSHOT');
  const a = norm(afterArtifact, 'LIVE');
  const raw = C.diffFlows(b, a);
  const deps = C.dependencyDelta(b, a);
  const changes = C.rank(C.assess(raw.changes));
  return {
    b, a, raw, deps, changes,
    summary: C.summarise({ changes, unchanged: raw.unchanged, dependencies: deps }),
    risk: C.overallRisk(changes, { complete: raw.complete }),
    real: changes.filter((x) => !x.display_only && x.kind !== 'UNCHANGED'),
  };
}

const pathsOf = (r) => r.real.map((c) => `${c.kind} ${c.path}`);

/* ================================================================== *
 * §43 — FALSE POSITIVES. Two identical artifacts, one diff: none.
 * ================================================================== */

test('F1 — a live flow and its published snapshot are identical, despite every row id differing', () => {
  const live = norm(refreshFlow(), 'LIVE');
  const snap = norm(snapshotOf(), 'PUBLISHED_SNAPSHOT');

  /* The fixtures really do differ where the instance differs, or this test
   * proves nothing. */
  assert.notEqual(live.artifact.sys_id, snap.artifact.sys_id);
  assert.notDeepEqual(
    refreshFlow().actions.map((x) => x.sys_id),
    snapshotOf().actions.map((x) => x.sys_id),
  );

  assert.equal(C.hashArtifact(live), C.hashArtifact(snap), 'two states of one flow hashed differently');
  const r = C.diffFlows(snap, live);
  assert.deepEqual(r.changes, []);
  assert.equal(r.complete, true);
  assert.ok(r.unchanged > 0, 'nothing was actually compared');
});

test('F2 — the hash ignores exactly the fields that describe the ROW, not the flow', () => {
  const base = norm(refreshFlow());
  for (const over of [
    { status: 'draft' },
    { updated_on: '2001-01-01 00:00:00' },
  ]) {
    assert.equal(C.hashArtifact(norm(refreshFlow({ over }))), C.hashArtifact(base),
      `${JSON.stringify(over)} moved the hash`);
  }
  /* And a snapshot's own bookkeeping cannot move it either. */
  assert.equal(C.hashArtifact(norm(snapshotOf())), C.hashArtifact(base));
});

test('F3 — §19: a relabelled reference is NOT an identity change', () => {
  const abel = 'a'.repeat(32);
  const before = refreshFlow({ over: { mutate: (a) => {
    a.actions[0].inputs.push(input('assigned_to', abel, { reference: 'sys_user', display: 'Abel Tuter' }));
  } } });
  const after = refreshFlow({ over: { mutate: (a) => {
    a.actions[0].inputs.push(input('assigned_to', abel, { reference: 'sys_user', display: 'Abel Tuter (Admin)' }));
  } } });

  const r = compare(before, after);
  assert.equal(r.real.length, 0, `a label change was counted: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(r.summary.total, 0);
  assert.equal(C.hashArtifact(r.b), C.hashArtifact(r.a), 'a label moved the hash');

  /* It is SHOWN, though — hiding it would baffle a reader looking at the UI. */
  const shown = r.changes.filter((c) => c.display_only);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].before_display, 'Abel Tuter');
  assert.equal(shown[0].after_display, 'Abel Tuter (Admin)');
  assert.equal(r.summary.display_only, 1);
});

test('F4 — the ORDER inputs are serialised in carries no meaning and produces no change', () => {
  const after = refreshFlow({ over: { mutate: (a) => { a.actions[0].inputs.reverse(); } } });
  const r = compare(refreshFlow(), after);
  assert.deepEqual(pathsOf(r), []);
  assert.equal(C.hashArtifact(r.b), C.hashArtifact(r.a));
});

test('F5 — renumbering `order` without reordering the steps is not a move', () => {
  /* The platform renumbers freely; 1,2,3 and 10,20,30 are the same sequence. */
  const after = refreshFlow({ over: { mutate: (a) => {
    a.actions[0].order = 10; a.actions[1].order = 20; a.actions[2].order = 30;
  } } });
  const r = compare(refreshFlow(), after);
  assert.deepEqual(pathsOf(r), [], 'a renumbering was reported as a change');
});

test('F6 — null, undefined and the empty string are one absence', () => {
  const after = refreshFlow({ over: { mutate: (a) => {
    a.flow.description = 'Manages the process of Refreshing Impacted Services';
    a.actions[1].parent_ui_id = '';
  } } });
  const before = refreshFlow({ over: { mutate: (a) => { a.actions[1].parent_ui_id = null; } } });
  assert.deepEqual(pathsOf(compare(before, after)), []);
});

test('F7 — comparing an artifact with ITSELF is always empty, whatever it contains', () => {
  for (const over of [
    {},
    { condition: '' },
    { gaps: ['one section could not be read'] },
    { mutate: (a) => { a.actions = []; } },
    { mutate: (a) => { a.triggers = []; } },
  ]) {
    const one = refreshFlow({ over });
    const r = C.diffFlows(norm(one), norm(refreshFlow({ over })));
    assert.deepEqual(r.changes, [], `self-comparison produced changes for ${JSON.stringify(Object.keys(over))}`);
  }
});

/* ================================================================== *
 * §44 — FALSE NEGATIVES. A known change must be found.
 * ================================================================== */

test('N1 — §14: the trigger KIND changing is found, and is HIGH', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { triggerKind: 'record_update' } }));
  const c = r.real.find((x) => x.path === 'trigger.kind');
  assert.ok(c, `not found: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(c.kind, 'CHANGED');
  assert.equal(c.before, 'record_create');
  assert.equal(c.after, 'record_update');
  assert.ok(c.categories.includes('TRIGGER'));
  assert.equal(c.risk, 'HIGH');
  assert.equal(r.risk.risk, 'HIGH');
  assert.equal(r.summary.trigger_changes >= 1, true);
});

test('N2 — §14: the trigger TABLE changing is found, and brings a dependency with it', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { triggerTable: 'incident' } }));
  const c = r.real.find((x) => x.path === 'trigger.table');
  assert.ok(c);
  assert.equal(c.after, 'incident');
  assert.equal(c.risk, 'HIGH');
  assert.ok(c.categories.includes('DEPENDENCY'));
  assert.equal(r.deps.added.some((d) => d.kind === 'table' && d.target === 'incident'), true);
  /*
   * And `chg_mgt_worker` is NOT reported as dropped, because it is not: the two
   * Update Record steps still write to it by name. A dependency delta that
   * looked only at the trigger would announce that the flow stopped depending
   * on a table it still writes to on every run.
   */
  assert.equal(r.deps.removed.some((d) => d.kind === 'table' && d.target === 'chg_mgt_worker'), false,
    'a table the flow still writes to was reported as a dropped dependency');
  assert.equal(r.a.references.some((d) => d.target === 'chg_mgt_worker'), true);
});

test('N3 — §15: a condition term added is found as that term, not as an opaque string change', () => {
  const r = compare(
    refreshFlow({ over: { condition: 'type=refresh_services' } }),
    refreshFlow({ over: { condition: 'type=refresh_services^source_table=change_request' } }),
  );
  const c = r.real.find((x) => x.path === 'trigger.condition[source_table]');
  assert.ok(c, `not found: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(c.kind, 'ADDED');
  assert.equal(c.after, 'source_table=change_request');
  assert.equal(c.risk, 'MEDIUM', 'a condition change is MEDIUM per §24, not HIGH');
});

test('N4 — §15: a condition term REMOVED is found, and widens what the flow runs for', () => {
  const r = compare(
    refreshFlow({ over: { condition: 'type=refresh_services^source_table=change_request' } }),
    refreshFlow({ over: { condition: 'type=refresh_services' } }),
  );
  const c = r.real.find((x) => x.kind === 'REMOVED' && x.element === 'condition');
  assert.ok(c);
  assert.equal(c.before, 'source_table=change_request');
});

test('N5 — §15: a term whose VALUE changed is one removal and one addition, never a silent match', () => {
  const r = compare(
    refreshFlow({ over: { condition: 'type=refresh_services' } }),
    refreshFlow({ over: { condition: 'type=conflict_detection' } }),
  );
  assert.equal(r.real.filter((x) => x.element === 'condition').length, 2);
  assert.ok(r.real.some((x) => x.kind === 'REMOVED' && x.before === 'type=refresh_services'));
  assert.ok(r.real.some((x) => x.kind === 'ADDED' && x.after === 'type=conflict_detection'));
});

test('N6 — the same terms in a different ORDER is reported, and its effect is NOT claimed', () => {
  const r = compare(
    refreshFlow({ over: { condition: 'type=refresh_services^source_table=change_request' } }),
    refreshFlow({ over: { condition: 'source_table=change_request^type=refresh_services' } }),
  );
  const c = r.real.find((x) => x.kind === 'MOVED' && x.path === 'trigger.condition');
  assert.ok(c, 'a reordered condition vanished — §63.3');
  assert.equal(c.status, 'UNKNOWN', 'equivalence was claimed without establishing it');
  assert.match(c.note, /not established/);
});

test('N7 — §16: an action ADDED is found, at its position', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => {
    a.actions.push(action({ sys_id: 'z'.repeat(32), order: 4, ui_id: 'new-step-uuid', type_name: 'Send Email' }));
  } } }));
  const c = r.real.find((x) => x.kind === 'ADDED' && x.element === 'action');
  assert.ok(c);
  assert.equal(c.after, 'Send Email');
  assert.equal(c.detail.order, 4);
  assert.equal(r.summary.added, 1);
});

test('N8 — §16: an action REMOVED is found', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => { a.actions.pop(); } } }));
  const c = r.real.find((x) => x.kind === 'REMOVED' && x.element === 'action');
  assert.ok(c);
  assert.equal(c.before, 'Update Record');
  assert.equal(r.summary.removed, 1);
});

test('N9 — §24: a DESTRUCTIVE action added is HIGH, not merely another action', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => {
    a.actions.push(action({ sys_id: 'z'.repeat(32), order: 4, ui_id: 'del-step', type_name: 'Delete Record' }));
  } } }));
  const c = r.real.find((x) => x.kind === 'ADDED' && x.element === 'action');
  assert.equal(c.risk, 'HIGH');
  assert.equal(c.rule, 'destructive_added');
  assert.equal(r.risk.risk, 'HIGH');
});

test('N10 — §16: an action REORDERED is found as a MOVE, not as a rewrite', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => {
    /* Swap the first and last steps by their order, keeping ui_ids intact —
     * which is what reordering a flow in the designer does. */
    a.actions[0].order = 3;
    a.actions[2].order = 1;
  } } }));
  const moves = r.real.filter((x) => x.kind === 'MOVED' && x.semantic_type === 'position');
  assert.equal(moves.length, 2, `expected two moves, got ${JSON.stringify(pathsOf(r))}`);
  assert.equal(r.summary.moved, 2);
  assert.equal(r.real.some((x) => x.kind === 'ADDED' || x.kind === 'REMOVED'), false,
    'a reorder was reported as an add and a remove');
  assert.equal(moves[0].risk, 'MEDIUM');
});

test('N11 — §16: an action whose TYPE changed is found', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { middleType: 'Look Up Record' } }));
  const c = r.real.find((x) => x.path.endsWith('.type'));
  assert.ok(c);
  assert.equal(c.before, 'Change Request - Refresh Impacted Services');
  assert.equal(c.after, 'Look Up Record');
  assert.ok(c.categories.includes('DEPENDENCY'));
});

test('N12 — a step moved into a BRANCH is found, because when it runs changed', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { middleParent: 'if-block-uuid' } }));
  const c = r.real.find((x) => x.element === 'branch');
  assert.ok(c, `not found: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(c.kind, 'MOVED');
  assert.equal(c.after, 'if-block-uuid');
  assert.equal(c.risk, 'MEDIUM');
});

test('N13 — §17: an action INPUT changed is found, at its exact path', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { lastValues: 'state=4' } }));
  const c = r.real.find((x) => x.path === `steps[${UI.last}].inputs.values`);
  assert.ok(c, `not found: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(c.kind, 'CHANGED');
  assert.equal(c.before, 'state=3');
  assert.equal(c.after, 'state=4');
  assert.ok(c.categories.includes('DATA'));
});

test('N14 — an input ADDED and an input REMOVED are both found', () => {
  const added = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => {
    a.actions[0].inputs.push(input('order', '100'));
  } } }));
  assert.ok(added.real.some((x) => x.kind === 'ADDED' && x.path.endsWith('.inputs.order')));

  const removed = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => {
    a.actions[0].inputs = a.actions[0].inputs.filter((i) => i.name !== 'values');
  } } }));
  assert.ok(removed.real.some((x) => x.kind === 'REMOVED' && x.path.endsWith('.inputs.values')));
});

test('N15 — an input EMPTIED is a change, not an absence', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { lastValues: '' } }));
  const c = r.real.find((x) => x.path === `steps[${UI.last}].inputs.values`);
  assert.ok(c, 'emptying a field vanished — §63.3');
  assert.equal(c.before, 'state=3');
  assert.equal(c.after, null);
});

test('N16 — §18: a reference IDENTITY change is found even when the label is unchanged', () => {
  const abel = 'a'.repeat(32);
  const john = 'b'.repeat(32);
  const before = refreshFlow({ over: { mutate: (a) => {
    a.actions[0].inputs.push(input('assigned_to', abel, { reference: 'sys_user', display: 'Abel Tuter' }));
  } } });
  const after = refreshFlow({ over: { mutate: (a) => {
    /* Same display, different record — the case a label comparison misses. */
    a.actions[0].inputs.push(input('assigned_to', john, { reference: 'sys_user', display: 'Abel Tuter' }));
  } } });

  const r = compare(before, after);
  const c = r.real.find((x) => x.element === 'reference');
  assert.ok(c, 'an identity change hid behind an unchanged label — §63.4');
  assert.equal(c.before, abel);
  assert.equal(c.after, john);
  assert.notEqual(C.hashArtifact(r.b), C.hashArtifact(r.a));
});

test('N17 — the flow being DEACTIVATED is found, and is HIGH', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { active: false } }));
  const c = r.real.find((x) => x.path === 'header.active');
  assert.ok(c);
  assert.equal(c.risk, 'HIGH');
  assert.equal(r.risk.risk, 'HIGH');
});

test('N18 — §12: a description change is COSMETIC and LOW, and is still reported', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { description: 'Something else entirely' } }));
  const c = r.real.find((x) => x.path === 'header.description');
  assert.ok(c, 'a description change was normalized away');
  assert.deepEqual(c.categories, ['COSMETIC']);
  assert.equal(c.risk, 'LOW');
  assert.equal(r.risk.risk, 'LOW');
  assert.equal(r.summary.cosmetic_changes, 1);
});

test('N19 — a trigger removed entirely is found, and the flow stops running', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => { a.triggers = []; } } }));
  const c = r.real.find((x) => x.path === 'trigger');
  assert.ok(c);
  assert.equal(c.kind, 'REMOVED');
  assert.equal(c.risk, 'HIGH');
});

/* ================================================================== *
 * §24 / §25 — RISK AND ORDERING
 * ================================================================== */

test('R1 — §24: each of its own examples lands where it says', () => {
  const cases = [
    [{ description: 'x' }, 'LOW', 'header.description'],
    [{ condition: 'type=other' }, 'MEDIUM', null],
    [{ triggerKind: 'record_update' }, 'HIGH', 'trigger.kind'],
  ];
  for (const [over, expected, path] of cases) {
    const r = compare(refreshFlow(), refreshFlow({ over }));
    assert.equal(r.risk.risk, expected, `${JSON.stringify(over)} was ${r.risk.risk}, expected ${expected}`);
    if (path) assert.ok(r.real.some((x) => x.path === path));
  }
});

test('R2 — §25: certainty outranks risk in the ordering', () => {
  const ranked = C.rank([
    { path: 'a', kind: 'CHANGED', status: 'POSSIBLE', risk: 'CRITICAL' },
    { path: 'b', kind: 'CHANGED', status: 'CONFIRMED', risk: 'HIGH' },
    { path: 'c', kind: 'CHANGED', status: 'UNKNOWN', risk: 'CRITICAL' },
    { path: 'd', kind: 'CHANGED', status: 'CONFIRMED', risk: 'LOW' },
  ]);
  assert.deepEqual(ranked.map((x) => x.path), ['b', 'd', 'a', 'c'],
    'speculation outranked confirmed evidence');
});

test('R3 — the ordering is deterministic, including for ties', () => {
  const items = [
    { path: 'z', kind: 'CHANGED', status: 'CONFIRMED', risk: 'HIGH' },
    { path: 'a', kind: 'CHANGED', status: 'CONFIRMED', risk: 'HIGH' },
    { path: 'm', kind: 'ADDED', status: 'CONFIRMED', risk: 'HIGH' },
  ];
  assert.deepEqual(C.rank(items).map((x) => x.path), C.rank([...items].reverse()).map((x) => x.path));
  assert.deepEqual(C.rank(items).map((x) => x.path), ['a', 'm', 'z']);
});

test('R4 — the overall risk is taken over CONFIRMED changes, and the rest is reported beside it', () => {
  const only = C.overallRisk([
    { path: 'a', kind: 'MOVED', status: 'UNKNOWN', risk: 'HIGH', categories: [] },
  ]);
  assert.equal(only.risk, 'UNKNOWN', 'an unestablished change set the headline risk');
  assert.equal(only.unknown_changes, 1);

  const mixed = C.overallRisk([
    { path: 'a', kind: 'MOVED', status: 'UNKNOWN', risk: 'CRITICAL', categories: [] },
    { path: 'b', kind: 'CHANGED', status: 'CONFIRMED', risk: 'MEDIUM', categories: [], why: 'because' },
  ]);
  assert.equal(mixed.risk, 'MEDIUM', 'an unestablished CRITICAL inflated the headline');
  assert.equal(mixed.unknown_changes, 1);
});

test('R5 — identical artifacts are LOW and say why; an incomplete read is UNKNOWN', () => {
  assert.equal(C.overallRisk([], { complete: true }).risk, 'LOW');
  assert.match(C.overallRisk([], { complete: true }).reason, /identical/);
  assert.equal(C.overallRisk([], { complete: false }).risk, 'UNKNOWN');
});

test('R6 — a change shape no rule recognises is UNKNOWN, never LOW', () => {
  const r = C.riskOf({ kind: 'CHANGED', path: 'nowhere', element: 'nothing', categories: [] });
  assert.equal(r.risk, 'UNKNOWN');
  assert.equal(r.rule, 'unrecognised');
});

/* ================================================================== *
 * §11 / §30 / §31 — DETERMINISM AND IDENTITY
 * ================================================================== */

test('D1 — §11: the same two states always produce byte-identical output', () => {
  const a = compare(snapshotOf(), refreshFlow({ over: { lastValues: 'state=9', triggerKind: 'record_update' } }));
  const b = compare(snapshotOf(), refreshFlow({ over: { lastValues: 'state=9', triggerKind: 'record_update' } }));
  assert.deepEqual(a.changes, b.changes);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(JSON.stringify(a.changes), JSON.stringify(b.changes));
});

test('D2 — §30: the canonical string is inspectable, and covers the semantics', () => {
  const s = C.canonicalString(norm(refreshFlow()));
  /* A present value is prefixed with a colon and an absent one emits nothing,
   * so no value can impersonate an absence. */
  assert.match(s, /header\.name=:Change - Refresh Impacted Services/);
  assert.match(s, /trigger\.condition=:type=refresh_services/);
  assert.match(s, /inputs\.values=:state=3/);
  assert.equal(s.includes(' '), false, 'the canonical string carries a NUL, which makes the file binary to grep');
  /* An absent scalar and a value cannot collide. */
  assert.notEqual(
    C.canonicalString(norm(refreshFlow({ over: { description: null } }))),
    C.canonicalString(norm(refreshFlow({ over: { description: '' } }))) + 'x',
  );
  /* And it carries no row identity at all. */
  assert.equal(s.includes(LIVE_ID), false, 'the flow sys_id reached the hash');
  assert.equal(/1{32}|2{32}|3{32}/.test(s), false, 'an action row sys_id reached the hash');
  assert.equal(s.includes('published'), false, 'the snapshot status reached the hash');
});

test('D3 — §31: the diff fingerprint depends on the two states and nothing else', () => {
  const one = C.diffFingerprint({ baseline: 'aaa', current: 'bbb', type: 'flow' });
  assert.equal(one, C.diffFingerprint({ baseline: 'aaa', current: 'bbb', type: 'flow' }));
  assert.notEqual(one, C.diffFingerprint({ baseline: 'bbb', current: 'aaa', type: 'flow' }),
    'the direction of a comparison is part of its identity');
  assert.notEqual(one, C.diffFingerprint({ baseline: 'aaa', current: 'ccc', type: 'flow' }));
});

test('D4 — §29: a state with a real version keeps it; one without gets a derived id, marked', () => {
  const n = norm(refreshFlow());
  const real = C.versionIdOf(n, { version: '2' });
  assert.equal(real.id, '2');
  assert.equal(real.derived, false);

  const derived = C.versionIdOf(n);
  assert.equal(derived.derived, true);
  assert.equal(derived.id.length, 12);
  assert.equal(derived.id, C.hashArtifact(n).slice(0, 12), 'the derived id is not derived from the content');
  assert.match(derived.note, /records no version/);
});

/* ================================================================== *
 * §40 / §41 — PARTIAL AND UNKNOWN
 * ================================================================== */

test('P1 — §40: a gap on either side makes the comparison INCOMPLETE, and it says which', () => {
  const r = C.diffFlows(
    norm(refreshFlow({ over: { gaps: ['action 2 has inputs that could not be decoded'] } }), 'PUBLISHED_SNAPSHOT'),
    norm(refreshFlow()),
  );
  assert.equal(r.complete, false);
  assert.equal(r.unreadable.length, 1);
  assert.match(r.unreadable[0], /^baseline: /);
});

test('P2 — §41: every change in a partial comparison is UNKNOWN, not CONFIRMED', () => {
  const r = C.diffFlows(
    norm(refreshFlow({ over: { gaps: ['unreadable'] } }), 'PUBLISHED_SNAPSHOT'),
    norm(refreshFlow({ over: { lastValues: 'state=4' } })),
  );
  assert.equal(r.complete, false);
  assert.ok(r.changes.length > 0);
  assert.equal(r.changes.every((c) => c.status === 'UNKNOWN'), true,
    'a diff over a partly-unreadable artifact claimed certainty');
});

test('P3 — an action whose inputs would not decode becomes a stated gap, not a silent empty', () => {
  const n = norm(refreshFlow({ over: { mutate: (a) => { a.actions[1].inputs_readable = false; } } }));
  assert.equal(n.complete, false);
  assert.ok(n.gaps.some((g) => /could not be decoded/.test(g)));
  /* And the unreadability is part of the hash, so it cannot look identical to
   * a readable version of the same step. */
  assert.notEqual(C.hashArtifact(n), C.hashArtifact(norm(refreshFlow())));
});

test('P4 — a state that could not be read at all yields no diff, not an empty one', () => {
  const r = C.diffFlows(null, norm(refreshFlow()));
  assert.equal(r.complete, false);
  assert.deepEqual(r.changes, []);
  assert.match(r.unreadable[0], /baseline could not be read/);
});

/* ================================================================== *
 * §3 / §4 / §35 / §36 — BASELINES
 * ================================================================== */

const readerFor = (map) => async (id) => {
  if (!map[id]) throw new Error(`No flow found with sys_id ${id}`);
  return map[id];
};

test('B1 — §4: a source this build does not have is refused outright', async () => {
  await assert.rejects(
    () => C.readState({ sysId: LIVE_ID, source: 'THE_USER_TOLD_ME', readArtifact: readerFor({}) }),
    /not a baseline source/,
  );
});

test('B2 — the published snapshot is chosen as the baseline, and the rest are offered', async () => {
  const found = await C.findBaseline({
    flowSysId: LIVE_ID,
    findSnapshot: async () => ([
      { sys_id: SNAP_ID, version: '2', created_on: '2025-10-16 13:48:38' },
      { sys_id: 'older', version: '1', created_on: '2024-01-01 00:00:00' },
    ]),
    readArtifact: readerFor({ [SNAP_ID]: snapshotOf() }),
  });
  assert.equal(found.ok, true);
  assert.equal(found.chosen, 'published_snapshot');
  assert.equal(found.state.source, 'PUBLISHED_SNAPSHOT');
  assert.equal(found.state.version.id, '2');
  assert.equal(found.state.version.derived, false);
  assert.equal(found.alternatives.length, 1);
});

test('B3 — §63.1: with no snapshot and nothing captured, the answer is NO_BASELINE', async () => {
  const found = await C.findBaseline({
    flowSysId: LIVE_ID,
    findSnapshot: async () => [],
    captured: async () => null,
    readArtifact: readerFor({}),
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'NO_BASELINE');
  assert.match(found.note, /will not be reconstructed/);
});

test('B4 — §36: a captured baseline identifies its source, hash, time and provenance', async () => {
  const state = await C.readState({ sysId: LIVE_ID, source: 'LIVE', readArtifact: readerFor({ [LIVE_ID]: refreshFlow() }) });
  const b = C.captureBaseline(state, { at: '2026-09-07T00:00:00Z', by: 'task-1', note: 'before the edit' });
  assert.equal(b.source, 'LIVE');
  assert.equal(b.read_from_sys_id, LIVE_ID);
  assert.equal(b.hash, state.hash);
  assert.equal(b.captured_at, '2026-09-07T00:00:00Z');
  assert.equal(b.captured_by, 'task-1');
  assert.ok(b.normalized, 'the content itself was not kept, so the baseline is a pointer rather than a state');

  /* And a capture without a time is refused: an undated claim about the past
   * is not evidence about it. */
  assert.throws(() => C.captureBaseline(state, {}), /when it was captured/);
});

test('B5 — §36: a baseline edited after capture is DETECTED, not believed', () => {
  const stored = C.captureBaseline(
    { ok: true, source: 'LIVE', sys_id: LIVE_ID, normalized: norm(refreshFlow()), hash: C.hashArtifact(norm(refreshFlow())), complete: true, gaps: [] },
    { at: '2026-09-07T00:00:00Z' },
  );
  assert.equal(C.baselineIsIntact(C.restoreBaseline(stored)).ok, true);

  /* Somebody rewrote the stored content. The hash no longer matches. */
  const tampered = { ...stored, normalized: norm(refreshFlow({ over: { lastValues: 'state=99' } })) };
  const check = C.baselineIsIntact(C.restoreBaseline(tampered));
  assert.equal(check.ok, false);
  assert.match(check.note, /no longer hashes/);
});

/* ================================================================== *
 * §22 / §23 / §32 — THE INTEGRATIONS
 * ================================================================== */

test('I1 — §22: the lint scope names the rules the change makes relevant', () => {
  const trigger = compare(refreshFlow(), refreshFlow({ over: { triggerKind: 'record_update' } }));
  const scope = C.lintScope(trigger.changes);
  assert.ok(scope.relevant.includes('FLOW006'), 'a trigger change did not pull in the trigger rules');
  assert.ok(scope.relevant.includes('FLOW010'), 'the capability rule is always relevant');
  assert.match(scope.caveat, /nothing here says they pass/);

  const input = compare(refreshFlow(), refreshFlow({ over: { lastValues: 'state=4' } }));
  const inputScope = C.lintScope(input.changes);
  assert.ok(inputScope.relevant.includes('FLOW001'), 'an input change did not pull in the field rules');
  assert.equal(inputScope.relevant.includes('FLOW006'), false, 'an input change pulled in trigger rules');
});

test('I2 — §23: a downstream change is testable against the same fixture; a trigger change is not', () => {
  const testability = { triggerOf: (a) => ({ ok: true, table: a.triggers[0].table }), isDisposable: () => true };

  const downstream = compare(refreshFlow(), refreshFlow({ over: { lastValues: 'state=4' } }));
  const t1 = C.testRecommendation({ changes: downstream.changes, current: downstream.a, testability });
  assert.equal(t1.recommended, true);
  assert.equal(t1.scenario, 'targeted');

  const trigger = compare(refreshFlow(), refreshFlow({ over: { triggerKind: 'record_update' } }));
  const t2 = C.testRecommendation({ changes: trigger.changes, current: trigger.a, testability });
  assert.equal(t2.recommended, true);
  assert.equal(t2.scenario, 'regenerate');
  assert.match(t2.reason, /rebuilt/);
});

test('I3 — §23: a flow NowTest would refuse is not offered as testable', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { lastValues: 'state=4' } }));
  const t = C.testRecommendation({
    changes: r.changes, current: r.a,
    testability: { triggerOf: (a) => ({ ok: true, table: a.triggers[0].table }), isDisposable: () => false },
  });
  assert.equal(t.recommended, false);
  assert.equal(t.blocked, true);
  assert.match(t.reason, /NowTest would refuse/);
});

test('I4 — §23: nothing changed means nothing to test', () => {
  const r = compare(refreshFlow(), refreshFlow());
  const t = C.testRecommendation({
    changes: r.changes, current: r.a,
    testability: { triggerOf: () => ({ ok: true, table: 'incident' }), isDisposable: () => true },
  });
  assert.equal(t.recommended, false);
  assert.match(t.reason, /Nothing changed/);
});

test('I5 — §21: a change targeting a derived field is reported from the semantic ledger', async () => {
  const before = refreshFlow({ over: { triggerTable: 'incident', mutate: (a) => {
    a.actions[0].inputs = [
      input('record', '{{Created_1.current}}', { type: 'document_id' }),
      input('table_name', 'incident', { type: 'table_name' }),
      input('values', 'state=2', { type: 'template_value' }),
    ];
  } } });
  const after = refreshFlow({ over: { triggerTable: 'incident', mutate: (a) => {
    a.actions[0].inputs = [
      input('record', '{{Created_1.current}}', { type: 'document_id' }),
      input('table_name', 'incident', { type: 'table_name' }),
      input('values', 'priority=1', { type: 'template_value' }),
    ];
  } } });

  const r = compare(before, after);
  const impact = await C.schemaImpact({
    changes: r.changes, current: r.a,
    ctx: { derivationOf, fieldsOf: async () => new Map([['priority', { name: 'priority' }]]) },
  });
  const derived = impact.find((f) => f.kind === 'derived_field');
  assert.ok(derived, `not found: ${JSON.stringify(impact.map((f) => f.kind))}`);
  assert.match(derived.statement, /incident\.priority is computed/);
  assert.equal(derived.status, 'LIKELY');
});

test('I6 — §21: a dictionary that could not be read yields UNKNOWN, never a clean bill', async () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { lastValues: 'state=4' } }));
  const impact = await C.schemaImpact({
    changes: r.changes, current: r.a,
    ctx: { derivationOf: () => null, fieldsOf: async () => null },
  });
  const unknown = impact.find((f) => f.kind === 'schema_unknown');
  assert.ok(unknown, 'an unreadable dictionary produced no finding at all');
  assert.equal(unknown.status, 'UNKNOWN');
  assert.match(unknown.why_it_matters, /not a field that was found to be fine/);
});

test('I7 — §20: a new reference supplied as a LABEL is called out separately', () => {
  const impact = C.dependencyImpact({
    added: [{ kind: 'record', table: 'sys_user', target: 'Abel Tuter', is_identity: false, via: 'steps[x].inputs.assigned_to' }],
    removed: [],
  });
  assert.equal(impact[0].kind, 'new_dependency_by_label');
  assert.match(impact[0].why_it_matters, /resolves by name/);
});

/* ================================================================== *
 * §32 / §59 — DEPLOYMENT IS SOMEWHERE ELSE
 * ================================================================== */

test('X1 — §32: a deployment request is recognised and becomes a planner GOAL', () => {
  assert.equal(C.readMode('Deploy this change.'), 'PREPARE_DEPLOYMENT');
  assert.equal(C.readMode('Ship the Assign Incident flow.'), 'PREPARE_DEPLOYMENT');
  assert.equal(C.readMode('What changed in this flow?'), 'ANALYZE');
  assert.equal(C.readMode('Save the current version as a baseline.'), 'CAPTURE_BASELINE');
});

test('X2 — §32: the goal names both states and the change count, and nothing runs', () => {
  const comparison = {
    complete: true,
    artifact: { name: 'Assign Incident' },
    baseline: { version: { id: 'aaa111' } },
    current: { version: { id: 'bbb222' } },
    summary: { total: 3, trigger_changes: 1, behavioral_changes: 2, dependency_changes: 0 },
    risk: 'HIGH',
  };
  const goal = C.deploymentGoal(comparison);
  assert.match(goal, /Assign Incident/);
  assert.match(goal, /aaa111/);
  assert.match(goal, /bbb222/);
  assert.match(goal, /3 semantic change/);
  assert.match(goal, /HIGH/);
});

test('X3 — a goal is REFUSED for an incomplete or empty comparison', () => {
  assert.throws(() => C.deploymentGoal({ complete: false, summary: { total: 2 } }), /complete comparison/);
  assert.throws(() => C.deploymentGoal({ complete: true, summary: { total: 0 } }), /nothing to deploy/);
  assert.throws(() => C.deploymentGoal({ stopped: { reason: 'x' }, summary: { total: 1 } }), /nothing to describe/);
});

test('X4 — §59: the change domain contains no way to deploy, mutate or approve', () => {
  const dir = new URL('../src/agent/change/', import.meta.url);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of fs.readdirSync(dir)) {
    const code = strip(fs.readFileSync(new URL(file, dir), 'utf8'));
    for (const forbidden of [
      /executeTool/, /executePlan/, /table\.(create|update|remove|insert)\s*\(/,
      /\bcreate_record\b/, /\bupdate_record\b/, /\bdelete_record\b/,
      /awaitApprovalDecision/, /resolveApproval/, /approvePlan/,
      /\bfetch\s*\(/, /getDb\s*\(/,
    ]) {
      assert.equal(forbidden.test(code), false, `${file} can reach ${forbidden}`);
    }
  }
});

/* ================================================================== *
 * §26 / §38 / §39 — THE REPORT
 * ================================================================== */

test('S1 — §26: the counts are computed once and the prose cannot disagree', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: {
    triggerKind: 'record_update', lastValues: 'state=4', description: 'new',
  } }));
  assert.equal(r.summary.total, r.real.length);
  assert.equal(r.summary.added + r.summary.removed + r.summary.changed + r.summary.moved, r.summary.total);

  const md = C.renderComparison({
    artifact: { name: 'F' }, baseline: { source: 'PUBLISHED_SNAPSHOT', version: { id: '2' } },
    current: { source: 'LIVE', version: { id: 'abc', derived: true } },
    changes: r.changes, summary: r.summary, complete: true, risk: r.risk.risk,
    risk_reason: r.risk.reason, impact: [], dependencies: r.deps, test: {}, deployment: {},
  });
  assert.match(md, new RegExp(`### ${r.summary.total} changes`));
});

test('S2 — §39: a value change renders as -/+ and a structural one does not', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { lastValues: 'state=4', mutate: (a) => {
    a.actions.push(action({ sys_id: 'z'.repeat(32), order: 4, ui_id: 'new-step', type_name: 'Send Email' }));
  } } }));
  const md = C.renderComparison({
    artifact: { name: 'F' }, baseline: {}, current: {}, changes: r.changes, summary: r.summary,
    complete: true, risk: r.risk.risk, impact: [], dependencies: r.deps, test: {}, deployment: {},
  });
  assert.match(md, /- state=3/);
  assert.match(md, /\+ state=4/);
  assert.match(md, /ADDED ACTION Send Email/);
  assert.equal(/- Send Email/.test(md), false, 'a structural change was flattened into text');
});

test('S3 — §41: a PARTIAL comparison says so before anything else, and lists what is missing', () => {
  const md = C.renderComparison({
    artifact: { name: 'F' }, baseline: {}, current: {},
    changes: [], summary: { total: 0, unchanged: 3 }, complete: false,
    unreadable: ['current: action 2 has inputs that could not be decoded'],
    risk: 'UNKNOWN', impact: [], dependencies: { added: [], removed: [] }, test: {}, deployment: {},
  });
  assert.match(md, /### PARTIAL/);
  assert.match(md, /could not be decoded/);
  assert.ok(md.indexOf('### PARTIAL') < md.indexOf('### No semantic changes'));
});

test('S4 — every report ends by saying nothing was deployed', () => {
  for (const c of [
    { artifact: { name: 'F' }, baseline: {}, current: {}, changes: [], summary: { total: 0 }, complete: true, risk: 'LOW', impact: [], dependencies: { added: [], removed: [] }, test: {}, deployment: {} },
    { artifact: { name: 'F' }, stopped: { reason: 'NO_BASELINE', note: 'none' } },
  ]) {
    assert.match(C.renderComparison(c), /No changes have been deployed\./);
  }
});

test('S5 — §19: a label-only difference is shown apart from the changes, and counted apart', () => {
  const abel = 'a'.repeat(32);
  const r = compare(
    refreshFlow({ over: { mutate: (a) => { a.actions[0].inputs.push(input('assigned_to', abel, { reference: 'sys_user', display: 'Abel' })); } } }),
    refreshFlow({ over: { mutate: (a) => { a.actions[0].inputs.push(input('assigned_to', abel, { reference: 'sys_user', display: 'Abel Tuter' })); } } }),
  );
  const md = C.renderComparison({
    artifact: { name: 'F' }, baseline: {}, current: {}, changes: r.changes, summary: r.summary,
    complete: true, risk: r.risk.risk, impact: [], dependencies: r.deps, test: {}, deployment: {},
  });
  assert.match(md, /### Labels only/);
  assert.match(md, /identity is unchanged/);
  assert.match(md, /### No semantic changes/);
});

/* ================================================================== *
 * REGRESSIONS — each of these is a defect that reached the code
 * ================================================================== */

/** A flow carrying branch containers and a subflow call, as the reader emits them. */
function withStructure({ branchDef = 'if-def-sys-id', callTarget = 's'.repeat(32), wait = true, extra = {} } = {}) {
  const a = refreshFlow({ over: extra });
  a.logic = [
    { sys_id: 'L1', order: 1, definition: branchDef, definition_label: 'If', ui_id: 'branch-1', parent_ui_id: null, comment: null },
    { sys_id: 'L2', order: 2, definition: 'else-def', definition_label: 'Else', ui_id: 'branch-2', parent_ui_id: 'branch-1', comment: null },
  ];
  a.subflow_calls = [{
    sys_id: 'C1', order: 5, subflow: callTarget, subflow_name: 'Check Intake Status',
    wait, ui_id: 'call-1', parent_ui_id: null, inputs: { request: '{{Created_1.current}}' },
  }];
  return a;
}

test('G1 — §63.3: a REPOINTED SUBFLOW CALL is a change, not silence', () => {
  /*
   * FOUND BY REVIEW, and it was the worst defect in the phase. `readFlowArtifact`
   * returns `subflow_calls` and `normalizeFlow` discarded them, so a flow whose
   * call was repointed at a different subflow hashed identically and reported
   * "the two states are identical".
   */
  const before = withStructure({ callTarget: 'a'.repeat(32) });
  const after = withStructure({ callTarget: 'b'.repeat(32) });
  const r = compare(before, after);

  const c = r.real.find((x) => x.path.startsWith('calls[') && x.path.endsWith('.target'));
  assert.ok(c, `a repointed subflow call vanished: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(c.before, 'a'.repeat(32));
  assert.equal(c.after, 'b'.repeat(32));
  assert.ok(c.categories.includes('DEPENDENCY'));
  assert.notEqual(C.hashArtifact(r.b), C.hashArtifact(r.a), 'the hash did not move for a repointed call');
  /* And it moves the dependency set, because it is one. */
  assert.ok(r.deps.added.some((d) => d.kind === 'subflow' && d.target === 'b'.repeat(32)));
  assert.ok(r.deps.removed.some((d) => d.kind === 'subflow' && d.target === 'a'.repeat(32)));
});

test('G2 — §19 applies to a subflow too: a renamed target is not a change', () => {
  const before = withStructure();
  const after = withStructure();
  after.subflow_calls[0].subflow_name = 'Check Intake Status (v2)';
  const r = compare(before, after);
  assert.equal(r.real.length, 0, `a renamed subflow was counted: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(C.hashArtifact(r.b), C.hashArtifact(r.a));
  assert.ok(r.changes.some((x) => x.display_only && x.path.startsWith('calls[')));
});

test('G3 — a call that stops waiting for its subflow is a behaviour change', () => {
  const r = compare(withStructure({ wait: true }), withStructure({ wait: false }));
  const c = r.real.find((x) => x.path.endsWith('.wait'));
  assert.ok(c, `a wait change vanished: ${JSON.stringify(pathsOf(r))}`);
  assert.match(c.note, /no longer waits/);
});

test('G4 — a call whose INPUT changed is found', () => {
  const before = withStructure();
  const after = withStructure();
  after.subflow_calls[0].inputs = { request: '{{Created_1.current.source_record}}' };
  const r = compare(before, after);
  assert.ok(r.real.some((x) => x.path === 'calls[call-1].inputs.request'));
});

test('G5 — §63.3: a BRANCH CONTAINER added, removed or retyped is a change', () => {
  const added = compare(refreshFlow(), withStructure());
  assert.equal(added.real.filter((x) => x.element === 'branch' && x.kind === 'ADDED').length, 2,
    `branch containers were invisible: ${JSON.stringify(pathsOf(added))}`);

  const retyped = compare(withStructure({ branchDef: 'if-def-sys-id' }), withStructure({ branchDef: 'foreach-def' }));
  const c = retyped.real.find((x) => x.path === 'branches[branch-1].definition');
  assert.ok(c, 'a retyped container vanished');
  assert.equal(c.before, 'if-def-sys-id');
  assert.equal(c.after, 'foreach-def');
});

test('G6 — §40: a flow with branch containers is INCOMPLETE, because their conditions are not read', () => {
  const n = norm(withStructure());
  assert.equal(n.complete, false, 'a flow whose branch conditions are unread reported complete');
  assert.ok(n.gaps.some((g) => /conditions inside them are not read/.test(g)));

  /* And that honesty propagates: every change in such a comparison is UNKNOWN. */
  const r = compare(withStructure({ branchDef: 'a' }), withStructure({ branchDef: 'b' }));
  assert.equal(r.raw.complete, false);
  assert.equal(r.real.every((x) => x.status === 'UNKNOWN'), true);
});

test('G7 — §63.2: inserting ONE step does not report every later step as moved', () => {
  /*
   * FOUND BY REVIEW. Position was compared by ARRAY INDEX, so inserting a step
   * at the front shifted every later index and produced one addition plus a
   * move of every following step. On a twenty-step flow that is nineteen false
   * positives from one real edit.
   */
  const after = refreshFlow({ over: { mutate: (a) => {
    a.actions.unshift(action({ sys_id: 'z'.repeat(32), order: 0, ui_id: 'inserted-step', type_name: 'Log' }));
  } } });
  const r = compare(refreshFlow(), after);

  assert.equal(r.summary.added, 1, `expected one addition: ${JSON.stringify(pathsOf(r))}`);
  assert.equal(r.summary.moved, 0, `an insertion reported ${r.summary.moved} spurious move(s)`);
  assert.equal(r.real.length, 1);

  /* A REAL reorder is still caught — the fix must not blind it. */
  const reordered = compare(refreshFlow(), refreshFlow({ over: { mutate: (a) => {
    a.actions[0].order = 3;
    a.actions[2].order = 1;
  } } }));
  assert.equal(reordered.summary.moved, 2);
});

test('G8 — §21: a newly ADDED step that writes a derived field is assessed', async () => {
  /*
   * FOUND BY REVIEW. The "was this write touched" filter matched an edited
   * input and not a whole new step, so the one case where a derived-field
   * warning matters most — somebody just added a step that writes `priority` —
   * produced no finding at all.
   */
  const before = refreshFlow({ over: { triggerTable: 'incident' } });
  const after = refreshFlow({ over: { triggerTable: 'incident', mutate: (a) => {
    a.actions.push(action({
      sys_id: 'z'.repeat(32), order: 4, ui_id: 'new-write', type_name: 'Update Record',
      inputs: [
        input('record', '{{Created_1.current}}', { type: 'document_id' }),
        input('table_name', 'incident', { type: 'table_name' }),
        input('values', 'priority=1', { type: 'template_value' }),
      ],
    }));
  } } });

  const r = compare(before, after);
  const impact = await C.schemaImpact({
    changes: r.changes, current: r.a,
    ctx: { derivationOf, fieldsOf: async () => new Map([['priority', { name: 'priority' }]]) },
  });
  assert.ok(impact.some((f) => f.kind === 'derived_field'),
    `an added step writing a derived field produced no finding: ${JSON.stringify(impact.map((f) => f.kind))}`);
});

test('G9 — §36: a baseline read off the instance is labelled LIVE, not CAPTURED_ARTIFACT', async () => {
  const found = await C.findBaseline({
    flowSysId: LIVE_ID,
    explicitSysId: SNAP_ID,
    readArtifact: async () => snapshotOf(),
  });
  assert.equal(found.ok, true);
  assert.equal(found.state.source, 'LIVE',
    'a state this build read was labelled as one it had captured');
  assert.equal(found.chosen, 'explicit');
});

test('G10 — §24: retyping a step INTO a destructive action is HIGH, like adding one', () => {
  const r = compare(refreshFlow(), refreshFlow({ over: { middleType: 'Delete Record' } }));
  const c = r.real.find((x) => x.path.endsWith('.type'));
  assert.ok(c);
  assert.equal(c.risk, 'HIGH', 'retyping into a destructive action scored below adding one');
  assert.equal(c.rule, 'destructive_added');

  /* And a step that was ALREADY destructive and stays destructive is not
   * re-flagged as though the change introduced it. */
  const stillDestructive = compare(
    refreshFlow({ over: { middleType: 'Delete Record' } }),
    refreshFlow({ over: { middleType: 'Remove Record' } }),
  );
  const d = stillDestructive.real.find((x) => x.path.endsWith('.type'));
  assert.notEqual(d.rule, 'destructive_added');
});

test('G11 — §28: two timestamp formats are compared as times, not as text', () => {
  /*
   * FOUND BY REVIEW. ServiceNow writes `2026-09-07 10:00:00` and a capture time
   * is ISO. Compared as strings, the space sorts before the T, so every
   * execution on the same day was declared to predate the baseline — attributing
   * recent runs to the version being compared against.
   */
  const laterSameDay = C.executionContext({
    executions: [{ started_at: '2026-09-07 10:00:00', state: 'EXECUTION_COMPLETE' }],
    baselineCapturedAt: '2026-09-07T00:00:00Z',
  });
  assert.equal(laterSameDay.attributable_to_baseline, false,
    'an execution AFTER the capture was attributed to the baseline');
  assert.match(laterSameDay.note, /Nothing establishes which/);

  const genuinelyEarlier = C.executionContext({
    executions: [{ started_at: '2026-09-06 10:00:00', state: 'EXECUTION_COMPLETE' }],
    baselineCapturedAt: '2026-09-07T00:00:00Z',
  });
  assert.equal(genuinelyEarlier.attributable_to_baseline, true);

  /* An unparseable stamp makes the set unattributable rather than comparing as text. */
  assert.equal(C.executionContext({
    executions: [{ started_at: 'sometime', state: 'x' }],
    baselineCapturedAt: '2026-09-07T00:00:00Z',
  }).attributable_to_baseline, false);
});

test('G12 — an INCOMPLETE comparison is never told the states are identical', () => {
  /*
   * FOUND BY REVIEW, in two places at once: the deployment note and the report
   * both claimed identity for a comparison that had not read the whole artifact.
   */
  const partial = {
    complete: false, summary: { total: 0, unchanged: 3 },
    artifact: { name: 'F' }, baseline: {}, current: {},
    changes: [], risk: 'UNKNOWN', impact: [], dependencies: { added: [], removed: [] },
    test: {}, unreadable: ['current: a section could not be read'],
  };
  const handoff = C.deploymentHandoff(partial);
  assert.equal(handoff.available, false);
  assert.match(handoff.note, /incomplete comparison/);
  assert.equal(/semantically identical/.test(handoff.note), false,
    'an incomplete comparison claimed the two states are identical');

  const md = C.renderComparison({ ...partial, deployment: handoff });
  assert.match(md, /### PARTIAL/);
  assert.equal(/The two states are identical/.test(md), false);
  assert.match(md, /Nothing differs in the sections that could be read/);
});

test('G13 — §35: a "snapshot version" question is a COMPARISON, not a capture', () => {
  /*
   * FOUND BY REVIEW. `snapshot` was a capture verb, so "show me the snapshot
   * version of this flow" — a natural way to ask for a diff, given that the
   * baseline IS a snapshot — skipped the comparison and wrote a baseline.
   */
  assert.equal(C.readMode('Show me the snapshot version of this flow.'), 'ANALYZE');
  assert.equal(C.readMode('Compare this flow with its snapshot version.'), 'ANALYZE');
  /* And a real capture request still is one. */
  assert.equal(C.readMode('Save the current version as a baseline.'), 'CAPTURE_BASELINE');
  assert.equal(C.readMode('Capture this flow as the baseline.'), 'CAPTURE_BASELINE');
  assert.equal(C.readMode('Remember the current state as a baseline.'), 'CAPTURE_BASELINE');
});

test('G14 — §35: a captured baseline does not render as a comparison', () => {
  const md = C.renderComparison({
    artifact: { type: 'flow', sys_id: LIVE_ID, name: 'Change - Refresh Impacted Services' },
    current: { source: 'LIVE', version: { id: 'abc123456789', derived: true } },
    baseline: null,
    captured_baseline: { hash: 'f'.repeat(64), source: 'LIVE', captured_at: '2026-09-07T00:00:00Z' },
    changes: [], summary: null, complete: true, risk: 'LOW',
    impact: [], dependencies: { added: [], removed: [] }, test: {}, deployment: {},
  });
  assert.match(md, /### Baseline captured/);
  assert.equal(/The two states are identical/.test(md), false,
    'a run that compared nothing claimed the two states are identical');
  assert.match(md, /Nothing was compared/);
  assert.match(md, /No changes have been deployed\./);
});

test('G15 — §40: an action read that hit its ceiling is a stated gap', () => {
  /*
   * FOUND BY REVIEW, in Phase 16 code this phase depends on: the action read
   * stopped at a hundred and said nothing, so a larger flow normalised to its
   * first hundred steps and compared clean against anything sharing them.
   */
  const src = fs.readFileSync(new URL('../src/servicenow/flow-artifact.js', import.meta.url), 'utf8');
  assert.match(src, /actionsTruncated/, 'the truncation is not detected');
  assert.match(src, /only the first \$\{ACTION_LIMIT\} were read/, 'the truncation is not stated as a gap');
  assert.match(src, /limit: ACTION_LIMIT \+ 1/, 'truncation is guessed from a full page rather than observed');
});

test('G16 — exactly one terminal frame leaves a comparison stream', async () => {
  /*
   * FOUND ON REVIEW OF THE WIRING, and it is the second time this build has
   * made it — Phase 17 had the same defect on its own route. The domain and the
   * route both emitted `change_complete`, so two terminal frames reached one
   * stream and the client had to key on the payload to tell them apart.
   *
   * The domain now says `change_decided` — the verdict is known — and the route
   * says `change_complete` — the stream is over.
   */
  const frames = [];
  await C.compareFlow({
    request: 'What changed in the flow?',
    taskId: 'frames',
    find: async () => ({ ok: true, sys_id: LIVE_ID, name: 'Change - Refresh Impacted Services' }),
    readArtifact: async (id) => (id === SNAP_ID ? snapshotOf() : refreshFlow()),
    findSnapshot: async () => ([{ sys_id: SNAP_ID, version: '2', created_on: '2025-10-16 13:48:38' }]),
    at: '2026-09-07T00:00:00Z',
    emit: (e) => frames.push(e.type),
  });
  assert.equal(frames.filter((f) => f === 'change_complete').length, 0,
    'the domain emitted a terminal frame that belongs to the route');
  assert.equal(frames.filter((f) => f === 'change_decided').length, 1);

  const domain = fs.readFileSync(new URL('../src/agent/change/index.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/plan.js', import.meta.url), 'utf8');
  assert.equal(/emit\(\{\s*type: 'change_complete'/.test(domain), false,
    'the domain emits the terminal frame again');
  assert.equal((route.match(/type: 'change_complete'/g) ?? []).length, 1,
    'the route no longer emits exactly one terminal frame');
});

/* ================================================================== *
 * §57 / §63.13 — SECRETS NEVER REACH A DIFF, AN EVIDENCE ENTRY OR A
 * STORED BASELINE
 * ================================================================== */

const secretFlow = (password, apiKey) => ({
  flow: { sys_id: 'a'.repeat(32), name: 'Credentialed', active: true, type: 'flow' },
  triggers: [], gaps: [], logic: [], subflow_calls: [],
  actions: [{
    sys_id: 'b'.repeat(32), order: 1, type_name: 'REST Step',
    ui_id: 'step-1', parent_ui_id: null, inputs_readable: true,
    inputs: [
      { name: 'password', supplied: password, display: password, type: 'string' },
      { name: 'short_description', supplied: 'an = sign is not a field map', type: 'string' },
      { name: 'table_name', supplied: 'incident', type: 'table_name' },
      { name: 'values', supplied: `api_key=${apiKey}^state=2`, type: 'template_value' },
    ],
  }],
});

test('S1 — a credential in an input never appears in the normalised form', () => {
  /*
   * FOUND BY AUDIT, not by a test that already existed. `agent/change/` did not
   * redact at all: a flow input named `password` carried its value into the
   * diff, into every evidence entry, into the rendered report and into the
   * baseline stored in `agent_tasks.metadata_json`.
   *
   * The fix is at the NORMALISATION boundary rather than at each exit, so there
   * is no path by which a caller gets the plaintext and forgets to mask it.
   */
  const n = C.normalizeFlow(secretFlow('hunter2', 'sk-live-9999'));
  const json = JSON.stringify(n);
  assert.equal(json.includes('hunter2'), false, 'a password reached the normalised form');
  assert.equal(json.includes('sk-live-9999'), false, 'an api key inside a field map reached the normalised form');
  assert.match(n.steps[0].inputs.password.value, /^\[redacted\]:/);
  assert.equal(n.steps[0].inputs.password.display, '[redacted]');
  assert.equal(n.steps[0].inputs.password.secret, true);
});

test('S2 — a credential inside a field map is masked field by field', () => {
  /*
   * The input is called `values`, which reveals nothing. Masking by input name
   * alone left `api_key=sk-live-9999` in place — the real shape a ServiceNow
   * credential takes in an Update Record.
   */
  const n = C.normalizeFlow(secretFlow('pw', 'sk-live-9999'));
  assert.match(n.steps[0].inputs.values.value, /^api_key=\[redacted\]:[0-9a-f]{16}\^state=2$/);
  const write = n.writes.find((w) => w.field === 'api_key');
  assert.equal(write.secret, true);
  assert.match(write.value, /^\[redacted\]:/);
  /* The non-secret half of the same map is untouched — masking everything would
   * be its own defect. */
  assert.equal(n.writes.find((w) => w.field === 'state').value, '2');
});

test('S3 — a plain value containing "=" is not mangled into a field map', () => {
  const n = C.normalizeFlow(secretFlow('pw', 'k'));
  assert.equal(n.steps[0].inputs.short_description.value, 'an = sign is not a field map');
});

test('S4 — masking preserves comparability: equal secrets match, rotated ones do not', () => {
  /*
   * THE TRAP THIS AVOIDS. Replacing every secret with one constant would make
   * two DIFFERENT passwords compare equal — a real semantic change silently
   * normalised away, which §63.3 makes its own release blocker. A digest of the
   * value preserves equality and nothing else.
   */
  const a = C.normalizeFlow(secretFlow('hunter2', 'sk-1'));
  const same = C.normalizeFlow(secretFlow('hunter2', 'sk-1'));
  const rotatedPw = C.normalizeFlow(secretFlow('ROTATED', 'sk-1'));
  const rotatedKey = C.normalizeFlow(secretFlow('hunter2', 'sk-2'));

  assert.equal(C.hashArtifact(a), C.hashArtifact(same));
  assert.notEqual(C.hashArtifact(a), C.hashArtifact(rotatedPw), 'a rotated password did not move the hash');
  assert.notEqual(C.hashArtifact(a), C.hashArtifact(rotatedKey), 'a rotated api key did not move the hash');

  assert.equal(C.diffFlows(a, same).changes.length, 0);
  const rotated = C.diffFlows(a, rotatedPw);
  assert.equal(rotated.changes.length, 1, 'rotating a credential must still be reported as a change');
  assert.equal(rotated.changes[0].path, 'steps[step-1].inputs.password');
});

test('S5 — the rendered report and the stored comparison carry no plaintext', async () => {
  const changed = await C.compareFlow({
    request: 'What changed in the flow?',
    taskId: 'secrets',
    find: async () => ({ ok: true, sys_id: 'a'.repeat(32), name: 'Credentialed' }),
    readArtifact: async (id) => (id === 'c'.repeat(32)
      ? secretFlow('OLD-PASSWORD', 'sk-old-1111')
      : secretFlow('NEW-PASSWORD', 'sk-new-2222')),
    findSnapshot: async () => ([{ sys_id: 'c'.repeat(32), version: '2', created_on: '2025-01-01 00:00:00' }]),
    at: '2026-09-07T00:00:00Z',
  });

  const everything = JSON.stringify(changed) + C.renderComparison(changed);
  for (const secret of ['OLD-PASSWORD', 'NEW-PASSWORD', 'sk-old-1111', 'sk-new-2222']) {
    assert.equal(everything.includes(secret), false, `${secret} leaked into the comparison or its report`);
  }
  /* And the change is still REPORTED — a leak fixed by hiding the finding
   * would be worse than the leak. */
  assert.ok(changed.summary.total >= 1, 'rotating both credentials produced no change at all');
});
