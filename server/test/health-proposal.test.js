import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProposal, validateProposalReply, planFromProposal, proposalFingerprint,
  executableChanges, CHANGE_STATUS, FIX_FIELD,
} from '../src/health/proposal.js';

/*
 * Health Assist — the approval-first remediation flow.
 *
 * The architecture changed shape here: the AI may now propose a fix for ANY
 * finding, including the ones whose remedy is a judgement call, and the
 * boundary moved to the approval instead. These tests guard the properties
 * that make that safe — that a proposal changes nothing, that what executes is
 * what was approved, and that a model cannot widen the blast radius.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const finding = (over = {}) => ({
  fingerprint: 'f1',
  rule_id: 'CMDB-OWNER',
  domain: 'CMDB',
  table: 'cmdb_ci',
  severity: 'MEDIUM',
  title: 'CI has no owner: web-01',
  description: 'The owned_by field is empty in the extracted record.',
  target_ids: ['a'.repeat(32), 'b'.repeat(32)],
  evidence: [{ sn_table: 'cmdb_ci', sn_sys_id: 'a'.repeat(32), field_name: 'owned_by', field_value: '' }],
  ...over,
});

/** A record the way the Table API returns it with display values on. */
const row = (over = {}) => ({
  sys_id: { value: 'a'.repeat(32) },
  name: { value: 'web-01', display_value: 'web-01' },
  owned_by: { value: '', display_value: '' },
  managed_by: { value: 'u1', display_value: 'David Loo' },
  ...over,
});

const readRecord = async () => row();

/* ── A proposal changes nothing ────────────────────────────────────────── */

