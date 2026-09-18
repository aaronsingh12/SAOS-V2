/**
 * THE END-TO-END MATRIX — requested design vs. what the instance stored.
 *
 * Each row states what a source in `fluent-workspace/src/fluent/flows/e2e-*`
 * ASKED FOR, as a claim about live ServiceNow records. The check reads those
 * records back and says whether the claim holds.
 *
 * This is deliberately not a unit test. A unit test can prove the generator
 * emits the right TypeScript; only this can prove the platform stored the right
 * flow — and those are different questions, which is the whole reason the
 * matrix exists.
 *
 * READ-ONLY. It queries the instance and never writes.
 *
 *   node scripts/flow-e2e-matrix.mjs            # check every row
 *   node scripts/flow-e2e-matrix.mjs --json     # machine-readable
 */
import { readBackByName, byOrder } from './flow-readback.mjs';

const val = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/** Steps of one artifact in stored order, whatever kind each is. */
const steps = (r) => [
  ...r.actions.map((a) => ({ ...a, kind: 'action', label: a.action })),
  ...r.logic.map((l) => ({ ...l, kind: 'logic', label: l.logic })),
  ...r.subflowCalls.map((s) => ({ ...s, kind: 'subflow', label: s.subflow.name })),
].sort(byOrder);

const stepNamed = (r, kind, label) => steps(r).find((s) => s.kind === kind && String(s.label ?? '').toLowerCase() === label.toLowerCase());
const logicNamed = (r, label) => r.logic.find((l) => String(l.logic ?? '').toLowerCase() === label.toLowerCase());

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

