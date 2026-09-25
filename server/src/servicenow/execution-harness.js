import crypto from 'node:crypto';
import { table } from './client.js';

/**
 * Server-side execution harness for TRIGGERLESS artifacts.
 *
 * A record-triggered flow can be proven by creating a record that matches its
 * trigger (see fluent.js `verify`). A SUBFLOW has no trigger, so there is
 * nothing to create — it has to be *called*. Everything below exists to make
 * that call from outside the instance, and to leave nothing behind.
 *
 * WHAT WAS MEASURED (docs/fluent-research.md §32), not assumed:
 *
 *   1. `sn_fd.FlowAPI` is real but server-side only, exactly as §11 said. What
 *      §11 got wrong was the conclusion: reaching it does NOT require a
 *      Scripted REST API. A one-shot `sysauto_script` (Scheduled Script
 *      Execution) with run_type='once' and run_start in the past is created
 *      over the ordinary Table API and RUNS WITHIN SECONDS — measured at ~2s
 *      from insert to execution across every probe.
 *
 *   2. The runner's real signature, confirmed against the live instance:
 *
 *        sn_fd.FlowAPI.getRunner()
 *          .subflow('<scope>.<internal_name>')
 *          .inBackground()            // or .inForeground()
 *          .withInputs({ ... })
 *          .run()
 *
 *      The result object answers getContextId() and getOutputs().
 *      The scope prefix is MANDATORY: an unqualified name is resolved as
 *      global.<name> and the runner throws
 *      "java.lang.IllegalArgumentException: flow object for 'global.x' does not exist".
 *
 *   3. inBackground vs inForeground, and why this ships background:
 *      - foreground THROWS on a failing subflow
 *        (FlowObjectAPIException: The current operation ended in state: ERROR...),
 *        which loses the contextId the caller was about to store;
 *      - background returns in 14-29ms with a valid contextId, and the failure
 *        shows up as `sys_flow_context.state = ERROR` with a full
 *        `error_message` — the same vocabulary the record-triggered runner
 *        already speaks. A subflow that pauses therefore times out as a FAIL
 *        with its last observed state instead of hanging a scheduled job.
 *
 *   4. Outputs ARE capturable, from the platform's own storage:
 *      `sys_flow_runtime_value` where context=<contextId> and type='output'
 *      carries a JSON map of every output. getOutputs() in background mode
 *      returns {} (the flow has not run yet), so the runtime-value table is
 *      the authority, not the script.
 *
 *   5. The job's return channel is ONE deletable row. gs.info was rejected
 *      after measuring that syslog cannot be deleted over REST (403), which
 *      would make "clean up every test record" a lie. A namespaced
 *      `sys_user_preference` row round-trips a 65,000-char value and deletes
 *      cleanly.
 *
 * This module is deliberately artifact-agnostic: `runServerScript` runs ANY
 * server-side script and hands back a JSON report, so v0.4's fix-script and
 * script-include verification calls the same code path rather than growing a
 * second copy of the job/sink/cleanup dance.
 *
 * INJECTION: every value that reaches the generated script is either a
 * validated identifier (the qualified flow name), a hex id we minted, or is
 * embedded through jsLiteral(). Nothing is concatenated raw.
 */

/*
 * The sink is a `sys_user_preference` NAME, not a scoped artifact.
 *
 * It used to be namespaced under the application's scope name, which coupled a
 * transient preference row to the app scope for no reason — and broke the
 * harness when that scope was renamed. Nothing about this row belongs to the
 * app scope: it is created, read once and deleted inside a single call.
 * Namespacing it under the product removes the coupling entirely, rather than
 * swapping one scope literal for another.
 */
const SINK_PREFIX = 'nowhelpassist.exec_harness';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 3000;

/** How far back run_start is set so the scheduler claims the job immediately. */
const JOB_START_BACKDATE_MS = 60_000;

