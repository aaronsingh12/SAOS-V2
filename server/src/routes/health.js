import crypto from 'node:crypto';
import { Router } from 'express';
import { log } from '../logging.js';
import { startBuildRun, finishBuildRun, auditedEmit, csvCell } from '../memory/audit.js';
import { boundInstance, onInstanceChanged } from '../servicenow/instance-binding.js';
import { runHealthCheck, buildParameterRegistry, describeParameters, validateRuntimeParameters, itsmMeasureHistoryFrom } from '../health/index.js';
import { TABLES, DEFAULT_TABLES } from '../health/tables.js';
import { AGENTS, RULE_VERSION, SEVERITIES } from '../health/rules.js';
import { remediationFor } from '../health/remediation.js';
import { buildProposal, proposalFingerprint, executableChanges, CHANGE_STATUS } from '../health/proposal.js';
import { readRecord, resolveReference } from '../health/instance-read.js';
import { prepareRemediation, runRemediation } from '../health/remediate.js';
import { approvePlan } from '../agent/plan/index.js';
import {
  createProposal, getProposal, proposalsForFinding, saveEdit, rejectProposal,
} from '../health/proposal-store.js';
import {
  openRun, completeRun, failRun, cancelRun, runInFlight, trend, scopesForRun,
  listRuns, getRun, latestRun, listFindings, getFinding, deleteRun, abandonOrphanedRuns, cmdbMeasureHistory,
  moduleBaselines, tableSettings, recordScanOutcome, setTableIncremental, scanStateTable, moduleResults,
  composedView, listModuleFindings, itsmParameterOverrides, setItsmParameterOverride, clearItsmParameterOverride, itsmHistoryRuns,
} from '../health/store.js';
import {
  setFindingState, clearFindingState, stateMap, STATE_VOCABULARY,
} from '../health/finding-state.js';
import { scopeVocabulary, normaliseScope, normaliseModules, MODULE_KEYS, scopeOf as scopeOfFinding, scopeOfRule } from '../health/scopes.js';
import { INCREMENTAL_DEFAULTS } from '../health/incremental.js';
import { mappingIndex, dimensionsForRule } from '../health/finding-dimensions.js';

/* The finding-dimension filter. `category` is the pre-rename spelling, still
   accepted so a bookmarked or scripted URL keeps working; `dimension` wins. */
const dimensionParam = (q) => q.dimension || q.category || undefined;
import {
  BULK_MAX, BULK_ITEM_STATUS, hasFieldFix, normaliseSelection, normaliseApprovals,
  classifyProposal, classifyOutcome, proposalNote, summarise as summariseBulk,
} from '../health/bulk.js';

export const healthRouter = Router();

/**
 * Health Assist — estate health over the bound instance, across CMDB, ITOM,
 * ITSM and platform hygiene.
 *
 * DETECTION READS; ONLY AN APPROVED PLAN WRITES. Running a check, reading
 * findings, setting a finding's lifecycle state and generating a remediation
 * proposal never touch the instance — the last two write only to our own
 * database. Two routes can lead to a change — `POST /proposals/:id/approve`
 * and `POST /bulk/approve` — and both run the ONE sequence in `applyProposal`,
 * which binds the approval here and hands each change list to the ordinary
 * plan executor, which owns the gate, the read-back and the audit trail. Bulk
 * is that sequence once per proposal, in order; it is not a second path. This
 * router never imports the instance client.
 */

/**
 * Attach per-scope summaries to a run — stored, or computed for an older one — and
 * name the scope of every skipped check, routed exactly as its findings are
 * (`scopeOfRule`), so a module tab lists its own skips and not the whole run's.
 */
function withScopes(run) {
  if (!run?.manifest) return run;
  const skipped = Array.isArray(run.manifest.skipped_checks)
    ? run.manifest.skipped_checks.map((s) => ({ ...s, scope: scopeOfRule(s.rule) }))
    : run.manifest.skipped_checks;
  return { ...run, manifest: { ...run.manifest, scopes: scopesForRun(run), skipped_checks: skipped } };
}

