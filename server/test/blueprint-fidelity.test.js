/**
 * WI-4 — THE ARTIFACT INSTALLED MUST BE THE ARTIFACT APPROVED.
 *
 * ═══ THE DEFECT, AS MEASURED ═══
 *
 * A blueprint for the onboarding subflow was produced by `design_flow_blueprint`
 * and approved. It named the artifact "Add Priority Check Work Note", declared a
 * reference input, and specified the work note
 * "Priority checked by onboarding subflow".
 *
 * What installed — and what is still on disk at
 * `fluent-workspace/src/fluent/flows/add-priority-check-work-note.now.ts` —
 * carries `TemplateValue({ work_notes: 'Priority check performed.' })`.
 *
 * The chain that allowed it:
 *
 *   1. `create_flow_live` read `description || blueprint`, so a call carrying
 *      BOTH — the normal case after a blueprint is approved — discarded the
 *      blueprint entirely.
 *   2. The only literal guard was `groundLiterals`, which keeps a claim only if
 *      it appears in the SPEC TEXT. With the blueprint discarded, the approved
 *      string was not in the spec, so it was never grounded and never enforced.
 *   3. Everything downstream was green: it compiled, it installed, and the
 *      verification spec was written by the same model that dropped the string.
 *
 * Nothing in the pipeline compared the built artifact to the approved one. These
 * tests are that comparison.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { blueprintPromises, checkBlueprintFidelity } from '../src/servicenow/codegen-guards.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/** The blueprint as approved, in the shape `design_flow_blueprint` returns. */
const ONBOARDING = {
  name: 'Add Priority Check Work Note',
  description: 'Checks an incident priority and records that the check happened.',
  inputs: [{ name: 'incident', type: 'reference', purpose: 'the incident to check' }],
  steps: [
    {
      order: 1,
      kind: 'action',
      flow_designer_action: 'Update Record',
      summary: 'Add the work note',
      config: { table: 'incident', work_notes: 'Priority checked by onboarding subflow' },
    },
  ],
};

/* ================================================================== *
 * What a blueprint promises
 * ================================================================== */

test('B1 — the approved name, inputs and written literals are extracted', () => {
  const p = blueprintPromises(ONBOARDING);
  assert.equal(p.name, 'Add Priority Check Work Note');
  assert.deepEqual(p.inputs, [{ name: 'incident', type: 'reference' }]);
  assert.deepEqual(p.literals, ['Priority checked by onboarding subflow']);
});

test('B2 — identifiers and encoded queries are NOT treated as written text', () => {
  /*
   * A table name, a field name and an encoded query all legitimately appear
   * TRANSFORMED in Fluent source — `table: 'incident'` becomes
   * `table_name: 'incident'`, a query becomes a template literal. Enforcing
   * them verbatim would fail correct sources, and a guard that fails correct
   * sources is a guard someone switches off.
   */
  const p = blueprintPromises({
    name: 'X',
    steps: [{
      config: {
        table: 'incident',
        field: 'work_notes',
        query: 'active=true^priority=1',
        templated: 'Priority is {{priority}} today',
        note: 'Priority checked by onboarding subflow',
      },
    }],
  });
  assert.deepEqual(p.literals, ['Priority checked by onboarding subflow']);
});

test('B3 — a blueprint with nothing checkable promises nothing, and never throws', () => {
  for (const bp of [null, undefined, {}, { steps: null }, { inputs: 'nope' }, 'a string']) {
    const p = blueprintPromises(bp);
    assert.ok(Array.isArray(p.literals) && Array.isArray(p.inputs));
  }
});

/* ================================================================== *
 * The comparison itself
 * ================================================================== */

test('B4 — THE MEASURED DEFECT: the real drifted source is rejected', () => {
  /*
   * The actual file that installed, read from disk. Not a paraphrase of it —
   * if someone regenerates this artifact correctly the fixture updates itself,
   * and if it drifts again this test says so in the same words the guard will.
   */
  const drifted = fs.readFileSync(
    path.join(HERE, 'fixtures', 'flow-corpus', 'add-priority-check-work-note.now.ts'),
    'utf8',
  );
  const p = blueprintPromises(ONBOARDING);
  const r = checkBlueprintFidelity(drifted, p);

  if (r.ok) {
    /* The source has since been regenerated to match. That is the fix landing,
     * not a broken test — assert the thing the acceptance actually asks for. */
    assert.ok(drifted.includes('Priority checked by onboarding subflow'));
    assert.ok(drifted.includes('incident'));
    return;
  }

  const kinds = r.drift.map((d) => d.kind);
  assert.ok(kinds.includes('literal'), `expected a literal drift, got ${kinds.join(',')}`);
  const lit = r.drift.find((d) => d.kind === 'literal');
  assert.equal(lit.approved, 'Priority checked by onboarding subflow');
  assert.match(r.diagnostic, /does not match the APPROVED blueprint/);
  /* And the diagnostic must tell the model not to "improve" the wording. */
  assert.match(r.diagnostic, /Do not paraphrase/);
});