/* States, kept identical to the record-triggered runner's vocabulary. */
export const TERMINAL_OK = ['COMPLETE'];
export const TERMINAL_BAD = ['ERROR', 'CANCELLED', 'PRESUMED_INTERRUPTED'];
export const SETTLED_PAUSED = ['WAITING', 'PAUSED'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ServiceNow stores glide_date_time in UTC; the Table API takes it raw. */
export const utcStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** U+2028 / U+2029: legal in JSON, illegal in an ES5 string literal. */
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/**
 * Embed a JS value in generated ES5 source.
 *
 * JSON.stringify is nearly right, but U+2028/U+2029 are legal in JSON and were
 * illegal inside a JavaScript string literal before ES2019 — and the platform's
 * script engine is ES5. A subflow input carrying one would produce a syntax
 * error in a script we generated, which is our bug to prevent, not the model's.
 */
export function jsLiteral(value) {
  return JSON.stringify(value ?? null).replace(LINE_SEPARATORS, (c) =>
    '\\u' + c.charCodeAt(0).toString(16));
}

/**
 * <scope>.<internal_name> — the only shape the runner accepts.
 *
 * Validated rather than trusted because this string is the one identifier that
 * is CONCATENATED into the generated script (it is a method argument spelled
 * inline), so it cannot go through jsLiteral without changing the call.
 * Anything outside [a-z0-9_] on either side of a single dot is refused loudly.
 */
const QUALIFIED_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

export function assertQualifiedName(qualified) {
  if (!QUALIFIED_RE.test(String(qualified || ''))) {
    throw new Error(
      `"${qualified}" is not a valid <scope>.<internal_name> for sn_fd.FlowAPI. ` +
      'The scope prefix is mandatory — an unqualified name resolves as global.<name> and the runner ' +
      'throws "flow object for \'global.<name>\' does not exist".'
    );
  }
  return qualified;
}

/*
 * ── M-1: WHY THERE IS A SECOND RETURN CHANNEL ───────────────────────────────
 *
 * MEASURED on dev428633, 2026-08-31, after a trivial one-shot probe "timed out"
 * at 93.7s against a ~2s baseline. The job was not slow and the scheduler was
 * not asleep. Instrumenting the generated script with gs.info showed:
 *
 *   NFQ… scope=x_2002152_nwforge
 *   NFQ… isValid=true canCreate=true canWrite=true canRead=true
 *   NFQ… afterSet name=[null] value=[null]      <-- the write did NOTHING
 *   NFQ… insert=48997ce573cfc390a40ef7303ab8b747 lastErr=null
 *   NFQ… reread name=[null] value=[null]
 *
 * The job ran in UNDER FIVE SECONDS. What failed was the return channel:
 *
 *   1. A `sysauto_script` created over the Table API is born in the REST
 *      session's current application, which is this app's scope — and the scope
 *      cannot be overridden on the insert (trap #69; client.js proves it by
 *      refusing). So the job runs SCOPED.
 *   2. `sys_user_preference` is owned by `global` with `update_access = false`.
 *      A scoped script's field writes to it are DISCARDED IN SILENCE:
 *      `canWrite()` answers true, `setValue` is a no-op, `insert()` returns a
 *      real sys_id and `getLastErrorMessage()` is null. Every signal says
 *      success; the row lands with an empty name and an empty value.
 *   3. The harness then polled for `name=<sinkName>`, never matched, and timed
 *      out blaming the scheduler — the opposite of the truth.
 *   4. Cleanup queried by that same name, found nothing, and reported
 *      `sinkDeleted: true, leftovers: []` while a blank-named row STAYED on the
 *      instance. The leak was invisible for the same reason the payload was.
 *
 * So the wrapper now (a) says out loud that it started, (b) PROVES the sink row
 * round-tripped instead of trusting `insert()`, and (c) falls back to syslog —
 * the one channel a scoped script demonstrably can write — when it did not.
 * syslog cannot be deleted over REST, which is why it was rejected as the
 * primary channel in §32 and why it is still only the fallback: the ordinary
 * path leaves nothing behind, and the fallback trades a few undeletable log
 * lines for an answer instead of a wrong diagnosis and a silent leak.
 */

/** syslog.message is 4000 chars (measured); chunk well under it. */
const LOG_CHUNK = 3000;

/** Markers the wrapper emits and the poller reads. Short, and unique per run. */
const MARK = { start: 'NFSTART', sink: 'NFSINK', report: 'NFRPT' };

/**
 * Wrap a caller's script so its result comes back as one deletable row.
 *
 * The caller's script writes onto `report`; the wrapper owns the try/catch, the
 * timing, and the sink insert. A caller cannot forget to report a failure,
 * because failing to report IS the failure the harness times out on.
 */
export function wrapScript({ body, sinkName, token }) {
  const T = jsLiteral(token);
  return [
    `var report = { token: ${T} };`,
    'var __t0 = new Date().getTime();',
    // Executed-at-all marker. It is emitted BEFORE the body so that "the job
    // never ran" and "the job ran and could not report" stop looking alike.
    "var __scope = 'unknown';",
    "try { __scope = String(gs.getCurrentScopeName()); } catch (e0) { __scope = 'unreadable'; }",
    `gs.info(${T} + ' ${MARK.start} scope=' + __scope);`,
    'try {',
    body,
    '  report.ok = true;',
    '} catch (e) { report.ok = false; report.error = String(e); }',
    'report.elapsedMs = new Date().getTime() - __t0;',
    'report.scope = __scope;',
    'var __json = JSON.stringify(report);',
    "var __sink = new GlideRecord('sys_user_preference');",
    '__sink.initialize();',
    `__sink.name = ${jsLiteral(sinkName)};`,
    '__sink.value = __json.substring(0, 60000);',
    '__sink.system = true;',
    'var __sinkId = __sink.insert();',
    // insert() returning an id proves nothing: a cross-scope write is dropped
    // field by field and still yields a row. Read it back and compare.
    'var __sinkOk = false;',
    'try {',
    "  var __v = new GlideRecord('sys_user_preference');",
    `  __sinkOk = !!__sinkId && __v.get(__sinkId) && String(__v.getValue('name')) === ${jsLiteral(sinkName)};`,
    '} catch (e2) { __sinkOk = false; }',
    `gs.info(${T} + ' ${MARK.sink} ' + (__sinkOk ? 'ok' : 'blocked') + ' id=' + __sinkId);`,
    'if (!__sinkOk) {',
    `  var __n = Math.ceil(__json.length / ${LOG_CHUNK});`,
    '  if (__n < 1) { __n = 1; }',
    '  for (var __i = 0; __i < __n; __i++) {',
    `    gs.info(${T} + ' ${MARK.report} ' + (__i + 1) + '/' + __n + ' ' + __json.substr(__i * ${LOG_CHUNK}, ${LOG_CHUNK}));`,
    '  }',
    '}',
  ].join('\n');
}

/**
 * Reassemble a report from the syslog fallback channel.
 *
 * Returns what was observed rather than throwing, because a PARTIAL set of
 * chunks is itself a useful state: it means the job ran and reported, and the
 * harness simply has not seen every row yet.
 */
export function readLogChannel(rows, token) {
  const out = { started: false, scope: null, sinkStatus: null, straySinkId: null, report: null, chunks: 0, expected: null };
  const parts = new Map();
  for (const row of rows || []) {
    const msg = String(row?.message ?? '');
    const at = msg.indexOf(token);
    if (at === -1) continue;
    const tail = msg.slice(at + token.length).trim();

    if (tail.startsWith(MARK.start)) {
      out.started = true;
      out.scope = /scope=(\S+)/.exec(tail)?.[1] ?? null;
      continue;
    }
    if (tail.startsWith(MARK.sink)) {
      const m = /^\S+\s+(ok|blocked)(?:\s+id=([0-9a-f]{32}))?/.exec(tail);
      if (m) {
        out.sinkStatus = m[1];
        if (m[1] === 'blocked' && m[2]) out.straySinkId = m[2];
      }
      continue;
    }
    if (tail.startsWith(MARK.report)) {
      const m = /^\S+\s+(\d+)\/(\d+)\s?([\s\S]*)$/.exec(tail);
      if (!m) continue;
      out.expected = Number(m[2]);
      parts.set(Number(m[1]), m[3]);
    }
  }
  out.chunks = parts.size;
  if (out.expected && parts.size === out.expected) {
    const joined = Array.from({ length: out.expected }, (_, i) => parts.get(i + 1) ?? '').join('');
    try { out.report = JSON.parse(joined); } catch { out.report = { ok: false, error: 'The syslog fallback channel carried a payload that was not JSON.', raw: joined.slice(0, 500) }; }
  }
  return out;
}

export function statusForHarnessTimeoutCause(cause) {
  return cause === 'not-started' ? 'EXECUTION_PATH_BLOCKED' : 'TIMEOUT';
}

const TABLE_RE = /^[a-z0-9_]+$/i;

/**
 * The FlowAPI call itself. Separate so a test can read it without an instance.
 *
 * `declaredInputs` is the subflow's own input contract, and it is not optional
 * decoration: a REFERENCE input will not take a sys_id string. Measured, the
 * runner answers
 *
 *   com.snc.process_flow.exception.ProcessAutomationException:
 *   Invalid GlideRecord input format found
 *
 * and never starts the flow. A reference input has to be handed a real,
 * positioned GlideRecord, so one is fetched in the script and passed by
 * variable. A sys_id that matches nothing throws there, with the table and the
 * id named, instead of producing an execution that fails obscurely later.
 */
export function buildSubflowScript({ qualified, inputs = {}, declaredInputs = [] }) {
  assertQualifiedName(qualified);
  const byName = new Map((declaredInputs || []).map((i) => [i.name, i]));

  const prelude = [];
  const pairs = [];
  let n = 0;
  for (const [name, value] of Object.entries(inputs)) {
    const declared = byName.get(name);
    const isEmpty = value === '' || value === null || value === undefined;
    if (declared?.type !== 'reference' || isEmpty) {
      // An empty reference is passed through as an empty value: fetching a
      // GlideRecord for "nothing" would be a record we invented.
      pairs.push(`${jsLiteral(name)}: ${jsLiteral(value ?? '')}`);
      continue;
    }
    if (!TABLE_RE.test(String(declared.reference || ''))) {
      throw new Error(
        `Input "${name}" is a reference but declares no reference table, so the harness cannot fetch the ` +
        'record the runner requires. Add referenceTable to the ReferenceColumn in the subflow source.'
      );
    }
    const varName = `__in${n++}`;
    prelude.push(
      `  var ${varName} = new GlideRecord(${jsLiteral(declared.reference)});`,
      `  if (!${varName}.get(${jsLiteral(String(value))})) {`,
      `    throw 'input ${name}: no ${declared.reference} record ' + ${jsLiteral(String(value))};`,
      '  }'
    );
    pairs.push(`${jsLiteral(name)}: ${varName}`);
  }

  return [
    ...prelude,
    `  var __res = sn_fd.FlowAPI.getRunner().subflow('${qualified}')`,
    '    .inBackground()',
    `    .withInputs({ ${pairs.join(', ')} })`,
    '    .run();',
    '  report.contextId = __res.getContextId();',
  ].join('\n');
}

/**
 * Subflow outputs, as the platform stores them.
 *
 * sys_flow_runtime_value.value is a JSON map of output name -> OutVal object.
 * A run that ERRORED carries internal bookkeeping keys (__action_status__,
 * __dont_treat_as_error__) in the same map, so the DECLARED output names are
 * passed in and everything else is reported separately rather than mixed into
 * the contract's values.
 */
export function parseRuntimeOutputs(rawValue, declared = []) {
  let parsed;
  try { parsed = JSON.parse(String(rawValue || '')); } catch {
    return { outputs: {}, extra: {}, error: 'sys_flow_runtime_value.value was not JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { outputs: {}, extra: {}, error: 'sys_flow_runtime_value.value was not an object.' };
  }

  const want = new Set(declared);
  const outputs = {};
  const extra = {};
  for (const [key, cell] of Object.entries(parsed)) {
    const flat = cell && typeof cell === 'object'
      ? { value: cell.value ?? null, display: cell.displayValue ?? null, hasValue: cell.hasValue === true }
      : { value: cell, display: cell, hasValue: cell != null };
    if (want.size === 0 || want.has(key)) outputs[key] = flat;
    else extra[key] = flat;
  }
  return { outputs, extra, error: null };
}

/**
 * Run an arbitrary server-side script through a one-shot scheduled job.
 *
 * Returns whatever the script put on `report`, plus proof that the job and its
 * sink row are gone. A timeout is a FAIL carrying everything observed so far —
 * never a hang, and never a silent success.
 */
export async function runServerScript({
  body,
  label = 'script',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  emit = () => {},
} = {}) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const jobId = crypto.randomUUID().replace(/-/g, '');
  const sinkName = `${SINK_PREFIX}.${token}`;
  const script = wrapScript({ body, sinkName, token });

  const cleanup = { jobDeleted: false, sinkDeleted: false, leftovers: [] };
  let report = null;
  let sinkId = null;
  let created = false;
  let channel = null;          // 'preference' | 'syslog'
  let observed = { started: false, scope: null, sinkStatus: null, straySinkId: null, chunks: 0, expected: null };

  try {
    emit({ type: 'harness_job_creating', label, job: jobId });
    // The sys_id is minted here rather than read back, so the job can be
    // correlated to its sys_flow_context even if the sink never arrives:
    // measured, sys_flow_context.source_record IS this sys_id and
    // source_table is 'sysauto_script'.
    await table.create('sysauto_script', {
      sys_id: jobId,
      name: `NowHelpAssist execution harness — ${String(label).slice(0, 60)}`,
      active: 'true',
      run_type: 'once',
      run_start: utcStamp(Date.now() - JOB_START_BACKDATE_MS),
      script,
    });
    created = true;
    emit({ type: 'harness_job_created', job: jobId });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);

      // Both channels are read every pass. The preference sink is the ordinary
      // one and wins when it is there; syslog answers when a scoped write was
      // silently dropped, and — either way — tells us whether the job STARTED.
      const [rows, logs] = await Promise.all([
        table.query('sys_user_preference', {
          query: `name=${sinkName}`, fields: 'sys_id,value', limit: 1, display: 'false',
        }).catch(() => []),
        table.query('syslog', {
          query: `messageLIKE${token}`, fields: 'sys_id,message', limit: 60, display: 'false',
        }).catch(() => []),
      ]);

      observed = readLogChannel(logs, token);

      if (rows.length) {
        sinkId = rows[0].sys_id;
        channel = 'preference';
        try { report = JSON.parse(rows[0].value); } catch {
          report = { ok: false, error: 'The job reported a value that was not JSON.', raw: String(rows[0].value).slice(0, 500) };
        }
        break;
      }
      if (observed.report) {
        channel = 'syslog';
        report = observed.report;
        break;
      }
      emit({
        type: 'harness_waiting',
        remainingMs: Math.max(0, deadline - Date.now()),
        started: observed.started,
        ...(observed.expected ? { reportChunks: `${observed.chunks}/${observed.expected}` } : {}),
      });
    }
  } finally {
    /*
     * A sink row whose NAME was dropped by a cross-scope write is invisible to
     * a name query — that is how the old cleanup reported "no leftovers" while
     * leaving one behind on every run. The script logs the sys_id `insert()`
     * returned, so the orphan is deletable even though nothing can find it by
     * name. Measured: three of these were on the instance and were removed.
     */
    if (!sinkId && observed.straySinkId) sinkId = observed.straySinkId;
    // Cleanup is proven, not assumed: both rows are deleted and then read back.
    if (sinkId) {
      await table.remove('sys_user_preference', sinkId).catch(() => {});
      /*
       * Read back BY SYS_ID, not by name. The old check queried the name, which
       * a blank-named orphan can never match — so it answered "deleted" without
       * having looked at the row it was supposed to have deleted. A cleanup
       * check that cannot fail is not a check.
       */
      const stillThere = await table.get('sys_user_preference', sinkId, 'false').catch(() => null);
      const left = await table.query('sys_user_preference', {
        query: `name=${sinkName}`, fields: 'sys_id', limit: 1, display: 'false',
      }).catch(() => []);
      cleanup.sinkDeleted = stillThere == null && left.length === 0;
      if (stillThere) cleanup.leftovers.push(`sys_user_preference:${sinkId}`);
      if (left.length) cleanup.leftovers.push(`sys_user_preference:${sinkName}`);

      // The sink is written with `system = true`, which makes it CONFIGURATION
      // — so creating it emits a `sys_update_xml` row, and deleting the record
      // does not remove that row (trap #74: cleaning up configuration is
      // itself configuration). Measured: 10 of these had accumulated in the
      // global Default set, one per harness run.
      //
      // Left alone they are not merely untidy. A captured session that runs a
      // subflow verification would SWEEP one into its update set, and the
      // export would then carry a meaningless "User Preference" artifact into
      // whatever instance it was imported on.
      cleanup.updateRowsDeleted = 0;
      const stale = await table.query('sys_update_xml', {
        query: `name=sys_user_preference_${sinkId}^ORtarget_name=${sinkName}`,
        fields: 'sys_id', limit: 10, display: 'false',
      }).catch(() => []);
      for (const row of stale) {
        try { await table.remove('sys_update_xml', row.sys_id); cleanup.updateRowsDeleted += 1; }
        catch { cleanup.leftovers.push(`sys_update_xml:${row.sys_id}`); }
      }
    } else {
      cleanup.sinkDeleted = true; // nothing was ever written
    }
    if (created) {
      await table.remove('sysauto_script', jobId).catch(() => {});
      const still = await table.get('sysauto_script', jobId, 'false').catch(() => null);
      cleanup.jobDeleted = still == null;
      if (still) cleanup.leftovers.push(`sysauto_script:${jobId}`);
    }
    emit({ type: 'harness_cleanup', ...cleanup });
  }

  if (!report) {
    /*
     * A timeout must NAME its cause. The version of this message that shipped
     * asserted "the scheduler is not claiming the job at all", which was
     * measurably wrong — the job had run in under five seconds and the return
     * channel was what failed (M-1). A confident wrong diagnosis sends the next
     * person to investigate the scheduler for an hour.
     */
    const seconds = Math.round(timeoutMs / 1000);
    const cause = observed.started
      ? (observed.sinkStatus === 'blocked' || observed.expected ? 'return-channel-blocked' : 'no-report')
      : 'not-started';
    const message = {
      'not-started': `The scheduled job never reported within ${seconds}s and never logged that it started, so as `
        + 'far as this harness can tell it did not run. It was created and then deleted. On this instance a one-shot '
        + 'job starts within a few seconds, so this points at the scheduler not claiming the job.',
      'return-channel-blocked': `The job RAN — it logged its start${observed.scope ? ` in scope ${observed.scope}` : ''} — `
        + `but its report did not come back within ${seconds}s. The sink row was ${observed.sinkStatus === 'blocked' ? 'written and came back empty' : 'not readable'}`
        + `${observed.expected ? `, and only ${observed.chunks} of ${observed.expected} fallback log chunks arrived` : ''}. `
        + 'This is a RETURN-CHANNEL failure, not a scheduling one: do not conclude anything about the scheduler, and '
        + 'do not conclude anything about what the script was asked to read.',
      'no-report': `The job RAN — it logged its start${observed.scope ? ` in scope ${observed.scope}` : ''} — but produced `
        + `no report within ${seconds}s, on either channel. It was created and then deleted.`,
    }[cause];

    return {
      ok: false,
      timedOut: true,
      status: statusForHarnessTimeoutCause(cause),
      cause,
      started: observed.started,
      scope: observed.scope,
      job: jobId,
      report: null,
      cleanup,
      message,
    };
  }
  return {
    ok: report.ok === true,
    timedOut: false,
    status: report.ok === true ? 'SUCCESS' : 'FAILED',
    cause: null,
    started: true,
    scope: report.scope ?? observed.scope ?? null,
    channel: channel ?? 'preference',
    job: jobId,
    report,
    cleanup,
    ...(channel === 'syslog'
      ? {
        channelNote: 'The report came back through the syslog fallback: this job ran in an application scope, and a '
          + 'scoped script\'s writes to the global sys_user_preference table are discarded in silence. The result is '
          + 'complete; the fallback log rows cannot be deleted over REST.',
      }
      : {}),
  };
}

