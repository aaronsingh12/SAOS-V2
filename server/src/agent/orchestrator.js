import crypto from 'node:crypto';
import { chatTurn, providerInfo } from './providers/index.js';
// The attempt count belongs to the retry policy, so the message quotes it
// rather than restating "three times in a row" and drifting from it.
import { RETRY_ATTEMPTS } from './providers/retry.js';
import { log, ms, shortId } from '../logging.js';
import { TOOLS, toolMap } from './tools.js';
import { buildSystemPrompt, iterationBudgetNotice } from './prompts.js';
import { getSettings } from '../config/store.js';
import {
  createSession,
  getSession as loadSessionRow,
  appendMessage,
  rewriteMessage,
  loadHistory,
  recordToolEvent,
  latestUserSeq,
} from '../memory/sessions.js';
import { compactIfNeeded, buildDigestNote, estimateTokens } from '../memory/compaction.js';
import { computeBudget } from '../memory/budget.js';
import { sanitizeHistory, isBlankText } from '../memory/sanitize.js';
import { recordVerificationFailure } from '../memory/facts.js';
import { indexMessage } from '../memory/recall.js';
import { captureAfterTool, captureMark, reconcileTurn } from './capture.js';
import { openCaptureWindow, closeCaptureWindow } from '../servicenow/transport.js';
import { snapshotBefore, verifyMutation, attachVerification, isFailedWrite } from './mutation-pipeline.js';
import { appendMutation, annotateLatestCapture, mutationsForTurn, renderMutationReport, ledgerDigestForModel } from '../memory/ledger.js';
import { impersonationBoundaryLine, impFacts } from '../memory/impersonation-mode.js';
import { appendImpersonatedMutation } from '../memory/impersonation-audit.js';
import { impersonationChip } from './impersonation-render.js';
import { willExecuteImpersonated } from './impersonated-write.js';
import { checkTaskBoundary, previewImpersonation } from './impersonation-ops.js';
import { checkBeforeGate, recordDrops, recordRejection } from './write-guard.js';
import { checkWriteTarget } from '../memory/provenance.js';
import { businessRuleAbortPlaybook, dataVsConfigNote } from './playbooks.js';
import { planTimeTrapCheck } from './plan-check.js';
import { retrieveForTurn } from '../knowledge/context.js';
import { buildContextProfile, widenProfile, contextDiagnostics, logProfile } from './context-engine.js';
import { isGatedDescriptor, runGatedWrite, resolveRunnerSysId } from '../servicenow/elevation-shim-client.js';
import { registerElevatedWrite } from '../memory/provenance.js';
import { listSkills, toolsForSkills, skillsForProfile, skillContextBlock, activeSkillSummary } from './skills/index.js';

/**
 * The backbone, modeled on Claude Code / opencode:
 *   session state → provider-agnostic agent loop → tool registry →
 *   permission gate on mutations → streamed events to the UI.
 *
 * Neutral history format (translated per-provider by the adapters):
 *   { role: 'user', text }
 *   { role: 'assistant', text, toolCalls: [{id, name, input}] }
 *   { role: 'tool', results: [{id, name, output, isError}] }
 *
 * History is PERSISTED (A-1): it is read from SQLite at the start of every turn
 * and written through as it is produced. Nothing about a conversation lives
 * only in this process any more, which is what makes "navigate away and back"
 * and "restart the server" lossless rather than merely unlikely to be noticed.
 *
 * The in-memory map now holds only what genuinely cannot be persisted: the
 * unresolved approval promises for turns currently in flight. A restart
 * legitimately abandons those — the tool never ran.
 */

/**
 * WI-IMP-2 — the two tools whose approval card must state WHO is being
 * impersonated and whether that person holds admin. Both escalate: they decide
 * whose authority every following instruction carries.
 */
const IMPERSONATION_GATED_TOOLS = new Set(['impersonation_start', 'impersonation_switch']);

const live = new Map(); // sessionId -> { pending: Map<approvalId, resolver> }

function liveState(id) {
  if (!live.has(id)) live.set(id, { pending: new Map() });
  return live.get(id);
}

/**
 * PHASE 4 — the approval primitives, exposed so the plan executor can use THIS
 * gate rather than growing a second one.
 *
 * Nothing about the gate changes. `resolveApproval` is still the only resolver,
 * `POST /api/agent/approve` is still its only caller, the nonce is still minted
 * per card and compared in constant time, and `executeTool` still refuses any
 * mutation whose approval cannot be attributed. What these two exports add is
 * ACCESS to the same pending map, so a plan step waits at the same place a turn
 * step does and a click resolves either identically.
 *
 * Exported rather than refactored deliberately: `runTurn`'s inline gate is
 * untouched, so every Phase 0-3 turn-control invariant is byte-for-byte what it
 * was.
 */
export { liveState as _approvalState };
export function awaitApprovalDecision(sessionId, approvalId, nonce, signal = null) {
  return awaitApproval(liveState(sessionId), approvalId, nonce, signal);
}

/** Kept for API compatibility; the durable half now comes from SQLite. */
export function getSession(id) {
  if (!loadSessionRow(id)) createSession({ id });
  return { history: loadHistory(id), pending: liveState(id).pending };
}

/**
 * WI-4 — where an approval came from.
 *
 * `unknown` is not a failure mode to be avoided; it is the honest value for
 * every row written before this existed, and for any resolver that cannot say
 * who it is. It is rendered as "unknown", never quietly upgraded.
 */
export const APPROVAL_SOURCES = Object.freeze({
  USER_CLICK: 'user_click',
  AUTO_APPROVE: 'auto_approve',
  UNKNOWN: 'unknown',
});
const KNOWN_SOURCES = new Set(Object.values(APPROVAL_SOURCES));

/**
 * Resolve a pending approval. `source` says who did it.
 *
 * There is exactly one caller — POST /api/agent/approve, the endpoint the
 * approval card's buttons post to. It reports `user_click` because that is what
 * that endpoint is for; the app is unauthenticated local dev, so any process
 * that knows an approvalId can reach it and would be recorded the same way.
 * That limit is real and is written down in docs/incidents/2026-08-24-ask-act.md
 * rather than papered over with a value this code cannot actually verify.
 */
export function resolveApproval(sessionId, approvalId, approved, source = APPROVAL_SOURCES.UNKNOWN, nonce = null) {
  const state = live.get(sessionId);
  const pending = state?.pending.get(approvalId);
  if (!pending) return { ok: false, reason: 'no-such-approval' };

  /*
   * FOLLOW-UP WI-3 — the approval must come from the card that asked for it.
   *
   * Before this, `POST /api/agent/approve` accepted any local POST that knew an
   * approvalId, and the id travels in the SSE stream. `user_click` therefore
   * meant no more than "what that endpoint is for". The nonce is minted here,
   * goes out once with the card, and comes back or the decision is refused.
   *
   * A mismatch LEAVES THE APPROVAL PENDING. Consuming it would let one wrong
   * POST cancel a mutation the user was about to authorise, which converts a
   * spoofing guard into a denial-of-service on the gate — the pending record
   * survives to be approved correctly afterwards, and the test says so.
   *
   * `timingSafeEqual` because a comparison that returns early on the first
   * wrong byte is a comparison that can be probed one byte at a time. The
   * length check precedes it: the primitive throws on unequal lengths, which
   * would be a leak of its own.
   */
  if (!nonceMatches(pending.nonce, nonce)) {
    log.error('gate',
      `REFUSED an approval for ${approvalId}: the request carried ${nonce ? 'a different token' : 'no token'}. `
      + 'The approval is still pending.');
    try {
      recordToolEvent(sessionId, {
        /*
         * EXPERIENCE §8 — a REFUSED approval belongs to the task whose card was
         * refused, and this is the one audit row the turn loop cannot stamp
         * itself: `resolveApproval` runs on the approve REQUEST, in a different
         * HTTP call, with no turn on the stack. The live state is the only
         * thing both sides share, so the turn leaves its id there (see
         * `state.taskId` in runTurn) and this reads it back.
         *
         * Null when no turn is live — which is exactly the case where there is
         * no task to name, and the window fallback is then the honest answer.
         */
        taskId: state?.taskId ?? null,
        kind: 'guard', name: 'approve_token_mismatch',
        payload: { approvalId, presented: nonce ? 'mismatched' : 'absent', approved: Boolean(approved) },
        resultStatus: 'refused', mutating: false, approval: null,
      });
    } catch (err) { log.warn('gate', `could not record the token mismatch: ${err.message}`); }
    // Straight into the transcript when a turn is live: a refused approval the
    // user cannot see is the shape this whole class of defect keeps taking.
    try { state.emit?.({ type: 'approve_token_mismatch', approvalId, presented: nonce ? 'mismatched' : 'absent' }); }
    catch { /* the stream is gone; the durable row is the record */ }
    return { ok: false, reason: 'token-mismatch' };
  }

  state.pending.delete(approvalId);
  pending.resolve({
    approved: Boolean(approved),
    source: KNOWN_SOURCES.has(source) ? source : APPROVAL_SOURCES.UNKNOWN,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

/** Constant-time, and length-checked first because the primitive throws otherwise. */
function nonceMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * F14 — how many LLM calls one user turn may spend.
 *
 * 15 was sized for a conversational turn: read a couple of records, write one,
 * report. It is not what this agent is asked to do any more. A phase pack —
 * build the item, its variables, the UI policies, verify each write, save the
 * sys_ids — is dozens of tool calls by construction, and every `remember_fact`
 * spends one too, so the turn that is diligent about persisting what it
 * learned exhausts the budget FASTER than the one that is careless.
 *
 * Live 2026-08-24: a phase turn failed on iteration 15 of 15 — the last call
 * in the budget, with fact-saves having consumed several of the ones before
 * it. The cap was not a safety margin that turn ran into; it was the turn's
 * cause of death.
 *
 * 30 is the phase-pack size with room to wind down. It is still a bound, and
 * it is now a bound the model can SEE coming: F12 warns at three calls left,
 * so a turn that would previously have been cut off mid-work gets told to save
 * its sys_ids and report instead.
 */
export const MAX_ITERATIONS = 30;

/**
 * M3 — how many times one turn may be told to explain itself.
 *
 * Three, measured rather than chosen: live round 2 recovered after one bounce,
 * round 3 needed a second (the model read a schema in between and submitted
 * another bare write), so two is the observed requirement and three is that
 * with one spare. Past it the turn is abandoned loudly — an agent that will not
 * say what it is doing does not get to do it.
 */
export const MAX_UNEXPLAINED_BOUNCES = 3;

/**
 * The completion budget per call. Named because the history budget subtracts
 * headroom for it — the two numbers have to agree, and a literal in two places
 * is how they stop agreeing.
 */
 const MAX_OUTPUT_TOKENS = 4096;


/**
 * F9 — the agent loop asks for a temperature instead of inheriting one.
 *
 * Every other generation path in this repo pins its decoding (see
 * agent/decoding.js); the agent turn was the one that sent nothing and took
 * whatever the backend's default sampling happened to be. Evidence that it
 * matters is in the session this branch came from: one assistant turn opened
 * as valid JSON and then collapsed into a run of repeated U+00A0 and stray
 * punctuation before stopping — a repetition collapse, which is what
 * unpinned sampling looks like when it goes wrong.
 *
 * 0.2 rather than 0: this loop chooses tools and writes prose to a person, so
 * it is not the pure structured-generation case that CODEGEN_TEMPERATURE is
 * for, and a hard 0 makes a model that has picked the wrong tool pick it again
 * on the retry.
 *
 * No seed. It is measured to be ignored by this backend (decoding.js), and
 * requesting one here would only invite someone downstream to assume a
 * reproducibility that does not exist.
 */
const AGENT_TEMPERATURE = 0.2;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const RESULT_CHAR_LIMIT = 8000;

function truncate(str) {
  return str.length > RESULT_CHAR_LIMIT ? str.slice(0, RESULT_CHAR_LIMIT) + '\n…[truncated]' : str;
}

/**
 * WI-2's invariant, made mechanical.
 *
 * The turn's mutations are rendered by the HARNESS and appended to the turn's
 * output. The model narrates around a block it did not author and cannot omit,
 * so "an executed mutation is absent from the report" stops being possible
 * rather than becoming less likely. Emitted as its own event so the renderer
 * can style it from the same verification statuses (WI-6).
 */
/*
 * B3/D6 — the impersonation boundary, surfaced every turn it is active.
 *
 * Separate from the mutation report because it must appear on a turn that
 * mutated NOTHING. The thing a human most needs to not lose track of is whose
 * authority their next instruction carries, and a read performed as someone
 * else is exactly the case the mutation report is silent about.
 *
 * Rendered from the mode TABLE, not from anything the model said, so it cannot
 * be omitted or paraphrased — the same property that makes the mutation report
 * trustworthy.
 */
const boundaryEmitted = new Set();

function emitImpersonationBoundary({ sessionId, turnSeq, emit }) {
  const key = `${sessionId}:${turnSeq}`;
  if (boundaryEmitted.has(key)) return;          // several terminal paths call the reporter
  try {
    const line = impersonationBoundaryLine(sessionId);
    if (!line) return;
    boundaryEmitted.add(key);
    if (boundaryEmitted.size > 500) boundaryEmitted.clear();   // bounded; it is a de-dupe, not a record
    const facts = impFacts(sessionId);
    emit({ type: 'impersonation_boundary', markdown: line, facts });
    log.info('impersonation', `turn ${turnSeq}: acting as ${facts['imp.target']?.user_name}`);
  } catch (err) {
    log.error('impersonation', `could not render the impersonation boundary: ${err.message}`);
  }
}

function emitMutationReport({ sessionId, turnSeq, emit }) {
  emitImpersonationBoundary({ sessionId, turnSeq, emit });
  let entries = [];
  try { entries = mutationsForTurn(sessionId, turnSeq); }
  catch (err) { log.error('ledger', `could not read the mutation ledger: ${err.message}`); return; }
  if (!entries.length) return;
  const markdown = renderMutationReport(entries);
  if (!markdown) return;
  emit({
    type: 'mutation_report',
    markdown,
    mutations: entries.map((e) => ({
      tool: e.tool, table: e.table, sys_id: e.sys_id, displayId: e.displayId,
      status: e.status, approval: e.approval,
      approvedSource: e.approvedSource, approvedAt: e.approvedAt,
      dropped: e.verification?.dropped || [],
      capture: e.capture?.message || null,
    })),
  });
  const bad = entries.filter((e) => e.status === 'no-op' || e.status === 'partial').length;
  log.info('ledger', `turn report: ${entries.length} mutation(s)${bad ? `, ${bad} not fully applied` : ''}`);
}

/**
 * WI-6 — mutation execution requires a RESOLVED approval, structurally.
 *
 * Auditing the path showed the ordering was already correct: the gate `await`s
 * before `tool.execute` is reached, so nothing could run early. But "correct
 * because the statements are in this order" is a property that a later edit can
 * silently remove, and this is the one place in the codebase where that would
 * be a severity-1 bug rather than a regression.
 *
 * So the executor now takes the approval as an ARGUMENT and refuses to run a
 * mutation without a resolved one. Reordering the code no longer changes the
 * safety property; deleting this check does, and the test asserts it directly.
 */
export const APPROVAL_RESOLVED = new Set(['approved', 'auto']);

/**
 * WI-4 tightens this. "approved" alone is no longer enough.
 *
 * The 2026-08-24 investigation could not answer "who approved this", because
 * `approval = 'approved'` was the entire record. A terminal string that any
 * code path can produce is not provenance — so the executor now demands that
 * the approval say where it came from, and the two legal answers are disjoint:
 *
 *   approved  requires  source = user_click     (a human resolved the gate)
 *   auto      requires  source = auto_approve   AND auto-approve actually on
 *
 * `unknown` is therefore never executable. That is the point: a mutation whose
 * authorisation cannot be attributed does not run, rather than running and
 * leaving a row nobody can interpret a month later.
 */
export async function executeTool(tool, input, approval, provenance = null, context = null) {
  // `context` carries turn-scoped facts a tool cannot derive from its own
  // arguments — currently { sessionId, turnSeq }, which the impersonation-mode
  // tools need because "mode" is per-session state, not an argument. Optional
  // and ignored by every tool that does not read it, so existing tools and
  // their tests are unaffected.
  if (!tool.mutating) return tool.execute(input || {}, context || {});

  if (!APPROVAL_RESOLVED.has(approval)) {
    throw Object.assign(
      new Error(
        `Refusing to execute the mutating tool "${tool.name}" with approval="${approval ?? 'none'}". `
        + 'A mutation may only run after the gate resolves to approved, or under explicit auto-approve.',
      ),
      { status: 500, detail: { tool: tool.name, approval: approval ?? null, reason: 'unapproved-mutation' } },
    );
  }

  const source = provenance?.source ?? null;
  const autoApprove = Boolean(provenance?.autoApprove);
  const refuse = (reason, message) => {
    throw Object.assign(new Error(message), {
      status: 500,
      detail: { tool: tool.name, approval, approvedSource: source, autoApprove, reason },
    });
  };

  if (approval === 'approved' && source !== APPROVAL_SOURCES.USER_CLICK) {
    refuse('unattributed-approval',
      `Refusing to execute the mutating tool "${tool.name}": its approval is recorded as "${source ?? 'none'}" `
      + 'rather than user_click. An approval nobody can be attributed is not an approval.');
  }
  if (approval === 'auto' && !autoApprove) {
    refuse('auto-without-auto-approve',
      `Refusing to execute the mutating tool "${tool.name}" under auto-approve: auto-approve is OFF. `
      + 'No server-side path may approve a mutation the user did not.');
  }
  if (approval === 'auto' && source !== APPROVAL_SOURCES.AUTO_APPROVE) {
    refuse('unattributed-approval',
      `Refusing to execute the mutating tool "${tool.name}": approval="auto" but its source is `
      + `"${source ?? 'none'}" rather than auto_approve.`);
  }
  /*
   * SESSION 2 — AUTO-APPROVE IS SCOPED TO A NAMED HOST.
   *
   * `autoApprove` is one global boolean. Turned on for a scripted run against a
   * disposable PDI, it stays on — and the instance binding is UI-owned and can
   * move underneath it. The combination is a switch that authorises unattended
   * writes against whatever happens to be bound later, which is precisely the
   * shape of the drift this project has already been bitten by twice (an
   * install landing on a retired PDI; a schema cache answering for the wrong
   * host).
   *
   * So an unattended write now needs the bound host named in
   * `agent.liveHosts`. Empty by default, which means auto-approve authorises
   * nothing until somebody writes a host down. Switching instances disarms it
   * rather than carrying it over.
   *
   * NARROWING ONLY. A human click is untouched — `user_click` never reaches
   * this branch — and a host in the list still needs `autoApprove` on.
   */
  if (approval === 'auto') {
    const { connection, agent } = getSettings();
    const host = (() => {
      try { return new URL(connection.instanceUrl).host; } catch { return null; }
    })();
    const allowed = Array.isArray(agent?.liveHosts) ? agent.liveHosts : [];
    if (!host || !allowed.includes(host)) {
      refuse('host-not-allow-listed',
        `Refusing to execute the mutating tool "${tool.name}" under auto-approve against ${host ?? 'an unresolvable host'}: `
        + `that host is not in agent.liveHosts (${allowed.length ? allowed.join(', ') : 'the list is empty'}). `
        + 'Unattended writes are permitted only against a host somebody named deliberately. A human approval is '
        + 'unaffected — approve the card instead, or add the host to liveHosts in Settings.');
    }
  }

  return tool.execute(input || {}, context || {});
}

/**
 * Resolves to a DECISION, not a boolean (WI-4): who decided, and when.
 *
 * The timeout is its own source. It is a rejection nobody made, and recording
 * it as one would put a refusal in the audit trail that no person is
 * responsible for.
 *
 * PHASE 0 adds a third source for exactly the same reason. A cancelled wait is
 * not a rejection either: nobody refused the operation, the turn was stopped
 * while the card was still on screen. Recording it as `rejected` would write a
 * decision into the audit trail that no person made — and, worse, would feed
 * `recordRejection` a refusal the user never gave, blocking a resubmission they
 * might well have wanted. So `cancelled` is its own source, and the caller
 * branches on it BEFORE the approved/rejected split.
 *
 * Whatever settles the wait — click, timeout or cancellation — goes through one
 * `finish`, which is idempotent, clears the timer, drops the abort listener and
 * removes the pending entry. That is what makes "no dangling approval promise"
 * a property of this function rather than of its callers remembering.
 */
function awaitApproval(state, approvalId, nonce, signal = null) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // `resolveApproval` deletes this too; the second delete is a no-op. Doing
      // it here as well is what makes the timeout and cancellation paths leave
      // nothing executable behind.
      state.pending.delete(approvalId);
      resolve(decision);
    };
    const timer = setTimeout(
      () => finish({ approved: false, source: 'timeout', at: new Date().toISOString() }),
      APPROVAL_TIMEOUT_MS,
    );
    const onAbort = () => finish({ approved: false, source: 'cancelled', at: new Date().toISOString() });
    // Already cancelled before the card was even registered: settle immediately
    // rather than registering a resolver nothing will ever call.
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    state.pending.set(approvalId, { nonce, resolve: finish });
  });
}

