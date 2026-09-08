import {
  CAPABILITIES, GLOBAL, TOOL_CAPABILITIES, RULE_CAPABILITIES, FACT_CAPABILITIES,
  expandCapabilities, isCapability,
} from './context-capabilities.js';

/**
 * PHASE 2 — RECOGNISING WHAT A REQUEST IS ABOUT, AND SELECTING FOR IT.
 *
 * Pure functions over data. No I/O, no database, no instance, no model. Every
 * function here is total and deterministic: the same inputs produce the same
 * output on every call and in every process, which is what makes a context
 * selection something a test can pin down rather than observe.
 *
 * THE CLASSIFIER RECOGNISES; IT DOES NOT GUESS.
 *
 * That distinction is the safety property of this file. A guess would be a
 * scoring function with a threshold — "this looks 0.6 flow-ish" — and the
 * failure mode of a threshold is that it always returns something, so a request
 * it has never seen still gets a confident narrow answer and a turn that cannot
 * finish. This does the opposite: it looks for explicit, unambiguous evidence
 * of a domain, and when it finds none it says so and the caller falls back to
 * the whole surface.
 *
 * The signals are word-boundary matches on terms that name a ServiceNow
 * artifact class. They are not synonyms or stems of general English: "flow" is
 * a signal, "flowing" is not; "acl" is a signal, "access" alone is not, because
 * "I cannot access the record" is not an access-control request.
 *
 * WHEN IN DOUBT IT WIDENS. Several domains matched means the union of all of
 * them, never a ranking that picks one. A request that says "add an SLA to the
 * incident flow" is genuinely about three things, and the correct answer is
 * three capabilities rather than the strongest one.
 */

/**
 * Domain signals, as anchored regular expressions.
 *
 * Every entry earns its place by naming a ServiceNow noun. The comments record
 * why the narrow ones are narrow — each is a phrase that would otherwise
 * misfire on ordinary English in a ServiceNow conversation.
 */
const SIGNALS = Object.freeze([
  // Flow Designer. `subflow` and `flow designer` are unambiguous; bare "flow"
  // is common enough in ServiceNow prose to be worth taking.
  { capability: 'flow_authoring', re: /\b(flows?|subflows?|flow designer|flow_designer|trigger(?:ed|s)?|sys_hub_flow)\b/i },

  // SLA. Never "service level" alone — "service level agreement" is the phrase;
  // "service" on its own appears in "service catalog" and "ServiceNow".
  { capability: 'sla', re: /\b(slas?|service level agreements?|breach(?:ed|es)?|contract_sla|task_sla)\b/i },

  // Access control. "access control", "acl", role-permission phrasing.
  { capability: 'acl', re: /\b(acls?|access controls?|sys_security_acl|permissions?|who can (?:read|write|create|delete)|security_admin)\b/i },

  // Service catalog.
  { capability: 'catalog', re: /\b(catalog(?:ue)?|catalog items?|order guides?|record producers?|ui polic(?:y|ies)|variable sets?|sc_cat_item|item_option_new)\b/i },

  // Incidents and the task tables.
  { capability: 'incident', re: /\b(incidents?|inc\d{5,}|p1|p2|major incidents?)\b/i },

  // Applications and scopes.
  { capability: 'application', re: /\b(applications?|scoped? app|app scope|sys_scope|sys_app|studio|vendor prefix)\b/i },

  // Update sets and transport.
  { capability: 'update_set', re: /\b(update sets?|sys_update_set|transport|captured? sets?)\b/i },

  // Impersonation.
  { capability: 'impersonation', re: /\b(impersonat\w*|act as|on behalf of)\b/i },

  // Schema AUTHORING — changing the shape of a table. Deliberately verb-led:
  // "column" or "field" alone appear in almost every ServiceNow sentence, so
  // the signal is the CHANGE, not the noun.
  {
    capability: 'schema_authoring',
    re: /\b(?:add|create|new|drop|remove|delete|rename|widen|narrow|modify|change|alter)\s+(?:an?\s+|the\s+)?(?:\w+\s+){0,2}(?:column|field|table)s?\b|\b(?:table|column|field)\s+(?:creation|authoring)\b|\bdba_\w+/i,
  },

  // Schema READING — the dictionary, the hierarchy, what exists.
  { capability: 'schema_read', re: /\b(schemas?|dictionar(?:y|ies)|sys_dictionary|sys_db_object|table structure|field list|what fields|which fields|hierarch(?:y|ies)|extends)\b/i },

  // Impact and dependency questions.
  { capability: 'impact_analysis', re: /\b(impacts?|what breaks|dependenc(?:y|ies)|depends? on|affected by|blast radius|referenced by)\b/i },

  // Generic record work.
  { capability: 'record_mutation', re: /\b(create|insert|update|modify|set|delete|remove)\s+(?:a\s+|the\s+|this\s+)?record\b|\b(create_record|update_record|delete_record)\b/i },
  { capability: 'record_read', re: /\b(query|search|find|list|look ?up|show me|how many)\b/i },

  // Verification.
  { capability: 'verification', re: /\b(verif(?:y|ication|ied)|prove|smoke ?test|assert)\b/i },
]);