test('building a proposal performs no write, only reads', async () => {
  /*
   * Asserted by what it is GIVEN: the only instance access `buildProposal`
   * has is the `readRecord` it is handed. It imports no client, so there is no
   * other route to the platform from inside it.
   */
  const SRC = fs.readFileSync(path.resolve(__dirname, '../src/health/proposal.js'), 'utf8');
  assert.equal(/servicenow\//.test(SRC), false, 'proposal.js reaches the instance on its own');
  assert.equal(/\btable\.(create|update|remove)\b/.test(SRC), false, 'proposal.js writes');

  let writes = 0;
  await buildProposal(finding(), {
    readRecord: async () => { return row(); },
    resolveReference: async () => ({ matches: [] }),
    generate: async () => { writes += 0; return ''; },
  });
  assert.equal(writes, 0);
});

test('a model failure still produces a reviewable proposal, with blank values', async () => {
  // "The model was down" is not a reason to invent a value, and it is not a
  // reason to show the user nothing either.
  const p = await buildProposal(finding(), {
    readRecord,
    generate: async () => { throw new Error('ollama is not running'); },
  });
  assert.equal(p.llm.status, 'unavailable');
  assert.equal(p.changes.length, 2);
  for (const c of p.changes) {
    assert.equal(c.proposedValue, '');
    assert.equal(c.status, CHANGE_STATUS.NEEDS_VALUE);
  }
  assert.equal(executableChanges(p).length, 0, 'a blank proposal was considered executable');
});

/* ── The model may not widen the blast radius ──────────────────────────── */

test('a reply naming a record that was never sent is rejected WHOLE', () => {
  /*
   * Higher stakes than the summary path: these values are headed for a write.
   * A model that fabricated one target is not keying off the input, so its
   * other entries cannot be trusted either.
   */
  const known = new Set(['a'.repeat(32)]);
  const bad = JSON.stringify({
    changes: [
      { sys_id: 'a'.repeat(32), value: 'ok' },
      { sys_id: 'f'.repeat(32), value: 'invented' },
    ],
  });
  const r = validateProposalReply(bad, known);
  assert.equal(r.ok, false);
  assert.match(r.reason, /never sent/);
});

test('the model cannot choose the table or the field — the rule does', async () => {
  const p = await buildProposal(finding(), {
    readRecord,
    resolveReference: async () => ({ matches: [{ sys_id: 'u1', display: 'David Loo' }] }),
    generate: async () => JSON.stringify({
      summary: 's',
      // A model trying to retarget: a different table and field entirely.
      table: 'sys_user', field: 'name',
      changes: [{ sys_id: 'a'.repeat(32), value: 'David Loo', confidence: 0.8 }],
    }),
  });
  assert.equal(p.table, FIX_FIELD['CMDB-OWNER'].table);
  assert.equal(p.field, FIX_FIELD['CMDB-OWNER'].field);
  for (const c of p.changes) {
    assert.equal(c.table, 'cmdb_ci');
    assert.equal(c.field, 'owned_by');
  }
});

/* ── Reference resolution ──────────────────────────────────────────────── */

test('a named person is resolved to a real sys_id, never written as a name', async () => {
  /*
   * MEASURED on dev424910: the model found the answer in `managed_by` and
   * proposed nothing, because it knew `owned_by` holds a sys_id and it had a
   * name. Resolving through the app's own lookup is what closes that gap
   * without asking the model to invent an id.
   */
  const p = await buildProposal(finding(), {
    readRecord,
    resolveReference: async (t, q) => {
      assert.equal(t, 'sys_user');
      assert.equal(q, 'David Loo');
      return { matches: [{ sys_id: 'u'.repeat(32), display: 'David Loo' }] };
    },
    generate: async () => JSON.stringify({
      summary: 's',
      changes: finding().target_ids.map((id) => ({ sys_id: id, value: 'David Loo', confidence: 0.8 })),
    }),
  });
  for (const c of p.changes) {
    assert.equal(c.proposedValue, 'u'.repeat(32), 'a display name was left in a reference field');
    assert.equal(c.proposedDisplay, 'David Loo');
    assert.equal(c.resolvedFrom, 'David Loo');
    assert.equal(c.status, CHANGE_STATUS.READY);
  }
});

test('an AMBIGUOUS name is left blank with the candidates offered, never guessed', async () => {
  // Picking the first of several is exactly the invention this path avoids.
  const p = await buildProposal(finding(), {
    readRecord,
    resolveReference: async () => ({
      matches: [{ sys_id: 'u1', display: 'D Loo' }, { sys_id: 'u2', display: 'David Loo' }],
    }),
    generate: async () => JSON.stringify({
      summary: 's',
      changes: [{ sys_id: 'a'.repeat(32), value: 'Loo', confidence: 0.5 }],
    }),
  });
  const c = p.changes[0];
  assert.equal(c.proposedValue, '');
  assert.equal(c.status, CHANGE_STATUS.NEEDS_VALUE);
  assert.equal(c.candidates.length, 2);
  assert.match(c.resolutionNote, /matches 2 records/);
});

test('a name matching nothing is left blank and says so', async () => {
  const p = await buildProposal(finding(), {
    readRecord,
    resolveReference: async () => ({ matches: [] }),
    generate: async () => JSON.stringify({
      summary: 's', changes: [{ sys_id: 'a'.repeat(32), value: 'Nobody At All' }],
    }),
  });
  assert.equal(p.changes[0].proposedValue, '');
  assert.match(p.changes[0].resolutionNote, /matched no record/);
});

/* ── What is executable ────────────────────────────────────────────────── */

test('a removed change and a valueless change are both unexecutable', () => {
  const p = {
    ruleId: 'CMDB-OWNER',
    operation: 'update',
    changes: [
      { id: 'c1', table: 'cmdb_ci', sys_id: 'a', field: 'owned_by', proposedValue: 'u1', status: CHANGE_STATUS.READY },
      { id: 'c2', table: 'cmdb_ci', sys_id: 'b', field: 'owned_by', proposedValue: 'u2', status: CHANGE_STATUS.REMOVED },
      { id: 'c3', table: 'cmdb_ci', sys_id: 'c', field: 'owned_by', proposedValue: '', status: CHANGE_STATUS.NEEDS_VALUE },
    ],
  };
  const ex = executableChanges(p);
  assert.deepEqual(ex.map((c) => c.id), ['c1']);
});

/* ── The fingerprint is what makes "you approved this" true ────────────── */

test('editing a value changes the fingerprint; re-rendering does not', () => {
  /*
   * THE LOAD-BEARING PROPERTY. Approval sends the fingerprint the user was
   * looking at, and the server refuses if it disagrees with what it holds. So
   * an edit MUST move the hash, and a repaint must NOT.
   */
  const base = {
    ruleId: 'CMDB-OWNER',
    operation: 'update',
    changes: [{ id: 'c1', table: 'cmdb_ci', sys_id: 'a', field: 'owned_by', proposedValue: 'u1', status: 'ready' }],
  };
  const same = JSON.parse(JSON.stringify(base));
  assert.equal(proposalFingerprint(base), proposalFingerprint(same), 're-rendering invalidated an approval');

  const edited = JSON.parse(JSON.stringify(base));
  edited.changes[0].proposedValue = 'u2';
  assert.notEqual(proposalFingerprint(base), proposalFingerprint(edited), 'an edited value kept the old approval');
});

test('removing a change changes the fingerprint', () => {
  const base = {
    ruleId: 'R', operation: 'update',
    changes: [
      { id: 'c1', table: 't', sys_id: 'a', field: 'f', proposedValue: 'x', status: 'ready' },
      { id: 'c2', table: 't', sys_id: 'b', field: 'f', proposedValue: 'y', status: 'ready' },
    ],
  };
  const fewer = JSON.parse(JSON.stringify(base));
  fewer.changes[1].status = CHANGE_STATUS.REMOVED;
  assert.notEqual(proposalFingerprint(base), proposalFingerprint(fewer));
});

test('the fingerprint ignores ordering, so it is stable across re-reads', () => {
  const a = {
    ruleId: 'R', operation: 'update',
    changes: [
      { id: 'c1', table: 't', sys_id: 'a', field: 'f', proposedValue: 'x', status: 'ready' },
      { id: 'c2', table: 't', sys_id: 'b', field: 'f', proposedValue: 'y', status: 'ready' },
    ],
  };
  const b = { ...a, changes: [a.changes[1], a.changes[0]] };
  assert.equal(proposalFingerprint(a), proposalFingerprint(b));
});

/* ── The plan the executor receives ────────────────────────────────────── */

test('every step is a single record and carries a read-back assertion', () => {
  /*
   * One step per record, because the mutation pipeline verifies per step. A
   * batched step would read back as one result and hide a partial write —
   * which is the exact thing the user is told did not happen.
   */
  const p = {
    ruleId: 'CMDB-OWNER', title: 't', operation: 'update',
    changes: [
      { id: 'c1', table: 'cmdb_ci', sys_id: 'a', field: 'owned_by', proposedValue: 'u1', status: 'ready' },
      { id: 'c2', table: 'cmdb_ci', sys_id: 'b', field: 'owned_by', proposedValue: 'u2', status: 'ready' },
    ],
  };
  const plan = planFromProposal(p);
  assert.equal(plan.steps.length, 2);
  for (const s of plan.steps) {
    assert.equal(s.mutating, true);
    assert.equal(s.tool, 'update_record');
    assert.equal(s.verification.strategy, 'read_back');
    assert.ok(s.verification.asserts.length > 0, 'a write named no way to prove it worked');
    assert.ok(s.target.sys_id);
    assert.equal(Object.keys(s.inputs.data).length, 1, 'a step wrote more than the one approved field');
  }
});

test('a plan contains ONLY the approved changes', () => {
  const p = {
    ruleId: 'R', title: 't', operation: 'update',
    changes: [
      { id: 'c1', table: 't', sys_id: 'a', field: 'f', proposedValue: 'x', status: 'ready' },
      { id: 'c2', table: 't', sys_id: 'b', field: 'f', proposedValue: 'y', status: CHANGE_STATUS.REMOVED },
      { id: 'c3', table: 't', sys_id: 'c', field: 'f', proposedValue: '', status: CHANGE_STATUS.NEEDS_VALUE },
    ],
  };
  const plan = planFromProposal(p);
  assert.equal(plan.steps.length, 1, 'a removed or valueless change reached the plan');
  assert.equal(plan.steps[0].target.sys_id, 'a');
});

test('a delete step asserts absence rather than a value', () => {
  const p = {
    ruleId: 'REL-SELF', title: 't', operation: 'delete',
    changes: [{ id: 'c1', table: 'cmdb_rel_ci', sys_id: 'r1', field: null, fieldKind: 'delete', status: 'ready' }],
  };
  const [s] = planFromProposal(p).steps;
  assert.equal(s.tool, 'delete_record');
  assert.match(s.verification.asserts[0], /absent/);
});

/* ── The route surface ─────────────────────────────────────────────────── */

test('the user may edit a value but may NOT retarget a change', () => {
  /*
   * `table`, `sys_id` and `field` are carried over from the stored draft by id
   * rather than read from the request body. Editing the VALUE is the feature;
   * editing the TARGET would make the finding's own evidence stop describing
   * what is about to happen.
   */
  const ROUTE = fs.readFileSync(path.resolve(__dirname, '../src/routes/health.js'), 'utf8');
  assert.match(ROUTE, /const base = byId\.get\(c\?\.id\);/, 'the patch route no longer resolves changes by stored id');
  assert.match(ROUTE, /\.\.\.base,/, 'the patch route no longer carries the stored target over the request');
  assert.equal(/table:\s*c\.table/.test(ROUTE), false, 'the patch route takes the table from the request body');
  assert.equal(/sys_id:\s*c\.sys_id/.test(ROUTE), false, 'the patch route takes the sys_id from the request body');
});

test('approval is the only route that can lead to a write, and it delegates', () => {
  const ROUTE = fs.readFileSync(path.resolve(__dirname, '../src/routes/health.js'), 'utf8');
  // Generating, editing and rejecting touch our own database only.
  assert.match(ROUTE, /healthRouter\.post\('\/proposals\/:id\/approve'/);
  assert.match(ROUTE, /prepareRemediation/);
  assert.match(ROUTE, /runRemediation/);
  // And the router still never names the instance client.
  assert.equal(/servicenow\/client\.js/.test(ROUTE), false, 'the health router talks to the instance directly');
});

test('execution goes through the existing plan pipeline, not a second executor', () => {
  /*
   * A second executor would mean a second gate, a second read-back and a
   * second audit trail — three chances to be quietly weaker than the ones that
   * already exist.
   */
  const R = fs.readFileSync(path.resolve(__dirname, '../src/health/remediate.js'), 'utf8');
  for (const required of ['generatePlan', 'savePlan', 'executePlan', 'buildReview']) {
    assert.match(R, new RegExp(`\\b${required}\\b`), `remediation does not use ${required}`);
  }
  assert.equal(/table\.(create|update|remove)/.test(R), false, 'remediation writes directly');
  // A global auto-approve preference may not widen a specific approval.
  assert.match(R, /autoApprove: Boolean\(agent\?\.autoApprove\) && false/);
});

test('remediation cannot authorise its own execution — the route binds', () => {
  /*
   * `routes/` is the only place this system raises or binds an approval, so a
   * reader auditing "what can authorise a write" can read the routers and stop.
   *
   * An earlier shape passed `approvePlan` in as a callback. That was WORSE than
   * calling it here: the call then lived in the domain module under an alias,
   * where neither the approval inventory nor a reader of the router could see
   * it. Splitting prepare/run puts the binding somewhere both can.
   */
  const R = fs.readFileSync(path.resolve(__dirname, '../src/health/remediate.js'), 'utf8');
  /* Comments stripped first — this file DISCUSSES approvePlan at length, and
     the guard is about what the code does, not what it explains. Same shape as
     the architecture suite's own `body()`. */
  const code = R.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/approvePlan/.test(code), false, 'the domain module can authorise its own execution');
  assert.equal(/bindApproval|approveCallback/.test(code), false, 'the binding was smuggled in as a callback');
  assert.match(R, /export async function prepareRemediation/);
  assert.match(R, /export async function runRemediation/);

  const ROUTE = fs.readFileSync(path.resolve(__dirname, '../src/routes/health.js'), 'utf8');
  assert.match(
    ROUTE,
    /approvePlan\(prep\.taskId, prep\.planFingerprint, \{ source: 'user_click' \}\)/,
    'the route no longer binds the approval between prepare and run',
  );
});