/**
 * Execute a subflow with inputs and settle its execution.
 *
 * `declaredOutputs` is the subflow's own output contract, used to separate the
 * outputs it promises from the engine's internal bookkeeping keys.
 */
export async function executeSubflow({
  qualified,
  inputs = {},
  declaredInputs = [],
  declaredOutputs = [],
  label = qualified,
  jobTimeoutMs = 90_000,
  settleTimeoutSec = 120,
  pollMs = DEFAULT_POLL_MS,
  emit = () => {},
} = {}) {
  assertQualifiedName(qualified);
  emit({ type: 'harness_invoking', qualified, inputs });

  let body;
  try {
    body = buildSubflowScript({ qualified, inputs, declaredInputs });
  } catch (err) {
    // A contract the harness cannot build a call from is a failure here, before
    // anything is created on the instance — not a job that dies obscurely.
    return {
      mechanism: 'sysauto_script + sn_fd.FlowAPI.getRunner().subflow().inBackground()',
      qualified, inputs, job: null, cleanup: { jobDeleted: true, sinkDeleted: true, leftovers: [] },
      ok: false, stage: 'build', execution: null, outputs: {}, message: err.message,
    };
  }

  const run = await runServerScript({
    body,
    label,
    timeoutMs: jobTimeoutMs,
    pollMs,
    emit,
  });

  const base = {
    mechanism: 'sysauto_script + sn_fd.FlowAPI.getRunner().subflow().inBackground()',
    qualified,
    inputs,
    job: run.job,
    cleanup: run.cleanup,
  };

  // The job ran but FlowAPI refused the call — a bad qualified name, an input
  // the subflow does not declare. That is a hard failure with a real message.
  if (!run.ok) {
    const invoked = await findContextByJob(run.job);
    return {
      ...base,
      ok: false,
      stage: run.timedOut ? 'job' : 'invoke',
      execution: invoked,
      outputs: {},
      message: run.timedOut
        ? run.message
        : `sn_fd.FlowAPI refused the call: ${run.report?.error || 'no error text was reported'}`,
      report: run.report,
    };
  }

  const contextId = run.report?.contextId || (await findContextByJob(run.job))?.sys_id || null;
  if (!contextId) {
    return {
      ...base, ok: false, stage: 'invoke', execution: null, outputs: {},
      message: 'The job reported success but no sys_flow_context id came back, so there is no execution to inspect.',
      report: run.report,
    };
  }

  const settled = await settleContext(contextId, { timeoutSec: settleTimeoutSec, pollMs, emit });
  const outputs = settled.execution
    ? await readOutputs(contextId, declaredOutputs)
    : { outputs: {}, extra: {}, error: null };

  return {
    ...base,
    ok: settled.ok,
    stage: settled.ok ? 'settled' : 'wait',
    execution: settled.execution,
    outputs: outputs.outputs,
    outputsExtra: outputs.extra,
    outputsError: outputs.error,
    message: settled.message,
    report: run.report,
  };
}