/** GET /api/health/meta — the rule pack, the allow-list, and what is bound. */
healthRouter.get('/meta', (req, res) => {
  const bound = boundInstance();
  res.json({
    rulePackVersion: RULE_VERSION,
    instance: bound.url,
    configured: bound.configured,
    // The severity words the UI renders. Served, not coined in the browser.
    severities: SEVERITIES,
    // Same rule for the lifecycle vocabulary.
    findingStates: STATE_VOCABULARY,
    // And for the CMDB / ITOM / ITSM / Platform switch.
    scopes: scopeVocabulary(),
    // The modules a scan can be limited to, and how unchanged modules are reused.
    modules: MODULE_KEYS,
    incremental: { ...INCREMENTAL_DEFAULTS, basis: 'row count and newest sys_updated_on per input table, compared with the run that produced each module\'s result' },
    domains: Object.entries(AGENTS).map(([agent, [domain, label]]) => ({ agent_id: agent, domain, label })),
    tables: Object.entries(TABLES).map(([name, spec]) => ({
      table: name,
      key: spec.key,
      required: spec.required,
      fields: spec.fields,
      default: DEFAULT_TABLES.includes(name),
    })),
    /* Stated in two parts because it is two facts. The old single `writes:
       false` became untrue the day remediation shipped. */
    detectionWrites: false,
    remediation: { requiresApproval: true, executesThrough: 'plan executor' },
    /* Bulk Fix is the same flow, one finding after another; the cap is the
       server's, so the page cannot offer a batch the server would refuse. */
    bulk: { max: BULK_MAX, sequential: true },
    note: 'Checks only read. A fix is proposed first, and nothing on the instance changes until you approve that exact list.',
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   RUNNING A CHECK — owned by the server, watched by the page

   ═══ THE ONE IN-MEMORY RUN TABLE, AND WHY HEALTH CHECKS EARN IT ═══

   Every other streaming route here ties the work to the request: the client
   aborts its fetch, the server sees `close`, the controller aborts. That is
   right for them, because they WRITE — a turn, a plan, a flow install, a
   remediation — and work that changes the instance should stop when the person
   authorising it walks away.

   A health check does not write. Tying it to the request produced two measured
   failures instead of any safety:

     1. Navigating to another page, or refreshing, lost the run. The page came
        back showing "Check again", the check was still going on the server,
        and pressing the button answered "a health check is already running".
     2. Closing the server mid-run left the row at `running`. The only thing
        that cleared it was a thirty-minute timeout, so restarting the project —
        and restarting the PC — still answered "already running" about a check
        nothing was executing.

   So the run belongs to the server process, and the page is a WATCHER:

     POST   /runs             start one, and watch it on this response
     GET    /runs/active      is one running against this instance, and where is it
     GET    /runs/:id/stream  watch it again after leaving or refreshing
     POST   /runs/:id/cancel  stop it — an explicit request, not a disconnect

   `liveHealthRuns` is what "running" means. A row at `running` that this
   process is not executing is closed out as interrupted the next time anyone
   asks, so a restart can never lock the feature again.

   The exception is deliberately narrow: this table holds read-only checks and
   nothing else. Applying a remediation still cancels when its page goes away
   (see `/proposals/:id/approve` below), and the architecture suite pins that.
   ══════════════════════════════════════════════════════════════════════════ */
const liveHealthRuns = new Map();   // runId -> { runId, instanceKey, startedAt, controller, watchers, last }

/* A check against an instance that is no longer bound — logged out of, or
   switched away from — is stopped. It would otherwise keep reading with
   credentials that were just cleared and file results nobody can see. */
onInstanceChanged(({ previous }) => {
  for (const entry of liveHealthRuns.values()) {
    if (entry.instanceKey === previous) entry.controller.abort();
  }
});

/** Close out rows this process is not executing. Cheap; runs on every question. */
function reconcileRuns() {
  const closed = abandonOrphanedRuns([...liveHealthRuns.keys()]);
  if (closed) log.warn('health', `closed ${closed} health run(s) left at "running" by a server that stopped mid-check`);
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** Open an SSE response and keep it alive. Returns a writer that never throws. */
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
  res.on('close', () => clearInterval(keepAlive));
  return (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* watcher gone */ } };
}

/**
 * Add a watcher to a live run. Leaving removes the watcher — and ONLY the
 * watcher. The run carries on.
 */
function watch(entry, res, { replay = false } = {}) {
  const write = openStream(res);
  const watcher = (event) => {
    write(event);
    if (TERMINAL.has(event.type)) { try { res.end(); } catch { /* already gone */ } }
  };
  entry.watchers.add(watcher);
  res.on('close', () => entry.watchers.delete(watcher));
  if (replay) {
    write({ type: 'run_started', runId: entry.runId, startedAt: entry.startedAt, reattached: true });
    if (entry.last) write(entry.last);
  }
}

/** Everything a run says goes to the audit trail once and to every watcher. */
function publish(entry, event) {
  if (event.type === 'progress') entry.last = event;
  for (const watcher of [...entry.watchers]) {
    try { watcher(event); } catch { /* one broken watcher must not stop the others */ }
  }
}

/** Execute a check to its one terminal frame. Never throws; always forgets the run. */
async function executeRun(entry, { emit, auditRun, options }) {
  const { runId, controller } = entry;
  try {
    /* "Accepted risk" decisions are the Schema's approved-exception de-escalator.
       Read here, because the rule pack never touches the database. */
    const acceptedRules = [...stateMap().values()].filter((st) => st.state === 'accepted')
      .map((st) => ({ fingerprint: st.fingerprint, ruleId: st.ruleId }));
    const measureHistory = cmdbMeasureHistory();
    /* ITSM catalogue parameters: declarations + this instance's stored overrides, and this run's runtime overrides. */
    const itsmRegistry = buildParameterRegistry(itsmParameterOverrides());
    /* What each module's current result was computed from, and the per-table
       settings — read here, because the run itself never touches the database. */
    const result = await runHealthCheck({
      ...options,
      acceptedRules,
      measureHistory,
      baselines: moduleBaselines(),
      tableSettings: tableSettings(),
      itsm: { parameters: itsmRegistry.registry, runtime: options.itsmParameters ?? {}, rejected: itsmRegistry.rejected, measureHistory: itsmMeasureHistoryFrom(itsmHistoryRuns()) },
      user: boundInstance().username,
      signal: controller.signal,
      onProgress: async (p) => emit({ type: 'progress', ...p }),
    });
    completeRun(runId, result);
    /* Stamps, checks and verifications are recorded only now — after the run
       finished and its results are stored. A failed or stopped scan never gets
       here, so every earlier baseline stays exactly as it was. */
    try { recordScanOutcome(runId, result); } catch (err) {
      log.warn('health', `run ${runId.slice(0, 8)} finished but its scan state was not recorded — ${err.message}; the next scan re-reads what it cannot compare`);
    }
    emit({ type: 'done', runId, status: result.status, manifest: result.manifest });
    finishBuildRun(auditRun, {
      status: result.status === 'failed' ? 'error' : 'ok',
      summary: {
        runId,
        status: result.status,
        findings: result.manifest.findings_stored,
        score: result.manifest.metrics.cmdb_quality_score,
        modules: result.manifest.modules,
        verified: result.manifest.verified_modules,
      },
    });
  } catch (err) {
    /*
     * A cancellation is not a failure. Somebody changed their mind, and saying
     * "the check failed" would send them looking for a problem that is not
     * there.
     */
    if (controller.signal.aborted || err?.name === 'AbortError') {
      cancelRun(runId);
      emit({ type: 'cancelled', runId, note: 'Stopped. A health check only reads, so nothing was left half-done.' });
      finishBuildRun(auditRun, { status: 'ok', summary: { runId, status: 'cancelled' } });
    } else {
      /*
       * A failed run is KEPT, not discarded. "The check could not complete" is
       * itself a fact about the instance — usually an ACL — and deleting the row
       * would leave the page looking like nobody ever tried.
       */
      log.error('health', `health run ${runId.slice(0, 8)} failed — ${err.message}`);
      try { failRun(runId, err); } catch { /* the row stays running; reconcile closes it */ }
      emit({ type: 'error', runId, message: err.message });
      finishBuildRun(auditRun, { status: 'error', summary: { runId, message: err.message } });
    }
  } finally {
    liveHealthRuns.delete(runId);
    entry.watchers.clear();
  }
}

/**
 * POST /api/health/runs — start a check, and watch it on this response.
 *
 * SSE over POST because the request carries a body, like every other streaming
 * route here. Exactly one terminal frame (`done`, `error` or `cancelled`) per
 * §4.6. Closing this response stops WATCHING; it does not stop the check — use
 * `POST /runs/:id/cancel` for that.
 */
healthRouter.post('/runs', (req, res) => {
  const bound = boundInstance();
  if (!bound.configured) {
    return res.status(409).json({
      message: 'No ServiceNow instance is bound. Connect one on the Dashboard before running a health check.',
    });
  }

  /*
   * ONE RUN AT A TIME, PER INSTANCE.
   *
   * Two concurrent checks extract the same tables twice and leave whichever
   * finished last as "latest", so the page would show one run's coverage beside
   * the other's findings. There is no way to merge two snapshots taken at
   * different cutoffs, so the second is refused rather than reconciled — and
   * the refusal carries the run's id, so the page can watch it instead.
   */
  reconcileRuns();
  const inFlight = runInFlight({ live: liveHealthRuns });
  if (inFlight) {
    return res.status(409).json({
      message: 'A health check is already running against this instance. Wait for it to finish, or stop it first.',
      runId: inFlight.id,
      startedAt: inFlight.startedAt,
    });
  }

  const { tables, staleDays, explain = true, limit, modules: requestedModules, reuse = true, itsmParameters } = req.body || {};
  /* Refused before a run row exists: an unknown module is a bad request, not a failed scan. */
  let modules;
  try { modules = normaliseModules(requestedModules); } catch (err) {
    return res.status(err.status || 422).json({ message: err.message });
  }
  /* Runtime ITSM parameter overrides are checked against their declarations up front, for the same reason. */
  const parameterProblems = validateRuntimeParameters(itsmParameters);
  if (parameterProblems.length) return res.status(422).json({ message: `Invalid itsmParameters: ${parameterProblems.join('; ')}` });
  const auditRun = startBuildRun({
    kind: 'health_check',
    label: bound.url,
    request: { tables: tables ?? null, staleDays: staleDays ?? null, explain, modules, reuse: reuse !== false },
  });

  const runId = openRun();
  const entry = {
    runId,
    instanceKey: bound.key,
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    watchers: new Set(),
    last: null,
  };
  liveHealthRuns.set(runId, entry);
  const emit = auditedEmit(auditRun, (event) => publish(entry, event));

  watch(entry, res);
  emit({ type: 'run_started', runId, startedAt: entry.startedAt });

  /* Not awaited: the server owns the run from here. */
  executeRun(entry, {
    emit,
    auditRun,
    options: {
      tables,
      modules,
      reuse: reuse !== false,
      explain,
      limit: Number(limit) || undefined,
      staleDays: Number(staleDays) || undefined,
      itsmParameters: itsmParameters ?? undefined,
    },
  });
  return undefined;
});

/*
 * ITSM CATALOGUE PARAMETERS (ITSM Phase 5).
 *
 * The instance layer of DECISIONS.md §4: workbook default → INSTANCE OVERRIDE →
 * runtime override. Stored locally per bound instance — nothing is written to
 * ServiceNow. A value is validated against its declaration before it is stored,
 * and an UNDEFINED parameter is never given a suggested value.
 */
healthRouter.get('/itsm/parameters', (req, res, next) => {
  try {
    const overrides = itsmParameterOverrides();
    const built = buildParameterRegistry(overrides);
    res.json({ parameters: describeParameters(built.registry), overrides, rejected: built.rejected });
  } catch (err) { next(err); }
});

healthRouter.put('/itsm/parameters/:ruleId/:key', (req, res, next) => {
  try {
    const { ruleId, key } = req.params;
    const value = req.body?.value;
    if (value === undefined) return res.status(422).json({ message: 'A value is required.' });
    try {
      buildParameterRegistry([]).registry.setInstanceOverride(ruleId, key, value);
    } catch (err) {
      return res.status(422).json({ message: err.message });
    }
    setItsmParameterOverride({ ruleId, key, value, by: boundInstance().username ?? null });
    const parameter = describeParameters(buildParameterRegistry(itsmParameterOverrides()).registry).find((p) => p.rule_id === ruleId && p.key === key);
    return res.json({ parameter });
  } catch (err) { return next(err); }
});

healthRouter.delete('/itsm/parameters/:ruleId/:key', (req, res, next) => {
  try {
    const removed = clearItsmParameterOverride({ ruleId: req.params.ruleId, key: req.params.key });
    res.status(removed ? 200 : 404).json({ removed });
  } catch (err) { next(err); }
});

/** GET /api/health/runs/active — the check running against this instance, if any. */
healthRouter.get('/runs/active', (req, res, next) => {
  try {
    reconcileRuns();
    const row = runInFlight({ live: liveHealthRuns });
    if (!row) return res.json({ run: null });
    const entry = liveHealthRuns.get(row.id);
    res.json({ run: { id: row.id, startedAt: row.startedAt, progress: entry?.last ?? null } });
  } catch (err) { next(err); }
});

/**
 * GET /api/health/runs/:runId/stream — watch a check again.
 *
 * A live run replays where it is, then streams to its terminal frame. A run
 * that already ended answers with that ending as its one terminal frame, so a
 * page that comes back after the check finished learns how it finished.
 */
healthRouter.get('/runs/:runId/stream', (req, res, next) => {
  try {
    const bound = boundInstance();
    const entry = liveHealthRuns.get(req.params.runId);
    if (entry && entry.instanceKey === bound.key) {
      watch(entry, res, { replay: true });
      return undefined;
    }
    reconcileRuns();
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ message: 'No such run on the bound instance.' });
    const write = openStream(res);
    if (run.status === 'completed' || run.status === 'partial') {
      write({ type: 'done', runId: run.id, status: run.status });
    } else if (run.status === 'cancelled') {
      write({ type: 'cancelled', runId: run.id, note: run.error });
    } else {
      write({ type: 'error', runId: run.id, message: run.error || 'The health check did not finish.' });
    }
    res.end();
    return undefined;
  } catch (err) { return next(err); }
});

/** POST /api/health/runs/:runId/cancel — stop a check. Nothing to unwind: it only reads. */
healthRouter.post('/runs/:runId/cancel', (req, res) => {
  const bound = boundInstance();
  const entry = liveHealthRuns.get(req.params.runId);
  if (!entry || entry.instanceKey !== bound.key) {
    return res.status(409).json({ ok: false, message: 'That health check is not running any more.' });
  }
  entry.controller.abort();
  return res.json({ ok: true, runId: entry.runId });
});

/** GET /api/health/runs — this instance's runs, newest first. */
healthRouter.get('/runs', (req, res, next) => {
  try {
    res.json({ runs: listRuns({ limit: Math.min(Number(req.query.limit) || 20, 100) }) });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════════════════════════════
   MODULES — each keeps its own latest result and time
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/health/modules — every module's current result, and the All view
 * composed from them. `checkedAt` is when a module's rows were read;
 * `verifiedAt` is when a later scan last confirmed none of its inputs changed.
 */
healthRouter.get('/modules', (req, res, next) => {
  try {
    const view = composedView();
    res.json({ modules: moduleResults(), view: view ? withScopes(view) : null });
  } catch (err) { next(err); }
});

/**
 * `fixable` on a list row: does this rule have an automated single-field fix?
 *
 * Decided by the SAME registry the proposal builder reads (FIX_FIELD), so the
 * page's Bulk Fix checkbox and the proposal it leads to can never disagree —
 * a rule added there tomorrow becomes selectable without touching the page.
 */
/*
 * Each row also carries its finding DIMENSIONS — resolved from its rule at read time
 * (health/finding-dimensions.js), never stored on the finding. One mapping read
 * per page, however many rows. Unclassified when no dimension claims the rule.
 */
const withFixable = (page) => {
  const index = mappingIndex();
  return {
    ...page,
    findings: (page.findings || []).map((f) => ({
      ...f, fixable: hasFieldFix(f.rule_id), dimensions: dimensionsForRule(f.rule_id, index),
    })),
  };
};

/** GET /api/health/modules/findings — findings from each module's own current result. */
healthRouter.get('/modules/findings', (req, res, next) => {
  try {
    res.json(withFixable(listModuleFindings({
      scope: normaliseScope(req.query.scope),
      domain: req.query.domain || undefined,
      severity: req.query.severity || undefined,
      priority: req.query.priority || undefined,
      rule: req.query.rule || undefined,
      q: req.query.q || undefined,
      dimension: dimensionParam(req.query),
      limit: Math.min(Number(req.query.limit) || 100, 500),
      offset: Number(req.query.offset) || 0,
    })));
  } catch (err) { next(err); }
});

/**
 * GET /api/health/scan-state — the incremental configuration table: every
 * allow-listed table, whether change checking is on for it, its last complete
 * read and its last change check.
 */
healthRouter.get('/scan-state', (req, res, next) => {
  try {
    res.json({ tables: scanStateTable(), modules: moduleResults(), defaults: INCREMENTAL_DEFAULTS });
  } catch (err) { next(err); }
});

/** PATCH /api/health/scan-state/:table — `{ enabled }`. Off means that table is always read in full. */
healthRouter.patch('/scan-state/:table', (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(422).json({ message: '`enabled` must be true or false.' });
    }
    setTableIncremental(req.params.table, req.body.enabled);
    return res.json({ ok: true, table: req.params.table, enabled: req.body.enabled });
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ message: err.message });
    return next(err);
  }
});

