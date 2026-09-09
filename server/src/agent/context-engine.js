import { log } from '../logging.js';
import { estimateTextTokens } from '../memory/tokens.js';
import { listFacts } from '../memory/facts.js';
import { ALL_RULE_IDS } from './prompts.js';
import {
  classifyRequest, selectTools, selectRuleIds, selectFactKeys, retrievalQuery,
} from './context-selection.js';
import { expandCapabilities, isCapability } from './context-capabilities.js';

/**
 * PHASE 2 — THE CONTEXT ENGINE.
 *
 * WHAT IT IS. An assembly layer. It decides what the model is SHOWN — which
 * tools, which operating rules, which measured facts, which retrieval query —
 * and it decides nothing else. It has no opinion about whether a mutation is
 * allowed, whether an approval is valid, whether an elevation may proceed or
 * whether a write succeeded. Those questions belong to the orchestrator's
 * gates, the write guard, the elevation shim and the read-back verifier, all of
 * which sit BELOW this and none of which this imports.
 *
 * THE PROPERTY THAT MATTERS MOST. A narrower tool list is not a narrower
 * permission. If `create_sla` is not in a profile, that means "the model was
 * not shown create_sla on this invocation" and it means nothing else: the
 * approval gate, the provenance requirement and the mutation ledger are
 * unchanged and still authoritative for every tool that DOES run. Context
 * selection can make the model less likely to try something; it can never make
 * something permitted that was not, and it can never make something forbidden
 * that was. `test/context-engine.test.js` asserts that directly.
 *
 * WHY IT EXISTS. Measured on the live registry and the live prompt, the fixed
 * per-invocation cost was 31,759 tokens against a 60,000-token self-imposed
 * ceiling — 20,856 of it tool schemas, 6,079 the fact ledger, 4,263 the
 * operating rules. Better than half the envelope was spent before a word of
 * conversation, on a surface that is mostly irrelevant to any given request: an
 * incident lookup was carrying the ACL authoring rules, the catalog UI-policy
 * traps and 36 DBA tool schemas.
 *
 * FAILURE DIRECTION. Every default here is "include". An unclassified tool,
 * rule or fact is sent. An unrecognised request is sent everything, loudly. The
 * engine is allowed to make the prompt smaller only where a human has said in
 * advance that it may.
 */

/** The profile a caller gets when nothing could be recognised. */
function fullProfile({ goal, reason, totals }) {
  return Object.freeze({
    capabilities: null,          // null means "no selection was made"
    matched: [],
    confident: false,
    fallback: true,
    fallbackReason: reason,
    tools: totals.tools,
    ruleIds: null,               // null => renderRules sends every rule
    factKeys: null,              // null => factBlock sends the whole ledger
    query: String(goal || '').trim().slice(0, 400),
  });
}

/**
 * Build the context profile for one turn.
 *
 * @param {object}   opts
 * @param {string}   opts.goal      the user's request, verbatim
 * @param {object[]} opts.tools     the LIVE registry
 * @param {string|string[]|null} opts.capability
 *        An explicitly known capability, when one exists. This is the seam a
 *        planner plugs into in a later phase — the step's own capability,
 *        passed down instead of being recognised from prose. Nothing sets it
 *        today, so it is null on every call and the classifier decides.
 *
 * TOTAL BY CONSTRUCTION. Every path returns a usable profile, and a thrown
 * error inside selection falls back to the full surface rather than failing the
 * turn. A turn that dies because the context engine had a bad day would be
 * strictly worse than one that runs with a larger prompt — the same rule
 * `retrieveForTurn` and the plan-time trap check already follow.
 */
