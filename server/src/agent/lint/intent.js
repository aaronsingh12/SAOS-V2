/**
 * PHASE 16 — WHAT WAS ASKED, AND ABOUT WHICH FLOW.
 *
 * §30 lists what a model may and may not be the authority for. Reading a
 * request is on the permitted side; deciding which flow that names is NOT, and
 * the split is enforced here by what this module returns.
 *
 * It returns a STRING to look up. It never returns a flow. `findFlow` performs
 * the lookup against the instance and refuses to choose between candidates, so
 * the worst a misread request can do is fail to find something or offer a list
 * back — never lint the wrong flow and report confidently on it.
 *
 * THE DETERMINISTIC READER RUNS FIRST and the model is the fallback, not the
 * other way round. "Lint the Assign Incident flow" needs no model, and spending
 * one on it would add a failure mode to a case that has none.
 */

/** Does this request want a change, rather than an analysis? (§34) */
const WANTS_FIX = /\b(fix|repair|correct|change|update|patch|resolve)\b/i;

/**
 * The flow name inside a request, by stripping the words around it.
 *
 * Deliberately a strip and not a parse. What is left is handed to `findFlow`,
 * which is the only thing that can check it against the instance — a cleverer
 * extractor here would move the identification decision away from the code able
 * to verify it.
 */
export function nameFromRequest(message) {
  return String(message ?? '')
    /* PHASES 17 AND 18 add their verbs to the same list, additively. "Test my
     * Assign Incident flow" and "Compare my Assign Incident flow" both name a
     * flow exactly the way "Lint the Assign Incident flow" does, and one
     * stripper for all three is one behaviour to measure rather than three
     * that can drift apart. */
    .replace(/^\s*(please\s+)?(lint|check|analy[sz]e|review|inspect|examine|test|run|verify|compare|diff|deploy|prepare)\s+/i, '')
    .replace(/^\s*(is|does|why|what|can)\b.*?\b(flow|the)\s+/i, '')
    .replace(/\b(the|my|our)\s+/gi, '')
    .replace(/\s+flow\b/i, '')
    .replace(/\b(safe|broken|ok|okay|failing|correct)\b.*$/i, '')
    .replace(/[?.!,]+\s*$/, '')
    .trim();
}

/** The prompt used only when the strip above yields nothing usable. */
export function intentSystem() {
  return [
    'You extract the NAME OF A SERVICENOW FLOW from a request. Nothing else.',
    '',
    'Answer with JSON only: { "flow": "<the flow name exactly as written, or null>" }',
    '',
    'RULES:',
    '  1. Copy the name from the request. Do not correct spelling, expand abbreviations,',
    '     or supply a name the request does not contain.',
    '  2. If the request names no flow, answer { "flow": null }. That is a correct answer.',
    '  3. You are not choosing which flow to analyse. The name you return is looked up against',
    '     the instance, and if it matches several the user is asked which one they meant.',
  ].join('\n');
}

/** Pull the JSON object out of whatever the model wrapped it in. */
export function extractIntentJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/**
 * Read a lint request.
 *
 * @returns {{ flow_name, wants_fix, by }}
 *
 * `by` records which reader produced the name, so an evaluation can tell how
 * often the model was needed at all — and so a surprising result can be traced
 * to the right half.
 */
export async function readLintIntent({ request, chat = null, signal = null } = {}) {
  const wantsFix = WANTS_FIX.test(String(request ?? ''));
  const stripped = nameFromRequest(request);
  if (stripped.length >= 3) {
    return { flow_name: stripped, wants_fix: wantsFix, by: 'deterministic' };
  }
  if (typeof chat !== 'function') {
    return { flow_name: null, wants_fix: wantsFix, by: 'deterministic' };
  }
  return askModel({ request, chat, signal, wantsFix });
}

async function askModel({ request, chat, signal, wantsFix }) {
  try {
    const raw = await chat({
      system: intentSystem(),
      user: `REQUEST:\n${request}`,
      maxTokens: 200,
      signal,
    });
    const parsed = extractIntentJson(raw);
    const name = typeof parsed?.flow === 'string' && parsed.flow.trim() ? parsed.flow.trim() : null;
    return { flow_name: name, wants_fix: wantsFix, by: 'model' };
  } catch {
    return { flow_name: null, wants_fix: wantsFix, by: 'model_failed' };
  }
}

/**
 * Turn a fixable finding into a GOAL for the existing planner (§35).
 *
 * This is the whole of NowLint's remediation path: a sentence. Everything after
 * it — capability discovery, canonicalisation, fingerprint, review, approval,
 * the executor, read-back — is the pipeline Phases 4-15 already built. There is
 * no lint executor, and this function is the reason none is needed.
 */
export function fixGoal(finding, { flow }) {
  if (!finding?.recommendation?.statement) {
    throw new Error('a fix goal needs a finding that carries a recommendation');
  }
  return `In the ServiceNow flow "${flow?.name ?? 'unknown'}", ${finding.recommendation.statement} `
    + `This addresses ${finding.rule_id}: ${finding.title}.`;
}

/**
 * Identify the flow a request is about, cheaply first and verifiably always.
 *
 * MEASURED, and the reason this exists. The word-stripper is right often enough
 * to be worth trying and wrong in a way that looks right: "Why might the
 * Change - Conflict Detection flow fail?" strips to
 * "Change - Conflict Detection fail", which is long, plausible, and matches
 * nothing. A length check cannot tell that from a real name, so twelve of
 * twenty evaluation requests failed to identify a flow that was sitting there
 * — and the model, gated behind that length check, was never asked.
 *
 * So the INSTANCE decides whether the cheap read worked. If the stripped name
 * is not found, the model is asked and the answer looked up again.
 *
 * AN AMBIGUOUS RESULT IS NEVER RETRIED. Several flows matching is a real answer
 * and §6 says to stop and ask; sending it to the model would be asking a model
 * to make exactly the choice this phase refuses to let it make.
 */
export async function resolveFlowForRequest({ request, find, chat = null, signal = null } = {}) {
  if (typeof find !== 'function') throw new Error('resolveFlowForRequest requires an injected find()');
  const wantsFix = WANTS_FIX.test(String(request ?? ''));

  const stripped = nameFromRequest(request);
  if (stripped.length >= 3) {
    const first = await find({ name: stripped });
    if (first.ok || first.reason === 'ambiguous') {
      return { found: first, flow_name: stripped, wants_fix: wantsFix, by: 'deterministic' };
    }
  }

  if (typeof chat !== 'function') {
    return {
      found: stripped.length >= 3 ? await find({ name: stripped })
        : { ok: false, reason: 'no_identifier', note: 'Name the flow to lint.', candidates: [] },
      flow_name: stripped || null,
      wants_fix: wantsFix,
      by: 'deterministic',
    };
  }

  const asked = await askModel({ request, chat, signal, wantsFix });
  if (!asked.flow_name) {
    return {
      found: { ok: false, reason: 'no_identifier', note: 'No flow name could be read from the request.', candidates: [] },
      flow_name: null,
      wants_fix: wantsFix,
      by: asked.by,
    };
  }
  return {
    found: await find({ name: asked.flow_name }),
    flow_name: asked.flow_name,
    wants_fix: wantsFix,
    by: asked.by,
  };
}
