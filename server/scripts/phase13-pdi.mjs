/**
 * PHASE 13 — THE ACCEPTANCE CRITERION, against the real instance.
 *
 *   node scripts/phase13-pdi.mjs
 *
 * "A real user can give SNADA a meaningful incident-management request in
 *  natural language, and SNADA can safely take it from natural language all the
 *  way to a verified real ServiceNow result without guessing."
 *
 * So the goals below are sentences, the MODEL plans them, and the real approval,
 * execution, read-back and evidence machinery runs. Nothing is hand-authored.
 *
 * DISPOSABLE ARTIFACTS. Every incident this script acts on is one it created,
 * and it deletes them in a finally block — including on failure. The user it
 * assigns to already exists and is not modified. Nothing pre-existing is
 * touched, and the script prints anything it could not clean up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p13pdi-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');

const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const created = [];          // everything this script must delete
let n = 0;
function newTask(goal) {
  const sid = `p13pdi-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

/** Plan the sentence with the real model, approve every card, run it. */
async function run(goal) {
  const gen = await P.generatePlan({ goal });
  if (!gen.ok) return { gen, cards: [], res: null, evidence: null };

  const { taskId, sessionId } = newTask(goal);
  const saved = P.savePlan(taskId, gen.plan);
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

  const cards = [];
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    emit: (e) => {
      if (e.type !== 'approval_required') return;
      cards.push(e);
      setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
    },
  });
  return { gen, cards, res, evidence: buildEvidence(taskId), taskId };
}

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log();

