import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSourcesToInstance, rollUpSync, headerStatus } from '../src/servicenow/binding-status.js';
import { describeHeaderStatus, describeScope } from '../../client/src/components/headerStatus.js';

/*
 * Part C — the header readout.
 *
 * The rule under test is the honesty rule, not the styling: `unknown` is a
 * first-class answer and must never be shown as health. "Nothing disagreed" and
 * "nothing was compared" look identical unless something states which it is —
 * the same distinction listIndexes refuses a false zero for, and the same one
 * describeInstanceState draws between an empty page and an unreadable one.
 */

const SRC = (name, cols) => ({
  file: `/w/${name}.now.ts`,
  text: `import { Table, StringColumn } from '@servicenow/sdk/core'
export const ${name} = Table({
    name: "${name}",
    schema: {
${cols.map((c) => `        ${c}: StringColumn({ label: "${c}" }),`).join('\n')}
    },
})`,
});

const reader = (byTable) => async (name) => {
  const cols = byTable[name];
  if (cols === undefined) throw new Error(`no such table ${name}`);
  return cols.map((element) => ({ element }));
};

test('a table whose columns all exist on the instance is in sync', async () => {
  const tables = await compareSourcesToInstance(
    [SRC('x_demo_a', ['one', 'two'])],
    reader({ x_demo_a: ['one', 'two', 'sys_id', 'sys_created_on'] }),
  );
  assert.equal(tables[0].state, 'in-sync');
  assert.equal(rollUpSync(tables).state, 'in-sync');
});

test('platform columns the source never declared do NOT count as drift', async () => {
  // A table legitimately carries columns this application did not author.
  // Flagging those would make the indicator cry wolf until it was ignored.
  const tables = await compareSourcesToInstance(
    [SRC('x_demo_a', ['one'])],
    reader({ x_demo_a: ['one', 'sys_id', 'sys_mod_count', 'u_added_by_someone_else'] }),
  );
  assert.equal(tables[0].state, 'in-sync');
});

test('a column in source that the instance does not have is OUT OF SYNC', async () => {
  // This is the real failure: the next install would ship it, and until then
  // the user believes a change landed that did not.
  const tables = await compareSourcesToInstance(
    [SRC('x_demo_a', ['one', 'assigned_date'])],
    reader({ x_demo_a: ['one'] }),
  );
  assert.equal(tables[0].state, 'out-of-sync');
  assert.deepEqual(tables[0].missingOnInstance, ['assigned_date']);
  const roll = rollUpSync(tables);
  assert.equal(roll.state, 'out-of-sync');
  assert.match(roll.detail, /assigned_date/);
  assert.match(roll.detail, /next install would ship them/);
});

test('a table that could not be read is UNKNOWN, never in-sync', async () => {
  const tables = await compareSourcesToInstance([SRC('x_demo_a', ['one'])], reader({}));
  assert.equal(tables[0].state, 'unknown');
  const roll = rollUpSync(tables);
  assert.equal(roll.state, 'unknown');
  assert.match(roll.detail, /NOT a clean bill of health/);
});

test('a known divergence outranks an unknown — one cannot hide the other', async () => {
  const tables = await compareSourcesToInstance(
    [SRC('x_demo_a', ['gone']), SRC('x_demo_b', ['x'])],
    reader({ x_demo_a: [] }),   // b is unreadable, a is genuinely short
  );
  assert.equal(rollUpSync(tables).state, 'out-of-sync');
});

test('an augments source is compared against the table it attaches to', async () => {
  const augment = {
    file: '/w/augment_incident.now.ts',
    text: `export const incident = Table({ augments: "incident", schema: {
        x_2002152_nwforge_triage_note: StringColumn({ label: "Triage Note" }),
    } })`,
  };
  const ok = await compareSourcesToInstance([augment], reader({ incident: ['x_2002152_nwforge_triage_note', 'number'] }));
  assert.equal(ok[0].kind, 'augments');
  assert.equal(ok[0].state, 'in-sync');

  const drifted = await compareSourcesToInstance([augment], reader({ incident: ['number'] }));
  assert.equal(drifted[0].state, 'out-of-sync');
});

test('no managed sources is in-sync, and says why', () => {
  assert.equal(rollUpSync([]).state, 'in-sync');
  assert.match(rollUpSync([]).detail, /No SDK-managed sources/);
});

/* ── the pill's single word ───────────────────────────────────────────────── */

test('deploying outranks everything — mid-install, drift is expected', () => {
  const s = headerStatus({ connected: true, bindingOk: true, sync: { state: 'out-of-sync' }, deploying: true });
  assert.equal(s.state, 'deploying');
  assert.equal(s.tone, 'busy');
});

test('a failed binding outranks a sync verdict', () => {
  // If the guards an install must pass are failing, the sync comparison is not
  // the thing to report.
  const s = headerStatus({ connected: true, bindingOk: false, sync: { state: 'in-sync' }, deploying: false });
  assert.equal(s.state, 'binding-failed');
  assert.equal(s.tone, 'bad');
});

test('sync unknown is a WARNING, never green', () => {
  const s = headerStatus({ connected: true, bindingOk: true, sync: { state: 'unknown' }, deploying: false });
  assert.equal(s.state, 'unknown');
  assert.equal(s.tone, 'warn');
  assert.notEqual(s.tone, 'ok');
});

test('everything holding is the only route to green', () => {
  const s = headerStatus({ connected: true, bindingOk: true, sync: { state: 'in-sync' }, deploying: false });
  assert.equal(s.state, 'ok');
  assert.equal(s.tone, 'ok');
});

test('no instance bound reads as unbound, not as broken', () => {
  assert.equal(headerStatus({ connected: false }).state, 'unbound');
});

/* ── what the header renders ──────────────────────────────────────────────── */

test('a local server outage does not read as an instance problem', () => {
  // "disconnected" here would send someone to look at their PDI for a fault in
  // the local API on :4000.
  const d = describeHeaderStatus({ loading: false, error: 'fetch failed', binding: null });
  assert.equal(d.tone, 'bad');
  assert.match(d.label, /server down/);
  assert.match(d.detail, /not your instance/);
});

test('the pill reports the server verdict and explains it in the tooltip', () => {
  const d = describeHeaderStatus({
    loading: false,
    error: null,
    binding: {
      status: { state: 'out-of-sync', label: 'out of sync', tone: 'warn' },
      binding: { ok: true },
      sync: { state: 'out-of-sync', detail: 'x_demo declares assigned_date; the instance does not have it.' },
      deploying: false,
    },
  });
  assert.equal(d.label, 'out of sync');
  assert.equal(d.dotClass, 'warn');
  assert.match(d.title, /binding verified/);
  assert.match(d.title, /assigned_date/);
});

test('the scope badge shows the NAME, which is the address', () => {
  const s = describeScope({ scope: 'x_2002152_nwforge', name: 'NowForge Flows', sys_id: 'abc' });
  assert.equal(s.text, 'x_2002152_nwforge');
  assert.match(s.title, /NowForge Flows/);
  assert.equal(s.known, true);
});

test('an unreadable scope says so rather than rendering blank', () => {
  // A blank badge and a missing one are different facts.
  const s = describeScope(null);
  assert.equal(s.text, 'no scope');
  assert.equal(s.known, false);
});