/**
 * Phase 0 — the approval sources that mean "nobody decided this".
 *
 * Both leave `approval` null and neither may reach `executeTool`, but they are
 * kept apart because they say different things to a person reading the trail: a
 * timeout is an unanswered question, a cancellation is a stopped turn.
 */
export const NO_DECISION_SOURCES = Object.freeze(['timeout', 'cancelled']);

/* ------------------------------------------------------------------ *
 * WI-3 — the ELEVATION GATE, wired into the mutation path.
 *
 * A write to a security_admin-gated table (sys_security_acl CRUD) CANNOT land
 * un-elevated (WI-1). So instead of the normal REST executeTool path — which
 * would silently no-op — a gated op is routed here, and this is the ONLY route
 * to elevation. The model has no elevate verb; it cannot reach the shim; it
 * cannot bypass this gate or force a plain-GR fallback.
 *
 * Order enforced by the shim client: mechanical (table,op) derivation ->
 * classifier -> eligibility -> APPROVAL -> shim -> target read-back -> tier.
 * Refuse/fail-closed happen BEFORE approval; deny => nothing elevated. No
 * un-elevated revert on any failure path.
 *
 * Returns `{ handled, cancelled }`. `handled` is true when it fully handled the
 * call (result + audit pushed); `cancelled` says the turn was stopped while this
 * elevation was at the gate, which the caller must not treat as a denial.
 *
 * FLAG #3 — GUARD-SUPERSET AUDIT. Routing around the normal permission gate must
 * ADD protection, never remove it. Every guard the ordinary mutation path applies:
 *   - confabulated-sys_id block (checkWriteTarget), known-drop/user-rejected
 *     (checkBeforeGate), plan-time trap (planTimeTrapCheck): run BEFORE this
 *     interception in the loop, so a gated op still passes all three. NOT skipped.
 *   - approval + 32-byte nonce + awaitApproval: PRESENT here (own enriched card).
 *   - mutatingCallCount increment: PRESENT (at the call site).
 *   - recordToolEvent, appendMutation (ledger), recordRejection on deny: PRESENT.
 *   - verifyMutation: replaced by the read-back TIER, which is a cross-transport
 *     verification — stronger, not weaker.
 *   - recordDrops: N/A — the REST silent-drop registry; COERCED/mismatches carry
 *     the equivalent for the elevated path.
 *   - appendImpersonatedMutation: N/A — elevation is not impersonation.
 *   - captureAfterTool: N/A — the elevated write runs in a background job, not the
 *     REST transport window; its sys_update_xml is recorded provenance, not swept.
 *   - emit tool_use: N/A — the elevation bubble is its own render (WI-4).
 *   - recordVerificationFailure: N/A — it early-returns for anything but
 *     verify_flow_live (memory/facts.js).
 *   - PHASE 0 cancellation: PRESENT, and it ADDS to the superset rather than
 *     relaxing it. The card here takes the same signal as the normal gate, and
 *     a cancelled wait is reported as cancelled rather than denied — so no
 *     `recordRejection` is written for a decision nobody made. Nothing is
 *     elevated and nothing is written on that path, identically to a denial.
 * ------------------------------------------------------------------ */
async function handleGatedElevation({ tool, call, descriptor, sessionId, taskId = null, turnSeq, state, emit, results, autoApprove, signal = null }) {
  // Phase 0. `runGatedWrite` speaks one vocabulary — approved or denied — and
  // must keep speaking it, because a denial is what makes it refuse to elevate
  // and refuse to write, which is exactly right for a cancellation too. What it
  // cannot know is WHY, so the reason is captured here and the outcome is
  // relabelled below rather than the shim being taught a third answer.
  let cancelledAtGate = false;
  let runner;
  try {
    runner = await resolveRunnerSysId();
  } catch (err) {
    // FAIL-CLOSED: no resolvable runner means no eligible elevation.
    const msg = `Refused: this operation on ${descriptor.table} requires elevation, but the runner identity could not be resolved (${err.message}). No elevation, no write.`;
    results.push({ id: call.id, name: call.name, output: msg, isError: true });
    recordToolEvent(sessionId, {
      taskId,
      kind: 'tool_call', name: call.name, payload: call.input, result: msg,
      resultStatus: 'elev_blocked_no_runner', mutating: true, approval: null,
    });
    emit({
      type: 'tool_blocked', id: call.id, name: call.name, input: call.input, reason: 'elevation_no_runner', message: msg,
      elevation: { tier: null, state: 'FAIL_CLOSED', required_role: null, elevation_occurred: false, target: { table: descriptor.table, sys_id: descriptor.sys_id ?? null }, reason: msg },
    });
    return { handled: true };
  }

  const requestApproval = autoApprove
    ? async () => ({ approved: true, source: APPROVAL_SOURCES.AUTO_APPROVE, at: new Date().toISOString() })
    : async (elevationPayload) => {
        // The amber gate fires BEFORE any elevation or write, enriched with the
        // elevation context, nonce-bound exactly like every other mutation.
        const approvalId = crypto.randomUUID();
        const nonce = crypto.randomBytes(32).toString('base64url');
        /*
         * SESSION 1 / WI-2 — REGISTER BEFORE THE CARD IS VISIBLE.
         *
         * `awaitApproval` puts the pending entry in place synchronously, inside
         * its Promise executor. Emitting first meant an answer given from the
         * emit callback itself found nothing to resolve, and the gate waited
         * out its five-minute timer. Measured 2026-09-08: two exact
         * five-minute gaps for two cards. The card, the nonce and the resolver
         * are unchanged; only the order is.
         */
        const decisionPending = awaitApproval(state, approvalId, nonce, signal);
        emit({
          type: 'approval_required', approvalId, nonce, name: call.name, input: call.input,
          warning: elevationPayload.note, elevation: elevationPayload,
        });
        log.warn('gate', `elevation approval required: ${call.name} on ${descriptor.table} — waiting for the user`);
        const decision = await decisionPending;
        if (decision.source === 'cancelled') {
          // NOT `approval_resolved`. Nothing was resolved — the card was still
          // waiting when the turn was stopped, and rendering it as a decision
          // would put a verdict on screen that no person gave.
          cancelledAtGate = true;
          emit({ type: 'approval_cancelled', approvalId, name: call.name, at: decision.at });
          return decision;
        }
        emit({ type: 'approval_resolved', approvalId, approved: decision.approved, source: decision.source, at: decision.at });
        return decision;
      };

  const r = await runGatedWrite({ descriptor, runnerUserSysId: runner, requestApproval, emit });

  /*
   * WI-ACL-1 — refused on the SPEC, before any approval card.
   *
   * Kept as its own branch, ahead of the generic refusal, because the two say
   * completely different things to a user. The eligibility refusal below means
   * "you are not allowed to do this". This one means "what you asked for would
   * break the thing you are trying to protect" — an empty ACL that denies
   * everyone, a role that does not exist, a condition on a field that does not
   * either. Collapsing them into one message would leave the user unable to tell
   * a permissions problem from a request that needs rewriting.
   *
   * The refusal text is passed through verbatim: it was written to be actionable
   * (it names the rule, the reason, and what to do instead), and rewording it
   * here would lose that.
   */
  if (r.decision === 'refused_spec') {
    const msg = `Refused before approval: ${r.specRefusal.message}`;
    log.warn('gate', `ACL spec refused (${r.specRefusal.reason}) — no approval requested, nothing elevated`);
    results.push({ id: call.id, name: call.name, output: msg, isError: true });
    recordToolEvent(sessionId, {
      taskId,
      kind: 'tool_call', name: call.name, payload: call.input, result: msg,
      resultStatus: `elev_refused_spec:${r.specRefusal.reason}`, mutating: true, approval: null,
    });
    emit({
      type: 'tool_blocked', id: call.id, name: call.name, input: call.input,
      reason: `acl_spec_${r.specRefusal.reason}`, message: msg,
      elevation: {
        tier: null, state: 'REFUSED_SPEC', required_role: r.plan.requiredRole, elevation_occurred: false,
        target: { table: descriptor.table, sys_id: descriptor.sys_id ?? null },
        spec_refusal: { reason: r.specRefusal.reason, detail: r.specRefusal.detail ?? null },
        reason: r.specRefusal.message,
      },
    });
    return { handled: true };
  }

  // Refused before approval — ineligible or eligibility-read-failed (fail-closed).
  if (r.refused) {
    const why = r.decision === 'blocked_read_failed'
      ? 'eligibility could not be verified (fail-closed)'
      : 'the runner is not eligible for the required role';
    const msg = `Refused: ${r.plan.op.table}.${r.plan.op.operation} requires ${r.plan.requiredRole} and ${why}. ${r.plan.reason || ''} No elevation, no write, no fallback.`;
    results.push({ id: call.id, name: call.name, output: msg, isError: true });
    recordToolEvent(sessionId, {
      taskId,
      kind: 'tool_call', name: call.name, payload: call.input, result: msg,
      resultStatus: `elev_${r.decision}`, mutating: true, approval: null,
    });
    emit({
      type: 'tool_blocked', id: call.id, name: call.name, input: call.input, reason: `elevation_${r.decision}`, message: msg,
      elevation: {
        tier: null,
        state: r.decision === 'blocked_read_failed' ? 'FAIL_CLOSED' : 'REFUSED',
        required_role: r.plan.requiredRole, elevation_occurred: false,
        target: { table: r.plan.op.table, sys_id: descriptor.sys_id ?? null }, reason: r.plan.reason || msg,
      },
    });
    return { handled: true };
  }

  /*
   * Phase 0 — CANCELLED at the gate. Checked before the denial branch below,
   * because the two produce the same (correct) effect on the instance and must
   * produce completely different records of it.
   *
   * Nothing was elevated and nothing was written, exactly as for a denial. But
   * no `recordRejection` is written: a rejection is a fact about what the user
   * decided, and blocking a resubmission on the strength of a decision they
   * never made would make Stop quietly narrower than it looks.
   */
  if (r.decision === 'denied' && cancelledAtGate) {
    const msg = 'The turn was cancelled while this elevation was waiting for approval. '
      + 'Nothing was elevated, nothing was written, and no decision was recorded.';
    log.warn('gate', `elevation cancelled at the gate on ${descriptor.table} — nothing elevated, nothing written`);
    results.push({ id: call.id, name: call.name, output: msg, isError: true });
    recordToolEvent(sessionId, {
      taskId,
      kind: 'tool_call', name: call.name, payload: call.input, result: msg,
      resultStatus: 'cancelled', mutating: true, approval: null,
    });
    emit({
      type: 'tool_result', id: call.id, name: call.name, output: msg, isError: true,
      elevation: {
        tier: null, state: 'CANCELLED', required_role: r.plan.requiredRole, elevation_occurred: false,
        target: { table: r.plan.op.table, sys_id: descriptor.sys_id ?? null }, reason: msg,
      },
    });
    return { handled: true, cancelled: true };
  }

  // Denied at the gate — nothing elevated, nothing written.
  if (r.decision === 'denied') {
    const msg = 'The user did not approve the elevation. Nothing was elevated or written. Do not retry it; ask what they would like to change.';
    recordRejection({ sessionId, turnSeq, tool: call.name, table: descriptor.table, sys_id: descriptor.sys_id, requested: descriptor.requested });
    results.push({ id: call.id, name: call.name, output: msg, isError: true });
    recordToolEvent(sessionId, {
      taskId,
      kind: 'tool_call', name: call.name, payload: call.input, result: msg,
      resultStatus: 'elev_denied', mutating: true, approval: 'rejected', approvedSource: r.approvalSource,
    });
    // approval_resolved was already emitted by the approval callback; not re-emitted here.
    emit({
      type: 'tool_result', id: call.id, name: call.name, output: msg, isError: true,
      elevation: {
        tier: null, state: 'DENIED', required_role: r.plan.requiredRole, elevation_occurred: false,
        target: { table: r.plan.op.table, sys_id: descriptor.sys_id ?? null }, reason: msg,
      },
    });
    return { handled: true };
  }

  // Approved and executed. Truth is the tier from the target read-back.
  const tier = r.outcome?.tier ?? 'FAILED';
  const isError = tier !== 'EXECUTED';
  const output = JSON.stringify({
    elevation: {
      tier, op: r.plan.op, required_role: r.plan.requiredRole,
      elevated: r.elevated === true, ingestion_tier: r.ingestionTier || 'elevated-path',
      target: r.outcome, not_implemented: r.not_implemented || undefined,
      // WI-ACL-1 — the model must see BOTH halves, or it will report an ACL as
      // created on the strength of the row alone and never mention that the role
      // requirement it asked for is missing.
      acl: r.aclUnit ? { unit: 'acl_and_role_links', ...r.aclUnit.summary, roles_outcome: r.outcome?.roles ?? null, role_less: r.outcome?.role_less === true } : undefined,
    },
  }, null, 1);
  results.push({ id: call.id, name: call.name, output, isError });
  recordToolEvent(sessionId, {
    taskId,
    kind: 'tool_call', name: call.name, payload: call.input, result: output,
    resultStatus: `elev_${tier.toLowerCase()}`, mutating: true,
    approval: 'approved', approvedSource: r.approvalSource, approvedAt: r.approvalAt,
  });
  // The mutation ledger, tagged with the elevated ingestion tier.
  appendMutation({
    sessionId, turnSeq, tool: call.name,
    descriptor: { table: r.plan.op.table, operation: r.plan.op.operation, requested: descriptor.requested, sys_id: r.outcome?.sys_id ?? null },
    result: r.actual,
    verification: {
      status: tier === 'EXECUTED' ? 'applied' : (tier === 'COERCED' ? 'transformed' : 'no-op'),
      summary: r.outcome?.detail || tier, ingestion: 'elevated-path',
    },
    approval: 'approved', approvedSource: r.approvalSource, approvedAt: r.approvalAt,
  });
  // sys_id provenance — the created record, marked elevated-path.
  if (r.outcome?.sys_id) {
    registerElevatedWrite({ sessionId, seq: turnSeq, table: r.plan.op.table, sysId: r.outcome.sys_id });
  }
  if (isError) log.warn('gate', `elevation ${tier} on ${r.plan.op.table} — ${r.outcome?.detail}`);
  else log.info('gate', `elevation EXECUTED on ${r.plan.op.table} — ${r.outcome?.sys_id}`);
  emit({
    type: 'tool_result', id: call.id, name: call.name, output, isError,
    // The renderer derives its state SOLELY from this object — never from
    // isError, a sys_id, or "approved". Green is reachable only from tier===EXECUTED.
    elevation: {
      tier, state: null, required_role: r.plan.requiredRole,
      elevation_occurred: r.elevated === true,
      target: { table: r.plan.op.table, sys_id: r.outcome?.sys_id ?? null },
      compared_fields: r.outcome?.compared_fields ?? [],
      compared_detail: r.outcome?.compared_detail ?? [],
      mismatches: r.outcome?.mismatches ?? [],
      coerced: r.outcome?.coerced ?? [],
      unverified: r.outcome?.unverified ?? [],
      detail: r.outcome?.detail ?? null,
      not_implemented: r.not_implemented === true,
      // WI-ACL-1 — the role half, so the renderer can refuse green on a rule
      // whose row landed but whose role requirement did not.
      acl: r.aclUnit
        ? {
          operation: r.aclUnit.operation,
          name: r.aclUnit.summary?.name ?? null,
          roles_expected: r.aclUnit.summary?.roles ?? [],
          roles: r.outcome?.roles ?? null,
          role_less: r.outcome?.role_less === true,
          conditions: r.aclUnit.summary?.conditions ?? [],
        }
        : null,
    },
  });
  return { handled: true };
}

