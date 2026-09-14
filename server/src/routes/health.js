import { Router } from 'express';
import { startBuildRun, finishBuildRun, auditedEmit, csvCell } from '../memory/audit.js';
import { boundInstance } from '../servicenow/instance-binding.js';
import { runHealthCheck, MAX_FINDINGS } from '../health/index.js';
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
  listRuns, getRun, latestRun, listFindings, getFinding, deleteRun,
} from '../health/store.js';
import {
  setFindingState, clearFindingState, stateMap, STATE_VOCABULARY,
} from '../health/finding-state.js';
import { scopeVocabulary, normaliseScope, scopeOf as scopeOfFinding } from '../health/scopes.js';

export const healthRouter = Router();

/**
 * Health Assist — estate health over the bound instance, across CMDB, ITOM,
 * ITSM and platform hygiene.
 *
 * DETECTION READS; ONLY AN APPROVED PLAN WRITES. Running a check, reading
 * findings, setting a finding's lifecycle state and generating a remediation
 * proposal never touch the instance — the last two write only to our own
 * database. The single route that can lead to a change is
 * `POST /proposals/:id/approve`, and it binds the approval here and hands the
 * change list to the ordinary plan executor, which owns the gate, the read-back
 * and the audit trail. This router never imports the instance client.
 */

/** Attach per-scope summaries to a run — stored, or computed for an older one. */
function withScopes(run) {
  if (!run?.manifest) return run;
  return { ...run, manifest: { ...run.manifest, scopes: scopesForRun(run) } };
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
    note: 'Checks only read. A fix is proposed first, and nothing on the instance changes until you approve that exact list.',
  });
});

/**
 * POST /api/health/runs — run a check, streaming progress.
 *
 * SSE over POST because the request carries a body, like every other streaming
 * route here. Exactly one terminal frame (`done` or `error`) per §4.6 — the
 * client's reader throws on a stream that simply stops, so a server that dies
 * mid-run is distinguishable from one that finished.
 */
healthRouter.post('/runs', async (req, res) => {
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
   * different cutoffs, so the second is refused rather than reconciled.
   */
  const inFlight = runInFlight();
  if (inFlight) {
    return res.status(409).json({
      message: 'A health check is already running against this instance. Wait for it to finish, or stop it first.',
      runId: inFlight.id,
      startedAt: inFlight.startedAt,
    });
  }

  const { tables, staleDays, explain = true, limit } = req.body || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ } };
  const auditRun = startBuildRun({
    kind: 'health_check',
    label: bound.url,
    request: { tables: tables ?? null, staleDays: staleDays ?? null, explain },
  });
  const emit = auditedEmit(auditRun, write);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  /*
   * Phase 0's cancellation, unchanged: one controller per request, aborted when
   * the client goes away, observed between tables. A health check only reads,
   * so stopping one leaves nothing half-done on the instance.
   */
  const controller = new AbortController();
  let settled = false;
  const onGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onGone);

  const runId = openRun();
  emit({ type: 'run_started', runId });

  try {
    const result = await runHealthCheck({
      tables,
      explain,
      limit: Number(limit) || undefined,
      staleDays: Number(staleDays) || undefined,
      signal: controller.signal,
      onProgress: async (p) => emit({ type: 'progress', ...p }),
    });

    completeRun(runId, result);
    emit({ type: 'done', runId, status: result.status, manifest: result.manifest });
    finishBuildRun(auditRun, {
      status: result.status === 'failed' ? 'error' : 'ok',
      summary: {
        runId,
        status: result.status,
        findings: result.manifest.findings_stored,
        score: result.manifest.metrics.cmdb_quality_score,
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
      failRun(runId, err);
      emit({ type: 'error', runId, message: err.message });
      finishBuildRun(auditRun, { status: 'error', summary: { runId, message: err.message } });
    }
  } finally {
    clearInterval(keepAlive);
    settled = true;
    res.off('close', onGone);
    res.end();
  }
});

/** GET /api/health/runs — this instance's runs, newest first. */
healthRouter.get('/runs', (req, res, next) => {
  try {
    res.json({ runs: listRuns({ limit: Math.min(Number(req.query.limit) || 20, 100) }) });
  } catch (err) { next(err); }
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
    res.json(listFindings(req.params.runId, {
      scope: normaliseScope(req.query.scope),
      domain: req.query.domain || undefined,
      severity: req.query.severity || undefined,
      priority: req.query.priority || undefined,
      rule: req.query.rule || undefined,
      limit: Math.min(Number(req.query.limit) || 100, 500),
      offset: Number(req.query.offset) || 0,
    }));
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
  if (!['draft', 'edited'].includes(p.status)) {
    return res.status(409).json({ message: `This proposal is already ${p.status}.` });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ } };
  const auditRun = startBuildRun({
    kind: 'health_remediation',
    label: `${p.ruleId} · ${p.findingFingerprint.slice(0, 12)}`,
    request: { proposalId: p.id, runId: p.runId, changes: executableChanges(p.proposal).length },
  });
  const emit = auditedEmit(auditRun, write);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  /* Phase 0's cancellation: the client aborting is the only cancel path. */
  const controller = new AbortController();
  let settled = false;
  const onGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onGone);

  try {
    /* ---- PREPARE: build and save the plan, park it at AWAITING_APPROVAL ---- */
    const prep = await prepareRemediation({
      proposalId: p.id,
      proposal: p.proposal,
      runId: p.runId,
      presentedFingerprint: req.body?.fingerprint || null,
      emit,
      signal: controller.signal,
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
          signal: controller.signal,
          readRecord,
        });
      }
    }

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
    clearInterval(keepAlive);
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
healthRouter.get('/runs/:runId/export.csv', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ message: 'No such run on the bound instance.' });

    const { findings } = listFindings(req.params.runId, {
      scope: normaliseScope(req.query.scope),
      domain: req.query.domain || undefined,
      severity: req.query.severity || undefined,
      rule: req.query.rule || undefined,
      /* The run's own storage cap, not a smaller one of our own: an export that
         silently stopped at 10,000 of 12,194 would be a different report. */
      limit: MAX_FINDINGS,
    });

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