/** GET /api/health/runs/latest — what the page shows before you run anything. */
healthRouter.get('/runs/latest', (req, res, next) => {
  try {
    const run = latestRun();
    if (!run) return res.json({ run: null });
    res.json({
      run: withScopes(run),
      ...listFindings(run.id, {
        scope: normaliseScope(req.query.scope),
        limit: Math.min(Number(req.query.limit) || 50, 200),
      }),
    });
  } catch (err) { next(err); }
});

healthRouter.get('/runs/:runId', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ message: 'No such run on the bound instance.' });
    res.json({ run: withScopes(run) });
  } catch (err) { next(err); }
});

/** GET /api/health/runs/:runId/findings — filtered, paged, no evidence blobs. */
healthRouter.get('/runs/:runId/findings', (req, res, next) => {
  try {
    if (!getRun(req.params.runId)) return res.status(404).json({ message: 'No such run on the bound instance.' });
    res.json(withFixable(listFindings(req.params.runId, {
      scope: normaliseScope(req.query.scope),
      domain: req.query.domain || undefined,
      severity: req.query.severity || undefined,
      priority: req.query.priority || undefined,
      rule: req.query.rule || undefined,
      q: req.query.q || undefined,
      dimension: dimensionParam(req.query),
      limit: Math.min(Number(req.query.limit) || 100, 500),
      offset: Number(req.query.offset) || 0,
    })));
  } catch (err) { next(err); }
});

