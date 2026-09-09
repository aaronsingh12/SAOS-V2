/**
 * NOWFORGE EXPERIENCE — THE SKILL REGISTRY.
 *
 *   node --test server/test/
 *
 * §60 asks for skill registry, validation, enable/disable, permissions,
 * conflicts and session state. §61 adds the two that actually matter: a
 * disabled skill must be unavailable to the PLANNER, and the permission display
 * must match the real capability.
 *
 * ═══ THE REGISTRY IS PERSISTED IN THE CONFIG STORE ═══
 *
 * So this suite pins it through `_setSettingsForTests`, which merges over the
 * defaults rather than over what is on disk — the same seam every other suite
 * uses, and the reason none of these tests can be made to pass or fail by
 * whatever `data/settings.json` happens to hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowforge-xskill-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');

const BASE = {
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
};
/** Pin the registry to a known state. Every test states its whole world. */
const withSkills = (skills) => _setSettingsForTests({ ...BASE, skills });
withSkills({ installed: [], disabled: [] });

const S = await import('../src/agent/skills/index.js');
const { TOOLS } = await import('../src/agent/tools.js');
const { CAPABILITIES, TOOL_CAPABILITIES, expandCapabilities } = await import('../src/agent/context-capabilities.js');

const {
  BUILT_IN, BUILT_IN_IDS, SKILL_TRUST, SKILL_STATE, MANIFEST_KEYS,
  validateManifest, listSkills, enabledSkills, getSkill, permissionsFor, toolsForSkills,
  skillsForProfile, skillContextBlock, skillSnapshot, NEVER,
} = S;

const tools = { tools: TOOLS };
const good = (over = {}) => ({
  id: 'cmdb-investigator',
  name: 'CMDB Investigator',
  version: '1.0.0',
  description: 'Read CIs and their relationships.',
  capabilities: ['record_read'],
  tools: [],
  rules: [],
  knowledge: [],
  permissions: { read: ['cmdb_ci'], change: [], note: null },
  ...over,
});

/* ================================================================== *
 * §39 — the built-ins are a mapping, not a second implementation
 * ================================================================== */

test('K1 — all seven built-in skills validate and are enabled by default', () => {
  withSkills({ installed: [], disabled: [] });
  const list = listSkills(tools);
  assert.equal(list.length, 7, `expected 7 built-ins, got ${list.length}`);
  for (const s of list) {
    assert.equal(s.trust, SKILL_TRUST.BUILT_IN);
    assert.equal(s.state, SKILL_STATE.ENABLED, `${s.id} is ${s.state}: ${s.errors.join('; ')}`);
    assert.equal(s.enabled, true);
    assert.deepEqual(s.errors, []);
  }
  assert.deepEqual([...BUILT_IN_IDS].sort(), [
    'application-builder', 'change-intelligence', 'doctor', 'incident-operations',
    'knowledge', 'nowlint', 'nowtest',
  ]);
});

test('K2 — every capability a built-in names EXISTS in the live taxonomy', () => {
  /*
   * §39: the registry points at existing capabilities. A built-in naming one
   * the platform does not have would be a skill that grants nothing while
   * looking like it grants something.
   */
  for (const s of BUILT_IN) {
    for (const c of s.capabilities) {
      assert.ok(CAPABILITIES.includes(c), `${s.id} names unknown capability "${c}"`);
    }
  }
});

test('K3 — a built-in names NO tools, so it cannot pin itself to a snapshot of the registry', () => {
  for (const s of BUILT_IN) assert.deepEqual(s.tools, [], `${s.id} hardcodes a tool list`);
});

/* ================================================================== *
 * §29/§31 — a manifest is data
 * ================================================================== */

test('K4 — a manifest carrying CODE is refused, by name and with a reason', () => {
  for (const key of ['script', 'code', 'handler', 'hook', 'exec', 'execute', 'eval']) {
    const r = validateManifest(good({ [key]: 'doSomething()' }));
    assert.equal(r.ok, false, `"${key}" was accepted`);
    assert.ok(r.errors.some((e) => e.includes(key)), `the refusal does not name "${key}"`);
  }
});

test('K5 — a manifest may not load a module, fetch anything, or carry a credential', () => {
  for (const key of ['require', 'import', 'module', 'url', 'endpoint', 'credentials', 'connection', 'instance']) {
    const r = validateManifest(good({ [key]: 'x' }));
    assert.equal(r.ok, false, `"${key}" was accepted`);
  }
});