try {
  /* ---- seed two disposable incidents ---- */
  const MARK = `NOWFORGE P13 ${new Date().toISOString()}`;
  for (const suffix of ['A', 'B']) {
    const c = await toolMap.get('create_incident').execute(
      { short_description: `${MARK} ${suffix}`, description: 'NowForge Phase 13 acceptance. Safe to delete.' },
      { sessionId: 'p13-seed', turnSeq: 0 },
    );
    created.push({ table: 'incident', sys_id: c?.sys_id?.value ?? c?.sys_id, number: c?.number?.value ?? c?.number });
  }
  const [incA, incB] = created;
  console.log(`seeded   : ${incA.number} (${incA.sys_id})`);
  console.log(`           ${incB.number} (${incB.sys_id})`);
  console.log();

  /* ============================================================== *
   * 1. ASSIGN BY NAME — the sentence the whole phase is about
   * ============================================================== */
  {
    const goal = `Assign incident ${incA.number} to Abel Tuter.`;
    console.log(`goal     : ${goal}`);
    const { gen, cards, res, evidence } = await run(goal);

    ok('A1', 'The MODEL produced a plan the validator accepts', gen.ok,
      gen.ok ? '' : `${gen.reason}: ${(gen.fatal ?? []).map((p) => `${p.code}@${p.step}`).join(', ')}`);

    if (gen.ok) {
      const tools = gen.plan.steps.map((s) => s.tool);
      ok('A2', 'It RESOLVED the identity rather than guessing it',
        tools.includes('lookup_reference'),
        `steps: ${tools.join(' -> ')}`);

      const assignedTo = gen.plan.steps
        .map((s) => s.inputs?.data?.assigned_to)
        .find((v) => v !== undefined);
      ok('A3', 'The name never appears as a literal in the mutation payload',
        assignedTo && typeof assignedTo === 'object' && '$ref' in assignedTo,
        `assigned_to = ${JSON.stringify(assignedTo)}`);

      const card = cards.find((c) => (c.dataflow ?? []).length);
      ok('A4', 'The approval card showed the operation, the record and the resolved identity',
        Boolean(card) && Boolean(card.operation) && Boolean(card.target)
          && card.dataflow.some((d) => /^[0-9a-f]{32}$/i.test(String(d.resolved))),
        card
          ? `"${card.operation}" on ${JSON.stringify(card.target)} ; `
            + `${card.dataflow.map((d) => `${d.declared} = ${String(d.resolved).slice(0, 12)}…`).join(', ')}`
          : 'no card carried a resolved reference');

      const change = evidence.changes[0] ?? null;
      ok('A5', 'The write landed on the right incident and read back',
        res.ok && change?.sys_id === incA.sys_id && change?.verification_status === 'applied',
        change
          ? `${change.table}/${String(change.sys_id).slice(0, 10)}… verify=${change.verification_status} final=${evidence.final.status}`
          : `${res?.reason}: ${res?.note}`);

      const live = await table.get('incident', incA.sys_id, 'all');
      const got = live?.assigned_to?.value;
      ok('A6', 'An INDEPENDENT read confirms the correct person is assigned',
        /^[0-9a-f]{32}$/i.test(String(got)) && live?.assigned_to?.display_value === 'Abel Tuter',
        `assigned_to = ${JSON.stringify(live?.assigned_to)}`);
    }
  }

  /* ============================================================== *
   * 2. PRIORITY — the ledger trap, end to end
   * ============================================================== */
  console.log();
  {
    const goal = `Make incident ${incB.number} the highest priority we have.`;
    console.log(`goal     : ${goal}`);
    const { gen, res, evidence } = await run(goal);

    ok('B1', 'The model planned the priority request without writing priority', gen.ok,
      gen.ok ? '' : `${gen.reason}: ${(gen.fatal ?? []).map((p) => `${p.code}@${p.step}`).join(', ')}`);

    if (gen.ok) {
      const data = gen.plan.steps.map((s) => s.inputs?.data).find(Boolean) ?? {};
      ok('B2', 'It set impact and urgency, the fields that actually drive priority',
        data.impact !== undefined && data.urgency !== undefined && data.priority === undefined,
        `data = ${JSON.stringify(data)}`);

      ok('B3', 'It executed and verified',
        res.ok && evidence.changes[0]?.verification_status === 'applied',
        `final = ${evidence.final.status}`);

      const live = await table.get('incident', incB.sys_id, 'all');
      ok('B4', 'The PLATFORM computed priority from what was actually written',
        String(live?.priority?.value) === '1',
        `impact=${live?.impact?.value} urgency=${live?.urgency?.value} -> priority=${live?.priority?.value} `
        + '(never written by us)');
    }
  }

  /* ============================================================== *
   * 3. AN IDENTITY THAT DOES NOT EXIST — it must STOP
   * ============================================================== */
  console.log();
  {
    const goal = `Assign incident ${incA.number} to Zzz Nonexistent Person.`;
    console.log(`goal     : ${goal}`);
    const before = await table.get('incident', incA.sys_id, 'all');

    const { gen, res, evidence } = await run(goal);
    const planned = gen.ok;
    const executed = Boolean(res?.ok);

    ok('C1', 'The request did NOT produce a successful assignment',
      !executed,
      planned
        ? `planned, then stopped at execution: ${res?.reason ?? 'n/a'} — ${String(res?.note ?? '').slice(0, 120)}`
        : `refused at validation: ${(gen.fatal ?? []).map((p) => p.code).join(', ')}`);

    ok('C2', 'The failure is reported, not absorbed',
      !planned || ['FAILED', 'BLOCKED', 'UNVERIFIED', 'PARTIALLY_VERIFIED'].includes(evidence?.final?.status ?? 'FAILED'),
      `final = ${evidence?.final?.status ?? 'not executed'}`);

    const after = await table.get('incident', incA.sys_id, 'all');
    ok('C3', 'assigned_to was NOT overwritten with a dangling reference',
      after?.assigned_to?.value === before?.assigned_to?.value
        && !(after?.assigned_to?.value && !after?.assigned_to?.display_value),
      `before=${JSON.stringify(before?.assigned_to)} after=${JSON.stringify(after?.assigned_to)}`);
  }

  /* ============================================================== *
   * 4. THE DEFECT ITSELF — proof the platform would have accepted it
   * ============================================================== */
  console.log();
  {
    const probe = await toolMap.get('create_incident').execute(
      { short_description: 'NOWFORGE P13 dangling-reference proof — safe to delete' },
      { sessionId: 'p13-seed', turnSeq: 0 },
    );
    const sysId = probe?.sys_id?.value ?? probe?.sys_id;
    created.push({ table: 'incident', sys_id: sysId, number: probe?.number?.value ?? probe?.number });

    await table.update('incident', sysId, { assigned_to: 'Zzz Nonexistent Person' });
    const live = await table.get('incident', sysId, 'all');
    ok('D1', 'THE PLATFORM ACCEPTS a name in a reference field and stores it dangling',
      live?.assigned_to?.value === 'Zzz Nonexistent Person' && !live?.assigned_to?.display_value,
      `assigned_to = ${JSON.stringify(live?.assigned_to)} — this is why the validator refuses it before the write`);

    const v = P.validatePlan({
      goal: 'the refused shape',
      steps: [{
        id: 'step_1', operation: 'assign by name', capability: 'record_update', tool: 'update_record',
        mechanism: 'rest', scope: null, mutating: true,
        target: { table: 'incident', sys_id: sysId },
        inputs: { table: 'incident', sys_id: sysId, data: { assigned_to: 'Zzz Nonexistent Person' } },
        depends_on: [], expected_effects: ['assigned'],
        verification: { strategy: 'read_back', asserts: ['assigned_to is set'] },
      }],
    }, {
      discover: () => ({
        capability: 'record_update', status: 'known', available: true, mechanism: 'rest', mutating: true,
        verification: 'read_back', requiresVerification: true, requiresApproval: true,
        requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
      }),
    });
    ok('D2', 'SNADA refuses that exact write before it reaches the instance',
      !v.valid && v.fatal.some((p) => p.code === 'reference_field_not_an_identity'),
      v.fatal.map((p) => p.code).join(', ') || 'the plan was ACCEPTED');
  }
} catch (err) {
  console.log();
  console.log(`ABORTED: ${err.message}`);
  console.log(err.stack);
} finally {
  console.log();
  const failed = [];
  for (const rec of created) {
    if (!rec.sys_id) continue;
    try {
      await table.remove(rec.table, rec.sys_id);
      console.log(`cleaned up: ${rec.table}/${rec.sys_id} (${rec.number ?? '—'})`);
    } catch (err) {
      failed.push(`${rec.table}/${rec.sys_id} — ${err.message}`);
    }
  }
  if (failed.length) {
    console.log();
    console.log('CLEANUP FAILED — these records are still on the instance:');
    for (const f of failed) console.log(`  ${f}`);
  }
}

console.log();
const pass = results.filter((r) => r.ok).length;
console.log(`REAL MODEL + REAL PDI — pass ${pass}  fail ${results.length - pass}  of ${results.length}`);