/* ------------------------------------------------------------------ *
 * A6 — the stalled turn
 *
 * MEASURED on gpt-oss:120b-cloud, twice in three runs of the C-4 acceptance.
 * Asked to "make the justification field mandatory only when duration is
 * Permanent", the model resolved the item, read its variables, quoted the two
 * correct sys_ids and the correct choice value in a tidy table — and then
 * ended the turn with "Shall I create this UI Policy now?".
 *
 * Nothing was created, and nothing said so. From the outside a stalled turn
 * looks exactly like a completed one: prose arrives, the stream closes.
 *
 * Asking harder does not fix it. The system prompt already said the approval
 * gate IS the confirmation and to call the tool; the model asked anyway, which
 * is §20's lesson again — three attempts of prose had not moved this model, and
 * one dictionary listing moved it immediately. So this is a guard, and the
 * evidence it feeds back is the thing the model demonstrably did not have: the
 * fact that its question reached nobody.
 *
 * Deliberately narrow. It fires only when ALL of:
 *   - the turn is ending with no tool call at all,
 *   - the assistant's last line asks to proceed,
 *   - the user's own message was an instruction to change something,
 *   - and it has not already fired this turn.
 * A genuine clarifying question ("which of these two items did you mean?") does
 * not match, because it does not ask for permission to proceed.
 * ------------------------------------------------------------------ */

/**
 * "Shall I ...?", "Let me know ...", "If you're happy with this, I'll ...".
 *
 * Widened after a measured miss (§32, A3): the model produced a complete flow
 * design and closed with "If you're happy with this design, I'll create the
 * flow on the instance. Let me know!" — every bit as stalled as the shape this
 * guard was written for, and matched by none of its patterns. "let me know IF"
 * required an "if" the model did not write, and an offer phrased as a promise
 * ("I'll create ...") was not covered at all.
 *
 * Widening is safe precisely because the guard also requires the turn to have
 * changed NOTHING: "Created it. Let me know if you want anything else" carries
 * a mutation and never reaches these patterns.
 */
const ASKS_TO_PROCEED = new RegExp(
  [
    String.raw`\bshall i\b`,
    String.raw`\bwould you like me to\b`,
    String.raw`\bdo you want me to\b`,
    String.raw`\blet me know\b`,
    String.raw`\bshould i (?:go ahead|proceed|create|update|delete|apply)\b`,
    String.raw`\bconfirm(?:\s+and)?\b[^.?!]*\bi(?:'ll| will)\b`,
    String.raw`\bplease confirm\b`,
    String.raw`\bgive me the go[- ]ahead\b`,
    String.raw`\bwaiting for your (?:approval|confirmation|go)\b`,
    // An offer phrased as a promise. Only reachable when nothing was changed.
    String.raw`\bif you(?:'re| are)? ?(?:happy|ok|okay|good)\b`,
    String.raw`\bi(?:'ll| will) (?:then )?(?:create|build|add|update|deploy|apply|set up|go ahead|proceed)\b`,
    String.raw`\bjust say the word\b`,
    String.raw`\bready to (?:create|build|deploy|proceed)\b`,
  ].join('|'),
  'i'
);

/**
 * The user told us to do something, rather than asking about something.
 *
 * Also widened by the same measurement. "When a P1 incident is UPDATED to state
 * On Hold ... escalate to the duty manager" is as directive as a sentence gets,
 * and it matched nothing: \bupdate\b does not match "updated", and none of the
 * automation verbs a flow request is actually phrased with were listed. A request
 * for automation is usually written as a RULE ("when X, do Y") rather than as an
 * order, so the verbs of the DO half have to be here too.
 */
const DIRECTIVE_VERBS = [
  'make', 'create', 'add', 'set', 'update', 'change', 'remove', 'delete', 'rename', 'build',
  'configure', 'hide', 'show', 'require', 'attach', 'enable', 'disable', 'reorder', 'fix',
  'escalate', 'notify', 'assign', 'route', 'send', 'email', 'trigger', 'close', 'reopen',
  'generate', 'deploy', 'schedule', 'approve',
];
// Some of these are also ordinary nouns ("the email", "the trigger"), so this
// list alone would over-match. It never fires alone: the assistant must ALSO
// have asked to proceed and changed nothing. When it is wrong the cost is one
// extra iteration carrying a nudge; when it was too narrow the cost was a whole
// acceptance run that designed a flow and built nothing. "log" is deliberately
// absent — it is a noun far more often than a verb here.
const IS_DIRECTIVE = new RegExp(`\\b(?:${DIRECTIVE_VERBS.join('|')})(?:s|d|es|ed|ing)?\\b`, 'i');

/**
 * WI-8 — a completion that both ASKS and ACTS.
 *
 * In the transcript the model emitted a clarifying question and the mutation
 * tool calls in what appears to be one completion, and the harness executed the
 * calls. The user was then asked to decide something that had already been
 * decided for them.
 *
 * This is the mirror image of the A6 stall guard above. A6 catches a turn that
 * asks and does NOTHING; this catches one that asks and does everything anyway.
 * Both exist because the model is free and wobbly today — and both are harness
 * guards precisely so the behaviour does not change when the model does.
 *
 * Deliberately narrow: only a question aimed at the USER counts, and only
 * mutating calls are held. Reads proceed, because a turn that asks a question
 * and gathers context while waiting is doing the right thing.
 */
/**
 * The clarification markers, in ONE place.
 *
 * The first four are the sprint's named baseline. The rest were already carried
 * by this guard's original regex and are kept because each answers a measured
 * miss — narrowing to the baseline would throw measured coverage away to satisfy
 * a list written before those measurements existed.
 *
 * Matched with word boundaries, never as substrings: "should i" appears inside
 * "should include", and a guard that holds a write on that is a guard people
 * turn off.
 */
export const CLARIFICATION_MARKERS = Object.freeze([
  'let me know',
  'which one',
  'please confirm',
  'should i',
  'would you like me to',
  'shall i',
  'do you want me to',
  'can you confirm',
  'did you mean',
  'which of these',
  // The VERB, aimed at the reader — so "a confirmation email" does not hold a
  // write, while "please confirm the group" does.
  'confirm (?:that|whether|if|the|which)',
]);

const MARKER_RE = new RegExp(CLARIFICATION_MARKERS.map((m) => `\\b${m}\\b`).join('|'), 'i');

/**
 * WI-3 — classify PROSE, never code.
 *
 * A `?` is punctuation in English and syntax in every language this agent
 * writes: `foo?.bar`, a ternary, a shell prompt, a regex. A guard that reads a
 * fenced Fluent snippet as a question to the user would withhold writes on the
 * turns that are doing the most work.
 *
 * Inline spans are stripped for the same reason and by the same rule — a `?`
 * inside backticks is code wherever it appears. Stripping them cannot hide a
 * real question, because the question mark that ends a sentence aimed at a
 * person is not inside backticks.
 */