test('K6 — a manifest may not claim trust, elevation or impersonation', () => {
  for (const key of ['trust', 'elevate', 'impersonate']) {
    const r = validateManifest(good({ [key]: true }));
    assert.equal(r.ok, false, `"${key}" was accepted`);
    assert.ok(r.errors.join(' ').length > 0);
  }
});

test('K7 — the key list is CLOSED: an unknown key is an error, not an extension point', () => {
  const r = validateManifest(good({ somethingElse: 1 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('somethingElse')));
  /* And the declared list is exactly what a valid manifest may hold. */
  const ok = validateManifest(good());
  assert.ok(ok.ok, ok.errors.join('; '));
  for (const k of Object.keys(ok.manifest)) assert.ok(MANIFEST_KEYS.includes(k), `${k} is not a declared key`);
});

test('K8 — §33: a capability or tool the platform does not have is refused', () => {
  const badCap = validateManifest(good({ capabilities: ['telepathy'] }));
  assert.equal(badCap.ok, false);
  assert.match(badCap.errors.join(' '), /telepathy/);

  const badTool = validateManifest(good({ tools: ['delete_the_instance'] }), { knownTools: new Set(TOOLS.map((t) => t.name)) });
  assert.equal(badTool.ok, false);
  assert.match(badTool.errors.join(' '), /delete_the_instance/);

  const realTool = validateManifest(good({ tools: ['query_records'] }), { knownTools: new Set(TOOLS.map((t) => t.name)) });
  assert.equal(realTool.ok, true, realTool.errors.join('; '));
});

test('K9 — §36: identity is id@version, and both halves are constrained', () => {
  assert.equal(validateManifest(good({ id: 'Not Kebab' })).ok, false);
  assert.equal(validateManifest(good({ id: 'trailing-' })).ok, false);
  assert.equal(validateManifest(good({ version: '1.0' })).ok, false);
  assert.equal(validateManifest(good({ version: 'latest' })).ok, false);
  const ok = validateManifest(good({ version: '2.11.3' }));
  assert.equal(ok.ok, true);
  assert.equal(S.SKILL_ID(ok.manifest.id, ok.manifest.version), 'cmdb-investigator@2.11.3');
});

test('K10 — a manifest is NORMALISED, so ordering cannot change identity', () => {
  const a = validateManifest(good({ capabilities: ['record_read', 'knowledge'] })).manifest;
  const b = validateManifest(good({ capabilities: ['knowledge', 'record_read', 'knowledge'] })).manifest;
  assert.deepEqual(a.capabilities, b.capabilities);
});

/* ================================================================== *
 * §32/§43/§79.13 — permissions are computed, never declared
 * ================================================================== */

test('K11 — permissions come from the LIVE registry and the capability map', () => {
  const p = permissionsFor(['record_read'], TOOLS);
  assert.ok(p.can_read.includes('query_records'));
  assert.deepEqual(p.can_change, [], 'record_read granted a mutating tool');
  assert.equal(p.mutating, false);

  const w = permissionsFor(['record_mutation'], TOOLS);
  assert.ok(w.can_change.includes('update_record'));
  assert.equal(w.mutating, true);
});

test('K12 — every computed change-tool really is `mutating` in the registry', () => {
  /*
   * §79.13 stated as an equality rather than a spot check: the panel's amber
   * list and the approval gate's own flag are the same bit.
   */
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const s of listSkills(tools)) {
    for (const name of s.permissions.can_change) {
      assert.equal(byName.get(name)?.mutating, true, `${s.id} lists ${name} as a change, but it is not mutating`);
    }
    for (const name of s.permissions.can_read) {
      assert.equal(byName.get(name)?.mutating, false, `${s.id} lists ${name} as a read, but it IS mutating`);
    }
  }
});

test('K13 — §79.13: a manifest may not UNDERSTATE what its capabilities grant', () => {
  /*
   * The defect this check was written for was in our own built-ins: the Doctor
   * declared no change permission while `incident` implied `record_mutation`,
   * and NowLint declared none while `flow_authoring` granted create_flow_live.
   * The declarations were corrected; this is what would have caught them.
   */
  withSkills({
    installed: [validateManifest(good({
      id: 'quiet-writer',
      capabilities: ['record_mutation'],
      permissions: { read: [], change: [], note: null },
    })).manifest],
    disabled: [],
  });
  const s = getSkill('quiet-writer@1.0.0', tools);
  assert.ok(s, 'the skill did not appear at all');
  assert.equal(s.state, SKILL_STATE.BLOCKED);
  assert.equal(s.enabled, false, 'a skill that understates its permissions was enabled');
  assert.match(s.errors.join(' '), /understate/);
});

