/**
 * PHASE 14 — WHERE THE MODEL IS ALLOWED TO THINK, AND WHAT HAPPENS TO IT AFTER.
 *
 * Everything the model contributes to a diagnosis passes through this module,
 * and it leaves in a strictly weaker form than it arrived. The model proposes
 * explanations; it does not get to say whether they are true, how confident to
 * be, or what counts as evidence. Those are computed in `diagnosis.js` from
 * citations that survived checking here.
 *
 * THE THREE THINGS THE MODEL CANNOT DO, and how each is prevented:
 *
 *   1. It cannot state a FACT. The response schema has no place to put one, and
 *      `factsFrom` — the only producer of facts — reads tool results, not model
 *      output. There is no path from a sentence to a fact.
 *
 *   2. It cannot cite evidence that does not exist. Every id it names is looked
 *      up in the real fact index; the ones that miss are stripped and COUNTED.
 *      Because support is measured by counting surviving citations, inventing
 *      one makes its own hypothesis weaker.
 *
 *   3. It cannot set its own confidence. Whatever it writes is kept as
 *      `claimed` for measurement and then overwritten by the evidence rule.
 *
 * ON THE FROZEN PROMPT. §18 asks whether Doctor can work through existing
 * prompt infrastructure. It cannot: `prompts.js` is the conversational system
 * prompt and `plannerSystem` builds plans — neither has a vocabulary for
 * symptom, hypothesis, evidence-against or unknown, and both are pinned by
 * freeze tests. So this is a NEW, ISOLATED prompt living in the Doctor domain.
 * `prompts.js` is not touched, and nothing here changes what any existing
 * prompt does.
 */
import {
  CLAIM_TYPES, CONFIDENCE, CONFIDENCE_LIST, HYPOTHESIS_STATUS,
} from './schemas.js';
import { checkCitations } from './evidence.js';

/** How many hypotheses are worth entertaining. Beyond this it is brainstorming. */
export const MAX_HYPOTHESES = 6;
/** How many facts to show the analyst. A whole incident is ~100 fields. */
export const MAX_FACTS_SHOWN = 120;

/**
 * The analyst prompt.
 *
 * Written to make the honest answer the easy one. The instruction that matters
 * most is the one about `evidence_against` and `missing_evidence` being
 * required arrays: a model asked only for support will always find some, and
 * asking it in the same breath what would REFUTE the idea is the cheapest
 * available defence against confirmation bias.
 */
export function analystSystem() {
  return [
    'You are a ServiceNow diagnostic analyst. You are given FACTS that were read from a real',
    'ServiceNow instance, and a reported symptom. Your job is to propose explanations and to say',
    'honestly how well the facts support each one.',
    '',
    'YOU ARE NOT ALLOWED TO STATE FACTS. Every fact you may use is already listed and has an id.',
    'You may only cite those ids. You have no knowledge of this instance beyond them: if something',
    'was not read, it is not known, and the correct response is an entry in "unknowns".',
    '',
    'Answer with JSON only, in exactly this shape:',
    '{',
    '  "hypotheses": [',
    '    {',
    '      "statement": "a possible explanation, phrased as a possibility",',
    '      "evidence_for":     ["fact_id", ...],',
    '      "evidence_against": ["fact_id", ...],',
    '      "missing_evidence": ["what would settle this but was not read"]',
    '    }',
    '  ],',
    '  "unknowns": [ { "statement": "...", "reason": "why it could not be established" } ],',
    '  "symptom_field": "the field the reported symptom is about, or null",',
    '  "symptom_expect": "empty" | "present" | null',
    '}',
    '',
    'RULES:',
    '  1. Cite only fact ids from the list. An id that is not in the list will be discarded, and the',
    '     hypothesis that cited it will be judged as though it had less evidence — inventing evidence',
    '     makes your explanation weaker, never stronger.',
    '  2. "evidence_against" and "missing_evidence" are REQUIRED arrays. Use [] only when you have',
    '     genuinely looked and there is nothing. A hypothesis nothing could refute is not a hypothesis.',
    '  3. Do not assert causation the facts do not show. "assigned_to is empty" supports "nobody is',
    '     assigned". It does NOT support "the assignment workflow failed" — that would need evidence',
    '     about a workflow, and if none was read, say so in "unknowns".',
    '  4. Do not propose a remedy here. You are establishing what is true, not what to do.',
    '  5. If the facts do not support any explanation, return an empty "hypotheses" array. That is a',
    '     correct and useful answer, and it is preferred over a confident guess.',
  ].join('\n');
}

/** The facts, as the analyst sees them: id, statement, nothing else. */
export function renderFacts(facts = [], { limit = MAX_FACTS_SHOWN } = {}) {
  const shown = facts.slice(0, limit);
  const lines = shown.map((f) => `${f.id}: ${f.statement}`);
  if (facts.length > shown.length) {
    lines.push(`(${facts.length - shown.length} further observations were read and are available as evidence.)`);
  }
  return lines.join('\n');
}