/** GET /api/health/runs/:runId/findings/:fingerprint — one finding, with evidence. */
healthRouter.get('/runs/:runId/findings/:fingerprint', (req, res, next) => {
  try {
    if (!getRun(req.params.runId)) return res.status(404).json({ message: 'No such run on the bound instance.' });
    const finding = getFinding(req.params.runId, req.params.fingerprint);
    if (!finding) return res.status(404).json({ message: 'No such finding in this run.' });
    res.json({ finding, remediation: remediationFor(finding) });
  } catch (err) { next(err); }
});

/**
 * GET /api/health/runs/:runId/findings/:fingerprint/prompt
 *
 * The draft the Agent page drops into its composer. FETCHED on arrival rather
 * than carried through navigation, exactly as a meeting brief is: a refresh
 * does not lose it, and a prompt naming 25 sys_ids does not belong in a URL.
 *
 * It is PLACED, never sent. The user reads it before it goes anywhere, and any
 * mutation it leads to still stops at the agent's own approval gate.
 */
healthRouter.get('/runs/:runId/findings/:fingerprint/prompt', (req, res, next) => {
  try {
    if (!getRun(req.params.runId)) return res.status(404).json({ message: 'No such run on the bound instance.' });
    const finding = getFinding(req.params.runId, req.params.fingerprint);
    if (!finding) return res.status(404).json({ message: 'No such finding in this run.' });
    const remediation = remediationFor(finding);
    res.json({
      text: remediation.prompt,
      aiAction: remediation.aiAction,
      decision: remediation.decision,
      label: `${finding.rule_id} - ${finding.title}`,
    });
  } catch (err) { next(err); }
});