test('K14 — and may not OVERSTATE either', () => {
  withSkills({
    installed: [validateManifest(good({
      id: 'loud-reader',
      capabilities: ['record_read'],
      permissions: { read: [], change: ['everything'], note: null },
    })).manifest],
    disabled: [],
  });
  const s = getSkill('loud-reader@1.0.0', tools);
  assert.equal(s.state, SKILL_STATE.BLOCKED);
  assert.match(s.errors.join(' '), /grant no mutating tool/);
});

test('K15 — every built-in agrees with its own computation', () => {
  withSkills({ installed: [], disabled: [] });
  for (const s of listSkills(tools)) {
    const declares = s.manifest.permissions.change.length > 0;
    const grants = s.permissions.can_change.length > 0;
    assert.equal(declares, grants,
      `${s.id} declares change=${declares} but grants ${s.permissions.can_change.length} mutating tool(s)`);
  }
});

test('K16 — the four things NO skill can do are constant, and not per-skill', () => {
  withSkills({ installed: [], disabled: [] });
  const list = listSkills(tools);
  for (const s of list) assert.equal(s.permissions.never, NEVER);
  assert.match(NEVER.join(' '), /elevate/);
  assert.match(NEVER.join(' '), /impersonate/);
  assert.match(NEVER.join(' '), /credentials/);
});

/* ================================================================== *
 * §41/§79.8 — a disabled skill is invisible to PLANNING
 * ================================================================== */

test('K17 — with nothing disabled the tool surface is UNCHANGED', () => {
  /*
   * THE REGRESSION THIS PINS. The first version of `toolsForSkills` selected
   * rather than subtracted, and with every built-in enabled it silently removed
   * eleven tools — the SLA surface, the update-set reader and every
   * impersonation verb — because no skill claims those capabilities. The
   * default state must be the behaviour that existed before Skills.
   */
  withSkills({ installed: [], disabled: [] });
  const surface = toolsForSkills(TOOLS, listSkills(tools));
  assert.equal(surface.restricted, false);
  assert.equal(surface.tools.length, TOOLS.length);
  assert.equal(surface.tools, TOOLS, 'the array was rebuilt when nothing changed');
});

test('K18 — disabling a skill removes only what it EXCLUSIVELY granted', () => {
  const all = listSkills(tools);
  const off = all.map((s) => (s.id === 'incident-operations' ? { ...s, enabled: false } : s));
  const surface = toolsForSkills(TOOLS, off);

  assert.equal(surface.restricted, true);
  const kept = new Set(surface.tools.map((t) => t.name));
  assert.ok(!kept.has('create_incident'), 'an incident-only tool survived the skill being disabled');
  /*
   * And a tool the disabled skill SHARED with an enabled one survives. The
   * diagnostic reads are tagged [record_read, incident]; the Doctor still
   * grants record_read, so they stay.
   */
  assert.ok(kept.has('get_record_audit'), 'a shared tool was removed with the skill that shared it');
  assert.ok(kept.has('query_records'), 'a core tool was removed');
});

test('K19 — a capability NO skill claims is never removed', () => {
  const all = listSkills(tools);
  const allOff = all.map((s) => ({ ...s, enabled: false }));
  const surface = toolsForSkills(TOOLS, allOff);
  const kept = new Set(surface.tools.map((t) => t.name));
  /* Nothing claims `sla` or `impersonation`, so the Skills layer cannot take them. */
  assert.ok(kept.has('create_sla'), 'the Skills layer removed a capability it was never given');
  assert.ok(kept.has('impersonation_start'));
  /* But core survives even with every skill off — the operating rules need it. */
  assert.ok(kept.has('get_table_schema'));
  assert.ok(kept.has('lookup_reference'));
});

test('K20 — disabling every skill that grants writes removes the generic write surface', () => {
  const all = listSkills(tools);
  const writers = new Set(['incident-operations', 'nowtest', 'application-builder']);
  const off = all.map((s) => (writers.has(s.id) ? { ...s, enabled: false } : s));
  const kept = new Set(toolsForSkills(TOOLS, off).tools.map((t) => t.name));
  assert.ok(!kept.has('update_record'), 'record_mutation survived every skill that grants it being disabled');
  assert.ok(!kept.has('delete_record'));
  assert.ok(kept.has('query_records'), 'reads were removed along with the writes');
});