test('B5 — a faithful source passes', () => {
  const faithful = `
    import { Subflow, wfa, action } from '@servicenow/sdk/automation'
    import { ReferenceColumn } from '@servicenow/sdk/core'
    export const addPriorityCheckWorkNote = Subflow(
      { name: 'Add Priority Check Work Note',
        inputs: { incident: ReferenceColumn({ referenceTable: 'incident' }) } },
      (params) => {
        wfa.action(action.core.updateRecord, {}, {
          values: TemplateValue({ work_notes: 'Priority checked by onboarding subflow' })
        })
      })`;
  const r = checkBlueprintFidelity(faithful, blueprintPromises(ONBOARDING));
  assert.equal(r.ok, true, JSON.stringify(r.drift));
  assert.equal(r.diagnostic, null);
});

test('B6 — a renamed artifact is drift, and so is a dropped input', () => {
  const renamed = `Subflow({ name: 'Priority Checker', inputs: {} }, () => {
    TemplateValue({ work_notes: 'Priority checked by onboarding subflow' }) })`;
  const r = checkBlueprintFidelity(renamed, blueprintPromises(ONBOARDING));
  assert.equal(r.ok, false);
  const kinds = r.drift.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['input', 'name']);
});

test('B7 — an input whose TYPE changed is drift', () => {
  /*
   * The reported symptom included a changed input type. Checked loosely — a
   * blueprint says "reference" and Fluent writes `ReferenceColumn` — so the
   * assertion is that the type word appears, not that the strings match.
   */
  const wrongType = `Subflow({ name: 'Add Priority Check Work Note',
      inputs: { incident: StringColumn({ label: 'Incident' }) } }, () => {
      TemplateValue({ work_notes: 'Priority checked by onboarding subflow' }) })`;
  const r = checkBlueprintFidelity(wrongType, blueprintPromises(ONBOARDING));
  assert.equal(r.ok, false);
  assert.deepEqual(r.drift.map((d) => d.kind), ['input_type']);
});

/* ================================================================== *
 * The wiring — a guard nothing calls is not a guard
 * ================================================================== */

test('B8 — an approved blueprint is no longer discarded when a description is present', () => {
  const tools = fs.readFileSync(path.join(SRC, 'agent', 'tools.js'), 'utf8');
  const site = tools.slice(tools.indexOf("name: 'create_flow_live'"));
  const body = site.slice(0, site.indexOf('\n  },\n'));

  assert.ok(!/description \|\| \(blueprint/.test(body),
    'create_flow_live still prefers the description and drops the approved blueprint');
  /* Both reach the generator, and the blueprint travels as STRUCTURE too. */
  assert.match(body, /blueprint: blueprint \|\| null/,
    'the blueprint is flattened to text only, so nothing can assert fidelity against it');
  assert.match(body, /APPROVED BLUEPRINT/);
});

test('B9 — the fidelity check runs in the PRE-BUILD gate, not after the install', () => {
  /*
   * The distinction that matters: a pre-build check means a drifted candidate
   * never compiles and never reaches the instance. The same check after an
   * install would be a report about something already deployed.
   */
  const fluent = fs.readFileSync(path.join(SRC, 'servicenow', 'fluent.js'), 'utf8');
  assert.match(fluent, /checkBlueprintFidelity\(source, promises\)/);
  assert.match(fluent, /stages\.push\('blueprint_fidelity'\)/);

  const gate = fluent.indexOf('const staticErrors = []');
  const check = fluent.indexOf('checkBlueprintFidelity(source, promises)');
  const build = fluent.indexOf('emit({ type: \'building\' })', gate);
  assert.ok(gate > -1 && check > gate, 'the fidelity check runs outside the static gate');
  if (build > -1) assert.ok(check < build, 'the fidelity check runs after the build');

  /* And the blueprint is threaded all the way down. */
  assert.match(fluent, /generateAndValidate\(spec, emit, \{ updates, artifactType, blueprint \}\)/);
});

test('B10 — a literal nested under config.fields is found, which is the shape the real generator emits', () => {
  /*
   * MEASURED, not imagined. `design_flow_blueprint` renders an Update Record
   * step as `config: { table, record, fields: { work_notes: '...' } }`, so the
   * one string that matters sits a level down. The first version of this
   * extractor read only top-level config values: it found `table`, found
   * `record`, and missed the work note entirely — which would have let exactly
   * the drift this guard exists to catch through a second time.
   */
  const p = blueprintPromises({
    name: 'Add Priority Check Work Note',
    inputs: [{ name: 'incident', type: 'reference' }],
    steps: [
      { order: 1, kind: 'if', config: { condition: "${inputs.incident.priority} != ''" } },
      {
        order: 2,
        kind: 'action',
        flow_designer_action: 'Update Record',
        config: { table: 'incident', record: '${inputs.incident}', fields: { work_notes: 'Priority checked by onboarding subflow' } },
      },
      { order: 3, kind: 'end', config: {} },
    ],
  });

  assert.deepEqual(p.literals, ['Priority checked by onboarding subflow'],
    'the nested work note was missed, or a template/identifier was treated as prose');
});

test('B11 — the walk terminates on depth and on cycles', () => {
  const deep = { config: {} };
  let node = deep.config;
  for (let i = 0; i < 40; i += 1) { node.next = {}; node = node.next; }
  node.leaf = 'Priority checked by onboarding subflow';
  assert.doesNotThrow(() => blueprintPromises({ steps: [deep] }));

  const cyclic = { a: 'Priority checked by onboarding subflow' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => blueprintPromises({ steps: [{ config: cyclic }] }));
});