healthRouter.delete('/runs/:runId', (req, res, next) => {
  try {
    if (!deleteRun(req.params.runId)) {
      return res.status(404).json({ message: 'No such run on the bound instance.' });
    }
    res.json({ deleted: true, runId: req.params.runId });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════════════════════════════
   REMEDIATION — propose → review/edit → approve → execute → validate

   The boundary is APPROVAL, not the kind of finding. Health Assist will
   propose a remediation for anything; nothing reaches the instance until a
   human has read that proposal, edited it if they disagree, and explicitly
   approved THAT version.

   Nothing in this section writes to the instance. Generating, editing and
   rejecting touch only our own database; approving hands the change list to
   the ordinary plan executor, which owns the gate, the read-back and the
   audit trail. See `health/remediate.js`.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/health/runs/:runId/findings/:fingerprint/proposal
 *
 * Ask the AI what it would do. Produces a DRAFT and stores it; changes nothing.
 */
healthRouter.post('/runs/:runId/findings/:fingerprint/proposal', async (req, res, next) => {
  try {
    if (!getRun(req.params.runId)) return res.status(404).json({ message: 'No such run on the bound instance.' });
    const finding = getFinding(req.params.runId, req.params.fingerprint);
    if (!finding) return res.status(404).json({ message: 'No such finding in this run.' });

    const draft = await buildProposal(finding, { readRecord, resolveReference });
    const id = createProposal({ runId: req.params.runId, finding, draft });
    const stored = getProposal(id);
    return res.status(201).json({
      proposal: stored,
      fingerprint: proposalFingerprint(stored.proposal),
      // Said plainly and early: a draft is not a change.
      state: 'Proposed changes — not yet applied',
    });
  } catch (err) { return next(err); }
});

/** GET /api/health/proposals/:id — the proposal and everything that happened to it. */
healthRouter.get('/proposals/:id', (req, res, next) => {
  try {
    const p = getProposal(req.params.id);
    if (!p) return res.status(404).json({ message: 'No such proposal on the bound instance.' });
    return res.json({ proposal: p, fingerprint: p.proposal ? proposalFingerprint(p.proposal) : null });
  } catch (err) { return next(err); }
});

/** GET /api/health/runs/:runId/findings/:fingerprint/proposals — this finding's history. */
healthRouter.get('/runs/:runId/findings/:fingerprint/proposals', (req, res, next) => {
  try {
    return res.json({ proposals: proposalsForFinding(req.params.runId, req.params.fingerprint) });
  } catch (err) { return next(err); }
});

/**
 * PATCH /api/health/proposals/:id
 *
 * Save the user's edited version. The AI's original is kept beside it, never
 * overwritten, so "what did the AI propose" stays answerable afterwards.
 *
 * Returns the NEW fingerprint. An edit invalidates any approval given for the
 * previous version, which is the point of returning it rather than assuming the
 * client still holds a current one.
 */
healthRouter.patch('/proposals/:id', (req, res, next) => {
  try {
    const existing = getProposal(req.params.id);
    if (!existing) return res.status(404).json({ message: 'No such proposal on the bound instance.' });

    const incoming = req.body?.proposal;
    if (!incoming || !Array.isArray(incoming.changes)) {
      return res.status(400).json({ message: 'A proposal with a changes array is required.' });
    }

    /*
     * THE USER MAY EDIT VALUES AND REMOVE CHANGES. THEY MAY NOT RETARGET ONE.
     *
     * `table`, `sys_id` and `field` are carried over from the stored draft by
     * id rather than read from the request, so a malformed or tampered body
     * cannot point an approved change at a different record. Editing the VALUE
     * is the whole feature; editing the TARGET would make the finding's own
     * evidence no longer describe what is about to happen.
     */
    const byId = new Map((existing.proposal?.changes || []).map((c) => [c.id, c]));
    const merged = [];
    for (const c of incoming.changes) {
      const base = byId.get(c?.id);
      if (!base) continue;
      const proposedValue = typeof c.proposedValue === 'string' ? c.proposedValue.slice(0, 500) : base.proposedValue;
      merged.push({
        ...base,
        proposedValue,
        status: c.status === CHANGE_STATUS.REMOVED
          ? CHANGE_STATUS.REMOVED
          : (base.fieldKind === 'delete' || String(proposedValue).trim() ? CHANGE_STATUS.READY : CHANGE_STATUS.NEEDS_VALUE),
        edited: proposedValue !== base.proposedValue || c.status === CHANGE_STATUS.REMOVED,
      });
    }

    const next = {
      ...existing.proposal,
      changes: merged,
      userNote: typeof incoming.userNote === 'string' ? incoming.userNote.slice(0, 2000) : (existing.proposal?.userNote ?? ''),
    };

    const saved = saveEdit(req.params.id, next);
    if (!saved.ok) {
      return res.status(409).json({
        message: saved.reason === 'already_decided'
          ? `This proposal is already ${saved.status} and cannot be edited. Generate a new one.`
          : saved.reason,
      });
    }
    return res.json({ proposal: getProposal(req.params.id), fingerprint: proposalFingerprint(next) });
  } catch (err) { return next(err); }
});

/**
 * POST /api/health/proposals/:id/reject
 *
 * Changes nothing on the instance, keeps the finding and its evidence, and
 * records the reason if one was given. A rejection is not a route back to
 * planning — generating a new proposal is a new row.
 */
healthRouter.post('/proposals/:id/reject', (req, res, next) => {
  try {
    const done = rejectProposal(req.params.id, req.body?.reason);
    if (!done.ok) {
      return res.status(done.reason === 'no_such_proposal' ? 404 : 409).json({
        message: done.reason === 'already_decided'
          ? `This proposal is already ${done.status}.`
          : 'No such proposal on the bound instance.',
      });
    }
    return res.json({ proposal: getProposal(req.params.id), applied: false });
  } catch (err) { return next(err); }
});

/** Statuses from which a proposal may still be approved. Anything else is settled. */
const APPROVABLE = ['draft', 'edited'];

/**
 * Apply ONE approved proposal: prepare → bind → execute → validate.
 *
 * THE ONE SEQUENCE, SHARED BY BOTH ROUTES THAT LEAD TO A WRITE. The single
 * Approve and apply and the Bulk Fix call this and nothing else, so a batch is
 * literally the single flow run once per finding — same fingerprint check,
 * same provenance re-read, same plan binding, same executor, same per-record
 * card, same read-back. There is no bulk-only path to a mutation, and the
 * approval inventory (phase9-approval-audit) still counts ONE `approvePlan`
 * call in this file.
 *
 * `emit` is the route's audited emitter; `signal` is the request's abort. The
 * caller owns the SSE headers, the audit run and the terminal frame.
 */
async function applyProposal({ p, presentedFingerprint, emit, signal }) {
  /* ---- PREPARE: build and save the plan, park it at AWAITING_APPROVAL ---- */
  const prep = await prepareRemediation({
    proposalId: p.id,
    proposal: p.proposal,
    runId: p.runId,
    presentedFingerprint,
    emit,
    signal,
    /* The targets are re-read in the remediation's own session before the
       plan is built, so the executor's provenance guard sees them. */
    readRecord,
  });

  let result = prep;
  if (prep.ok) {
    /* ---- APPROVE ----------------------------------------------------------
     * BOUND HERE, IN THE ROUTE, ON PURPOSE.
     *
     * `routes/` is the only place this system raises or binds an approval, so
     * that a reader auditing "what can authorise a write" can read the routers
     * and stop. `approvePlan` refuses on a fingerprint mismatch and is the only
     * thing that may open the edge into EXECUTING.
     *
     * The provenance is `user_click` because that is literally what happened: a
     * human read this exact change list and pressed Approve and apply.
     *
     * This binds the PLAN. The executor still raises its per-step card before
     * each write, and that card is answered in the drawer through
     * POST /api/agent/approve — never here. This route does not resolve
     * approvals; it only binds the one the human just gave.
     */
    const bound = approvePlan(prep.taskId, prep.planFingerprint, { source: 'user_click' });
    if (!bound.ok) {
      result = {
        ok: false,
        reason: bound.reason,
        taskId: prep.taskId,
        note: bound.reason === 'fingerprint_mismatch'
          ? 'The plan changed after it was built, so the approval does not apply. Nothing ran.'
          : `The plan could not be approved (${bound.reason}). Nothing ran.`,
      };
    } else {
      /* ---- EXECUTE + VALIDATE ---- */
      result = await runRemediation({
        proposalId: p.id,
        proposal: p.proposal,
        taskId: prep.taskId,
        sessionId: prep.sessionId,
        changes: prep.changes,
        emit,
        signal,
        readRecord,
      });
    }
  }
  return result;
}

/**
 * POST /api/health/proposals/:id/approve  (SSE)
 *
 * The only route in Health Assist that leads to a write, and it leads there
 * through the ordinary plan executor rather than doing anything itself.
 *
 * `fingerprint` is what the user was looking at. It is compared with the stored
 * proposal before a plan is built, so an approval given for one version cannot
 * execute another.
 */
healthRouter.post('/proposals/:id/approve', async (req, res) => {
  const p = getProposal(req.params.id);
  if (!p) return res.status(404).json({ message: 'No such proposal on the bound instance.' });
  if (!APPROVABLE.includes(p.status)) {
    return res.status(409).json({ message: `This proposal is already ${p.status}.` });
  }

  const write = openStream(res);
  const auditRun = startBuildRun({
    kind: 'health_remediation',
    label: `${p.ruleId} · ${p.findingFingerprint.slice(0, 12)}`,
    request: { proposalId: p.id, runId: p.runId, changes: executableChanges(p.proposal).length },
  });
  const emit = auditedEmit(auditRun, write);

  /* Phase 0's cancellation: the client aborting is the only cancel path. */
  const controller = new AbortController();
  let settled = false;
  const onGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onGone);

  try {
    const result = await applyProposal({
      p, presentedFingerprint: req.body?.fingerprint || null, emit, signal: controller.signal,
    });

    emit({
      type: result.ok ? 'done' : 'error',
      ...(result.ok ? {} : { message: result.note || result.reason }),
      proposal: getProposal(p.id),
      result,
    });
    finishBuildRun(auditRun, {
      status: result.ok ? 'ok' : 'error',
      summary: { proposalId: p.id, taskId: result.taskId ?? null, status: result.status ?? result.reason },
    });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    finishBuildRun(auditRun, { status: 'error', summary: { proposalId: p.id, message: err.message } });
  } finally {
    settled = true;
    res.off('close', onGone);
    res.end();
  }
  return undefined;
});

/* ══════════════════════════════════════════════════════════════════════════
   BULK FIX — the single flow, once per selected finding

   Two streamed routes, mirroring the two halves of the single flow:

     POST /bulk/proposals   generate a proposal for each selected finding
     POST /bulk/approve     apply each reviewed proposal, one after another

   Between them the reviewer edits, excludes and approves in the page, exactly
   as they do for one finding — every proposal is its own row, with its own
   fingerprint, and the approve body carries the fingerprint of EACH version
   the reviewer saw. There is no batch-level approval that could cover a
   proposal nobody read.

   SEQUENTIAL, ON PURPOSE. Each proposal is applied in its own session with its
   own provenance re-read, its own plan binding and its own per-record cards,
   and a card is one question to one person — two batches of cards racing for
   the same reviewer would be a worse interface, not a faster one. The executor
   also cancels at a step boundary, so a stopped batch leaves each item either
   fully reported or never started.

   Nothing here writes. The instance is reached only through `applyProposal`
   above, which is the single route's own sequence.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/health/bulk/proposals  (SSE)
 *
 * Body: `{ items: [{ runId, fingerprint }] }`. Emits one `item_proposed` (or
 * `item_skipped`) per finding as it is ready, then `done` with every item.
 * Read-only: it touches the instance for current values and writes only
 * proposal rows to our own database, exactly as the single proposal route does.
 */
healthRouter.post('/bulk/proposals', async (req, res) => {
  const sel = normaliseSelection(req.body?.items);
  if (!sel.ok) return res.status(sel.reason === 'too_many' ? 413 : 400).json({ message: sel.note });

  const write = openStream(res);
  const controller = new AbortController();
  let settled = false;
  const onGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onGone);

  const items = [];
  try {
    write({ type: 'bulk_started', phase: 'proposals', total: sel.items.length });
    for (let i = 0; i < sel.items.length; i += 1) {
      const it = sel.items[i];
      const item = { key: it.key, runId: it.runId, fingerprint: it.fingerprint, index: i };
      if (controller.signal.aborted) {
        items.push({ ...item, status: BULK_ITEM_STATUS.NOT_STARTED, note: 'Stopped before this finding was reached.' });
        continue;
      }
      write({ type: 'item_started', key: it.key, index: i, total: sel.items.length });

      /*
       * STALE: the run or the finding is not on this instance any more — the
       * run was deleted, or the page's list outlived a re-scan. Said per item
       * rather than failing the batch, because the other findings are fine.
       */
      const finding = getRun(it.runId) ? getFinding(it.runId, it.fingerprint) : null;
      if (!finding) {
        items.push({ ...item, status: BULK_ITEM_STATUS.STALE, note: 'This finding is no longer in its run on the bound instance. Re-run the scan and select it again.' });
        write({ type: 'item_skipped', key: it.key, status: BULK_ITEM_STATUS.STALE, note: items.at(-1).note });
        continue;
      }
      item.ruleId = finding.rule_id;
      item.title = finding.title;
      item.severity = finding.severity;
      item.table = finding.table;

      /* A finding that already has an applied proposal in this run is flagged,
         not refused: the reviewer decides whether to try again. */
      const prior = proposalsForFinding(it.runId, it.fingerprint).find((x) => ['applied', 'partial'].includes(x.status));
      if (prior) {
        item.priorProposal = { id: prior.id, status: prior.status, decidedAt: prior.decidedAt };
      }

      try {
        const draft = await buildProposal(finding, { readRecord, resolveReference });
        const id = createProposal({ runId: it.runId, finding, draft });
        const stored = getProposal(id);
        const executable = executableChanges(stored.proposal).length;
        item.proposalId = id;
        item.proposal = stored;
        item.proposalFingerprint = proposalFingerprint(stored.proposal);
        item.status = classifyProposal(stored.proposal, executable);
        item.note = proposalNote(item.status);
        items.push(item);
        write({ type: 'item_proposed', key: it.key, item });
      } catch (err) {
        log.error('health', `bulk proposal for ${it.fingerprint.slice(0, 12)} failed — ${err.message}`, err);
        items.push({ ...item, status: BULK_ITEM_STATUS.PROPOSAL_FAILED, note: `The proposal could not be generated: ${err.message}` });
        write({ type: 'item_skipped', key: it.key, status: BULK_ITEM_STATUS.PROPOSAL_FAILED, note: items.at(-1).note });
      }
    }
    write({ type: 'done', phase: 'proposals', items });
  } catch (err) {
    write({ type: 'error', message: err.message, items });
  } finally {
    settled = true;
    res.off('close', onGone);
    res.end();
  }
  return undefined;
});

/**
 * POST /api/health/bulk/approve  (SSE)
 *
 * Body: `{ items: [{ proposalId, fingerprint }] }` — each fingerprint is the
 * version of THAT proposal the reviewer approved. Every frame the single route
 * would stream for a proposal is streamed here tagged with `item: proposalId`,
 * so the page answers each executor card against the right session, and
 * `item_done` closes each one with the store's own verdict. `done` carries the
 * batch, never rounded up.
 */
healthRouter.post('/bulk/approve', async (req, res) => {
  const sel = normaliseApprovals(req.body?.items);
  if (!sel.ok) return res.status(sel.reason === 'too_many' ? 413 : 400).json({ message: sel.note });

  const bulkId = crypto.randomUUID();
  const write = openStream(res);
  const controller = new AbortController();
  let settled = false;
  const onGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onGone);

  const items = [];
  const settle = (item) => { items.push(item); write({ type: 'item_done', item: item.proposalId, ...item }); };
  try {
    write({ type: 'bulk_started', phase: 'apply', bulkId, total: sel.items.length });
    for (let i = 0; i < sel.items.length; i += 1) {
      const { proposalId, fingerprint } = sel.items[i];
      const base = { proposalId, index: i };
      if (controller.signal.aborted) {
        settle({ ...base, status: BULK_ITEM_STATUS.NOT_STARTED, note: 'Stopped before this proposal was reached. Nothing was sent for it.' });
        continue;
      }
      const p = getProposal(proposalId);
      if (!p) {
        settle({ ...base, status: BULK_ITEM_STATUS.STALE, note: 'No such proposal on the bound instance. Nothing was sent for it.' });
        continue;
      }
      base.runId = p.runId;
      base.fingerprint = p.findingFingerprint;
      base.ruleId = p.ruleId;
      if (!APPROVABLE.includes(p.status)) {
        settle({ ...base, status: BULK_ITEM_STATUS.ALREADY_DECIDED, note: `This proposal is already ${p.status}. Nothing was sent for it.`, proposal: p });
        continue;
      }
      /* Nothing executable — no field fix, or no value supplied. The single
         route would open a task and fail it with "nothing to do"; here it is
         a skip with the same reason, because the batch goes on. */
      if (!executableChanges(p.proposal).length) {
        const status = classifyProposal(p.proposal, 0);
        settle({ ...base, status, note: proposalNote(status) ?? 'Nothing to apply.', proposal: p });
        continue;
      }

      write({ type: 'item_started', item: proposalId, index: i, total: sel.items.length, ruleId: p.ruleId });
      /* One audit run per proposal — the same unit the single route records —
         carrying the batch id so the runs can be read together afterwards. */
      const auditRun = startBuildRun({
        kind: 'health_remediation',
        label: `${p.ruleId} · ${p.findingFingerprint.slice(0, 12)} · bulk ${bulkId.slice(0, 8)}`,
        request: { proposalId: p.id, runId: p.runId, changes: executableChanges(p.proposal).length, bulkId },
      });
      const emit = auditedEmit(auditRun, (e) => write({ ...e, item: proposalId }));
      let result;
      try {
        result = await applyProposal({ p, presentedFingerprint: fingerprint, emit, signal: controller.signal });
        finishBuildRun(auditRun, {
          status: result.ok ? 'ok' : 'error',
          summary: { proposalId: p.id, taskId: result.taskId ?? null, status: result.status ?? result.reason, bulkId },
        });
      } catch (err) {
        result = { ok: false, reason: 'error', note: err.message };
        finishBuildRun(auditRun, { status: 'error', summary: { proposalId: p.id, message: err.message, bulkId } });
      }
      settle({
        ...base,
        status: classifyOutcome(result),
        note: result.ok ? null : (result.note || result.reason),
        result,
        proposal: getProposal(p.id),
      });
    }
    write({ type: 'done', phase: 'apply', bulkId, items, summary: summariseBulk(items) });
  } catch (err) {
    write({ type: 'error', message: err.message, bulkId, items, summary: summariseBulk(items) });
  } finally {
    settled = true;
    res.off('close', onGone);
    res.end();
  }
  return undefined;
});

