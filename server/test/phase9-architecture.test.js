/**
 * PHASE 9 — THE ARCHITECTURAL BOUNDARY AUDIT.
 *
 *   node --test server/test/
 *
 * Nine phases have each added a layer, and each added a guard saying what its
 * layer may not reach. This file re-runs all of them together and adds the
 * ones Phase 9 asks for explicitly — because the failure mode being defended
 * against is not one bad commit, it is drift: a second execution path that
 * arrives one convenient import at a time.
 *
 * THE SINGULARITY CLAIMS, stated as counts rather than adjectives. There is ONE
 * function that can run a mutating tool, ONE that resolves an approval, ONE
 * read-back verifier, ONE evidence projection, ONE cancellation mechanism and
 * ONE recovery decision layer. Each is asserted by enumerating the source tree,
 * so a second one cannot be added quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const CLIENT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');

function sources(root = SRC) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
const rel = (full, root = SRC) => path.relative(root, full).replace(/\\/g, '/');
const body = (full) => fs.readFileSync(full, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const read = (r) => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Files whose (comment-stripped) body matches, as repo-relative paths. */
function filesMatching(re, root = SRC) {
  return sources(root).filter((f) => re.test(body(f))).map((f) => rel(f, root));
}

/** The import specifiers a file names. */
function importsOf(full) {
  return [...fs.readFileSync(full, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/* ================================================================== *
 * A. ONE OF EACH
 * ================================================================== */

test('B1 — there is exactly ONE function that can execute a mutating tool', () => {
  const definitions = filesMatching(/export\s+async\s+function\s+executeTool\s*\(/);
  assert.deepEqual(definitions, ['agent/orchestrator.js'],
    'a second tool-execution entry point exists');
  // And nothing else defines something that looks like one.
  const rivals = filesMatching(/function\s+(runMutation|executeMutation|applyWrite|performWrite|invokeTool)\s*\(/);
  assert.deepEqual(rivals, [], `a parallel execution function appeared: ${rivals.join(', ')}`);
});

test('B2 — there is exactly ONE approval mechanism', () => {
  assert.deepEqual(filesMatching(/export\s+function\s+resolveApproval\s*\(/), ['agent/orchestrator.js']);
  assert.deepEqual(filesMatching(/export\s+function\s+awaitApprovalDecision\s*\(/), ['agent/orchestrator.js']);
  const rivals = filesMatching(/function\s+(grantApproval|autoApproveStep|approveMutation|bypassApproval)\s*\(/);
  assert.deepEqual(rivals, [], `a second approval path appeared: ${rivals.join(', ')}`);
  // One provenance vocabulary, defined once.
  assert.deepEqual(filesMatching(/export\s+const\s+APPROVAL_SOURCES\s*=/), ['agent/orchestrator.js']);
});

test('B3 — there is exactly ONE read-back verifier', () => {
  assert.deepEqual(filesMatching(/export\s+async\s+function\s+verifyMutation\s*\(/), ['agent/mutation-pipeline.js']);
  assert.deepEqual(filesMatching(/export\s+function\s+diffWrite\s*\(/), ['servicenow/write-verify.js']);
  const rivals = filesMatching(/function\s+(verifyWrite|checkApplied|confirmMutation|reVerify)\s*\(/);
  assert.deepEqual(rivals, [], `a second verifier appeared: ${rivals.join(', ')}`);
});

test('B4 — there is exactly ONE evidence projection and no second store', () => {
  assert.deepEqual(filesMatching(/export\s+function\s+buildEvidence\s*\(/), ['agent/evidence/builder.js']);
  assert.deepEqual(filesMatching(/export\s+function\s+decideStatus\s*\(/), ['agent/evidence/status.js']);
  // No evidence table, and no file that writes one.
  const dbSrc = read('memory/db.js');
  for (const forbidden of ['CREATE TABLE IF NOT EXISTS evidence', 'CREATE TABLE evidence']) {
    assert.ok(!dbSrc.includes(forbidden), 'an evidence table was added to the schema');
  }
  const routes = fs.readdirSync(path.join(SRC, 'routes'));
  assert.ok(!routes.some((f) => /evidence/i.test(f)), `a second evidence route appeared: ${routes.join(', ')}`);
});

test('B5 — there is exactly ONE cancellation mechanism', () => {
  /*
   * Phase 0's shape: a per-request AbortController, observed at boundaries. No
   * registry, no global in-flight map, and nothing that aborts a tool mid-call.
   */
  const controllers = filesMatching(/new AbortController\(\)/);
  /*
   * The SSE routes, and nowhere else. The DBA pane's writes are job-based
   * rather than streamed, so it has no cancellation surface of its own.
   *
   * SESSION 1 / WI-4 — `routes/flows.js` joins the list. Its `/live` build now
   * waits at the approval gate, and a page that goes away while the card is
   * open must cancel the card the same way the other two routes do: the
   * client's own fetch abort → the server sees `close` → the controller
   * aborts → the gate resolves `cancelled`. Same mechanism, third route; no
   * registry, no in-flight map, nothing aborted mid-tool.
   */
  /*
   * `routes/health.js` joins the list on the same terms flows.js did. Applying
   * an approved remediation is a streamed, long-running write, and a page that
   * goes away mid-execution must stop it the way the other three do: the
   * client's own fetch abort -> the server sees `close` -> the controller
   * aborts -> the executor stops at the next step boundary. Same mechanism,
   * fourth route; still no registry, no in-flight map, nothing aborted
   * mid-tool.
   */
  assert.deepEqual(controllers.sort(), ['routes/agent.js', 'routes/flows.js', 'routes/health.js', 'routes/plan.js'],
    `an AbortController appeared outside the three streaming handlers: ${controllers.join(', ')}`);

  /*
   * THE ONE REGISTRY, WRITTEN DOWN AS THIS LIST REQUIRES.
   *
   * Health checks are READ-ONLY, and tying one to its request produced two
   * measured failures and no safety: leaving the page lost the run while it
   * kept going ("already running" with nothing on screen), and a server closed
   * mid-run left a row at `running` that a restart — even a reboot — could not
   * clear for thirty minutes. So `routes/health.js` owns its checks in one
   * module-level map and the page watches them.
   *
   * Pinned narrowly: exactly that one map, in that one file, and the ROUTE
   * THAT WRITES — applying a remediation — may not touch it. Work that changes
   * the instance still stops when the person authorising it goes away.
   */
  const registries = sources()
    .filter((f) => /^const\s+\w*(live|active|running|inflight|in_flight)\w*(runs?|jobs?|tasks?|checks?)\s*=\s*new (Map|Set)\(/im.test(body(f)))
    .map((f) => rel(f));
  assert.deepEqual(registries, ['routes/health.js'], `a run registry appeared somewhere else: ${registries.join(', ')}`);
  const healthRoutes = body(sources().find((f) => rel(f) === 'routes/health.js'));
  assert.match(healthRoutes, /^const liveHealthRuns = new Map\(\)/m, 'the health run registry was renamed or moved');
  const from = healthRoutes.indexOf("healthRouter.post('/proposals/:id/approve'");
  assert.ok(from > 0, 'the remediation route was not found, so this guard checks nothing');
  const approveRoute = healthRoutes.slice(from, healthRoutes.indexOf('\n});', from));
  assert.ok(!/liveHealthRuns/.test(approveRoute),
    'the remediation route reaches the read-only run registry — a write must still cancel with its request');
  assert.match(approveRoute, /res\.on\('close'/, 'the remediation route no longer cancels when its page goes away');
  for (const f of sources()) {
    const b = body(f);
    assert.ok(!/^const\s+\w*(inflight|IN_FLIGHT|activeRuns|runningTasks)\w*\s*=\s*new (Map|Set)/m.test(b),
      `${rel(f)} keeps global in-flight state`);
  }
});

test('B6 — there is exactly ONE recovery decision layer', () => {
  assert.deepEqual(filesMatching(/export\s+function\s+decideRecovery\s*\(/), ['agent/recovery/decision.js']);
  assert.deepEqual(filesMatching(/export\s+const\s+POLICY\s*=/), ['agent/recovery/policy.js']);
  assert.deepEqual(filesMatching(/export\s+async\s+function\s+recoverStep\s*\(/), ['agent/recovery/executor.js']);
  const rivals = filesMatching(/function\s+(retryStep|autoRetry|recoverAndRetry|attemptAgain)\s*\(/);
  assert.deepEqual(rivals, [], `a second recovery path appeared: ${rivals.join(', ')}`);
});

test('B7 — there is exactly ONE plan executor and ONE step path', () => {
  assert.deepEqual(filesMatching(/export\s+async\s+function\s+executePlan\s*\(/), ['agent/plan/executor.js']);
  // `runStep` is module-private: nothing outside the executor can call it.
  const exported = filesMatching(/export\s+(async\s+)?function\s+runStep\s*\(/);
  assert.deepEqual(exported, [], 'runStep was exported, which opens a second way into a step');
});

/* ================================================================== *
 * B. LAYERS MAY NOT REACH DOWNWARD
 * ================================================================== */

test('B8 — the PLANNER holds no provider-specific logic', () => {
  for (const f of sources(path.join(SRC, 'agent', 'plan'))) {
    const b = body(f);
    for (const vendor of ['anthropic', 'openai', 'ollama', 'openrouter', 'opencode', 'gpt-', 'claude-']) {
      assert.ok(!new RegExp(vendor, 'i').test(b), `${rel(f)} names the provider "${vendor}"`);
    }
    // It reaches a model only through the neutral gateway.
    for (const spec of importsOf(f)) {
      assert.ok(!/providers\/(anthropic|openai|ollama|openrouter|opencode)/.test(spec),
        `${rel(f)} imports a specific provider adapter`);
    }
  }
});

test('B9 — the RECOVERY layer holds no ServiceNow implementation', () => {
  for (const f of sources(path.join(SRC, 'agent', 'recovery'))) {
    const b = body(f);
    assert.ok(!/\bfetch\s*\(/.test(b), `${rel(f)} performs its own HTTP`);
    assert.ok(!/https?:\/\//.test(b), `${rel(f)} contains a URL`);
    for (const spec of importsOf(f)) {
      assert.ok(!/servicenow\/client/.test(spec), `${rel(f)} imports the ServiceNow client`);
      assert.ok(!/plan\/executor/.test(spec), `${rel(f)} imports the plan executor`);
    }
  }
  // The one ServiceNow import it may have is the pure read-back differ, reused
  // rather than reimplemented.
  const reconcile = read('agent/recovery/reconcile.js');
  assert.match(reconcile, /from '\.\.\/\.\.\/servicenow\/write-verify\.js'/);
});

test('B10 — the EVIDENCE layer is read-only and reaches no execution', () => {
  for (const f of sources(path.join(SRC, 'agent', 'evidence'))) {
    const b = body(f);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\s+(INTO|FROM|TABLE|SET)\b/i.test(b),
      `${rel(f)} writes to the database`);
    assert.ok(!/\bfetch\s*\(/.test(b), `${rel(f)} performs HTTP`);
    for (const spec of importsOf(f)) {
      assert.ok(!/servicenow\/client|plan\/executor|orchestrator/.test(spec),
        `${rel(f)} imports ${spec}`);
    }
  }
});

test('B11 — the CONTEXT layer decides what a model sees, and executes nothing', () => {
  for (const f of ['agent/context-engine.js', 'agent/context-selection.js', 'agent/context-capabilities.js']) {
    const b = body(path.join(SRC, f));
    assert.ok(!/executeTool|resolveApproval|appendMutation/.test(b), `${f} reaches an execution primitive`);
    assert.ok(!/\bfetch\s*\(/.test(b), `${f} performs HTTP`);
  }
});

test('B12 — the plan executor imports no recovery internals, and vice versa', () => {
  const exec = read('agent/plan/executor.js');
  assert.ok(!/from\s+['"][^'"]*recovery/.test(exec), 'the plan executor imports recovery');
  const rec = read('agent/recovery/executor.js');
  assert.ok(!/executePlan/.test(rec), 'recovery names executePlan');
  // They are joined only in the route.
  assert.match(read('routes/plan.js'), /from '\.\.\/agent\/recovery\/index\.js'/);
});

/* ================================================================== *
 * C. THE CLIENT
 * ================================================================== */

test('B13 — the client computes no status of its own', () => {
  const panel = fs.readFileSync(path.join(CLIENT, 'components', 'SourcesPanel.jsx'), 'utf8')
    + fs.readFileSync(path.join(CLIENT, 'components', 'sourceModel.js'), 'utf8');
  assert.ok(!/function\s+(computeStatus|deriveStatus|decideStatus|isSuccess)\s*\(/.test(panel),
    'the client derives its own verdict, competing with the durable record');
  /*
   * The "renders the server status" half went with the status header the
   * Sources redesign removed. What replaces it is the stronger form of the same
   * rule: every value the panel prints is passed through asText(), which
   * returns only what the response contained and refuses anything it would have
   * had to compose.
   */
  assert.match(panel, /asText\(/, 'the client prints values it did not take from the response');
  assert.ok(!/localStorage|sessionStorage|indexedDB/i.test(panel), 'the client caches evidence');
});

test('B14 — the client reaches exactly one evidence endpoint', () => {
  const hits = [];
  for (const f of sources(CLIENT)) {
    const b = body(f);
    for (const m of b.matchAll(/['"`][^'"`]*\/evidence[^'"`]*['"`]/g)) hits.push(`${rel(f, CLIENT)}: ${m[0]}`);
  }
  assert.equal(hits.length, 1, `the client reads evidence from ${hits.length} places: ${hits.join(', ')}`);
  assert.match(hits[0], /agent\/plan\//);
});

/* ================================================================== *
 * D. NOTHING VENDOR-SPECIFIC WHERE IT DOES NOT BELONG
 * ================================================================== */

test('B15 — provider neutrality: only the adapters name a vendor', () => {
  /*
   * TWO NAMED EXCEPTIONS, both pre-existing and neither of them logic.
   *
   *   routes/agent.js  proxies `GET /openrouter/models` so the Settings page can
   *                    list what a user could pick. It is a catalogue lookup and
   *                    touches no turn, plan or mutation. Phase 0's vendor scan
   *                    named this same exception rather than widening its rule.
   *
   *   servicenow/fluent.js  tells a user, in prose, that Fluent codegen is
   *                    demanding and a stronger provider is the first lever.
   *                    Advice printed to a human, not a branch on a vendor.
   *
   * Naming them is the point: the rule stays narrow, and a third exception
   * means editing this list on purpose.
   */
  const allowed = new Set([
    'agent/providers/index.js', 'agent/providers/anthropic.js', 'agent/providers/openaiCompat.js',
    'agent/providers/contract.js', 'agent/providers/retry.js', 'agent/decoding.js',
    'config/store.js', 'routes/settings.js', 'memory/budget.js',
    'routes/agent.js',        // the model-catalogue proxy, above
    'servicenow/fluent.js',   // the user-facing hint, above
  ]);
  const offenders = [];
  for (const f of sources()) {
    const r = rel(f);
    if (allowed.has(r) || r.startsWith('agent/providers/')) continue;
    const b = body(f);
    if (/\b(anthropic|openrouter|opencode)\b/i.test(b)) offenders.push(r);
  }
  assert.deepEqual(offenders, [], `vendor names leaked into: ${offenders.join(', ')}`);

  // And the two exceptions are still what they claim to be, not a foothold.
  const vendorLines = read('routes/agent.js').split('\n').filter((l) => /openrouter/i.test(l));
  assert.ok(vendorLines.length > 0 && vendorLines.length <= 8,
    `the model-catalogue proxy grew to ${vendorLines.length} lines`);
  assert.ok(!/executeTool|resolveApproval|runTurn|generatePlan/.test(vendorLines.join('\n')),
    'the model-catalogue proxy reaches a control path');
});

test('B16 — every Phase 0-8 architecture guard still exists', () => {
  // The guards themselves are the artefact. If a phase's boundary test file
  // disappeared, its invariant would stop being checked without any test failing.
  const testDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)));
  const files = fs.readdirSync(testDir);
  for (const required of [
    'recovery.test.js',                 // Phase 6
    'recovery-integration.test.js',     // Phase 7
    'phase8-correlation.test.js',       // Phase 8
    'phase8-security.test.js',
    'phase8-regression.test.js',
    'evidence.test.js',                 // Phase 5
    'plan.test.js',                     // Phase 4
    'agent-tasks.test.js',              // Phase 1
  ]) {
    assert.ok(files.includes(required), `the guard file ${required} is gone`);
  }
});

test('B17 — no test-only bypass exists in any production path', () => {
  const offenders = [];
  for (const f of sources()) {
    const b = body(f);
    if (/(skipApproval|bypassGate|__test(Only)?(Approve|Execute)|DISABLE_GUARDS|SKIP_VERIFICATION)/i.test(b)) {
      offenders.push(rel(f));
    }
  }
  assert.deepEqual(offenders, [], `a test bypass exists in: ${offenders.join(', ')}`);
  // The legitimate seams are named, few, and only replace INPUTS.
  /*
   * FIVE SEAMS, and every one replaces an INPUT rather than a guard: the
   * provider's chat function, the settings object, the audio directory, the
   * process spawner, the database handle. None can approve, execute, skip a
   * verification or relax a check — which is the property that matters, not
   * the count.
   */
  const seams = filesMatching(/export\s+function\s+_set\w+ForTests\s*\(/);
  assert.deepEqual(seams.sort(), [
    'agent/providers/index.js',   // the scripted model
    'config/store.js',            // settings
    'meetings/audio-store.js',    // the audio root directory
    'meetings/supervisor.js',     // the process spawner
    'memory/db.js',               // the database handle
    /*
     * SESSION 1 / WI-3 — the SDK capability probe (`_setCapabilityProbeForTests`)
     * and its cache contents (`_setCapCacheForTests`). Both replace an INPUT:
     * what the probe answers and what the cache currently holds. Neither can
     * approve, execute, skip a verification or relax a check — discovery still
     * reads the value through the same `cachedCapability()` and the same
     * status ladder. Without them the stale-while-revalidate rule could only be
     * asserted by waiting 30 s against a real CLI.
     */
    /*
     * SESSION 1 / WI-4 — two more INPUT seams. `_setApplicationProbesForTests`
     * replaces who the workspace says it is, whether that scope exists, and the
     * establisher; `_setTableExistsForTests` replaces the answer to "is this a
     * table on the bound instance". Neither can lift a refusal: a policy-refused
     * table stays refused whatever the override says, and an override that says
     * "absent" still produces unknown_table.
     */
    'servicenow/app-create.js',   // the application identity / existence / establisher probes
    'servicenow/fluent.js',       // the SDK capability probe and its cache
    'servicenow/schema.js',       // the table-existence answer
  ].sort(), `a new test seam appeared: ${seams.join(', ')}`);

  // And none of them sits on a control path.
  for (const seam of seams) {
    const fn = /export function _set\w+ForTests[\s\S]{0,300}/.exec(body(path.join(SRC, seam)))?.[0] ?? '';
    assert.ok(!/approv|verif|guard|mutat/i.test(fn), `${seam}'s test seam touches a control path`);
  }
});