export function buildContextProfile({ goal, tools, capability = null, priorCapabilities = null } = {}) {
  const all = Array.isArray(tools) ? tools : [];
  const totals = { tools: all };

  try {
    /*
     * SESSION 1 / WI-7 — THE PREVIOUS TURN IS A FLOOR, NOT A MEMORY.
     *
     * MEASURED 2026-09-08: turn one "When an incident is created, run a
     * subflow…" was classified flow_authoring + incident; turn two, "use the
     * Incident table", was classified incident / record_* only, so
     * `create_flow_live` was scoped out, the model asked for it, and an
     * iteration was spent widening. The classifier reads one sentence; the
     * conversation does not.
     *
     * So the caller may hand in the previous turn's capabilities. They are
     * ADDED to whatever this turn classifies as (never substituted), and a
     * turn with no domain noun at all inherits them instead of falling back to
     * the whole registry. Only one turn deep — the caller passes the last
     * profile's capabilities, not an accumulation — so the union is bounded
     * by two classifications and the budget assertion holds. Unknown names
     * are dropped, not widened; widening still happens the one way it always
     * did (`widenProfile`, on a tool the model asked for).
     */
    const prior = Array.isArray(priorCapabilities) ? priorCapabilities.filter(isCapability) : [];
    const verdict = classifyRequest(goal, { explicitCapability: capability });
    if (!verdict.confident && !prior.length) {
      return fullProfile({ goal, reason: verdict.reason, totals });
    }

    const own = verdict.confident ? verdict.capabilities : [];
    const carried = prior.filter((c) => !own.includes(c));
    const caps = expandCapabilities([...new Set([...own, ...prior])]);
    const matched = [
      ...(verdict.confident ? verdict.matched : []),
      ...carried.map((c) => ({ capability: c, term: '(prior turn)' })),
    ];
    const selectedTools = selectTools(all, caps);

    /*
     * A selection that kept nothing, or kept everything, is not a selection.
     *
     * The first would be a broken map and would hand the model no tools at all;
     * the second means the filter did no work and the honest report is that
     * this turn was not narrowed. Both fall back rather than pretending.
     */
    if (!selectedTools.length) {
      log.error('context', `capability selection produced ZERO tools for [${caps.join(', ')}] — falling back to the full registry`);
      return fullProfile({ goal, reason: 'empty_selection', totals });
    }

    const factKeys = selectFactKeys(listFacts().map((f) => f.key), caps);

    return Object.freeze({
      capabilities: caps,
      matched,
      confident: true,
      fallback: false,
      fallbackReason: null,
      floor: carried.length ? carried : null,
      tools: selectedTools,
      ruleIds: selectRuleIds(ALL_RULE_IDS, caps),
      factKeys,
      query: retrievalQuery(goal, caps),
    });
  } catch (err) {
    // Never fail a turn over context assembly.
    log.error('context', `context selection failed, falling back to the full surface: ${err.message}`, err);
    return fullProfile({ goal, reason: `error: ${err.message}`, totals });
  }
}

/**
 * Widen a profile to the full surface, keeping why.
 *
 * Used when the model asks for a tool the profile did not expose. Monotonic and
 * one-shot: it goes straight to everything rather than adding the one missing
 * capability, because a partial widening would need a second guess about what
 * else that turn is going to need, and the whole point of this layer is that it
 * does not guess. One wasted iteration is the cost, and the alternative is a
 * turn that cannot finish.
 */
export function widenProfile(profile, { tools, reason }) {
  log.warn('context', `widening the context to the full registry — ${reason}`);
  return fullProfile({ goal: profile?.query ?? '', reason, totals: { tools } });
}

/**
 * The diagnostic record for one context build.
 *
 * Deliberately NOT the profile itself: this is what goes into the event stream
 * and the log, so it carries counts and names rather than schemas and rule
 * text. Nothing here can contain a credential — the inputs are tool names,
 * rule ids, fact keys and capability names, none of which are secrets, and the
 * user's goal is deliberately absent (it is already in the transcript, and
 * copying it into telemetry would duplicate whatever the user typed).
 */
export function contextDiagnostics(profile, { allTools, systemPrompt = null } = {}) {
  const total = allTools?.length ?? 0;
  const selected = profile.tools.length;
  const schemaTokens = estimateTextTokens(JSON.stringify(
    profile.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  ));
  return {
    type: 'context_profile',
    capabilities: profile.capabilities,
    matched: profile.matched.map((m) => `${m.capability}:${m.term}`),
    fallback: profile.fallback,
    fallbackReason: profile.fallbackReason,
    selectedToolCount: selected,
    totalToolCount: total,
    excludedToolCount: Math.max(0, total - selected),
    selectedToolNames: profile.tools.map((t) => t.name),
    ruleCount: profile.ruleIds ? profile.ruleIds.length : ALL_RULE_IDS.length,
    totalRuleCount: ALL_RULE_IDS.length,
    factCount: profile.factKeys ? profile.factKeys.length : null,
    toolSchemaTokens: schemaTokens,
    systemPromptTokens: systemPrompt === null ? null : estimateTextTokens(systemPrompt),
  };
}

/** One line, so a turn's selection is visible in the terminal without a query. */
export function logProfile(diag) {
  if (diag.fallback) {
    log.info('context',
      `context: FALLBACK (${diag.fallbackReason}) — all ${diag.totalToolCount} tools, `
      + `all ${diag.totalRuleCount} rules, whole ledger (~${diag.toolSchemaTokens} schema tokens)`);
    return;
  }
  log.info('context',
    `context: [${diag.capabilities.filter((c) => c !== 'core').join(', ')}] — `
    + `${diag.selectedToolCount}/${diag.totalToolCount} tools, `
    + `${diag.ruleCount}/${diag.totalRuleCount} rules, `
    + `${diag.factCount} facts (~${diag.toolSchemaTokens} schema tokens)`);
}
