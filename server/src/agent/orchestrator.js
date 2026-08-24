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
import { checkBeforeGate, recordDrops, recordRejection } from './write-guard.js';
import { businessRuleAbortPlaybook, dataVsConfigNote } from './playbooks.js';

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

const live = new Map(); // sessionId -> { pending: Map<approvalId, resolver> }

function liveState(id) {
  if (!live.has(id)) live.set(id, { pending: new Map() });
  return live.get(id);
}

/** Kept for API compatibility; the durable half now comes from SQLite. */
export function getSession(id) {
  if (!loadSessionRow(id)) createSession({ id });
  return { history: loadHistory(id), pending: liveState(id).pending };
}

export function resolveApproval(sessionId, approvalId, approved) {
  const resolver = live.get(sessionId)?.pending.get(approvalId);
  if (!resolver) return false;
  live.get(sessionId).pending.delete(approvalId);
  resolver(Boolean(approved));
  return true;
}

const MAX_ITERATIONS = 15;

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
function emitMutationReport({ sessionId, turnSeq, emit }) {
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

export async function executeTool(tool, input, approval) {
  if (tool.mutating && !APPROVAL_RESOLVED.has(approval)) {
    throw Object.assign(
      new Error(
        `Refusing to execute the mutating tool "${tool.name}" with approval="${approval ?? 'none'}". `
        + 'A mutation may only run after the gate resolves to approved, or under explicit auto-approve.',
      ),
      { status: 500, detail: { tool: tool.name, approval: approval ?? null, reason: 'unapproved-mutation' } },
    );
  }
  return tool.execute(input || {});
}

function awaitApproval(state, approvalId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(approvalId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    state.pending.set(approvalId, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
  });
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
const ASKS_THE_USER = new RegExp([
  String.raw`\bwould you like me to\b`,
  String.raw`\bshall I\b`,
  String.raw`\bdo you want me to\b`,
  String.raw`\bshould I\b`,
  String.raw`\bwhich (?:one|of these)\b`,
  // The VERB, aimed at the reader - so "a confirmation email" does not hold
  // a write, while "please confirm the group" does.
  String.raw`\bplease confirm\b`,
  String.raw`\bcan you confirm\b`,
  String.raw`\bconfirm (?:that|whether|if|the|which)\b`,
  String.raw`\blet me know (?:if|which|whether|what)\b`,
].join('|'), 'i');

export function detectQuestionWithMutation({ assistantText, toolCalls = [], isMutating = () => false, enabled = true }) {
  if (!enabled) return null;
  const text = String(assistantText || '');
  if (!text.trim()) return null;
  if (!ASKS_THE_USER.test(text)) return null;
  const held = (toolCalls || []).filter((c) => isMutating(c.name)).map((c) => c.name);
  if (!held.length) return null;
  return { asked: text.match(ASKS_THE_USER)[0], held };
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
  const asked = text.match(ASKS_TO_PROCEED)[0];
  return { asked };
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
 *
 * `retry` re-issues a turn whose previous attempt died before writing anything
 * — an empty completion, or the upstream falling over. The user's message is
 * already the last row in history, so appending it again would duplicate it and
 * quietly change the conversation the model sees. Everything else is identical:
 * same history, same tools, same gate.
 */
export async function runTurn(sessionId, userText, emit, { retry = false } = {}) {
  const state = liveState(sessionId);
  const { agent } = getSettings();

  if (!loadSessionRow(sessionId)) createSession({ id: sessionId });

  let stallNudged = false;
  let compactedThisTurn = false;
  let mutatingCallCount = 0;
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

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
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
      const provisionalSystem = buildSystemPrompt({
        sessionId,
        digestNote: buildDigestNote(sessionId),
        mutationDigest: ledgerDigestForModel(ledgerSoFar),
        iterationNotice,
      });
      const budgets = await computeBudget({ system: provisionalSystem, tools: TOOLS, maxTokens: MAX_OUTPUT_TOKENS });
      if (i === 0) {
        // The three numbers, at meta time, every turn. Previously the budget
        // was a constant nobody could see was wrong.
        log.info('llm',
          `budget: model context ${budgets.modelCtx} (${budgets.modelCtxSource}), capped at ${budgets.ceiling}, ` +
          `fixed overhead ${budgets.fixed} (system + ${TOOLS.length} tool schemas), output headroom ${budgets.headroom} ` +
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
      const system = buildSystemPrompt({
        sessionId,
        digestNote: buildDigestNote(sessionId),
        mutationDigest: ledgerDigestForModel(ledgerSoFar),
        iterationNotice,
      });
      const requestTokens = budgets.fixed + estimateTokens(history);
      log.debug('llm', `request ~${requestTokens} tokens (fixed ${budgets.fixed}, history budget ${budgets.budget})`);
      if (requestTokens > budgets.ceiling) {
        log.warn('llm', `request ~${requestTokens} tokens is over the ${budgets.ceiling}-token self-imposed cap ` +
          `(model window is ${budgets.modelCtx}); sending anyway — compaction could not fold enough to help.`);
      }
      const callStart = Date.now();
      let res;
      try {
        res = await chatTurn({
          system,
          history,
          tools: TOOLS,
          maxTokens: MAX_OUTPUT_TOKENS,
          // F9 — asked for, never assumed. Both adapters pass this through;
          // whether the backend honours it is a separate question with a
          // measured answer in agent/decoding.js.
          decoding: { temperature: AGENT_TEMPERATURE },
        });
      } catch (err) {
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
        indexMessage(sessionId, assistantSeq, 'assistant', assistantText);
        emit({ type: 'assistant_text', text: assistantText });
      }

      if (!res.toolCalls?.length) {
        // A6. One nudge per turn, carrying the one fact the model is missing.
        const stalled = !stallNudged && detectStalledTurn({
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
            `read-only tool to get it instead of asking.`;
          appendMessage(sessionId, { role: 'user', text: note });
          emit({ type: 'nudged', reason: 'stalled', asked: stalled.asked.trim() });
          recordToolEvent(sessionId, {
            kind: 'guard', name: 'a6_stalled_turn', payload: { asked: stalled.asked.trim() },
            resultStatus: 'nudged', mutating: false, approval: null,
          });
          continue;
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
       * WI-8 — hold mutations that arrived alongside a question.
       *
       * The question is surfaced and the turn ends; nothing is written. The
       * user answers, and the next turn acts on the answer instead of on an
       * assumption the model made while asking.
       */
      const asking = detectQuestionWithMutation({
        assistantText,
        toolCalls: res.toolCalls,
        isMutating: (n) => Boolean(toolMap.get(n)?.mutating),
        enabled: agent.holdMutationsOnQuestion !== false,
      });
      if (asking) {
        log.warn('gate', `held ${asking.held.length} mutation(s) — the same completion asked the user a question`);
        recordToolEvent(sessionId, {
          kind: 'guard', name: 'wi8_question_with_mutation',
          payload: { asked: asking.asked, held: asking.held },
          resultStatus: 'held', mutating: false, approval: null,
        });
        emit({ type: 'mutations_held', asked: asking.asked, held: asking.held });
        emitMutationReport({ sessionId, turnSeq, emit });
        emit({ type: 'done' });
        return;
      }

      const results = [];
      for (const call of res.toolCalls) {
        const tool = toolMap.get(call.name);
        if (!tool) {
          results.push({ id: call.id, name: call.name, output: `Unknown tool: ${call.name}`, isError: true });
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
        if (tool.mutating && guardDescriptor) {
          const verdict = checkBeforeGate({
            sessionId, turnSeq, tool: call.name, descriptor: guardDescriptor,
            force: call.input?.force === true,
          });
          if (!verdict.allowed) {
            log.warn('gate', `${call.name} BLOCKED before approval — ${verdict.reason}`);
            results.push({ id: call.id, name: call.name, output: verdict.message, isError: true });
            recordToolEvent(sessionId, {
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

        // Permission gate — the heart of the platform's safety model.
        let approval = null;
        if (tool.mutating && !agent.autoApprove) {
          const approvalId = crypto.randomUUID();
          emit({ type: 'approval_required', approvalId, name: call.name, input: call.input });
          log.warn('gate', `approval required: ${call.name} — waiting for the user`);
          const approved = await awaitApproval(state, approvalId);
          approval = approved ? 'approved' : 'rejected';
          log.info('gate', `${call.name} ${approved ? 'APPROVED' : 'REJECTED'} by the user`);
          emit({ type: 'approval_resolved', approvalId, approved });
          if (!approved) {
            const output = 'The user rejected this operation. Do not retry it; ask what they would like to change.';
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
              kind: 'tool_call', name: call.name, payload: call.input, result: output,
              resultStatus: 'rejected', mutating: true, approval,
            });
            emit({ type: 'tool_result', id: call.id, name: call.name, output, isError: true });
            continue;
          }
        } else if (tool.mutating) {
          approval = 'auto';
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

        try {
          const raw = await executeTool(tool, call.input || {}, approval);

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
          const output = attachVerification(truncate(JSON.stringify(raw ?? null, null, 1)), verification);
          results.push({ id: call.id, name: call.name, output, isError: failedWrite });
          // The result is the audit trail's payload, not a nicety: the sys_id
          // of whatever was just created exists here and nowhere else.
          recordToolEvent(sessionId, {
            kind: 'tool_call', name: call.name, payload: call.input, result: output,
            resultStatus: verification && verification.status !== 'applied' && verification.status !== 'self-verified'
              ? verification.status
              : 'ok',
            mutating: tool.mutating, approval,
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
            appendMutation({
              sessionId, turnSeq, tool: call.name,
              descriptor: typeof tool.describeWrite === 'function' ? tool.describeWrite(call.input || {}, raw) : null,
              result: raw, verification, approval,
            });
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
            kind: 'tool_call', name: call.name, payload: call.input, result: output,
            resultStatus: 'error', mutating: tool.mutating, approval,
          });
          emit({ type: 'tool_result', id: call.id, name: call.name, output, isError: true });
        }
      }
      appendMessage(sessionId, { role: 'tool', results });
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
  }
}