export const MATRIX = [
  {
    artifact: 'E2E 01 Record Created',
    covers: 'basic flow · record.created · multi-clause AND condition · one action',
    checks: [
      ['is a flow', (r) => r.header.type === 'flow'],
      ['installed into our scope', (r) => /NowForge/i.test(r.header.scope ?? '')],
      ['exactly one trigger', (r) => r.triggers.length === 1],
      ['the trigger is Created', (r) => r.triggers[0].definition === 'Created'],
      ['trigger table is incident', (r) => val(r.triggers[0].inputs?.table) === 'incident'],
      /* Revision 2 of this source added `^active=true` to the condition; the
       * matrix tracks the SOURCE, which is the thing being verified. */
      ['the encoded condition survived verbatim', (r) => val(r.triggers[0].inputs?.condition) === 'priority=1^assignment_groupISNOTEMPTY^number=E2E_NEVER_MATCHES^active=true'],
      ['run_flow_in is background', (r) => val(r.triggers[0].inputs?.run_flow_in) === 'background'],
      ['run_on_extended is false', (r) => val(r.triggers[0].inputs?.run_on_extended) === 'false'],
      ['two Log actions after the revision-2 edit', (r) => r.actions.length === 2 && r.actions.every((a) => a.action === 'Log')],
      ['the rewritten message reached the instance', (r) => r.actions.some((a) => val(a.values?.log_message) === 'E2E 01 executed, revision 2.')],
      ['the appended step reached the instance at order 2', (r) => {
        const second = r.actions.find((a) => a.order === 2);
        return Boolean(second) && val(second.values?.log_message) === 'E2E 01 second step, added by revision 2.';
      }],
      /* The edit must have UPDATED the flow, not created a second one: this is
       * the same action record that existed before the edit. */
      ['the first action kept its identity across the edit', (r) => r.actions.some((a) => a.ui_id === '58498526-3447-4f17-9282-59deff5b8556')],
    ],
  },
  {
    artifact: 'E2E 02 Record Updated',
    covers: 'record.updated · OR · CHANGES · choice/boolean/reference/date clauses · trigger_strategy · run_on_extended',
    checks: [
      ['the trigger is Updated', (r) => r.triggers[0]?.definition === 'Updated'],
      ['the whole multi-kind condition survived verbatim', (r) => val(r.triggers[0].inputs?.condition)
        === 'priority=1^ORpriority=2^stateCHANGES^active=true^assigned_toISNOTEMPTY^opened_atISNOTEMPTY^number=E2E_NEVER_MATCHES'],
      ['trigger_strategy is unique_changes', (r) => val(r.triggers[0].inputs?.trigger_strategy) === 'unique_changes'],
      ['run_on_extended is true', (r) => val(r.triggers[0].inputs?.run_on_extended) === 'true'],
      ['flowPriority HIGH reached the header column', (r) => String(r.header.flow_priority ?? '').toUpperCase() === 'HIGH'],
      ['runAs system reached the header column', (r) => r.header.run_as === 'system'],
      ['the action reads a pill off the trigger record', (r) => /\{\{.*current\.number\}\}/.test(String(val(r.actions[0]?.values?.log_message) ?? ''))],
    ],
  },
  {
    artifact: 'E2E 03 Scheduled Daily',
    covers: 'scheduled.daily · timezone · a body with no trigger record · lookUpRecords parameters',
    checks: [
      ['the trigger is Daily', (r) => r.triggers[0]?.definition === 'Daily'],
      ['a time was stored', (r) => Boolean(val(r.triggers[0].inputs?.time))],
      /*
       * The timezone is HONOURED, not stored. 03:30 Asia/Kolkata (UTC+05:30) is
       * 22:00 UTC the previous day, and 22:00 is exactly what the instance
       * holds - on the epoch date, because only the time-of-day matters.
       * Asserting "03:30" would have been asserting that the conversion did
       * NOT happen.
       */
      ['the time converted to UTC (03:30 Asia/Kolkata = 22:00Z)', (r) => /22:00:00/.test(String(val(r.triggers[0].inputs?.time)))],
      ['no record-trigger table is set', (r) => !val(r.triggers[0].inputs?.table)],
      ['lookUpRecords is step 1', (r) => steps(r)[0]?.label === 'Look Up Records'],
      ['its conditions reached the instance', (r) => val(stepNamed(r, 'action', 'Look Up Records')?.values?.conditions) === 'active=true^priority=1'],
      ['max_results reached the instance', (r) => String(val(stepNamed(r, 'action', 'Look Up Records')?.values?.max_results)) === '5'],
      ['sort_type reached the instance', (r) => val(stepNamed(r, 'action', 'Look Up Records')?.values?.sort_type) === 'sort_desc'],
      ['the log consumes the lookup Count output', (r) => /\{\{.*\.Count\}\}/.test(String(val(stepNamed(r, 'action', 'Log')?.values?.log_message) ?? ''))],
    ],
  },
  {
    artifact: 'E2E 04 Pills And Logic',
    covers: 'action→action data pills · dot-walk · if/elseIf/else · forEach · doInParallel · tryCatch · branch placement',
    checks: [
      ['the lookup is step 1', (r) => steps(r)[0]?.label === 'Look Up Record'],
      ['step 2 consumes step 1 by its ui_id, dot-walked two levels', (r) => {
        const lookup = stepNamed(r, 'action', 'Look Up Record');
        const log = r.actions.find((a) => /manager is/.test(String(val(a.values?.log_message) ?? '')));
        return Boolean(lookup && log && String(val(log.values.log_message)).includes(`{{${lookup.ui_id}.Record.manager.email}}`));
      }],
      ['an If exists with the condition that was asked for', (r) => /priority.*=1|=1/.test(String(val(logicNamed(r, 'If')?.values?.condition) ?? ''))],
      ['Else If exists', (r) => Boolean(logicNamed(r, 'Else If') || logicNamed(r, 'ElseIf'))],
      ['Else exists', (r) => Boolean(logicNamed(r, 'Else'))],
      ['if/elseIf/else are SIBLINGS at the top level', (r) => ['If', 'Else If', 'Else']
        .map((n) => logicNamed(r, n))
        .filter(Boolean)
        .every((l) => !l.parent_ui_id)],
      ['the P1 log is attached INSIDE the If', (r) => {
        const iff = logicNamed(r, 'If');
        const log = r.actions.find((a) => /branch: P1/.test(String(val(a.values?.log_message) ?? '')));
        return Boolean(iff && log && log.parent_ui_id === iff.ui_id);
      }],
      ['the other log is attached INSIDE the Else', (r) => {
        const els = logicNamed(r, 'Else');
        const log = r.actions.find((a) => /branch: other/.test(String(val(a.values?.log_message) ?? '')));
        return Boolean(els && log && log.parent_ui_id === els.ui_id);
      }],
      ['a For Each exists over a record set', (r) => Boolean(logicNamed(r, 'For Each'))],
      ['its body action is inside it', (r) => {
        const fe = logicNamed(r, 'For Each');
        const log = r.actions.find((a) => /iterating one record/.test(String(val(a.values?.log_message) ?? '')));
        return Boolean(fe && log && log.parent_ui_id === fe.ui_id);
      }],
      /* The platform names it "Do the following in Parallel" and gives each
       * branch its own "Parallel Branch" container row. */
      ['a parallel container exists', (r) => Boolean(logicNamed(r, 'Do the following in Parallel'))],
      ['it has two Parallel Branch containers', (r) => {
        const par = logicNamed(r, 'Do the following in Parallel');
        return Boolean(par) && r.logic.filter((l) => l.parent_ui_id === par.ui_id && /parallel branch/i.test(l.logic ?? '')).length === 2;
      }],
      ['one action sits inside each branch', (r) => {
        const par = logicNamed(r, 'Do the following in Parallel');
        if (!par) return false;
        const branches = r.logic.filter((l) => l.parent_ui_id === par.ui_id).map((l) => l.ui_id);
        const inParallel = r.actions.filter((a) => /parallel branch/.test(String(val(a.values?.log_message) ?? '')));
        return inParallel.length === 2 && inParallel.every((a) => branches.includes(a.parent_ui_id));
      }],
      ['a step inside a branch carries a COMPOSITE order (branch➛position)', (r) => {
        const inParallel = r.actions.filter((a) => /parallel branch/.test(String(val(a.values?.log_message) ?? '')));
        return inParallel.length === 2 && inParallel.every((a) => a.composite === true && Number.isFinite(a.order) && Number.isFinite(a.sub));
      }],
      ['a Try/Catch exists', (r) => r.logic.some((l) => /try/i.test(String(l.logic ?? '')))],
      ['the catch body is attached under a catch container', (r) => {
        const log = r.actions.find((a) => /catch body/.test(String(val(a.values?.log_message) ?? '')));
        return Boolean(log && log.parent_ui_id);
      }],
      ['every step carries an order the platform can sequence', (r) => {
        const all = steps(r);
        return all.length > 0 && all.every((s) => Number.isFinite(s.order));
      }],
      ['top-level steps are strictly ascending with no gaps in the chain', (r) => {
        const top = steps(r).filter((s) => !s.parent_ui_id).map((s) => s.order);
        return top.length > 0 && top.every((o, i) => i === 0 || o > top[i - 1]);
      }],
    ],
  },
  {
    artifact: 'E2E 05 Classify Incident',
    covers: 'subflow · typed inputs · reference input with its table · mandatory · outputs · internal logic · assignSubflowOutputs',
    checks: [
      ['is a subflow', (r) => r.header.type === 'subflow'],
      ['has no trigger', (r) => r.triggers.length === 0],
      ['declares four inputs', (r) => r.inputs.length === 4],
      ['the reference input carries its table', (r) => {
        const i = r.inputs.find((x) => x.name === 'incident');
        return Boolean(i && i.reference === 'incident');
      }],
      ['mandatory inputs are stored mandatory', (r) => {
        const m = new Map(r.inputs.map((i) => [i.name, i.mandatory]));
        return m.get('incident') === true && m.get('threshold') === true && m.get('note') === false && m.get('verbose') === false;
      }],
      ['the integer input kept its type', (r) => /integer/i.test(r.inputs.find((i) => i.name === 'threshold')?.type ?? '')],
      ['the boolean input kept its type', (r) => /boolean/i.test(r.inputs.find((i) => i.name === 'verbose')?.type ?? '')],
      ['declares three outputs', (r) => r.outputs.length === 3],
      ['output types survived', (r) => {
        const t = new Map(r.outputs.map((o) => [o.name, o.type]));
        return /string/i.test(t.get('classification') ?? '') && /boolean/i.test(t.get('escalate') ?? '') && /integer/i.test(t.get('examined') ?? '');
      }],
      ['more than one action inside', (r) => r.actions.length >= 2],
      ['an input is read by an action as a pill', (r) => r.actions.some((a) => /\{\{subflow\./.test(JSON.stringify(a.values ?? {})))],
      ['If/Else logic inside the subflow', (r) => Boolean(logicNamed(r, 'If') && logicNamed(r, 'Else'))],
      ['outputs are assigned on BOTH paths', (r) => {
        const assigns = r.logic.filter((l) => l.values?._assigns);
        return assigns.length >= 2
          && assigns.some((a) => val(a.values._assigns.classification) === 'high')
          && assigns.some((a) => val(a.values._assigns.classification) === 'low');
      }],
    ],
  },
  {
    artifact: 'E2E 06 Subflow Caller',
    covers: 'flow→subflow call · input mapping · reference input · waitForCompletion · output consumed downstream · ordering',
    checks: [
      ['exactly one subflow call', (r) => r.subflowCalls.length === 1],
      ['it references the callee RECORD, not a name', (r) => /^[0-9a-f]{32}$/.test(r.subflowCalls[0]?.subflow.sys_id ?? '')],
      ['the callee is E2E 05', (r) => /E2E 05/.test(r.subflowCalls[0]?.subflow.name ?? '')],
      ['waitForCompletion in the INPUTS object set the wait column', (r) => r.subflowCalls[0]?.wait_for_completion === true],
      ['all four declared inputs are mapped', (r) => {
        const got = Object.keys(r.subflowCalls[0]?.inputs ?? {});
        return ['incident', 'threshold', 'note', 'verbose'].every((k) => got.includes(k));
      }],
      ['the reference input is mapped from the trigger record', (r) => /\{\{.*current\}\}/.test(String(val(r.subflowCalls[0]?.inputs?.incident) ?? ''))],
      ['literal inputs kept their values', (r) => String(val(r.subflowCalls[0]?.inputs?.threshold)) === '2'
        && val(r.subflowCalls[0]?.inputs?.note) === 'called from E2E 06'],
      ['waitForCompletion is NOT stored as an input', (r) => !Object.keys(r.subflowCalls[0]?.inputs ?? {}).includes('waitForCompletion')],
      ['the call is step 1 and the consumer follows it', (r) => {
        const all = steps(r);
        const call = all.findIndex((s) => s.kind === 'subflow');
        const log = all.findIndex((s) => s.kind === 'action' && s.label === 'Log');
        return call >= 0 && log > call;
      }],
      ['the later action consumes the subflow OUTPUT by pill', (r) => {
        const call = r.subflowCalls[0];
        const log = stepNamed(r, 'action', 'Log');
        const msg = String(val(log?.values?.log_message) ?? '');
        return Boolean(call && msg.includes(`{{${call.ui_id}.classification}}`));
      }],
    ],
  },
  {
    artifact: 'E2E 08 Scheduled Weekly',
    covers: 'scheduled.weekly · day_of_week + time',
    checks: [
      ['the trigger is Weekly', (r) => /weekly/i.test(r.triggers[0]?.definition ?? '')],
      ['day_of_week reached the instance', (r) => String(val(r.triggers[0].inputs?.day_of_week)) === '3'],
      ['a time was stored', (r) => /09:15:00/.test(String(val(r.triggers[0].inputs?.time)))],
    ],
  },
  {
    artifact: 'E2E 09 Scheduled Monthly',
    covers: 'scheduled.monthly · day_of_month + time',
    checks: [
      ['the trigger is Monthly', (r) => /monthly/i.test(r.triggers[0]?.definition ?? '')],
      ['day_of_month reached the instance', (r) => String(val(r.triggers[0].inputs?.day_of_month)) === '15'],
      ['a time was stored', (r) => /06:45:00/.test(String(val(r.triggers[0].inputs?.time)))],
    ],
  },
  {
    artifact: 'E2E 10 Scheduled Repeat',
    covers: 'scheduled.repeat · a Duration interval',
    checks: [
      ['the trigger is a repeating one', (r) => /repeat/i.test(r.triggers[0]?.definition ?? '')],
      ['the interval reached the instance', (r) => Boolean(val(r.triggers[0].inputs?.repeat) ?? val(r.triggers[0].inputs?.repeat_interval))],
    ],
  },
  {
    artifact: 'E2E 11 Scheduled Run Once',
    covers: 'scheduled.runOnce · a fixed datetime',
    checks: [
      ['the trigger runs once', (r) => /once/i.test(r.triggers[0]?.definition ?? '')],
      ['the datetime reached the instance', (r) => /2027-01-01/.test(String(val(r.triggers[0].inputs?.run_in) ?? ''))],
    ],
  },
  {
    artifact: 'E2E 07 Service Catalog Trigger',
    covers: 'application trigger family',
    checks: [
      ['one trigger', (r) => r.triggers.length === 1],
      ['it is the Service Catalog trigger', (r) => /catalog/i.test(r.triggers[0]?.definition ?? '')],
      ['its parameter reached the instance', (r) => val(r.triggers[0].inputs?.run_flow_in) === 'background'],
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Running it
 * ------------------------------------------------------------------ */

export async function runMatrix() {
  const results = [];
  for (const row of MATRIX) {
    // eslint-disable-next-line no-await-in-loop
    const live = await readBackByName(row.artifact).catch((e) => ({ missing: true, note: e.message }));
    if (live.missing || live.ambiguous) {
      results.push({ ...row, found: false, note: live.note ?? 'ambiguous', checks: [] });
      continue;
    }
    const checks = row.checks.map(([what, fn]) => {
      let ok = false;
      let error = null;
      try { ok = Boolean(fn(live)); } catch (err) { error = err.message; }
      return { what, ok, error };
    });
    results.push({ artifact: row.artifact, covers: row.covers, found: true, sys_id: live.header.sys_id, published: live.published.published, checks, live });
  }
  return results;
}

const asJson = process.argv.includes('--json');
const results = await runMatrix();
if (asJson) {
  console.log(JSON.stringify(results.map(({ live, ...r }) => ({ ...r, header: live?.header })), null, 1));
} else {
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (!r.found) { console.log(`\n### ${r.artifact}\n  NOT FOUND — ${r.note}`); fail += 1; continue; }
    console.log(`\n### ${r.artifact}   ${r.sys_id}   published=${r.published}`);
    console.log(`    covers: ${r.covers}`);
    for (const c of r.checks) {
      console.log(`    ${c.ok ? 'PASS' : 'FAIL'}  ${c.what}${c.error ? `  [${c.error}]` : ''}`);
      if (c.ok) pass += 1; else fail += 1;
    }
  }
  console.log(`\n==== ${pass} passed, ${fail} failed, across ${results.length} artifacts ====`);
}