/* ══════════════════════════════════════════════════════════════════════════
   LIFECYCLE, TREND AND EXPORT
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * PATCH /api/health/findings/:fingerprint/state
 *
 * Acknowledge, mute or accept a finding. Muting is PRESENTATION, never
 * deletion: the finding is still detected, still stored and still counted. What
 * changes is whether it demands attention.
 *
 * Keyed on the fingerprint, so a decision carries across runs — and cannot
 * suppress a different set of records, because a different set hashes
 * differently and arrives as new.
 */
healthRouter.patch('/findings/:fingerprint/state', (req, res, next) => {
  try {
    const { state, reason, ruleId, expiresAt } = req.body || {};
    const done = setFindingState(req.params.fingerprint, { state, reason, ruleId, expiresAt });
    if (!done.ok) {
      return res.status(422).json({
        message: done.note
          || (done.reason === 'unknown_state'
            ? `Unknown state. Allowed: ${done.allowed.join(', ')}.`
            : done.reason),
      });
    }
    return res.json({ state: done.state });
  } catch (err) { return next(err); }
});

/** DELETE — back to plain `open`, with no recorded decision. */
healthRouter.delete('/findings/:fingerprint/state', (req, res, next) => {
  try {
    return res.json({ cleared: clearFindingState(req.params.fingerprint).ok });
  } catch (err) { return next(err); }
});