/* ================================================================== *
 * §35/§36/§37 — lifecycle, versions, conflicts
 * ================================================================== */

test('K21 — §35: disabling does not delete the definition', () => {
  withSkills({ installed: [], disabled: ['doctor@1.0.0'] });
  const list = listSkills(tools);
  assert.equal(list.length, 7, 'a disabled skill vanished');
  const doc = list.find((s) => s.id === 'doctor');
  assert.equal(doc.enabled, false);
  assert.equal(doc.state, SKILL_STATE.DISABLED);
  assert.equal(doc.name, 'Doctor', 'the definition was lost');
  assert.ok(doc.permissions.can_read.length > 0, 'a disabled skill lost its permission display');
});

test('K22 — enabledSkills excludes the disabled and the blocked', () => {
  withSkills({ installed: [], disabled: ['doctor@1.0.0', 'nowlint@1.0.0'] });
  const on = enabledSkills(tools).map((s) => s.id);
  assert.ok(!on.includes('doctor'));
  assert.ok(!on.includes('nowlint'));
  assert.equal(on.length, 5);
});

test('K23 — §37: two manifests claiming one id BLOCK each other, and neither is chosen', () => {
  withSkills({
    installed: [
      validateManifest(good({ version: '1.0.0' })).manifest,
      validateManifest(good({ version: '1.1.0' })).manifest,
    ],
    disabled: [],
  });
  const both = listSkills(tools).filter((s) => s.id === 'cmdb-investigator');
  assert.equal(both.length, 2);
  for (const s of both) {
    assert.equal(s.state, SKILL_STATE.BLOCKED, 'a conflicting skill stayed usable');
    assert.equal(s.enabled, false);
    assert.match(s.errors.join(' '), /claimed by 2 skills/);
    assert.match(s.errors.join(' '), /1\.0\.0, 1\.1\.0/, 'the conflict does not name the other version');
  }
  assert.equal(enabledSkills(tools).some((s) => s.id === 'cmdb-investigator'), false);
});

test('K24 — a user manifest may not shadow a built-in id', () => {
  withSkills({ installed: [validateManifest(good({ id: 'doctor', capabilities: ['record_read'] })).manifest], disabled: [] });
  const doctors = listSkills(tools).filter((s) => s.id === 'doctor');
  assert.equal(doctors.length, 2);
  for (const s of doctors) assert.equal(s.state, SKILL_STATE.BLOCKED);
});

test('K25 — a stored manifest that no longer validates is shown, marked, and NOT enabled', () => {
  /*
   * Re-validated on every read rather than trusted because it validated once: a
   * tool can leave the registry between installs, and a skill naming it would
   * otherwise display a permission the platform cannot honour.
   */
  withSkills({ installed: [{ id: 'broken', name: 'Broken', version: 'not-semver' }], disabled: [] });
  const s = listSkills(tools).find((x) => x.id === 'broken');
  assert.ok(s, 'an unreadable manifest disappeared silently');
  assert.equal(s.state, SKILL_STATE.BLOCKED);
  assert.equal(s.enabled, false);
  assert.equal(s.trust, SKILL_STATE.ENABLED === s.state ? null : 'unverified');
  assert.ok(s.errors.length > 0);
});

/* ================================================================== *
 * §42 — what a skill contributes to a turn
 * ================================================================== */

test('K26 — only skills whose capabilities match the turn are active', () => {
  withSkills({ installed: [], disabled: [] });
  const all = listSkills(tools);
  const active = skillsForProfile(all, { fallback: false, capabilities: ['knowledge', 'core'] });
  assert.deepEqual(active.map((s) => s.id), ['knowledge']);
  /* And a disabled skill is never active, whatever the profile says. */
  withSkills({ installed: [], disabled: ['knowledge@1.0.0'] });
  assert.deepEqual(
    skillsForProfile(listSkills(tools), { fallback: false, capabilities: ['knowledge', 'core'] }).map((s) => s.id),
    [],
  );
});

test('K27 — a FALLBACK profile activates every enabled skill rather than guessing', () => {
  withSkills({ installed: [], disabled: [] });
  const all = listSkills(tools);
  assert.equal(skillsForProfile(all, { fallback: true, capabilities: [] }).length, 7);
  assert.equal(skillsForProfile(all, null).length, 7);
});