/** The user half of the analyst call. */
export function analystUser({ subject, symptom, facts, gaps = [] }) {
  const parts = [
    `SUBJECT: ${subject?.type ?? 'record'} ${subject?.identifier ?? '(unidentified)'}`,
    `REPORTED SYMPTOM: ${symptom?.statement ?? '(none given — report what you observe)'}`,
    '',
    'FACTS READ FROM THE INSTANCE:',
    renderFacts(facts),
  ];
  if (gaps.length) {
    parts.push('', 'READS THAT DID NOT COMPLETE (so nothing is known from them):',
      ...gaps.map((g) => `- ${g.step} (${g.tool ?? 'no tool'}): ${g.reason}`));
  }
  return parts.join('\n');
}

/** Pull the JSON object out of whatever the model wrapped it in. */
export function extractAnalysisJson(raw) {
  if (raw && typeof raw === 'object') return { ok: true, analysis: raw };
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object in the analyst response' };
  try {
    return { ok: true, analysis: JSON.parse(body.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false, reason: `the analyst response was not valid JSON: ${err.message}` };
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const asText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Take the analyst's raw answer apart and keep only what is defensible.
 *
 * Returns the sanitised hypotheses and unknowns, plus `invented` — every
 * citation that named a fact which does not exist. That list is the phase's
 * headline safety metric (§38) and is deliberately returned rather than logged,
 * so a caller cannot fail to notice it.
 *
 * Nothing here decides whether a hypothesis is TRUE. Status and confidence are
 * placeholders that `adjudicate` overwrites; they exist only so the shape is
 * complete.
 */
export function sanitiseAnalysis(analysis, byId, { max = MAX_HYPOTHESES } = {}) {
  const invented = [];
  const hypotheses = [];

  asArray(analysis?.hypotheses).slice(0, max).forEach((h, i) => {
    const statement = asText(h?.statement);
    if (!statement) return;                       // a hypothesis with no claim is not one

    const forCheck = checkCitations(asArray(h?.evidence_for), byId);
    const againstCheck = checkCitations(asArray(h?.evidence_against), byId);
    invented.push(
      ...forCheck.invented.map((id) => ({ hypothesis: statement, slot: 'evidence_for', id })),
      ...againstCheck.invented.map((id) => ({ hypothesis: statement, slot: 'evidence_against', id })),
    );

    hypotheses.push({
      id: `hyp_${i + 1}`,
      statement,
      type: CLAIM_TYPES.INFERENCE,
      evidence_for: forCheck.kept,
      evidence_against: againstCheck.kept,
      missing_evidence: asArray(h?.missing_evidence).map(asText).filter(Boolean),
      /* Placeholders. `adjudicate` computes the real ones from the counts. */
      status: HYPOTHESIS_STATUS.UNKNOWN,
      confidence: CONFIDENCE.LOW,
      /* Kept so `adjudicate` can measure the gap between claim and evidence. */
      claimed_confidence: CONFIDENCE_LIST.includes(h?.confidence) ? h.confidence : null,
      claimed_status: typeof h?.status === 'string' ? h.status : null,
    });
  });

  const unknowns = asArray(analysis?.unknowns).map((u) => {
    const statement = asText(u?.statement);
    const reason = asText(u?.reason);
    if (!statement || !reason) return null;
    return { type: CLAIM_TYPES.UNKNOWN, statement, reason };
  }).filter(Boolean);

  const symptomField = asText(analysis?.symptom_field);
  const expect = analysis?.symptom_expect;

  return {
    hypotheses,
    unknowns,
    invented,
    symptomCheck: symptomField
      ? { field: symptomField, expect: expect === 'present' ? 'present' : 'empty' }
      : null,
  };
}

/**
 * Ask the analyst, and return only what survived.
 *
 * `chat` is injected — the same `chatOnce` seam the planner uses, passed in
 * rather than imported, so this module reaches no provider of its own and can
 * be tested without a model.
 */
export async function proposeHypotheses({
  subject, symptom, facts = [], gaps = [], byId, chat, decoding = undefined, signal = null,
} = {}) {
  if (typeof chat !== 'function') throw new Error('proposeHypotheses requires an injected chat()');
  if (!facts.length) {
    return {
      ok: true,
      hypotheses: [],
      unknowns: [{
        type: CLAIM_TYPES.UNKNOWN,
        statement: 'No explanation could be considered.',
        reason: 'The investigation produced no observations to reason from.',
      }],
      invented: [],
      symptomCheck: null,
    };
  }

  let raw;
  try {
    raw = await chat({
      system: analystSystem(),
      user: analystUser({ subject, symptom, facts, gaps }),
      maxTokens: 1600,
      decoding,
      signal,
    });
  } catch (err) {
    return { ok: false, reason: 'analyst_failed', note: err.message };
  }

  const parsed = extractAnalysisJson(raw);
  if (!parsed.ok) return { ok: false, reason: 'unparseable', note: parsed.reason };

  return { ok: true, ...sanitiseAnalysis(parsed.analysis, byId) };
}