/**
 * Classify a request into capabilities, or report that it could not be.
 *
 * @returns {{ capabilities: string[], matched: {capability, term}[], confident: boolean, reason: string }}
 *
 * `confident: false` is a first-class answer and the caller must honour it by
 * widening rather than by picking something. It is returned for an empty
 * request, a very short one, and — most importantly — one where no signal fired
 * at all, which is exactly the case a scoring classifier would paper over.
 */
export function classifyRequest(text, { explicitCapability = null } = {}) {
  /*
   * An explicitly supplied capability WINS and is not second-guessed.
   *
   * This is the seam a later phase plugs a planner into: when a step carries a
   * capability, the classifier is not consulted at all. Today nothing sets it,
   * so it is null on every call and this branch is inert — but the contract is
   * here so that adding a planner is a change at the caller rather than a
   * change to this file.
   */
  if (explicitCapability) {
    const asked = (Array.isArray(explicitCapability) ? explicitCapability : [explicitCapability])
      .filter(isCapability);
    if (asked.length) {
      return {
        capabilities: expandCapabilities(asked),
        matched: asked.map((c) => ({ capability: c, term: '(supplied)' })),
        confident: true,
        reason: 'explicit_capability',
      };
    }
    // A capability that is not in the taxonomy is NOT quietly ignored and NOT
    // approximated to the nearest one. It is an unknown, and unknowns widen.
    return { capabilities: null, matched: [], confident: false, reason: 'unknown_capability' };
  }

  const q = String(text || '').trim();
  if (q.length < 8) {
    return { capabilities: null, matched: [], confident: false, reason: 'request_too_short' };
  }

  const matched = [];
  const found = new Set();
  for (const s of SIGNALS) {
    const m = s.re.exec(q);
    if (!m) continue;
    found.add(s.capability);
    matched.push({ capability: s.capability, term: m[0].toLowerCase() });
  }

  if (!found.size) {
    // The honest answer. No signal fired, so nothing is known about what this
    // request is for, and the caller sends everything.
    return { capabilities: null, matched: [], confident: false, reason: 'no_signal' };
  }

  return {
    capabilities: expandCapabilities([...found]),
    matched,
    confident: true,
    reason: 'classified',
  };
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

/**
 * The tools a set of capabilities exposes.
 *
 * `capabilities === null` means "everything", and that is the fallback path —
 * it returns the registry untouched, so an unrecognised request behaves exactly
 * as it did before Phase 2.
 *
 * A tool with no classification is INCLUDED rather than dropped. The suite
 * asserts the map covers the live registry, so this branch should never fire —
 * but if it ever does, the failure is a slightly larger prompt rather than a
 * tool the model needed and could not see.
 */
export function selectTools(tools, capabilities) {
  if (!capabilities) return tools;
  const want = new Set(capabilities);
  return tools.filter((t) => {
    const caps = TOOL_CAPABILITIES[t.name];
    if (!caps) return true;                       // unclassified: keep it
    return caps.some((c) => want.has(c));
  });
}

/**
 * The operating-rule ids a set of capabilities exposes.
 *
 * Global rules are always present. An UNMAPPED rule is global — so a rule added
 * to prompts.js without a classification is over-sent, never lost.
 */
export function selectRuleIds(allRuleIds, capabilities) {
  if (!capabilities) return [...allRuleIds];
  const want = new Set(capabilities);
  return allRuleIds.filter((id) => {
    const caps = RULE_CAPABILITIES[id];
    if (caps === undefined || caps === GLOBAL) return true;
    return caps.some((c) => want.has(c));
  });
}

/**
 * The fact keys a set of capabilities exposes.
 *
 * Same rule, same reason: unmapped is global. That covers every fact a user
 * stores through `remember_fact` and every one `recordVerificationFailure`
 * writes — neither can be classified in advance, and neither may be dropped.
 */
export function selectFactKeys(allKeys, capabilities) {
  if (!capabilities) return null;                 // null = no filter, send all
  const want = new Set(capabilities);
  return allKeys.filter((key) => {
    const caps = FACT_CAPABILITIES[key];
    if (caps === undefined || caps === GLOBAL) return true;
    return caps.some((c) => want.has(c));
  });
}

/**
 * The retrieval query for the knowledge layer.
 *
 * The capability names are appended to the user's own words so a request about
 * flows biases retrieval toward Flow Designer documentation rather than
 * whatever happens to share vocabulary with it. Bounded and deterministic: the
 * capabilities are sorted, and the goal is clipped, so the same request always
 * produces the same query string and therefore the same hits.
 */
export function retrievalQuery(goal, capabilities) {
  const base = String(goal || '').trim().slice(0, 400);
  if (!capabilities) return base;
  const terms = capabilities.filter((c) => c !== 'core').join(' ').replace(/_/g, ' ');
  return terms ? `${base} ${terms}` : base;
}

export { CAPABILITIES };