/** Fallback correlation when the sink never arrived — measured in §32. */
export async function findContextByJob(jobSysId) {
  if (!jobSysId) return null;
  const rows = await table.query('sys_flow_context', {
    query: `source_record=${jobSysId}^source_table=sysauto_script`,
    fields: 'sys_id,name,state,error_message,run_time',
    limit: 5, display: 'false',
  }).catch(() => []);
  const row = rows[0];
  return row
    ? { sys_id: row.sys_id, name: row.name, state: row.state, error_message: row.error_message || null, run_time: row.run_time }
    : null;
}

/** Poll one execution to a terminal (or legitimately paused) state. */
export async function settleContext(contextId, { timeoutSec = 120, pollMs = DEFAULT_POLL_MS, emit = () => {} } = {}) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutSec) || 120, 15), 600) * 1000;
  let execution = null;
  while (Date.now() < deadline) {
    const rec = await table.get('sys_flow_context', contextId, 'false').catch(() => null);
    if (rec) {
      execution = {
        sys_id: contextId,
        name: rec.name,
        state: rec.state,
        error_message: rec.error_message || null,
        run_time: rec.run_time,
      };
      emit({ type: 'harness_execution', state: execution.state, name: execution.name });
      if ([...TERMINAL_OK, ...TERMINAL_BAD, ...SETTLED_PAUSED].includes(execution.state)) break;
    }
    await sleep(pollMs);
  }

  if (!execution) {
    return { ok: false, execution: null, message: `No sys_flow_context ${contextId} could be read back.` };
  }
  if (TERMINAL_BAD.includes(execution.state)) {
    return {
      ok: false, execution,
      message: `The subflow ran and finished in state ${execution.state}${execution.error_message ? `: ${execution.error_message}` : '.'}`,
    };
  }
  if (![...TERMINAL_OK, ...SETTLED_PAUSED].includes(execution.state)) {
    return { ok: false, execution, message: `The subflow did not settle within the timeout (last state ${execution.state}).` };
  }
  return { ok: true, execution, message: `The subflow settled in state ${execution.state}.` };
}

/** Read a settled execution's declared outputs off sys_flow_runtime_value. */
export async function readOutputs(contextId, declared = []) {
  const rows = await table.query('sys_flow_runtime_value', {
    query: `context=${contextId}^type=output`, fields: 'value', limit: 5, display: 'false',
  }).catch(() => []);
  if (!rows.length) {
    return { outputs: {}, extra: {}, error: 'No sys_flow_runtime_value row of type "output" exists for this execution.' };
  }
  return parseRuntimeOutputs(rows[0].value, declared);
}

export const harness = { runServerScript, executeSubflow, settleContext, readOutputs, findContextByJob };
