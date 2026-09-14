import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REMEDIATION, AI_ACTION, remediationFor, buildAgentPrompt, estimateEffort, referencedTables,
} from '../src/health/remediation.js';

/*
 * Health Assist — remediation guidance.
 *
 * The catalogue is the one part of this module written by hand rather than
 * derived, so these tests guard the two things a human author can get wrong:
 * promising a fix for a finding that does not contain one, and letting the
 * "Fix with AI" path quietly become a write that nobody approved.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_SRC = fs.readFileSync(path.resolve(__dirname, '../src/health/rules.js'), 'utf8');

/** Every rule id the rule pack can actually emit, read out of its source. */
/* Segments may carry digits — `ITSM-INC-P1-AGED` — which an uppercase-only
   pattern silently skipped, so that rule's guidance read as an orphan. A rule
   id still has to START with a letter, which keeps quoted dates out. */
const EMITTED_RULES = [...new Set(
  [...RULES_SRC.matchAll(/'([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1]),
)].filter((id) => /^[A-Z][A-Z0-9]*-[A-Z0-9-]+$/.test(id));

const finding = (over = {}) => ({
  fingerprint: 'f1',
  rule_id: 'CMDB-OWNER',
  domain: 'CMDB',
  table: 'cmdb_ci',
  severity: 'MEDIUM',
  title: 'CI has no owner: web-01',
  description: 'The owned_by field is empty in the extracted record.',
  target_ids: ['a1', 'a2'],
  evidence: [{ sn_table: 'cmdb_ci', sn_sys_id: 'a1', field_name: 'owned_by', field_value: '' }],
  ...over,
});

/* ── Coverage of the rule pack ─────────────────────────────────────────── */

test('every rule the pack can emit has hand-written remediation guidance', () => {
  // A missing entry is not fatal — there is an honest fallback — but it should
  // be a deliberate gap, not one nobody noticed.
  const missing = EMITTED_RULES.filter((id) => !REMEDIATION[id]);
  assert.deepEqual(missing, [], `no remediation entry for: ${missing.join(', ')}`);
});

test('the catalogue does not describe rules that do not exist', () => {
  // A stale entry is guidance for a finding nobody can ever see.
  const orphans = Object.keys(REMEDIATION).filter((id) => !EMITTED_RULES.includes(id));
  assert.deepEqual(orphans, [], `remediation exists for rules the pack cannot emit: ${orphans.join(', ')}`);
});

test('every entry is complete enough to render', () => {
  for (const [id, entry] of Object.entries(REMEDIATION)) {
    for (const field of ['headline', 'problem', 'why', 'decision', 'aiAction', 'manualSteps', 'verify', 'effort']) {
      assert.ok(entry[field], `${id} has no ${field}`);
    }
    assert.ok(Array.isArray(entry.manualSteps) && entry.manualSteps.length >= 3,
      `${id} has fewer than three manual steps — that is a recommendation, not instructions`);
    assert.ok(['human', 'mechanical'].includes(entry.decision), `${id} has an unknown decision kind`);
    assert.ok(entry.effort.basis, `${id} states an effort with no basis, so a reader cannot disagree with it`);
  }
});

/* ── The property that matters: a fix is only promised where one exists ── */

test('a finding needing human judgement is NEVER offered as an AI fix', () => {
  /*
   * THE DEFECT THIS PREVENTS. "This CI has no owner" does not say who owns it.
   * A Fix button there would be asking a model to invent an accountable party,
   * and the finding's own recommendation says the opposite — do not infer an
   * assignee automatically.
   */
  for (const [id, entry] of Object.entries(REMEDIATION)) {
    if (entry.decision === 'human') {
      assert.equal(entry.aiAction, AI_ACTION.INVESTIGATE,
        `${id} needs a human judgement but offers to fix itself`);
    }
  }
});

test('the ownership and duplicate rules are specifically marked as judgement calls', () => {
  // Named explicitly: these are the ones most tempting to automate.
  for (const id of ['CMDB-OWNER', 'CMDB-DUPLICATE', 'CSDM-OWNER', 'SEC-INACTIVE-ROLE', 'CUSTOM-BEFORE-UPDATE']) {
    assert.equal(REMEDIATION[id].decision, 'human', `${id} must not be automatable`);
  }
});

test('only findings that state their own fix are mechanical', () => {
  const mechanical = Object.entries(REMEDIATION).filter(([, e]) => e.decision === 'mechanical').map(([id]) => id);
  // A self-referencing edge and a duplicated edge are wrong in every estate.
  assert.deepEqual(mechanical.sort(), ['REL-DUPLICATE', 'REL-SELF']);
});

/* ── The generated prompt ──────────────────────────────────────────────── */

test('an investigate prompt forbids applying anything', () => {
  const entry = REMEDIATION['CMDB-OWNER'];
  const prompt = buildAgentPrompt(finding(), entry);
  assert.match(prompt, /INVESTIGATE AND PROPOSE/);
  assert.match(prompt, /Do not apply anything yet/);
  assert.match(prompt, /Do not guess a value on my behalf/);
});

test('a fix prompt still demands confirmation against live data and a read-back', () => {
  /*
   * The health check read a snapshot. By the time the agent runs, the record
   * may have moved — so even a mechanical fix confirms first, and reports what
   * actually landed rather than what it sent.
   */
  const entry = REMEDIATION['REL-SELF'];
  const prompt = buildAgentPrompt(finding({ rule_id: 'REL-SELF', table: 'cmdb_rel_ci' }), entry);
  assert.match(prompt, /confirm the finding against the live data before changing anything/);
  assert.match(prompt, /Read back every record you change/);
  assert.match(prompt, /approval gate/);
});

test('the prompt names the actual records, and caps how many it lists', () => {
  const many = Array.from({ length: 60 }, (_, i) => `sys${i}`);
  const prompt = buildAgentPrompt(finding({ target_ids: many }), REMEDIATION['CMDB-OWNER']);
  assert.match(prompt, /sys0/);
  assert.match(prompt, /25 of 60 shown/, 'the prompt does not say it truncated the list');
  assert.equal(prompt.includes('sys30'), false, 'the prompt listed more than the cap');
});

test('no prompt tells the agent to bypass the gate or to author an ACL', () => {
  for (const [id, entry] of Object.entries(REMEDIATION)) {
    const prompt = buildAgentPrompt(finding({ rule_id: id }), entry);
    for (const forbidden of [/auto[- ]approve/i, /without asking/i, /skip the approval/i, /sys_security_acl/i]) {
      assert.equal(forbidden.test(prompt), false, `${id}'s prompt contains ${forbidden}`);
    }
  }
});

/* ── The estimate ──────────────────────────────────────────────────────── */

test('manual effort scales with record count; agent effort does not', () => {
  /*
   * This is the honest shape of the difference: somebody opens each record by
   * hand, while one agent turn covers the batch and the human cost is reading
   * one approval card. It is why the saving grows with the size of a finding
   * rather than being a constant multiplier.
   */
  const one = estimateEffort(REMEDIATION['CMDB-OWNER'], 1);
  const fifty = estimateEffort(REMEDIATION['CMDB-OWNER'], 50);
  assert.equal(fifty.manualMinutes, one.manualMinutes * 50);
  assert.ok(fifty.aiMinutes < one.aiMinutes * 5, 'agent effort was modelled as scaling like manual effort');
  assert.ok(fifty.savedMinutes > one.savedMinutes);
});

test('the estimate always carries its basis and says it was not measured', () => {
  const e = estimateEffort(REMEDIATION['MID-DOWN'], 3);
  assert.ok(e.basis.length > 20);
  assert.match(e.disclaimer, /estimate, not a measurement/i);
  assert.match(e.disclaimer, /Neither was timed/);
});

test('a zero or missing record count never produces a nonsensical estimate', () => {
  for (const n of [0, undefined, null, -4]) {
    const e = estimateEffort(REMEDIATION['MID-DOWN'], n);
    assert.ok(e.manualMinutes > 0, `count ${n} produced ${e.manualMinutes} minutes`);
    assert.ok(e.savedMinutes >= 0);
  }
});

/* ── Referenced tables ─────────────────────────────────────────────────── */

test('the tables panel names the real table and the fields the evidence read', () => {
  const tables = referencedTables(finding(), REMEDIATION['CMDB-OWNER']);
  assert.equal(tables[0].table, 'cmdb_ci');
  assert.deepEqual(tables[0].fields, ['owned_by']);
  assert.equal(tables[0].inAllowList, true);
});

test('a finding with no evidence still lists the table it came from', () => {
  const tables = referencedTables(finding({ evidence: [] }), REMEDIATION['CMDB-OWNER']);
  assert.equal(tables[0].table, 'cmdb_ci');
  assert.ok(tables[0].fields.length > 0, 'the panel would render an empty field list');
});

/* ── The whole payload ─────────────────────────────────────────────────── */

test('remediationFor returns everything the detail view reads', () => {
  const r = remediationFor(finding());
  for (const key of [
    'headline', 'problem', 'why', 'decision', 'aiAction', 'aiActionLabel', 'decisionNote',
    'tables', 'manualSteps', 'verify', 'effort', 'prompt', 'known',
  ]) {
    assert.ok(r[key] !== undefined, `remediationFor omitted ${key}`);
  }
  assert.equal(r.known, true);
  assert.equal(r.aiActionLabel, 'Investigate with AI');
});

test('an unknown rule gets an honest fallback rather than an invented fix', () => {
  const r = remediationFor(finding({ rule_id: 'SOME-FUTURE-RULE' }));
  assert.equal(r.known, false, 'a rule with no entry was reported as documented');
  assert.equal(r.decision, 'human');
  assert.equal(r.aiAction, AI_ACTION.INVESTIGATE, 'an undocumented rule offered to fix itself');
  assert.match(r.problem, /does not have an entry in the remediation catalogue/);
  assert.match(r.why, /not a sign the finding is wrong/);
});

test('the mechanical label promises approval, not autonomy', () => {
  const r = remediationFor(finding({ rule_id: 'REL-SELF', table: 'cmdb_rel_ci' }));
  assert.equal(r.aiActionLabel, 'Fix with AI');
  assert.match(r.decisionNote, /you still approve the write at the gate/);
});