export function proseOnly(text) {
  return String(text || '')
    // Fenced blocks, including one the completion was cut off inside.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * The opening of what the user was actually shown, for a log line and an event.
 *
 * Collapsed and bounded on purpose: this rides in `tool_events.payload` on
 * every quiet turn end, and a payload that can grow to a whole completion turns
 * telemetry into a second copy of the transcript.
 */
export const PROSE_HEAD_CHARS = 120;

export function proseHead(text, limit = PROSE_HEAD_CHARS) {
  const flat = proseOnly(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Did the turn announce work, or report a fact?
 *
 * A LABEL ON TELEMETRY, AND NOTHING ELSE. It gates no behaviour, holds no
 * write and changes no turn — which is the whole reason it is allowed to exist
 * this sprint. A6's nudge was built on a guess about the model and asserted
 * something false to it; the rule here is that a guess may describe a row and
 * may not decide one.
 *
 * The distinction matters because `stalled_turn_ended` fires on EVERY quiet
 * turn end, which is what makes it a usable denominator — "Beth Anglin." is a
 * complete answer and belongs in the population as an answer, not as a stall.
 * Without the label a future reader counting these rows would count both as
 * the same thing and badly overstate the rate.
 */
const DECLARES_INTENT = new RegExp([
  String.raw`\bi(?:'|’)?ll\b`,
  String.raw`\bi will\b`,
  String.raw`\bi(?:'|’)?m (?:going to|about to)\b`,
  String.raw`\bi am (?:going to|about to)\b`,
  String.raw`\blet me (?:create|update|add|set|build|configure|deploy|make|go)\b`,
  String.raw`\bgoing to (?:create|update|add|set|build|configure|deploy)\b`,
  String.raw`\bproceeding to\b`,
].join('|'), 'i');

export function stallIntent(text) {
  return DECLARES_INTENT.test(proseOnly(text)) ? 'declarative' : 'informational';
}

/** The last line a reader actually sees — where a question to them lands. */
export function lastProseLine(text) {
  const lines = proseOnly(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/**
 * Is this response ASKING the user something?
 *
 * Two signals, either sufficient: the final prose line ends in a question mark,
 * or the prose carries one of the clarification markers. The first catches a
 * question phrased in a way no marker list anticipates, which is the failure
 * mode a marker list always has.
 */
export function isAskingTheUser(text) {
  const prose = proseOnly(text);
  if (!prose.trim()) return null;
  const marker = prose.match(MARKER_RE);
  if (marker) return { asked: marker[0], via: 'marker' };
  const last = lastProseLine(text);
  if (last.endsWith('?')) return { asked: last.slice(-160), via: 'question-mark' };
  return null;
}

/**
 * WI-8/WI-3 — a completion that both ASKS and ACTS.
 *
 * In the original transcript the model was believed to have emitted a question
 * and mutation calls in one completion. WI-1 later proved that particular
 * incident was the OTHER mechanism (the A6 nudge re-invoking the provider), but
 * this guard stays and is widened anyway: both shapes end with the user being
 * asked to decide something already decided for them, and holding a write costs
 * one round trip while executing the wrong one costs a record.
 *
 * Deliberately narrow in what it HOLDS: only mutating calls, judged by the tool
 * registry's own `mutating` flag — the same source of truth the approval gate
 * uses, so the two can never disagree about what a write is. Reads proceed,
 * because a turn that asks a question and gathers context while waiting is
 * doing the right thing.
 */
/**
 * The one question the approval gate ALREADY ANSWERS.
 *
 * MEASURED live, 2026-08-24, and it is why this guard cannot simply hold every
 * write that arrives beside a question mark. The model wrote:
 *
 *   "I will update INC0010055 and set its priority to Low. Please confirm
 *    you'd like me to apply this change."
 *
 * — and called the tool. Withholding that produces a livelock: the user is shown
 * "withheld pending your answer" and a question whose only possible answer is
 * "yes, go ahead", which is precisely what the approval card in front of them
 * would have collected. Answering it just reproduces the shape. This model
 * phrases writes that way constantly; it is the same politeness reflex A6 exists
 * for.
 *
 * So a question that ONLY asks permission passes through to the gate, because
 * the gate is its answer. Everything else is held. The list is closed and each
 * entry ends in "do the thing" — "shall I proceed", never "shall I use the
 * Network group or Service Desk", which is a choice no card can collect.
 *
 * Default is HOLD. A phrasing this list does not recognise is withheld, which
 * costs a round trip; the other error costs a record.
 */
const ASKS_ONLY_FOR_PERMISSION = new RegExp([
  String.raw`\bshall i (?:proceed|go ahead|continue|apply|create|update|delete|add|set|build|deploy|make|do)\b`,
  String.raw`\bshould i (?:proceed|go ahead|continue|apply)\b`,
  String.raw`\b(?:please )?confirm (?:that )?you(?:'|’)?(?:d| would)? ?(?:like|want)\b`,
  String.raw`\bwould you like me to (?:proceed|go ahead|continue|apply)\b`,
  String.raw`\bdo you want me to (?:proceed|go ahead|continue|apply)\b`,
  String.raw`\bconfirm (?:and )?(?:to )?proceed\b`,
  String.raw`\bok(?:ay)? to (?:proceed|go ahead|apply)\b`,
  String.raw`\blet me know if you(?:'|’)?(?:d| would)? ?(?:like|want) me to (?:proceed|go ahead|apply)\b`,
].join('|'), 'i');

/**
 * A question the gate can answer, on prose that asks nothing else.
 *
 * All three conditions, because each on its own is reachable by a question that
 * genuinely needs a person: the permission phrasing must be present, no request
 * for a fact may be, and the prose must not put two records in front of the user.
 */
export function isPermissionOnly(text) {
  const prose = proseOnly(text);
  if (!ASKS_ONLY_FOR_PERMISSION.test(prose)) return false;
  // WI-4 — fact-seeking takes precedence INSIDE the permission branch, so a
  // permission phrasing cannot launder a question that needs an answer.
  if (needsAFactFromTheUser(text)) return false;
  return candidateTargets(prose).length < 2;
}

export function detectQuestionWithMutation({ assistantText, toolCalls = [], isMutating = () => false, enabled = true }) {
  if (!enabled) return null;
  const asking = isAskingTheUser(assistantText);
  if (!asking) return null;
  // The gate is the answer to "may I?", so that question does not hold a write.
  if (isPermissionOnly(assistantText)) return null;
  const held = (toolCalls || []).filter((c) => isMutating(c.name));
  if (!held.length) return null;
  return {
    asked: asking.asked,
    via: asking.via,
    held: held.map((c) => c.name),
    // The payloads are DISCARDED, not queued — so this is the only record of
    // what was about to be written. It goes to the structured log verbatim.
    discarded: held.map((c) => ({ id: c.id, name: c.name, input: c.input ?? {} })),
    allowed: (toolCalls || []).filter((c) => !isMutating(c.name)),
  };
}

/**
 * The A6 FENCE (WI-2).
 *
 * A6 nudges a turn that asked for PERMISSION and did nothing. It must never
 * nudge a turn that asked for a FACT, because the harness cannot supply one —
 * and the nudge asserts "You already have what you need", which is false
 * exactly then. That is the 2026-08-24 defect: the model asked which of two
 * incidents to change, A6 matched "let me know", told it to proceed, and it
 * picked one. See docs/incidents/2026-08-24-ask-act.md.
 *
 * Two signals, both grounded in that incident:
 *
 *  - the prose asks for a value, a name or a choice — something only the user
 *    can answer;
 *  - the prose names two or more candidate TARGETS. When the model puts
 *    INC0010052 and INC0010053 in front of the user and asks anything at all,
 *    the target is ambiguous by construction, whatever the phrasing. This
 *    catches the question no marker list would have.
 *
 * Precedence is deliberate: a text that both clarifies and asks permission is
 * treated as clarifying. Ending the turn costs one round trip with the user;
 * continuing is what wrote to the wrong record.
 */
const NEEDS_A_FACT_FROM_THE_USER = new RegExp([
  String.raw`\bwhich\b`,
  String.raw`\bdid you mean\b`,
  String.raw`\bwho (?:is|are|should|do you|would you)\b`,
  String.raw`\bwhat (?:is|are|should|value|name|number|group|table|field|category|priority|do you|would you)\b`,
  String.raw`\bcan you (?:tell me|give me|provide|share)\b`,
  String.raw`\b(?:tell|give) me the\b`,
].join('|'), 'i');

/** INC0010052, CHG0031234, RITM0001234 — the id a human reads off a card. */
const RECORD_NUMBER = /\b[A-Z]{2,6}\d{6,}\b/g;
const SYS_ID = /\b[0-9a-f]{32}\b/g;

/**
 * How many RECORDS the prose puts in front of the user — not how many strings.
 *
 * MEASURED live, 2026-08-24, and it was a false positive in this guard. The
 * model wrote:
 *
 *   "I will update **INC0010055** (sys_id 3324289783b6cf50b939cc65eeaad335)
 *    and set its priority to Low."
 *
 * One record, named twice, the second time precisely. Counting identifiers gave
 * two "candidates" and fenced A6 off a turn that was being exemplary — the exact
 * behaviour the system prompt asks for, punished.
 *
 * So the two id spaces are counted separately and the larger wins. Two
 * candidates means two NUMBERS or two SYS_IDS; a number beside its own sys_id is
 * one record described well.
 */
/**
 * FOLLOW-UP WI-4 — a choice offered to the user, whatever the phrasing around it.
 *
 * The boundary the permission list could not hold. "Shall I proceed with the
 * Network group or Service Desk?" matches `shall i proceed` and asks for
 * nothing the fact-markers name — no "which", no "what value", no two record
 * numbers — so it read as permission-only and went to the gate carrying a
 * choice the model had made for the user. The card can collect a yes; it
 * cannot collect *which group*.
 *
 * Read off the LAST PROSE LINE only, which is where a question aimed at the
 * reader lands. A disjunction earlier in a paragraph is usually the model
 * describing the world ("impact will be 1 or 2 depending on the category") and
 * holding a write on that would be noise.
 *
 * It over-holds on "Shall I proceed? Impact will be 1 or 2." — one line, one
 * disjunction, no real choice. That is the intended direction: the default here
 * is withhold, which costs a round trip, and the other error costs a record.
 */
const DISJUNCTION = /\S+\s+\bor\b\s+\S+/i;

export function offersAChoice(text) {
  const m = lastProseLine(text).match(DISJUNCTION);
  return m ? m[0].slice(0, 80) : null;
}

/**
 * Is the model asking for something only the user can supply?
 *
 * ONE definition, used by both guards — the permission branch (which must not
 * let a choice through to the gate) and the A6 fence (which must not nudge a
 * turn that asked for one). They were separately derived and could have drifted;
 * they cannot now.
 */
export function needsAFactFromTheUser(text) {
  const prose = proseOnly(text);
  const direct = prose.match(NEEDS_A_FACT_FROM_THE_USER);
  if (direct) return { quote: direct[0], via: 'marker' };
  const choice = offersAChoice(text);
  if (choice) return { quote: choice, via: 'disjunction' };
  return null;
}

export function candidateTargets(prose) {
  const text = String(prose);
  const numbers = [...new Set(text.match(RECORD_NUMBER) || [])];
  const sysIds = [...new Set(text.match(SYS_ID) || [])];
  return numbers.length >= sysIds.length ? numbers : sysIds;
}

/**
 * M3 — THE UNEXPLAINED MUTATION.
 *
 * MEASURED live on 2026-08-24, on the PDI, while verifying WI-2 and WI-3.
 * Given two candidate incidents in context and the ambiguous instruction
 * "priority ko change karke LOW kardo", the model read the schema and then
 * emitted this (session 79f36d98, message seq 7):
 *
 *     assistant  text=0ch  calls=1  [update_record]  → INC0010055, priority 4
 *
 * No prose. Not M1 (a question beside the calls) and not M2 (the nudge
 * re-invoking the provider) — a bare write on a target it had no basis to
 * choose, and an approval card showing the user a payload and nothing about
 * why THAT record. Every guard built for this incident classifies prose, and
 * there was none to classify.
 *
 * So the harness enforces the rule the system prompt already states: say in one
 * line what you are about to do, THEN call the tool. A write submitted with no
 * explanation anywhere in the turn is bounced once, with feedback — never
 * silently dropped, because the user would then see a withheld notice and no
 * question to answer.
 *
 * Narrow twice over: only when the turn has produced NO assistant prose at all,
 * and only once per turn. When it is wrong the cost is one LLM call and a
 * better-explained approval card; when it is absent the cost is a card nobody
 * can evaluate.
 */
/**
 * Is the TARGET of a write ambiguous, given what the user actually said?
 *
 * Two rules, in order, and the order is the whole thing:
 *
 *  1. If the user's own message names a record, the user has chosen. Nothing is
 *     ambiguous, whatever else is on screen.
 *  2. Otherwise, if the recent conversation put two or more records in front of
 *     them and the model is about to write, it is choosing for them.
 *
 * MEASURED, and the first rule is the one that cost a live round. An earlier
 * version demanded narration before ANY write. On "the child one — INC0010055"
 * the model simply would not narrate — three bounces, turn abandoned, user got
 * nothing. It was right not to: the user had just named the record, and a card
 * showing that record's payload needs no essay. The defect was never silence;
 * it was silence while CHOOSING.
 */
/**
 * FOLLOW-UP WI-1 — ambiguity read off the REGISTRY, not off prose.
 *
 * The prose version this replaces scanned the last eight history entries for
 * identifiers and counted them. Three things were wrong with that, and all
 * three are structural rather than tuning:
 *
 *   - it counted STRINGS. "INC0010055 (sys_id 3324…)" is one record named
 *     twice, and counting identifiers cost a live round last sprint. The
 *     registry answers about records, because the read that resolved them is
 *     where both identifiers were in hand at once;
 *   - it could only see what was still in `messages`, so a compaction erased
 *     the ambiguity along with the turns that created it;
 *   - it was a second derivation of "which records are in play", separate from
 *     the one the hard block uses. Two derivations of the same question drift.
 *
 * Now: a write is ambiguous when its target arrived ONLY as one row of a
 * multi-row read and nothing has narrowed it since. `checkWriteTarget` decides
 * that, and it is the same call the hard block makes.
 */
export function ambiguousWrites({ sessionId, userText, toolCalls = [], isMutating = () => false, describe = () => null }) {
  const hits = [];
  for (const call of toolCalls || []) {
    if (!isMutating(call.name)) continue;
    const sysId = describe(call)?.sys_id;
    if (!sysId) continue;
    const target = checkWriteTarget({ sessionId, sysId, userText });
    if (target.verdict === 'ambiguous') {
      hits.push({ name: call.name, sys_id: sysId, rowCount: target.rowCount, candidates: target.candidates });
    }
  }
  if (!hits.length) return null;
  // One candidate list for the bounce message: the writes in one completion
  // are almost always siblings from the same read.
  const candidates = [...new Set(hits.flatMap((h) => h.candidates))];
  return { hits, candidates };
}

export function detectUnexplainedMutation({
  assistantText, toolCalls = [], turnHasProse = false, isMutating = () => false, ambiguity = null,
}) {
  // Nothing to choose between, or the user already chose: a bare write is fine.
  if (!ambiguity) return null;
  if (turnHasProse) return null;
  if (!isBlankText(assistantText)) return null;
  const writes = (toolCalls || []).filter((c) => isMutating(c.name)).map((c) => c.name);
  if (!writes.length) return null;
  return { writes, candidates: ambiguity.candidates };
}

export function detectClarifyingQuestion({ assistantText }) {
  const asking = isAskingTheUser(assistantText);
  if (!asking) return null;
  const prose = proseOnly(assistantText);
  const fact = needsAFactFromTheUser(assistantText);
  if (fact) return { reason: 'asks-for-a-fact', quote: fact.quote, via: fact.via, asked: asking.asked };
  const targets = candidateTargets(prose);
  if (targets.length >= 2) {
    return { reason: 'multiple-candidate-targets', quote: targets.slice(0, 4).join(', '), asked: asking.asked };
  }
  return null;
}

export function detectStalledTurn({ assistantText, userText, mutatingCallCount = 0 }) {
  // The test is whether the turn CHANGED anything, not whether it called
  // anything. Measured: the guard first counted calls in the closing iteration,
  // so a turn that resolved the item, created the policy and then signed off
  // with "let me know if you want anything else" was nudged into a pointless
  // extra read. Reads before a stall are the common shape of the real failure —
  // the model gathers everything it needs and then asks permission anyway — so
  // only a mutation clears the guard.
  if (mutatingCallCount > 0) return null;
  const text = String(assistantText || '');
  if (!text.trim()) return null;
  if (!ASKS_TO_PROCEED.test(text)) return null;
  if (!IS_DIRECTIVE.test(String(userText || ''))) return null;
  // THE FENCE. A6's own comment claimed a genuine clarifying question could not
  // reach it "because it does not ask for permission to proceed". That was
  // wrong, and 2026-08-24 is the bill: "let me know" is in ASKS_TO_PROCEED
  // because a stalled flow design ended with it, and it is also how a person
  // asks which of two records you meant. The two are separated here rather than
  // by trying to make one pattern list carry both meanings.
  const clarifying = detectClarifyingQuestion({ assistantText: text });
  if (clarifying) return null;
  const asked = text.match(ASKS_TO_PROCEED)[0];
  return { asked };
}

/* ------------------------------------------------------------------ *
 * WI-2 — THE TURN-END INVARIANT
 *
 * An assistant response containing zero tool calls ENDS THE TURN. The only
 * legal reasons to call the provider again inside one user turn are tool
 * results to feed back, and the single measured exception below.
 *
 * A6 is that exception, and it is kept rather than removed: it answers a
 * failure measured twice in three runs, and deleting a measured guard to
 * satisfy an invariant written before the measurement existed would trade a
 * loud defect for a quiet one. It is FENCED instead (above), so it can no
 * longer fire on a question only the user can answer.
 *
 * What makes this mechanical rather than "correct because the statements are
 * in this order": the loop must have RECORDED a sanctioned continuation for
 * every iteration past the first, and it checks that before each provider
 * call. A future edit that adds a `continue` without naming its reason does
 * not quietly re-open 2026-08-24 — it throws on the next iteration.
 * ------------------------------------------------------------------ */
export const CONTINUATION_REASONS = Object.freeze({
  TOOL_RESULTS: 'tool_results',
  A6_STALL_NUDGE: 'a6_stall_nudge',
  // M3 — a write with no explanation, handed back once for one.
  UNEXPLAINED_MUTATION: 'unexplained_mutation_bounce',
});
const LEGAL_CONTINUATIONS = new Set(Object.values(CONTINUATION_REASONS));

export function assertContinuationsAccountFor(iteration, reasons) {
  if (iteration === 0) return;
  const unknown = reasons.filter((r) => !LEGAL_CONTINUATIONS.has(r));
  if (unknown.length) {
    throw Object.assign(
      new Error(`Refusing to call the provider again: unrecognised turn continuation "${unknown[0]}".`),
      { status: 500, detail: { iteration, reasons, legal: [...LEGAL_CONTINUATIONS] } },
    );
  }
  if (reasons.length < iteration) {
    throw Object.assign(
      new Error(
        `Refusing to call the provider for iteration ${iteration + 1} of this turn: only ${reasons.length} `
        + 'sanctioned continuation(s) were recorded. A response with no tool calls ends the turn.',
      ),
      { status: 500, detail: { iteration, reasons, legal: [...LEGAL_CONTINUATIONS] } },
    );
  }
}

/**
 * Run one user turn. `emit(event)` streams progress to the client:
 *   { type: 'meta', provider, model }
 *   { type: 'assistant_text', text }
 *   { type: 'tool_use', id, name, input, mutating }
 *   { type: 'approval_required', approvalId, name, input }
 *   { type: 'approval_resolved', approvalId, approved }
 *   { type: 'tool_result', id, name, output, isError }
 *   { type: 'compacted', ... } | { type: 'done' } | { type: 'error', message, retryable }
 *   { type: 'cancelled', phase, at, mutations }
 *
 * `retry` re-issues a turn whose previous attempt died before writing anything
 * — an empty completion, or the upstream falling over. The user's message is
 * already the last row in history, so appending it again would duplicate it and
 * quietly change the conversation the model sees. Everything else is identical:
 * same history, same tools, same gate.
 *
 * PHASE 0 — `signal` is an optional AbortSignal belonging to ONE execution. It
 * is owned by the caller (the route), never stored in a module-level variable,
 * and never shared between turns: two concurrent sessions cannot cancel each
 * other because there is nowhere for one to reach the other's controller.
 *
 * The contract it buys is narrow and deliberate. Cancellation is OBSERVED at
 * boundaries, never IMPOSED on work in flight:
 *
 *   - before an iteration builds a prompt or calls the provider
 *   - when an in-flight provider request is aborted (the fetch, not the tool)
 *   - after a completion is safely stored, before any tool runs
 *   - between completed tool executions
 *   - while a card is waiting at the approval gate
 *
 * A tool that has started NEVER sees the signal. It finishes, its result is
 * recorded, its ledger row is written and its capture runs — and only then does
 * the loop stop. That is the whole reason the mutation ledger stays internally
 * consistent through a cancellation.
 */
/*
 * EXPERIENCE §5/§8 — `taskId` IS NEW, AND IT IS A CORRELATION ID, NOT A LAYER.
 *
 * Migration 23 added `tool_events.task_id` so evidence could stop guessing, but
 * only the PLAN executor ever wrote it: every row the ordinary turn loop
 * produced was NULL, and both the evidence layer and the activity projection
 * fell back to matching by session plus the task's time window. That is
 * deterministic but it is not a key — two turns overlapping in one session each
 * claim the other's tool calls — so the workspace could show a tool this task
 * did not run, which is exactly what §8 forbids.
 *
 * The fix is one opaque string. `runTurn` does not import the task layer, does
 * not create, read or transition a task, and does not know what the id means;
 * it stamps it on the audit rows it already writes, exactly as it already
 * stamps `sessionId`. The dependency arrow is unchanged — the task layer still
 * watches the turn's output rather than the reverse.
 *
 * Additive: a caller that passes nothing keeps the window fallback, and every
 * row written before this stays NULL and keeps behaving as it did.
 */
export async function runTurn(sessionId, userText, emit, { retry = false, signal = null, taskId = null } = {}) {
  const state = liveState(sessionId);
  // WI-3 — so `resolveApproval`, which runs on the approve REQUEST rather than
  // in this turn, can put a refused approval into the transcript the user is
  // actually looking at. Cleared in the `finally` below: a stale emit would
  // write into a closed response for the rest of the process's life.
  state.emit = emit;
  /*
   * Published for the same reason `state.emit` is: `resolveApproval` runs on a
   * DIFFERENT request and needs to reach the turn its card belongs to. Cleared
   * in the same `finally` that clears `emit`, so a stale id can never attribute
   * a later refusal to a turn that has ended.
   */
  state.taskId = taskId;
  const { agent } = getSettings();

  if (!loadSessionRow(sessionId)) createSession({ id: sessionId });

  let stallNudged = false;
  // M3 — how many unexplained writes this turn has handed back, and whether it
  // has ever said anything to the user. `turnHasProse` is what makes the guard
  // narrow: a turn that narrated and then wrote is not the failure it exists
  // for, and one line of prose disarms it for the rest of the turn.
  let unexplainedBounces = 0;
  let turnHasProse = false;
  let compactedThisTurn = false;
  let mutatingCallCount = 0;
  /*
   * Phase 0 — everything cancellation needs, and all of it turn-local.
   *
   * `cancelRequestedAt` and `cancelDuringTool` are recorded by the abort
   * listener at the moment the request arrives; `finishCancelled` records when
   * it was OBSERVED. The gap between the two is the answer to "how long did
   * Stop take", and it is the one thing a log line cannot reconstruct
   * afterwards — a tool that was mid-flight when Stop was pressed has finished
   * and been recorded by the time the loop notices.
   */
  let cancelRequestedAt = null;
  let cancelDuringTool = null;
  /** The tool currently inside the mutation pipeline, or null. Never aborted. */
  let activeTool = null;
  const onAbort = () => {
    cancelRequestedAt = cancelRequestedAt || new Date().toISOString();
    cancelDuringTool = cancelDuringTool || activeTool;
    log.warn('agent', `cancellation requested  session=${shortId(sessionId)}`
      + `${activeTool ? ` — ${activeTool} is executing and will be allowed to finish` : ''}`);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const cancelled = () => Boolean(signal?.aborted);
  // WI-2 — one entry per SANCTIONED re-invocation of the provider. The loop
  // cannot reach iteration i without i of these, so a `continue` added later
  // without naming its reason fails loudly instead of silently re-opening the
  // ask-and-act defect.
  const continuations = [];
  // The seq of the user message that opened this turn — the key every ledger
  // row hangs off. On a retry the message is already stored, so the newest one
  // is this turn's.
  let turnSeq = 0;
  if (!retry) {
    const userSeq = appendMessage(sessionId, { role: 'user', text: userText });
    indexMessage(sessionId, userSeq, 'user', userText);
    turnSeq = userSeq;
  } else {
    turnSeq = latestUserSeq(sessionId);
  }
  const info = providerInfo();
  emit({ type: 'meta', ...info });
  const turnStart = Date.now();
  // Taken before any tool runs, so end-of-turn reconciliation can see
  // everything the turn produced — including rows no tool reported.
  const turnCaptureMark = captureMark();
  const sessionTitle = loadSessionRow(sessionId)?.title || null;
  // Declare this session's capture window so a CONCURRENT captured session
  // cannot claim rows this one produced, and vice versa (AD-4).
  openCaptureWindow(sessionId, turnCaptureMark);
  log.info('agent', `turn ${retry ? 'RETRY' : 'start'}  session=${shortId(sessionId)} ${info.provider}/${info.model}`,
    { message: userText.slice(0, 200) });

  /*
   * Phase 0 — THE CANCELLATION EXIT, and the only one.
   *
   * Every caller `return`s straight after awaiting this, so the `finally` below
   * still runs and the capture window still closes. It deliberately mirrors the
   * other terminal paths rather than short-circuiting them: reconcile what the
   * turn produced, render the harness's own mutation report, then emit exactly
   * one terminal frame. A turn that was stopped after writing a record must
   * still report that record, and the report is rendered from the ledger, so
   * cancelling cannot make a completed mutation disappear from it.
   *
   * `cancelled` replaces `done`, never accompanies it. The two risky steps are
   * caught individually so a failure in either cannot cost the terminal frame —
   * the invariant is one frame per stream, and a cancellation that emitted none
   * would look exactly like the truncated-stream defect `sse()` was hardened
   * against.
   */
  async function finishCancelled({ phase, iteration = null }) {
    const observedAt = new Date().toISOString();
    log.warn('agent', `turn CANCELLED at ${phase}  session=${shortId(sessionId)}  ${ms(turnStart)}`
      + `  (${mutatingCallCount} mutation(s) completed)`);
    try {
      recordToolEvent(sessionId, {
        taskId,
        kind: 'guard', name: 'turn_cancelled',
        payload: {
          phase,
          turnSeq,
          iteration,
          requestedAt: cancelRequestedAt,
          observedAt,
          // The question a reader will actually have: was something running
          // when Stop was pressed, and if so what.
          toolActive: Boolean(cancelDuringTool),
          tool: cancelDuringTool,
          mutationsCompleted: mutatingCallCount,
        },
        result: `The turn was cancelled at ${phase}.`
          + (cancelDuringTool ? ` ${cancelDuringTool} was executing and was allowed to finish.` : ''),
        resultStatus: 'cancelled', mutating: false, approval: null,
      });
    } catch (err) {
      log.warn('agent', `could not record the cancellation: ${err.message}`);
    }
    if (mutatingCallCount > 0) {
      try {
        const reconciled = await reconcileTurn({ sessionId, sessionTitle, since: turnCaptureMark });
        if (reconciled) emit(reconciled);
      } catch (err) {
        log.error('agent', `capture reconciliation failed after cancellation: ${err.message}`, err);
      }
    }
    try { emitMutationReport({ sessionId, turnSeq, emit }); }
    catch (err) { log.error('agent', `could not render the mutation report after cancellation: ${err.message}`, err); }
    emit({
      type: 'cancelled', phase, at: observedAt,
      requestedAt: cancelRequestedAt,
      mutations: mutatingCallCount,
      toolActive: Boolean(cancelDuringTool),
      tool: cancelDuringTool,
    });
  }

  /*
   * B4 / D3 — the task boundary, checked BEFORE the model sees the turn.
   *
   * Placement is the whole guarantee. A stop the model is asked to respect is a
   * suggestion; a stop that happens before it is invoked is a stop. Reaching
   * the model requires the classifier to have found positive evidence that this
   * request continues the task impersonation was started for — every other
   * outcome ends the turn with a question.
   *
   * Only fires while mode is active, so it is inert for every ordinary turn.
   */
  try {
    const boundary = checkTaskBoundary({ sessionId, userText });
    if (boundary.stop) {
      log.warn('impersonation', `turn stopped at the task boundary (${boundary.verdict}: ${boundary.reason})`);
      appendMessage(sessionId, { role: 'assistant', text: boundary.question });
      emit({ type: 'assistant_text', text: boundary.question });
      emit({
        type: 'impersonation_boundary_stop',
        verdict: boundary.verdict, reason: boundary.reason,
        target: boundary.target, task: boundary.task, evidence: boundary.evidence,
      });
      emitMutationReport({ sessionId, turnSeq, emit });
      emit({ type: 'done' });
      closeCaptureWindow(sessionId);
      if (state.emit === emit) { state.emit = null; state.taskId = null; }
      return;
    }
    if (boundary.verdict === 'consented' || boundary.verdict === 'declined') {
      log.info('impersonation', `task boundary ${boundary.verdict}`);
      emit({ type: 'impersonation_boundary_resolved', verdict: boundary.verdict, task: boundary.task ?? null });
    }
  } catch (err) {
    // A guard that crashes must not take the turn with it - but it must also
    // not fail OPEN silently, so the failure is logged loudly rather than
    // swallowed. An impersonating session whose boundary check is broken is a
    // thing a human needs to know about.
    log.error('impersonation', `task-boundary check failed, turn proceeding unchecked: ${err.message}`, err);
  }

  /*
   * K3 — RETRIEVAL HAPPENS ONCE PER TURN, HERE, AND NOT INSIDE THE LOOP.
   *
   * The query is the user's request, which does not change across iterations.
   * Retrieving per iteration would re-embed the same string up to MAX_ITERATIONS
   * times for an identical result, and — worse — would let the knowledge block
   * change shape mid-turn, so the prompt MEASURED by computeBudget and the
   * prompt SENT could differ. That equality is load-bearing (see the note on
   * `provisionalSystem` below), so the block is computed once and reused.
   *
   * The model can still reach for more: `search_servicenow_docs` is in the
   * catalogue for the case where the turn's real question only becomes clear
   * after a tool result.
   *
   * Never throws — `retrieveForTurn` is total, and a turn that dies because the
   * documentation index had a bad day is strictly worse than one that runs
   * without it.
   */
  /*
   * PHASE 2 — THE CONTEXT PROFILE, BUILT ONCE, BEFORE RETRIEVAL.
   *
   * Before retrieval because the profile owns the retrieval QUERY: a request
   * about flows should bias the corpus toward Flow Designer rather than toward
   * whatever shares its vocabulary.
   *
   * Once per turn for the same reason K3 gives below — the request does not
   * change between iterations, so re-classifying it would burn work for an
   * identical answer and, worse, would let the tool list change shape mid-turn
   * so that the prompt MEASURED by computeBudget and the prompt SENT could
   * differ. The one thing that DOES change it is a tool miss, and that widens
   * explicitly and monotonically (see below).
   *
   * `capability: null` today. That argument is the seam a planner plugs into in
   * a later phase — a step that knows what it is for passes it and the
   * classifier is never consulted. Nothing sets it yet.
   */
  /*
   * EXPERIENCE §40/§41 — THE SKILL SURFACE, APPLIED BEFORE CLASSIFICATION.
   *
   * §41 is the section that decides where this goes: "Do not merely hide the UI
   * while leaving the backend available to planning." So a disabled skill's
   * capabilities are removed from the tool array the context engine is given,
   * not from a list the renderer draws — the planner never sees them, the
   * prompt never carries their schemas, and `computeBudget` measures the
   * surface that was actually sent.
   *
   * BEFORE the profile, and this ordering matters twice. The profile narrows
   * the skill surface rather than the registry, so a narrowing can never
   * re-admit what a disabled skill removed; and `widenProfile` below widens
   * back to THIS array rather than to `TOOLS`, so the one path that undoes
   * narrowing cannot undo the skill boundary.
   *
   * NO SKILLS CONFIGURED is not a locked-down agent, it is an unconfigured one:
   * `toolsForSkills` returns the full registry with `restricted: false`, and
   * every turn behaves exactly as it did before this layer existed.
   */
  const allSkills = listSkills({ tools: TOOLS });
  const skills = allSkills.filter((sk) => sk.enabled);
  const surface = toolsForSkills(TOOLS, allSkills);
  if (surface.restricted) {
    log.info('skills', `tool surface narrowed to ${surface.tools.length}/${TOOLS.length} — `
      + `${allSkills.filter((sk) => !sk.enabled).map((sk) => sk.id).join(', ')} disabled, `
      + `removing ${surface.removed.join(', ')}`);
  }

  /*
   * SESSION 1 / WI-7 — the previous turn's domains are handed in as a floor,
   * and this turn's classified set becomes the next turn's floor. Kept on the
   * per-session live state (one turn deep), never accumulated.
   */
  const sessionLive = liveState(sessionId);
  const priorCapabilities = sessionLive.lastCapabilities ?? null;
  let profile = buildContextProfile({ goal: userText, tools: surface.tools, capability: null, priorCapabilities });
  if (profile.capabilities) sessionLive.lastCapabilities = profile.capabilities;
  {
    const diag = contextDiagnostics(profile, { allTools: surface.tools });
    logProfile(diag);
    emit(diag);
  }
  /*
   * §46 — the skills that are ACTIVE for this turn, which is not the same as
   * the skills that are installed. Only those whose capabilities intersect what
   * this request was classified as reach the prompt (§42), and only those are
   * announced.
   */
  const activeSkills = skillsForProfile(skills, profile);
  if (activeSkills.length) emit({ type: 'skills_active', skills: activeSkillSummary(activeSkills) });
  /*
   * §42 — what an active skill adds to the PROMPT, if anything.
   *
   * Appended to the assembled system prompt rather than passed into
   * `buildSystemPrompt`, because prompts.js is frozen and this is additive:
   * with only built-in skills enabled it is null and the prompt is unchanged.
   * Computed ONCE, here, and used for both the measured and the sent string
   * below — the same discipline `knowledgeNote` follows, and for the same
   * reason: a prompt that is measured and a prompt that is sent must be one
   * string or the budget stops describing the request.
   */
  const skillNote = skillContextBlock(activeSkills);
  const withSkills = (text) => (skillNote ? `${text}

${skillNote}` : text);

  // The profile's query is widened with the turn's capabilities; the user's
  // own words decide what is relevant enough to cite. See retrieveForTurn.
  const knowledge = await retrieveForTurn(profile.query, { askedAbout: userText });
  if (knowledge.retrieval) {
    emit({
      type: 'knowledge',
      mode: knowledge.retrieval.mode,
      indexed: knowledge.retrieval.indexed,
      hits: knowledge.retrieval.hits.length,
      degraded: Boolean(knowledge.retrieval.degraded),
      // Cited so the user can see what informed the turn, and check it.
      citations: knowledge.retrieval.hits.map((h) => ({
        title: h.title || h.topic, version: h.version, url: h.url, source: h.source,
      })),
    });

    /*
     * PHASE 8 — AND RECORDED, not only streamed.
     *
     * The frame above is SSE: it reaches the live transcript and dies with the
     * stream. Reopen the chat and nothing remembers that documentation was
     * retrieved, because evidence is built from durable rows and this turn
     * wrote none — so the Sources panel could never show an automatic
     * retrieval, only a tool the model happened to call itself.
     *
     * ONLY WHEN IT FOUND SOMETHING. A retrieval that returned nothing is not a
     * source, and writing a row for it would put "ServiceNow docs" in front of
     * a reader on the strength of an empty corpus. Zero hits stays unrecorded.
     *
     * The stored result is the store's own shape, so the evidence projection
     * reads it with exactly the parser it uses for the model-invoked tool.
     */
    if (knowledge.retrieval.hits.length > 0) {
      recordToolEvent(sessionId, {
        taskId,
        kind: 'tool_call',
        name: 'knowledge_retrieval',
        payload: { query: profile.query, automatic: true },
        result: JSON.stringify({
          query: profile.query,
          indexed: knowledge.retrieval.indexed ?? null,
          mode: knowledge.retrieval.mode ?? null,
          degraded: Boolean(knowledge.retrieval.degraded),
          hits: knowledge.retrieval.hits,
        }),
        resultStatus: 'ok',
        mutating: false,
        approval: null,
      });
    }
  }
  const knowledgeNote = knowledge.block;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      /*
       * Phase 0 — SAFE POINT 1: before this iteration costs anything.
       *
       * Nothing has been built, probed, folded or sent. On i === 0 this is the
       * whole guarantee that a turn cancelled before it started never reaches
       * the provider at all.
       */
      if (cancelled()) {
        await finishCancelled({ phase: i === 0 ? 'before-first-iteration' : 'iteration-boundary', iteration: i });
        return;
      }
      /*
       * D-7 — AT MOST ONE COMPACTION PER USER TURN.
       *
       * This used to run on every iteration of the loop, with the reasoning
       * that a single turn's tool results can be what pushes a session over
       * budget. True, and it produced the defect: one long spec compacted
       * THREE times inside one turn (9,629 -> 4,308, 7,209 -> 3,774,
       * 6,298 -> 2,476), because each fold landed just under a budget that a
       * single further tool result immediately pushed back over. Three LLM
       * calls, three spans of verbatim history destroyed, to end up where it
       * started.
       *
       * Compacting once is not a compromise. If one fold cannot get the turn
       * under budget, a second will not either — the recent turns are the
       * weight, and those are the ones compaction is not allowed to touch. The
       * honest outcome is to proceed and let the size warning say so.
       */
      /*
       * WI-2 — the ledger reaches the model SYSTEM-side.
       *
       * Not as a message: compaction rewrites `messages`, so a reminder posted
       * there could be folded away by the exact mechanism this defends against.
       * The system prompt is rebuilt every iteration, so by the final
       * completion it carries every mutation the turn has executed — including
       * ones the model can no longer see in its own history.
       */
      const ledgerSoFar = mutatingCallCount > 0 ? mutationsForTurn(sessionId, turnSeq) : [];
      /*
       * F12 — the one number the model could never see.
       *
       * Recomputed here every iteration and empty until the last three calls,
       * so it costs nothing on a normal turn. It is measured into the budget
       * below as well as sent, because a block that is in the request but not
       * in the estimate is how a budget quietly stops describing the request.
       */
      const iterationNotice = iterationBudgetNotice(MAX_ITERATIONS - i);
      const provisionalSystem = withSkills(buildSystemPrompt({
        sessionId,
        digestNote: buildDigestNote(sessionId),
        mutationDigest: ledgerDigestForModel(ledgerSoFar),
        iterationNotice,
        knowledgeNote,
        // Phase 2 — the same profile that supplies `tools` below, so the prompt
        // that is MEASURED and the prompt that is SENT stay one string.
        profile,
      }));
      const budgets = await computeBudget({ system: provisionalSystem, tools: profile.tools, maxTokens: MAX_OUTPUT_TOKENS });
      if (i === 0) {
        // The three numbers, at meta time, every turn. Previously the budget
        // was a constant nobody could see was wrong.
        log.info('llm',
          `budget: model context ${budgets.modelCtx} (${budgets.modelCtxSource}), capped at ${budgets.ceiling}, ` +
          `fixed overhead ${budgets.fixed} (system ${budgets.systemTokens} + ${budgets.toolCount}/${surface.tools.length} tool schemas ` +
          `${budgets.toolSchemaTokens}), output headroom ${budgets.headroom} ` +
          `=> history budget ${budgets.budget}`);
        emit({ type: 'budget', ...budgets });
      }

      if (!compactedThisTurn) {
        const compaction = await compactIfNeeded(sessionId, { budget: budgets.budget });
        if (compaction.compacted) {
          compactedThisTurn = true;
          emit({ type: 'compacted', ...compaction });
        } else if (compaction.warning || compaction.error) {
          // Not compacting is a decision with consequences for this turn, so
          // it is reported rather than inferred from the absence of a digest.
          log.warn('memory', compaction.warning || compaction.error);
        }
      }

      /*
       * The history that will actually be sent, with anything unsendable
       * removed. This is also the migration: a session written before D-7 can
       * hold blank assistant rows in SQLite, and they are repaired on read
       * here rather than in a one-shot script that only helps whoever runs it.
       */
      const raw = loadHistory(sessionId);
      const { history, dropped, reasons } = sanitizeHistory(raw);
      if (dropped) {
        log.warn('memory', `sanitized ${dropped} unsendable message(s) out of session ${shortId(sessionId)} before sending`,
          { reasons: [...new Set(reasons)] });
      }

      // Rebuilt after compaction, so a digest written just now is in the prompt.
      // Same ledger digest as the budget probe above, so the prompt that is
      // MEASURED and the prompt that is SENT are the same string.
      const system = withSkills(buildSystemPrompt({
        sessionId,
        digestNote: buildDigestNote(sessionId),
        mutationDigest: ledgerDigestForModel(ledgerSoFar),
        iterationNotice,
        // Same block the budget above measured, so the prompt that is MEASURED
        // and the prompt that is SENT stay the same string.
        knowledgeNote,
        profile,
      }));
      const requestTokens = budgets.fixed + estimateTokens(history);
      log.debug('llm', `request ~${requestTokens} tokens (fixed ${budgets.fixed}, history budget ${budgets.budget})`);
      if (requestTokens > budgets.ceiling) {
        log.warn('llm', `request ~${requestTokens} tokens is over the ${budgets.ceiling}-token self-imposed cap ` +
          `(model window is ${budgets.modelCtx}); sending anyway — compaction could not fold enough to help.`);
      }
      /*
       * Phase 0 — SAFE POINT 2: the last boundary before the provider speaks.
       *
       * Not redundant with the top of the loop. Compaction is an LLM call of
       * its own and can take seconds, and a cancellation that arrived while it
       * ran must not then be paid for with a full completion. Checked before
       * the continuation assertion so a cancelled turn is never the one that
       * has to satisfy it.
       */
      if (cancelled()) {
        await finishCancelled({ phase: 'before-provider-call', iteration: i });
        return;
      }
      // WI-2 — the invariant, checked at the one place it matters: immediately
      // before the provider is asked to speak again.
      assertContinuationsAccountFor(i, continuations);
      const callStart = Date.now();
      let res;
      try {
        res = await chatTurn({
          system,
          history,
          // Phase 2 — the SELECTED surface. Fewer tools is not fewer
          // permissions: everything that does run still passes the same gate,
          // the same guards and the same read-back verification.
          tools: profile.tools,
          maxTokens: MAX_OUTPUT_TOKENS,
          // F9 — asked for, never assumed. Both adapters pass this through;
          // whether the backend honours it is a separate question with a
          // measured answer in agent/decoding.js.
          decoding: { temperature: AGENT_TEMPERATURE },
          // Phase 0. The provider request is a READ and is the one thing in
          // this loop that is safe to abort in flight, so the signal is handed
          // to the adapter. Whether the adapter can use it is its own business
          // — cancellation still lands at the next boundary if it cannot.
          signal,
        });
      } catch (err) {
        /*
         * Phase 0 — SAFE POINT 3: we aborted this request ourselves.
         *
         * Judged from OUR signal, never from the shape of the error, so this
         * stays provider-neutral: no adapter has to invent an error type and
         * nothing here has to recognise one.
         */
        if (cancelled()) {
          log.info('llm', `iteration ${i + 1} aborted by cancellation after ${ms(callStart)}`);
          await finishCancelled({ phase: 'provider-call', iteration: i });
          return;
        }
        // The message shape is the usual cause of a provider 400, and it is
        // invisible from the error alone — so name it here rather than making
        // someone read the database to find out.
        log.error('llm', `iteration ${i + 1} failed after ${ms(callStart)} — ${err.message}`, {
          historyEntries: history.length,
          shapes: history.map((m) => (m.role === 'assistant'
            ? `assistant(text=${m.text ? 'str' : 'EMPTY'},calls=${m.toolCalls?.length || 0})`
            : m.role === 'tool' ? `tool(${(m.results || []).length})` : m.role)),
        });
        /*
         * F4 — and the same evidence, kept.
         *
         * The adapter's empty-completion dump is the only record of what
         * produced the failure, and it went to stderr alone: in the session
         * this fix came from it was gone before anyone read it, so the
         * question it exists to answer had to be re-asked of SQLite by hand.
         * `tool_events` is the right home — compaction rewrites `messages` and
         * touches nothing else, so this row cannot be folded away by the very
         * mechanism it is usually recording the consequences of.
         *
         * ONE row per failed call, and never load-bearing: a diagnostic that
         * can sink the turn it is diagnosing is worse than no diagnostic.
         *
         * F13 widened it. The adapter now attaches the same shape to an HTTP
         * failure that never produced a completion at all, under its own name,
         * so a 500 and an empty 200 land here identically but stay countable
         * apart. The adapter names the row; the default is F4's, because that
         * is the path that does not name one.
         */
        if (err.guardDump) {
          const guard = err.guard || { name: 'f4_empty_completion', status: 'empty-completion' };
          try {
            recordToolEvent(sessionId, {
              taskId,
              kind: 'guard',
              name: guard.name,
              payload: { iteration: i + 1, ...err.guardDump },
              result: err.message,
              resultStatus: guard.status,
              mutating: false,
              approval: null,
            });
          } catch (logErr) {
            log.warn('agent', `could not persist the ${guard.name} dump: ${logErr.message}`);
          }
        }
        throw err;
      }
      log.debug('llm', `iteration ${i + 1}  ${ms(callStart)}  stop=${res.stopReason || '—'}  ` +
        `text=${res.text ? res.text.length + 'ch' : 'none'}  calls=${res.toolCalls?.length || 0}`);

      /*
       * D-7 — AN EMPTY COMPLETION IS AN ERROR PATH, NEVER A MESSAGE.
       *
       * §29 already rejected `!res.text && !res.toolCalls?.length`. That guard
       * is truthiness, and "
" is truthy — so a whitespace-only completion,
       * which this model emits when reasoning eats the budget, walked straight
       * past it. It became a real assistant row, rendered as a blank bubble,
       * and rode along in every subsequent request for the rest of the session.
       * That is the shape behind the blank rows in the incident screenshot.
       *
       * The adapter now normalises whitespace to '' and this checks emptiness
       * rather than falsiness, so the two agree on what "nothing" means. And
       * the outcome is unchanged in kind but stricter in fact: nothing is
       * appended, nothing is rendered, and the turn fails loudly.
       */
      if (isBlankText(res.text) && !res.toolCalls?.length) {
        /*
         * F8 — report what happened, and stop guessing why.
         *
         * This used to end "this is usually a transient load on Ollama's side
         * rather than a problem with your request". It said that for every
         * finish reason, including the one that turned out to be a request
         * this code had built wrong — so it sent people to look at their model
         * choice while the defect was in compaction. That is trap #51 in the
         * ledger, arriving in the message written to close trap #51.
         *
         * The other claim was worse. "Nothing was written to the instance" is
         * true of THIS call and not of the turn: the failing turn in the
         * incident had already executed an approved create_record six seconds
         * earlier. The harness knows exactly what ran and renders it — so the
         * message points at that rather than asserting an absence it cannot
         * see.
         */
        const err = new Error(
          `The model returned nothing — no text and no tool call (finish reason: ${res.stopReason || 'unknown'}), ` +
          `on ${RETRY_ATTEMPTS} attempts in a row. The full request and the provider's reply were captured to ` +
          'this session\'s log. Earlier tool actions in this turn may already have applied — check the mutation ' +
          'report above. Retry re-runs the turn from the session\'s current state.'
        );
        // Tells the UI to offer Retry: the history is intact and unmodified, so
        // re-issuing this turn against it is a safe, meaningful thing to do.
        err.retryable = true;
        throw err;
      }

      // Whitespace never becomes stored text. Past this point res.text is
      // either real content or '', and '' is only legal beside a tool call.
      const assistantText = isBlankText(res.text) ? '' : res.text;
      const assistantSeq = appendMessage(sessionId, {
        role: 'assistant',
        text: assistantText,
        toolCalls: res.toolCalls,
      });
      if (assistantText) {
        turnHasProse = true;
        indexMessage(sessionId, assistantSeq, 'assistant', assistantText);
        emit({ type: 'assistant_text', text: assistantText });
      }

      /*
       * Phase 0 — SAFE POINT 4: the completion is stored, no tool has run.
       *
       * Checked here rather than the moment `chatTurn` returned, so the prose
       * the model produced is kept and shown: the user paid for it, and a turn
       * that says what it was about to do before stopping is more useful than
       * one that silently discards it.
       *
       * The tool calls, however, MUST come out of the stored row. A
       * `tool_call` with no matching `tool` result is the exact shape the wire
       * format rejects — it would poison every later request in this session,
       * which is the failure `rewriteMessage` already exists to prevent on the
       * withheld-mutation and unexplained-write paths. The payloads survive in
       * the guard row below, which is their only remaining record.
       */
      if (cancelled()) {
        if (res.toolCalls?.length) {
          rewriteMessage(sessionId, assistantSeq, { role: 'assistant', text: assistantText, toolCalls: [] });
          const discarded = res.toolCalls.map((c) => c.name);
          log.warn('gate', `discarded ${discarded.length} tool call(s) unrun — the turn was cancelled before they started`);
          try {
            recordToolEvent(sessionId, {
              taskId,
              kind: 'guard', name: 'cancelled_before_tools',
              payload: { discarded, calls: res.toolCalls, iteration: i },
              result: 'The turn was cancelled after the completion arrived and before any tool ran.',
              resultStatus: 'cancelled', mutating: false, approval: null,
            });
          } catch (err) { log.warn('agent', `could not record the discarded calls: ${err.message}`); }
          emit({ type: 'calls_discarded', reason: 'cancelled', discarded });
        }
        await finishCancelled({ phase: 'after-completion', iteration: i });
        return;
      }

      if (!res.toolCalls?.length) {
        /*
         * WI-2 — the turn ENDS on a question only the user can answer.
         *
         * Checked before A6 on purpose. Both look at the same prose, and on
         * 2026-08-24 both would have matched it: A6 saw "let me know" and
         * nudged; this sees that the model was asking which of two incidents to
         * change. Ending is the safe reading, so ending wins.
         *
         * The row is the point as much as the behaviour. `a6_stalled_turn` in
         * `tool_events` is the whole reason that incident was diagnosable at
         * all after compaction folded the messages away — so the harness
         * records the decision it made NOT to continue, under its own name.
         */
        const clarifying = detectClarifyingQuestion({ assistantText });
        if (clarifying) {
          log.info('gate', `turn ends on a question for the user (${clarifying.reason}: ${clarifying.quote})`);
          recordToolEvent(sessionId, {
            taskId,
            kind: 'guard', name: 'turn_ended_on_question',
            payload: { reason: clarifying.reason, quote: clarifying.quote, asked: clarifying.asked },
            resultStatus: 'awaiting-user', mutating: false, approval: null,
          });
          emit({ type: 'awaiting_user', reason: clarifying.reason, asked: clarifying.asked });
        }
        // A6. One nudge per turn, carrying the one fact the model is missing.
        const stalled = !stallNudged && !clarifying && detectStalledTurn({
          assistantText, userText, mutatingCallCount,
        });
        if (stalled) {
          stallNudged = true;
          const note =
            `SYSTEM: that turn ended without calling a tool, so nothing happened on the instance and your ` +
            `question ("${stalled.asked.trim()}") was not shown to the user as a prompt they can answer. ` +
            `Approval is not requested in prose — it is requested BY calling the tool, which pauses and shows ` +
            `the user an approve/reject card carrying the exact arguments. You already have what you need. ` +
            `Call the tool now with the values you just described. If you are genuinely missing a value, call a ` +
            `read-only tool to get it instead of asking. If the thing you are missing can only come from the ` +
            `USER — which of several records they meant, a value only they know — call no tool at all: ask the ` +
            `question on its own and end the turn. Never pick one and write to it.`;
          appendMessage(sessionId, { role: 'user', text: note });
          emit({ type: 'nudged', reason: 'stalled', asked: stalled.asked.trim() });
          recordToolEvent(sessionId, {
            taskId,
            kind: 'guard', name: 'a6_stalled_turn', payload: { asked: stalled.asked.trim() },
            resultStatus: 'nudged', mutating: false, approval: null,
          });
          // The ONE sanctioned reason to speak to the provider again after a
          // completion that called nothing (WI-2).
          continuations.push(CONTINUATION_REASONS.A6_STALL_NUDGE);
          continue;
        }
        /*
         * FOLLOW-UP WI-2 — TELEMETRY, NOT A GUARD.
         *
         * The turn is about to end on prose that asks the user nothing and
         * changed nothing. Some of those are fine — "there is no such field on
         * this table" is a complete answer. Some are the A6 failure in a
         * phrasing A6's patterns do not match: declarative intent with no tool
         * call, where the model announces work it then does not do, and the
         * stream closes looking exactly like success.
         *
         * A6 is still here and still nudges what it recognises (this fires only
         * when it did not), and rebuilding a wider nudge on a guess is how the
         * 2026-08-24 defect happened: A6's nudge asserted "You already have
         * what you need", which was false. So this sprint measures instead.
         * `stalled_turn_ended` is the population a successor would have to
         * serve; whether one is ever written is a decision for the rate this
         * event shows, and the rule for making it is written down in
         * docs/incidents/2026-08-24-ask-act.md.
         *
         * `mutatingCallCount === 0` is what keeps it meaningful. A turn that
         * created a record and signed off with "Created INC0010060." is not a
         * stall, and counting it would drown the signal in every successful
         * turn in the session.
         */
        if (assistantText && mutatingCallCount === 0 && !isAskingTheUser(assistantText)) {
          const head = proseHead(assistantText);
          const intent = stallIntent(assistantText);
          log.info('agent', `turn ended having asked nothing and changed nothing (${intent}) — "${head}"`);
          recordToolEvent(sessionId, {
            taskId,
            kind: 'guard', name: 'stalled_turn_ended',
            payload: { head, intent, nudgedEarlier: stallNudged },
            resultStatus: intent, mutating: false, approval: null,
          });
          emit({ type: 'stalled_turn_ended', head, intent, nudgedEarlier: stallNudged });
        }
        // Reconcile before 'done': the per-call sweeps were keyed on ids the
        // tools reported, and a composite builder or an SDK install produces
        // rows nothing named.
        if (mutatingCallCount > 0) {
          const reconciled = await reconcileTurn({ sessionId, sessionTitle, since: turnCaptureMark });
          if (reconciled) emit(reconciled);
        }
        // AFTER reconciliation, so the capture verdict is in the ledger before
        // the report renders it.
        emitMutationReport({ sessionId, turnSeq, emit });
        log.info('agent', `turn done  session=${shortId(sessionId)}  ${ms(turnStart)}`);
        emit({ type: 'done' });
        return;
      }

      /*
       * WI-3 — hold mutations that arrived alongside a question.
       *
       * The question is surfaced and the turn ends; nothing is written. The
       * user answers, and the next turn acts on the answer instead of on an
       * assumption the model made while asking.
       *
       * Reads still run. A turn that asks a question and gathers context while
       * waiting is doing the right thing, and the reads it already chose are
       * the cheapest way for the next turn to start from facts rather than from
       * the same guess.
       *
       * The withheld calls are DISCARDED, never queued — and discarded from
       * HISTORY too, not merely skipped. The assistant row was already written
       * with its tool_calls, and leaving a call in it with no matching tool
       * result is the exact shape the wire format rejects: it would poison every
       * later request in the session. So the row is rewritten to carry only what
       * actually ran. The payloads survive in the structured log below, which is
       * their only remaining record.
       */
      const asking = detectQuestionWithMutation({
        assistantText,
        toolCalls: res.toolCalls,
        isMutating: (n) => Boolean(toolMap.get(n)?.mutating),
        enabled: agent.holdMutationsOnQuestion !== false,
      });
      let endTurnAfterCalls = false;
      let callsToRun = res.toolCalls;
      if (asking) {
        endTurnAfterCalls = true;
        callsToRun = asking.allowed;
        log.warn('gate', `withheld ${asking.held.length} mutation(s) — the same completion asked the user a question`
          + ` (${asking.via}: "${asking.asked.trim()}")`);
        rewriteMessage(sessionId, assistantSeq, {
          role: 'assistant', text: assistantText, toolCalls: callsToRun,
        });
        recordToolEvent(sessionId, {
          taskId,
          kind: 'guard', name: 'withheld_mutation',
          // The discarded payloads, verbatim. Nothing else keeps them.
          payload: { asked: asking.asked, via: asking.via, held: asking.held, discarded: asking.discarded },
          resultStatus: 'withheld', mutating: false, approval: null,
        });
        emit({
          type: 'mutations_held', asked: asking.asked, held: asking.held,
          text: 'Proposed action withheld pending your answer.',
          ranAnyway: callsToRun.map((c) => c.name),
        });
      }

      /*
       * M3 — a write nobody explained goes back, not to the gate.
       *
       * Checked after the ask-XOR-act guard, which cannot reach the same
       * completion: that one needs prose, this one fires on its absence.
       *
       * NOT once per turn, and that distinction is measured. It was once, on
       * A6's pattern — and live round 3 showed why A6's reason does not carry
       * over. A6 nudges with a FACT the model was missing, so repeating it adds
       * nothing. This asks the model to SAY something, and "the turn has still
       * said nothing" is exactly the state that warrants asking again. Round 3:
       * bounced at seq 7, the model read a schema (seq 9), then submitted a
       * second bare write (seq 11) which the once-flag sent straight to the
       * gate — the card the criterion says must not exist.
       *
       * Bounded all the same. Three refusals to explain end the turn loudly
       * rather than spending a whole iteration budget arguing.
       *
       * The calls are discarded from the stored assistant row for the same
       * reason the withheld ones are — a tool_call with no matching result is
       * the shape the wire format rejects. What is left is a blank assistant
       * turn, which the sanitizer drops on the next read: nothing happened, and
       * history says nothing happened.
       */
      const describeCall = (c) => {
        const t = toolMap.get(c.name);
        if (typeof t?.describeWrite !== 'function') return null;
        try { return t.describeWrite(c.input || {}, null); } catch { return null; }
      };
      const unexplained = !asking && detectUnexplainedMutation({
        assistantText,
        toolCalls: res.toolCalls,
        turnHasProse,
        // WI-1 — the ambiguity now comes from the provenance registry, computed
        // per completion against the calls actually being made. The prose
        // derivation this replaced could not survive a compaction and counted
        // identifiers rather than records.
        ambiguity: ambiguousWrites({
          sessionId, userText, toolCalls: res.toolCalls,
          isMutating: (n) => Boolean(toolMap.get(n)?.mutating),
          describe: describeCall,
        }),
        isMutating: (n) => Boolean(toolMap.get(n)?.mutating),
      });
      if (unexplained) {
        unexplainedBounces += 1;
        rewriteMessage(sessionId, assistantSeq, { role: 'assistant', text: '', toolCalls: [] });
        const exhausted = unexplainedBounces >= MAX_UNEXPLAINED_BOUNCES;
        recordToolEvent(sessionId, {
          taskId,
          kind: 'guard', name: 'unexplained_mutation',
          payload: { writes: unexplained.writes, attempt: unexplainedBounces },
          resultStatus: exhausted ? 'abandoned' : 'bounced', mutating: false, approval: null,
        });
        if (exhausted) {
          // Loud, and over. Nothing was written and the transcript says so in
          // the harness's own words rather than leaving an absence to interpret.
          const text = `The agent submitted ${unexplained.writes.join(', ')} ${MAX_UNEXPLAINED_BOUNCES} times without ever `
            + 'saying what it was changing or why. Nothing was sent to the instance and nothing reached the approval '
            + 'gate. Ask again, naming the record you want changed.';
          log.error('gate', `abandoned the turn — ${MAX_UNEXPLAINED_BOUNCES} unexplained writes in a row`);
          appendMessage(sessionId, { role: 'assistant', text });
          emit({ type: 'assistant_text', text });
          emit({ type: 'mutation_bounced', writes: unexplained.writes, attempt: unexplainedBounces, abandoned: true });
          emitMutationReport({ sessionId, turnSeq, emit });
          emit({ type: 'done' });
          return;
        }
        log.warn('gate', `bounced ${unexplained.writes.length} unexplained write(s) `
          + `(${unexplainedBounces}/${MAX_UNEXPLAINED_BOUNCES}) — the turn has said nothing to the user`);
        const note =
          'SYSTEM: that write was NOT submitted, and the user saw nothing. You called '
          + `${unexplained.writes.join(', ')} without a single line of explanation, so the approval card would have `
          + `shown a payload and no reason for it. The user has NOT told you which record they mean — this `
          + `conversation has ${unexplained.candidates.length} candidates in front of them `
          + `(${unexplained.candidates.join(', ')}) and you picked one silently. Do not choose for them: name the `
          + 'candidates, ask which one, and call NO tool this turn. If you genuinely believe the target is settled, '
          + 'say in one line WHICH record you are changing and why that one, and call the tool again in that same '
          + 'response — the approval card IS the confirmation, so do not ask permission in prose.';
        appendMessage(sessionId, { role: 'user', text: note });
        emit({ type: 'mutation_bounced', writes: unexplained.writes, attempt: unexplainedBounces });
        continuations.push(CONTINUATION_REASONS.UNEXPLAINED_MUTATION);
        continue;
      }

      const results = [];
      /*
       * Phase 0 — set when the loop below stops early because the turn was
       * cancelled. Named rather than inferred from `results.length`, because a
       * turn can legitimately run fewer calls than it was given (a block, a
       * refusal) and only this says the reason was Stop.
       */
      let cancelledDuringCalls = false;
      let cancelPhase = null;
      for (const call of callsToRun) {
        /*
         * Phase 0 — SAFE POINT 5: between completed tool executions.
         *
         * The check is at the TOP of the body, so a tool that has already
         * started is never reached by it. Whatever ran before this point has
         * its result in `results`, its row in `tool_events`, its entry in the
         * mutation ledger and its capture already swept — cancelling here
         * cannot leave any of those half-written.
         */
        if (cancelled()) {
          cancelledDuringCalls = true;
          cancelPhase = 'between-tool-calls';
          break;
        }
        const tool = toolMap.get(call.name);
        if (!tool) {
          results.push({ id: call.id, name: call.name, output: `Unknown tool: ${call.name}`, isError: true });
          continue;
        }
        /*
         * PHASE 2 — THE TOOL THE PROFILE DID NOT EXPOSE.
         *
         * The tool EXISTS and is permitted; it was simply not in this turn's
         * selected surface. That distinction is the whole safety argument for
         * narrowing the surface at all, so the message says it in those words:
         * a missing tool is never a refusal, and the model must not read it as
         * one and go looking for another way to achieve the same write. It is
         * not routed anywhere — nothing is substituted, nothing falls back to a
         * generic mutation — the call simply does not run this iteration.
         *
         * The profile then WIDENS to the full registry for the rest of the
         * turn, so the very next iteration can call it. Monotonic and one-shot:
         * widening never narrows again, and it goes straight to everything
         * rather than adding one capability, because guessing what else this
         * turn will need is exactly what this layer must not do.
         */
        /*
         * Judged from what the engine EXCLUDED, not from what it selected.
         *
         * `toolMap` is the resolver and can legitimately hold entries the
         * registry array does not — the offline suite registers tools through
         * it to drive the loop without an instance. Those were never in the set
         * the engine filtered, so it did not exclude them, and treating "not in
         * the profile" as "excluded" would block a tool this layer had no
         * opinion about.
         */
        /*
         * EXPERIENCE §41/§79.8 — A TOOL A DISABLED SKILL OWNS DOES NOT RUN.
         *
         * Checked BEFORE the context-widening branch below, and that order is
         * the whole guarantee: widening goes to the full skill surface, so a
         * tool excluded by a SKILL must be refused here or it would be admitted
         * one iteration later by the mechanism that exists to recover from a
         * context miss.
         *
         * A REFUSAL, not a narrowing. The message says so in those words,
         * because the two are opposite instructions to the model: a tool
         * outside the profile should be called again, and a tool outside the
         * skill surface must not be — and must not be worked around with a
         * generic write either, which is the failure mode this sentence exists
         * to prevent.
         */
        if (surface.restricted
            && TOOLS.some((t) => t.name === call.name)
            && !surface.tools.some((t) => t.name === call.name)) {
          const message =
            `${call.name} is not available: the skill that provides it is disabled for this session. `
            + 'This IS a refusal. Do not call it again, do not substitute a different tool, and do not '
            + 'achieve the same effect with a generic record write. Tell the user which skill they would '
            + 'need to enable.';
          log.warn('skills', `${call.name} refused — no enabled skill grants it`);
          results.push({ id: call.id, name: call.name, output: message, isError: true });
          recordToolEvent(sessionId, {
            taskId,
            kind: 'guard', name: 'skill_disabled',
            payload: { tool: call.name, enabled_skills: skills.map((sk) => sk.identity) },
            result: message, resultStatus: 'skill-disabled', mutating: false, approval: null,
          });
          emit({ type: 'tool_blocked', id: call.id, name: call.name, input: call.input, reason: 'skill_disabled', message });
          continue;
        }
        const wasExcluded = profile.tools !== surface.tools
          && surface.tools.some((t) => t.name === call.name)
          && !profile.tools.some((t) => t.name === call.name);
        if (wasExcluded) {
          const message =
            `${call.name} was not offered in this turn's tool set, so it was not run. This is NOT a refusal and `
            + `${call.name} is not forbidden — the context for this turn was scoped to `
            + `${profile.capabilities?.filter((c) => c !== 'core').join(', ') || 'a subset'} and it fell outside that. `
            + 'The full tool set is now available: call it again. Do NOT substitute a different tool or a generic '
            + 'write to achieve the same effect.';
          log.warn('context', `${call.name} was called but not exposed — widening and asking the model to retry`);
          results.push({ id: call.id, name: call.name, output: message, isError: true });
          recordToolEvent(sessionId, {
            taskId,
            kind: 'guard', name: 'tool_not_in_context',
            payload: { tool: call.name, capabilities: profile.capabilities, exposed: profile.tools.length },
            result: message, resultStatus: 'not-exposed', mutating: false, approval: null,
          });
          emit({ type: 'tool_not_in_context', id: call.id, name: call.name, capabilities: profile.capabilities });
          profile = widenProfile(profile, { tools: surface.tools, reason: `${call.name} was called but not exposed` });
          emit(contextDiagnostics(profile, { allTools: surface.tools }));
          continue;
        }
        /*
         * WI-6 — emission ORDER.
         *
         * A read-only call announces itself first, as it always did. A MUTATION
         * does not: emitting `tool_use` before the gate pushed the tool card
         * above the approval card, and the tool card is then patched in place
         * with its result — so the transcript read
         * [tool … done] [approval requested], and the gate looked post-hoc.
         *
         * The gate was never actually late. The story the transcript told about
         * it was. For mutations the announcement now happens after approval, so
         * the visible sequence is: approval requested → approved → executed →
         * result.
         */
        if (!tool.mutating) {
          emit({ type: 'tool_use', id: call.id, name: call.name, input: call.input, mutating: false });
        }
        const toolStart = Date.now();
        log.info('tool', `${call.name}${tool.mutating ? ' (mutating)' : ''}`, call.input);

        /*
         * WI-3 — block a write the harness can already prove is a no-op,
         * BEFORE spending a human's approval on it.
         *
         * A gate is a request for someone's attention. Asking for it to
         * authorise something with proof against it is what made the transcript
         * painful: three approvals, three identical silent drops, zero effect.
         */
        let guardDescriptor = null;
        if (tool.mutating && typeof tool.describeWrite === 'function') {
          try { guardDescriptor = tool.describeWrite(call.input || {}, null); } catch { /* unverifiable */ }
        }

        /*
         * WI-1 — A SYS_ID WITH NO PROVENANCE IS NOT A TARGET.
         *
         * The standing debt: a weak model produces a well-formed 32-hex string
         * that no record has ever had (`bfdd8816…`), puts it in an update
         * payload, and the gate renders it a card. Nothing downstream catches
         * it either — the write goes to a sys_id that does not exist, the
         * platform answers, and the read-back verifies whatever it finds.
         *
         * So this is a HARD BLOCK and it happens before the gate: no card, and
         * the payload goes to the log because it is the only remaining record
         * of what was about to be authorised. The message is written to be
         * recoverable — the model can read the record it actually means and
         * try again, which registers the sys_id on the way past.
         */
        if (tool.mutating && guardDescriptor?.sys_id) {
          const target = checkWriteTarget({ sessionId, sysId: guardDescriptor.sys_id, userText });
          if (target.verdict === 'confabulated') {
            const message =
              `BLOCKED: sys_id ${guardDescriptor.sys_id} has never appeared in this session — not in a tool `
              + 'result, not in anything the user typed, and not in the knowledge ledger. It was not submitted to '
              + 'the approval gate and nothing was changed. Do not retype it. Look the record up (query_records or '
              + 'get_record) and use the sys_id that read returns.';
            log.error('gate', `${call.name} HARD BLOCKED — sys_id ${guardDescriptor.sys_id} has no provenance in this session`);
            results.push({ id: call.id, name: call.name, output: message, isError: true });
            recordToolEvent(sessionId, {
              taskId,
              kind: 'guard', name: 'confabulated_sys_id',
              // The full payload, because nothing else keeps it.
              payload: { tool: call.name, table: guardDescriptor.table, sys_id: guardDescriptor.sys_id, input: call.input },
              result: message, resultStatus: 'blocked', mutating: false, approval: null,
            });
            emit({
              type: 'tool_blocked', id: call.id, name: call.name, input: call.input,
              reason: 'confabulated-sys-id', message,
            });
            continue;   // never reaches the gate
          }
        }

        if (tool.mutating && guardDescriptor) {
          const verdict = checkBeforeGate({
            sessionId, turnSeq, tool: call.name, descriptor: guardDescriptor,
            force: call.input?.force === true,
          });
          if (!verdict.allowed) {
            log.warn('gate', `${call.name} BLOCKED before approval — ${verdict.reason}`);
            results.push({ id: call.id, name: call.name, output: verdict.message, isError: true });
            recordToolEvent(sessionId, {
              taskId,
              kind: 'tool_call', name: call.name, payload: call.input, result: verdict.message,
              resultStatus: `blocked:${verdict.reason}`, mutating: true, approval: null,
            });
            emit({
              type: 'tool_blocked', id: call.id, name: call.name, input: call.input,
              reason: verdict.reason, message: verdict.message,
            });
            continue;   // never reaches the gate
          }
          if (verdict.forced) {
            emit({ type: 'guard_forced', id: call.id, name: call.name, drops: verdict.drops });
          }
        }

        /*
         * WI-5 — the trap check at PLAN time.
         *
         * Runs before the gate, blocks nothing, and exists so a person is not
         * asked to authorise a write the ledger already knows the platform will
         * discard. Twice on 2026-08-24 a user approved {"priority":"4"} on an
         * incident and it stored 1 — the read-back caught it afterwards, but the
         * approval had already been spent.
         */
        let planWarning = null;
        if (tool.mutating && guardDescriptor) {
          try { planWarning = planTimeTrapCheck(guardDescriptor); }
          catch (err) { log.debug?.('gate', `plan-time check failed: ${err.message}`); }
          if (planWarning) log.warn('gate', `plan-time trap: ${planWarning.message}`);
        }

        /*
         * WI-3 — the ELEVATION GATE. A write to a security_admin-gated table
         * cannot land un-elevated (WI-1), so it does NOT take the normal REST
         * approval+executeTool path below — it is routed through the shim client:
         * mechanical (table,op) -> classifier -> eligibility -> approval -> shim
         * -> target read-back -> tier. This is the only route to elevation, and
         * the model has no verb that reaches it any other way.
         */
        if (tool.mutating && guardDescriptor && isGatedDescriptor(guardDescriptor)) {
          const gated = await handleGatedElevation({
            tool, call, descriptor: guardDescriptor, sessionId, taskId, turnSeq, state, emit, results,
            autoApprove: Boolean(agent.autoApprove),
            signal,
          });
          if (gated.handled) {
            mutatingCallCount += 1;
            // Phase 0 — cancelled at the elevation gate. Nothing was elevated
            // and nothing was written; the result and the audit row are already
            // pushed, so the turn stops here rather than taking the next call.
            if (gated.cancelled) {
              cancelledDuringCalls = true;
              cancelPhase = 'awaiting-elevation-approval';
              break;
            }
            continue;
          }
        }

        /*
         * WI-IMP-2 — the IMPERSONATION PREFLIGHT, and its position is the fix.
         *
         * Eligibility used to run only inside the tool's `execute`, which is
         * AFTER this gate. Measured front-door against an administrator: the
         * card was shown, the human approved, and only then did the gate refuse
         * `target_holds_admin_role`. So an approval was spent on a decision
         * already destined to refuse — and, on the second attempt with
         * `elevated_approval: true`, the card for "act as an ADMINISTRATOR" was
         * visually identical to one for any ordinary user, because nothing had
         * yet asked who the target was.
         *
         * Running it here fixes both: an ineligible target is refused with NO
         * card, and an eligible one carries the resolved facts — who, whether
         * they hold admin, and whether this is the elevated tier — onto the card
         * as structured data the renderer can make loud.
         *
         * `execute` still re-runs the gate and stays authoritative. This is a
         * preview for the human, never a clearance for the machine (A3).
         */
        let impersonationApproval = null;
        if (tool.mutating && IMPERSONATION_GATED_TOOLS.has(call.name)) {
          let pre;
          try {
            pre = await previewImpersonation({
              user: call.input?.user, task: call.input?.task,
              elevatedApproval: call.input?.elevated_approval === true,
            });
          } catch (err) {
            // FAIL-CLOSED. An eligibility read that errors is not an eligible target.
            pre = { ok: false, refusal: { status: 'refused', reason: 'eligibility_read_failed', message: `Impersonation eligibility could not be verified (${err.message}), so nothing was started (fail-closed).` } };
          }
          if (!pre.ok) {
            const msg = `Refused before approval: ${pre.refusal.message}${pre.refusal.next ? ` ${pre.refusal.next}` : ''}`;
            log.warn('gate', `${call.name} refused before approval — ${pre.refusal.reason}`);
            results.push({ id: call.id, name: call.name, output: msg, isError: true });
            recordToolEvent(sessionId, {
              taskId,
              kind: 'tool_call', name: call.name, payload: call.input, result: msg,
              resultStatus: `imp_refused:${pre.refusal.reason}`, mutating: true, approval: null,
            });
            emit({
              type: 'tool_blocked', id: call.id, name: call.name, input: call.input,
              reason: `impersonation_${pre.refusal.reason}`, message: msg,
              impersonationApproval: { refused: true, reason: pre.refusal.reason, candidates: pre.refusal.candidates ?? null },
            });
            continue;   // no card, nothing started
          }
          impersonationApproval = pre.preview;
        }

        // Permission gate — the heart of the platform's safety model.
        let approval = null;
        // WI-4 — the two facts the audit trail could not previously state.
        let approvedSource = null;
        let approvedAt = null;
        if (tool.mutating && !agent.autoApprove) {
          const approvalId = crypto.randomUUID();
          // WI-3 — minted here, sent once with the card, required back. 32 bytes
          // from the CSPRNG: an approval token that can be guessed is the same
          // hole as no token, worn differently.
          const nonce = crypto.randomBytes(32).toString('base64url');
          // SESSION 1 / WI-2 — the pending entry exists before the card does.
          // See the elevation gate above for the measured defect.
          const decisionPending = awaitApproval(state, approvalId, nonce, signal);
          emit({
            type: 'approval_required', approvalId, nonce, name: call.name, input: call.input,
            warning: planWarning?.message || null,
            /*
             * B6/B7 — whose authority this card carries, bound to what will
             * ACTUALLY happen rather than to whether mode is switched on.
             *
             * `willExecuteImpersonated` is true only for a tool that routes its
             * write through the impersonation wrapper (B7). Everything else
             * still writes over REST as the service account while mode is on,
             * and the chip says so in different words and a different colour.
             * An approval card is the one place a false claim about identity
             * gets acted on by a human.
             */
            impersonation: impersonationChip(sessionId, {
              executesImpersonated: willExecuteImpersonated(sessionId, tool),
            }),
            /*
             * WI-IMP-2 — WHO this card hands authority to.
             *
             * `impersonation` above is the chip for the CURRENT mode, and it is
             * null on a first start, because mode is not active yet. That is
             * precisely the card where the question "whose authority?" is being
             * decided, so it needs its own payload. Carries the resolved target,
             * whether they hold admin, and whether this is the elevated tier —
             * so the renderer can make an administrator target impossible to
             * approve inattentively, which is the whole point of the flag.
             */
            impersonationApproval,
          });
          log.warn('gate', `approval required: ${call.name}${impersonationApproval?.elevated ? ' — ELEVATED (admin target)' : ''} — waiting for the user`);
          const decision = await decisionPending;
          /*
           * Phase 0 — SAFE POINT 6: cancelled while the card was waiting.
           *
           * Handled BEFORE the approved/rejected split, and that ordering is
           * the whole point. `approval` stays null, so `executeTool` would
           * refuse this call even if something later tried to run it; no
           * `recordRejection` is written, because nobody rejected anything and
           * a fabricated refusal would block a resubmission the user never
           * declined; and the card is reported as cancelled rather than
           * decided, so the transcript does not show a verdict no one gave.
           */
          if (decision.source === 'cancelled') {
            const output = 'The turn was cancelled while this operation was waiting for approval. '
              + 'It was never authorised and never executed.';
            log.warn('gate', `${call.name} CANCELLED at the gate — never authorised, never executed`);
            results.push({ id: call.id, name: call.name, output, isError: true });
            recordToolEvent(sessionId, {
              taskId,
              kind: 'tool_call', name: call.name, payload: call.input, result: output,
              resultStatus: 'cancelled', mutating: true, approval: null,
            });
            emit({ type: 'approval_cancelled', approvalId, name: call.name, at: decision.at });
            emit({ type: 'tool_result', id: call.id, name: call.name, output, isError: true });
            cancelledDuringCalls = true;
            cancelPhase = 'awaiting-approval';
            break;
          }
          approval = decision.approved ? 'approved' : 'rejected';
          approvedSource = decision.source;
          approvedAt = decision.at;
          log.info('gate', `${call.name} ${decision.approved ? 'APPROVED' : 'REJECTED'} — source ${decision.source}`);
          emit({
            type: 'approval_resolved', approvalId, approved: decision.approved,
            source: decision.source, at: decision.at,
          });
          if (!decision.approved) {
            const output = decision.source === 'timeout'
              ? 'This operation was never answered and the approval expired. Do not retry it; ask the user what they want.'
              : 'The user rejected this operation. Do not retry it; ask what they would like to change.';
            // Remembered for THIS turn, so a resubmission is blocked rather
            // than merely discouraged. Turn-scoped on purpose: a user who asks
            // again next turn means it.
            if (guardDescriptor) {
              recordRejection({
                sessionId, turnSeq, tool: call.name,
                table: guardDescriptor.table, sys_id: guardDescriptor.sys_id, requested: guardDescriptor.requested,
              });
            }
            results.push({ id: call.id, name: call.name, output, isError: true });
            recordToolEvent(sessionId, {
              taskId,
              kind: 'tool_call', name: call.name, payload: call.input, result: output,
              resultStatus: 'rejected', mutating: true, approval,
              approvedSource, approvedAt,
            });
            emit({ type: 'tool_result', id: call.id, name: call.name, output, isError: true });
            continue;
          }
        } else if (tool.mutating) {
          approval = 'auto';
          approvedSource = APPROVAL_SOURCES.AUTO_APPROVE;
          approvedAt = new Date().toISOString();
          log.warn('gate', `${call.name} ran UNGATED — auto-approve is on, nobody saw it`);
        }
        // Now, and only now: approved (or explicitly ungated) and about to run.
        if (tool.mutating) {
          emit({ type: 'tool_use', id: call.id, name: call.name, input: call.input, mutating: true, approval });
        }
        if (tool.mutating) mutatingCallCount += 1;

        const callCaptureMark = tool.mutating ? captureMark() : null;

        /*
         * WI-1 — what is this tool about to write, and what did the record hold
         * before it?
         *
         * `describeWrite` is called twice: once here with no result, to learn
         * the table and sys_id so the pre-write snapshot can be taken, and
         * again after execution to pick up the sys_id of anything created. A
         * tool without the hook skips both and is reported as self-verifying.
         */
        const beforeRecord = await snapshotBefore(guardDescriptor);

        /*
         * Phase 0 — THE UNINTERRUPTIBLE SPAN STARTS HERE.
         *
         * From this line until the `finally` below, the call is executing and
         * its consequences are being recorded: the write itself, the read-back
         * verification, the tool event, the mutation ledger row, the
         * impersonation provenance and the transport sweep. The signal is
         * deliberately not consulted anywhere inside it. A cancellation that
         * arrives now is remembered by the abort listener and acted on at the
         * next boundary, which is what keeps the ledger internally consistent:
         * every executed mutation has its verification and its capture.
         */
        activeTool = call.name;

        try {
          const raw = await executeTool(tool, call.input || {}, approval, {
            source: approvedSource, autoApprove: Boolean(agent.autoApprove),
          }, { sessionId, turnSeq, userText });

          // The write landed on the instance. Whether it landed as REQUESTED is
          // a different question, and until this the answer was never asked.
          let verification = null;
          if (tool.mutating) {
            try {
              const descriptor = typeof tool.describeWrite === 'function'
                ? tool.describeWrite(call.input || {}, raw)
                : null;
              verification = await verifyMutation({ descriptor, result: raw, before: beforeRecord, toolName: call.name });
            } catch (err) {
              log.error('verify', `verification threw after ${call.name}: ${err.message}`, err);
              verification = {
                verified: false, status: 'unverified',
                summary: `the write could not be verified: ${err.message}`,
                applied: [], dropped: [], transformed: [],
                unverifiable: [{ field: '(all)', reason: err.message }], noOpSignal: null,
              };
            }
          }

          // A dropped field is not an exception — the call reached the instance
          // — but it must not read as plain success, or the model narrates a
          // write that did not happen. That is the defect, exactly.
          const failedWrite = isFailedWrite(verification);
          let output = attachVerification(truncate(JSON.stringify(raw ?? null, null, 1)), verification);
          // WI-5 — the fact reaches the model's NEXT context, so a re-plan is
          // informed rather than another guess at the same field.
          if (planWarning) output += `
${JSON.stringify(planWarning.note, null, 1)}`;
          results.push({ id: call.id, name: call.name, output, isError: failedWrite });
          // The result is the audit trail's payload, not a nicety: the sys_id
          // of whatever was just created exists here and nowhere else.
          recordToolEvent(sessionId, {
            taskId,
            kind: 'tool_call', name: call.name, payload: call.input, result: output,
            resultStatus: verification && verification.status !== 'applied' && verification.status !== 'self-verified'
              ? verification.status
              : 'ok',
            mutating: tool.mutating, approval, approvedSource, approvedAt,
          });
          // WI-2 — the ledger. Written here, on the executed path only, so it
          // records what HAPPENED rather than what was attempted. Compaction
          // cannot reach this table, so the closing report can be rendered from
          // it even if the turn folds three times before it gets there.
          if (tool.mutating && guardDescriptor && verification?.dropped?.length) {
            // Proven, not suspected: this exact tuple returned success and did
            // not land. The next identical attempt never reaches the gate.
            recordDrops({
              sessionId, turnSeq, table: guardDescriptor.table, sys_id: guardDescriptor.sys_id,
              operation: guardDescriptor.operation, verification,
            });
          }
          if (tool.mutating) {
            const writeDescriptor = typeof tool.describeWrite === 'function' ? tool.describeWrite(call.input || {}, raw) : null;
            appendMutation({
              sessionId, turnSeq, tool: call.name,
              descriptor: writeDescriptor,
              result: raw, verification, approval, approvedSource, approvedAt,
            });
            /*
             * B5 — impersonation provenance.
             *
             * The mutation ledger above records WHAT was written. While
             * impersonating it cannot record WHO: the instance stamps the
             * target's name on the record and keeps no account of the real
             * initiator anywhere (Phase 0 D-3/D-4/D-5). This row is that
             * account, and nothing else is.
             *
             * A no-op when mode is off. Never throws — but a failure to record
             * provenance is surfaced rather than swallowed, because a change
             * that happened with no attributable cause is precisely the state
             * this table exists to make impossible.
             */
            /*
             * B7 — a tool that routed through the impersonation wrapper has
             * ALREADY recorded its own provenance, write-ahead: intent before
             * dispatch, confirmed after read-back. Appending here as well would
             * produce a second row for one change, and the post-hoc row would
             * be the weaker of the two.
             */
            const routedItself = willExecuteImpersonated(sessionId, tool);
            const provenance = routedItself
              ? { recorded: true, reason: 'recorded write-ahead by the impersonated write path' }
              : appendImpersonatedMutation({
                sessionId, turnSeq, tool: call.name, descriptor: writeDescriptor, result: raw, verification,
              /*
               * FALSE, and stated rather than defaulted.
               *
               * No mutating tool routes its write through the impersonation
               * wrapper yet — `runImpersonated` has no callers outside its own
               * module. Every mutating tool writes over REST as the
               * NowHelpAssist service account, so while mode is active the
               * instance still attributes the change to that account, correctly,
               * and there is NO attribution gap.
               *
               * Passing true here would fabricate one: the row would claim the
               * record is stamped with the target's name when it is not, and
               * `whoReallyDid` would report an audit finding someone could act
               * on. When a tool does execute through the wrapper, it must pass
               * true from the path that actually impersonated — never from mode
               * being switched on.
               */
                executedImpersonated: false,
              });
            if (provenance.recorded === false && provenance.reason !== 'not-impersonating') {
              log.error('impersonation', `PROVENANCE NOT RECORDED for ${call.name}: ${provenance.reason}`);
              emit({ type: 'impersonation_provenance_failed', tool: call.name, reason: provenance.reason });
            }
          }

          // A-4 write path: a verification that FAILED is the most valuable
          // thing this agent ever learns about an instance, and it used to be
          // thrown away with the session.
          recordVerificationFailure(call.name, raw);
          if (failedWrite) {
            log.warn('tool', `${call.name} ${verification.status.toUpperCase()}  ${ms(toolStart)} — ${verification.summary}`);
          } else {
            log.info('tool', `${call.name} ok  ${ms(toolStart)}  ${output.length}ch`);
          }
          // The renderer derives its glyph from `verification`, never from the
          // absence of an exception (WI-6).
          emit({
            type: 'tool_result', id: call.id, name: call.name, output, isError: failedWrite,
            impersonation: impersonationChip(sessionId, {
              executesImpersonated: willExecuteImpersonated(sessionId, tool),
            }),
            verification: verification && {
              status: verification.status, summary: verification.summary,
              dropped: verification.dropped, transformed: verification.transformed,
              unverifiable: verification.unverifiable, verifiedBy: verification.verifiedBy || null,
            },
          });

          // Transport capture. AFTER the result is emitted, because the change
          // has already landed and the user should see it succeed whether or
          // not it could be captured. Never throws — see agent/capture.js.
          if (tool.mutating) {
            const captured = await captureAfterTool({
              sessionId, sessionTitle, toolName: call.name,
              input: call.input || {}, result: raw, since: callCaptureMark,
            });
            if (captured) {
              annotateLatestCapture(sessionId, turnSeq, captured);
              // The pipeline already knew "incident does not extend
              // sys_metadata" and the prose never said it, so the user came
              // away believing an incident was created inside an update set.
              // Put it where the model actually reads (results was pushed
              // above; this object is serialised after the loop).
              const pushed = results.find((r) => r.id === call.id);
              const note = dataVsConfigNote(captured, guardDescriptor?.table);
              if (pushed) {
                pushed.output += `
${JSON.stringify({ capture: note || { captured: captured.captured, message: captured.message } }, null, 1)}`;
              }
              emit({ ...captured, id: call.id });
            }
          }
        } catch (err) {
          /*
           * WI-7 — a business-rule abort is a decision point, not a dead end.
           *
           * The transcript's agent adapted by dropping the blocked fields from
           * every later write, forever, without telling anyone — and reported a
           * rule sys_id that exists on no table. The rule is LOOKED UP here so
           * the model relays real rows or says it found none.
           */
          let playbook = null;
          try { playbook = await businessRuleAbortPlaybook({ detail: err.detail, table: guardDescriptor?.table }); }
          catch (e) { log.debug?.('playbook', `abort playbook failed: ${e.message}`); }

          const output = `Error: ${err.message}${err.detail ? ` — ${JSON.stringify(err.detail).slice(0, 300)}` : ''}`
            + (playbook ? `
${JSON.stringify({ businessRuleAbort: playbook }, null, 1)}` : '');
          log.error('tool', `${call.name} failed  ${ms(toolStart)} — ${err.message}`, err.detail || err);
          results.push({ id: call.id, name: call.name, output, isError: true });
          recordToolEvent(sessionId, {
            taskId,
            kind: 'tool_call', name: call.name, payload: call.input, result: output,
            resultStatus: 'error', mutating: tool.mutating, approval, approvedSource, approvedAt,
          });
          emit({ type: 'tool_result', id: call.id, name: call.name, output, isError: true });
        } finally {
          // Phase 0 — the uninterruptible span ends. Whatever happened, this
          // call is no longer in flight, so a cancellation arriving after it is
          // recorded as a boundary stop rather than as an interrupted tool.
          activeTool = null;
        }
      }
      // Only when something ran: an empty `tool` row is a slot the model has to
      // account for and a shape the wire format has no use for.
      if (results.length) appendMessage(sessionId, { role: 'tool', results });

      /*
       * Phase 0 — the tool loop stopped early because the turn was cancelled.
       *
       * Every call that RAN has a result, and the row above pairs them. The
       * calls that did NOT run must come out of the stored assistant row for
       * the same reason as safe point 4: an unanswered `tool_call` is the shape
       * the wire format rejects, and leaving one behind would break the next
       * request in this session rather than this one.
       *
       * Membership is decided by what is in `results`, not by counting, so it
       * stays correct however a call left the loop — executed, blocked,
       * refused, rejected or cancelled at the gate.
       */
      if (cancelledDuringCalls) {
        const ranIds = new Set(results.map((r) => r.id));
        const unrun = callsToRun.filter((c) => !ranIds.has(c.id));
        if (unrun.length) {
          rewriteMessage(sessionId, assistantSeq, {
            role: 'assistant', text: assistantText, toolCalls: callsToRun.filter((c) => ranIds.has(c.id)),
          });
          const discarded = unrun.map((c) => c.name);
          log.warn('gate', `discarded ${discarded.length} tool call(s) unrun — the turn was cancelled mid-sequence`);
          try {
            recordToolEvent(sessionId, {
              taskId,
              kind: 'guard', name: 'cancelled_before_tools',
              payload: { discarded, calls: unrun, iteration: i, ran: results.length },
              result: `The turn was cancelled after ${results.length} call(s); the rest were never started.`,
              resultStatus: 'cancelled', mutating: false, approval: null,
            });
          } catch (err) { log.warn('agent', `could not record the discarded calls: ${err.message}`); }
          emit({ type: 'calls_discarded', reason: 'cancelled', discarded });
        }
        await finishCancelled({ phase: cancelPhase || 'between-tool-calls', iteration: i });
        return;
      }

      if (endTurnAfterCalls) {
        // WI-3 — the question was already emitted as assistant_text. Nothing is
        // fed back and the provider is not called again: the next thing that
        // speaks is the user.
        if (mutatingCallCount > 0) {
          const reconciled = await reconcileTurn({ sessionId, sessionTitle, since: turnCaptureMark });
          if (reconciled) emit(reconciled);
        }
        emitMutationReport({ sessionId, turnSeq, emit });
        log.info('agent', `turn ends awaiting the user  session=${shortId(sessionId)}  ${ms(turnStart)}`);
        emit({ type: 'done' });
        return;
      }
      // WI-2 — the other legal reason to speak to the provider again: results
      // it has not seen.
      continuations.push(CONTINUATION_REASONS.TOOL_RESULTS);
    }
    const stopped = '(Stopped: maximum agent iterations reached for this turn.)';
    appendMessage(sessionId, { role: 'assistant', text: stopped });
    emit({ type: 'assistant_text', text: stopped });
    // A turn that ran out of iterations still changed the instance, and its
    // changes still have to be captured.
    if (mutatingCallCount > 0) {
      const reconciled = await reconcileTurn({ sessionId, sessionTitle, since: turnCaptureMark });
      if (reconciled) emit(reconciled);
    }
    // A turn that ran out of iterations still changed the instance, and its
    // changes still have to be reported.
    emitMutationReport({ sessionId, turnSeq, emit });
    emit({ type: 'done' });
  } catch (err) {
    log.error('agent', `turn failed  session=${shortId(sessionId)}  ${ms(turnStart)} — ${err.message}`, err);
    // `retryable` means the history is intact and re-issuing the turn against
    // it is safe. The UI turns that into a Retry button; without the flag it
    // shows the error alone, because retrying a malformed request or a
    // rejected mutation just fails again more slowly.
    // The turn failed AFTER writing to the instance in some cases. A report
    // that only renders on the happy path would hide exactly those.
    try { emitMutationReport({ sessionId, turnSeq, emit }); } catch { /* already failing */ }
    emit({ type: 'error', message: err.message, retryable: Boolean(err.retryable) });
  } finally {
    // ALWAYS — a window left open by a crashed turn would make every later
    // session's rows look contested, and the guard would stop capturing
    // anything at all.
    closeCaptureWindow(sessionId);
    if (state.emit === emit) { state.emit = null; state.taskId = null; }
    // Phase 0 — the listener dies with the turn it belongs to. A signal can
    // outlive one execution (a caller could hold it), and a listener left
    // attached would keep this turn's closure — and its whole history — alive
    // for as long as the controller existed.
    signal?.removeEventListener('abort', onAbort);
  }
}