/** GET /api/health/states — every decision on this instance, for the UI's filters. */
healthRouter.get('/states', (req, res, next) => {
  try {
    return res.json({ vocabulary: STATE_VOCABULARY, states: [...stateMap().values()] });
  } catch (err) { return next(err); }
});

/**
 * GET /api/health/trend — the score and counts over time.
 *
 * A run whose score was WITHHELD carries `null` rather than being dropped, so
 * the line has a visible gap instead of implying continuity across a period
 * where coverage was actually incomplete.
 */
healthRouter.get('/trend', (req, res, next) => {
  try {
    return res.json({ points: trend({ limit: Math.min(Number(req.query.limit) || 30, 100) }) });
  } catch (err) { return next(err); }
});

/**
 * GET /api/health/runs/:runId/export.csv
 *
 * Honours the same filters the page is showing, rather than dumping the table —
 * an export that does not match what you were looking at is a different report.
 *
 * Cells go through the audit module's own `csvCell`. There is one escaper in
 * this app and this is it: a spreadsheet executes a cell beginning `=`, `+`,
 * `-` or `@` (trap #38), and these carry rule text and model-authored
 * summaries.
 */
const EXPORT_EVERY_ROW = -1;
function exportFilters(req) {
  return {
    scope: normaliseScope(req.query.scope),
    domain: req.query.domain || undefined,
    severity: req.query.severity || undefined,
    rule: req.query.rule || undefined,
    dimension: dimensionParam(req.query),
    /* Every stored row. A run stores every finding it detected, and an export
       that silently stopped at 10,000 of 12,194 would be a different report.
       SQLite reads a negative LIMIT as "no upper bound". */
    limit: EXPORT_EVERY_ROW,
  };
}