test('K28 — the built-ins contribute NOTHING to the prompt, so it is unchanged', () => {
  /*
   * They are a presentation/registry mapping (§39): their contribution is the
   * tool surface, not prose. A block here would put lines in every turn's
   * system prompt for a heading nobody needed — and `budget.test.js` measures
   * the live prompt.
   */
  withSkills({ installed: [], disabled: [] });
  assert.equal(skillContextBlock(listSkills(tools)), null);
});

test('K29 — a user skill WITH rules does contribute, and is bounded', () => {
  const m = validateManifest(good({ rules: ['Always read the CI before changing it.'] })).manifest;
  const block = skillContextBlock([{ ...listSkills(tools)[0], manifest: m, name: 'CMDB Investigator', version: '1.0.0', description: m.description, enabled: true }]);
  assert.ok(block, 'a skill with rules contributed nothing');
  assert.match(block, /Always read the CI/);
  /* And it says what it is NOT. */
  assert.match(block, /not authorisation/i);
});

test('K30 — a rule longer than the cap is refused at validation, not truncated later', () => {
  const r = validateManifest(good({ rules: ['x'.repeat(501)] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /500 characters/);
});

/* ================================================================== *
 * §44/§45/§79.14 — session state
 * ================================================================== */

test('K31 — a snapshot records identity, and only enabled skills', () => {
  withSkills({ installed: [], disabled: ['doctor@1.0.0'] });
  const snap = skillSnapshot(listSkills(tools));
  assert.equal(snap.length, 6);
  assert.ok(!snap.some((s) => s.id === 'doctor'));
  for (const s of snap) {
    assert.ok(s.identity && s.id && s.version && s.name);
    assert.equal(s.identity, `${s.id}@${s.version}`);
  }
  /* Deterministic order, so two snapshots of one registry compare equal. */
  assert.deepEqual(snap, skillSnapshot(listSkills(tools)));
});

test('K32 — §45: changing the registry does not change a snapshot already taken', () => {
  withSkills({ installed: [], disabled: [] });
  const before = skillSnapshot(listSkills(tools));
  withSkills({ installed: [], disabled: ['doctor@1.0.0', 'nowlint@1.0.0'] });
  const after = skillSnapshot(listSkills(tools));

  assert.equal(before.length, 7);
  assert.equal(after.length, 5);
  /* The point: `before` is a plain array of plain objects and nothing mutated it. */
  assert.ok(before.some((s) => s.id === 'doctor'), 'a taken snapshot was rewritten by a later registry change');
});

test('K33 — the registry holds NO per-session state, so nothing can leak between sessions', () => {
  /*
   * §79.14. The guarantee is an absence: there is no map keyed by session and
   * no module-level cache in the skills layer, so two sessions read the same
   * configuration and each task carries its own snapshot. Asserted on the
   * source, because an absence is what nobody notices being added back.
   */
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'agent', 'skills');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/\bsessionId\b/.test(src), `skills/${f} names a session`);
    /*
     * Anchored at column 0: a `new Set(...)` INSIDE a function is a local, and
     * locals are fine — a fresh one per call cannot outlive the call and so
     * cannot carry one session's answer into another's. What must not exist is
     * one at module scope, which every caller would share.
     */
    assert.ok(!/^(const|let|var)\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\(/m.test(src),
      `skills/${f} holds module-level state`);
  }
});

/* ================================================================== *
 * The taxonomy addition this layer required
 * ================================================================== */

test('K34 — `flow_read` is additive: flow_authoring still reaches every flow tool', () => {
  /*
   * Added so a read-only flow skill could be NAMED (NowLint, Change
   * Intelligence). It must not have changed what an authoring profile sees.
   */
  assert.ok(CAPABILITIES.includes('flow_read'));
  assert.ok(expandCapabilities(['flow_authoring']).includes('flow_read'),
    'flow_authoring stopped implying flow_read, so an authoring turn lost its flow reads');
  assert.deepEqual(TOOL_CAPABILITIES.list_flows, ['flow_authoring', 'flow_read']);
  assert.deepEqual(TOOL_CAPABILITIES.get_flow, ['flow_authoring', 'flow_read']);
  /* And it grants no writes, which is the whole reason it exists. */
  assert.deepEqual(permissionsFor(['flow_read'], TOOLS).can_change, []);
});