/** GET /api/health/modules/export.csv — the All view's export: each module from its own result. */
healthRouter.get('/modules/export.csv', (req, res, next) => {
  try {
    const { findings } = listModuleFindings(exportFilters(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="health-modules-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(findingsCsv(findings, { withRun: true }));
  } catch (err) { return next(err); }
});

function findingsCsv(findings, { withRun = false } = {}) {
  const columns = ['scope', 'severity', 'priority', 'domain', 'rule', 'title', 'table',
    'records', 'sys_ids', 'state', 'state_reason', 'confidence', 'recommendation', ...(withRun ? ['run_id'] : [])];
  const lines = [columns.join(',')];
  for (const f of findings) {
    lines.push([
      scopeOfFinding(f), f.severity, f.priority, f.domain, f.rule_id, f.title, f.table,
      (f.target_ids || []).length, (f.target_ids || []).join(' '),
      f.lifecycle?.state || 'open', f.lifecycle?.reason || '',
      f.confidence, f.recommendation || '', ...(withRun ? [f.run_id] : []),
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

healthRouter.get('/runs/:runId/export.csv', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ message: 'No such run on the bound instance.' });

    const { findings } = listFindings(req.params.runId, exportFilters(req));

    const columns = ['scope', 'severity', 'priority', 'domain', 'rule', 'title', 'table',
      'records', 'sys_ids', 'state', 'state_reason', 'confidence', 'recommendation'];
    const lines = [columns.join(',')];
    for (const f of findings) {
      lines.push([
        scopeOfFinding(f), f.severity, f.priority, f.domain, f.rule_id, f.title, f.table,
        (f.target_ids || []).length, (f.target_ids || []).join(' '),
        f.lifecycle?.state || 'open', f.lifecycle?.reason || '',
        f.confidence, f.recommendation || '',
      ].map(csvCell).join(','));
    }

    const stamp = (run.startedAt || '').slice(0, 10) || 'run';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="health-${stamp}-${req.params.runId.slice(0, 8)}.csv"`);
    return res.send(lines.join('\n'));
  } catch (err) { return next(err); }
});
