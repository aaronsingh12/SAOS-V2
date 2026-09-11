import { chatOnce } from '../agent/providers/index.js';
import { detectDegenerateRepetition } from '../servicenow/acl.js';
import { digest } from './digest.js';

/**
 * Plain-language summaries over findings that already exist.
 *
 * The model is downstream of the rules and can only ever be downstream of them:
 * it receives DERIVED facts — an opaque id, the rule, the domain, the severity,
 * a record count — and returns prose keyed by those ids. It never sees record
 * names, scripts or sys_ids, it cannot add a finding, and an answer naming an
 * id that was not sent is discarded whole.
 *
 * That last check is the important one. Without it a model that invents an id
 * gets its invention rendered beside real findings, where it reads exactly like
 * one. The same reasoning as `explainAclReport`: the structured result is read
 * off the instance, the paragraph is generated, and the two are never blurred.
 *
 * The pass is OPTIONAL and its failure is never the run's failure. A model that
 * is unreachable, slow, or looping leaves `status: "unavailable"` on the
 * manifest and every deterministic finding intact.
 */

const SYSTEM = [
  'You explain ServiceNow estate findings that deterministic rules have ALREADY detected.',
  '',
  'Return ONLY valid JSON of the shape:',
  '{"explanations":[{"id":"<an id copied verbatim from the input>","explanation":"<plain language>"}]}',
  '',
  'Rules you must not break:',
  '- Every id MUST be copied from the input. Never invent one.',
  '- Do NOT create findings, and do NOT claim a cause the input does not state.',
  '- Do NOT recommend an automatic change; a human reviews every one of these.',
  '- Do NOT output ServiceNow URLs, credentials, or record identifiers.',
  '- Two or three sentences each. Say what the rule observed and why it is worth a look.',
].join('\n');

/** Strip a ```json fence if the model wrapped its answer in one. */
export function unfence(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Validate a model reply against the findings that were actually sent.
 *
 * Returns `{ ok, explanations, reason }`. An unknown id fails the WHOLE reply
 * rather than being dropped: a model that fabricated one entry has demonstrated
 * it is not keying off the input, so its other entries are not trustworthy
 * either.
 */
export function validateReply(raw, known) {
  let parsed;
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    return { ok: false, reason: 'the reply was not valid JSON' };
  }
  const list = parsed?.explanations;
  if (!Array.isArray(list)) return { ok: false, reason: 'the reply carried no explanations array' };

  const out = new Map();
  for (const entry of list) {
    const id = entry?.id;
    const text = entry?.explanation;
    if (typeof id !== 'string' || !known.has(id)) {
      return { ok: false, reason: `the reply named a finding that was never sent (${String(id).slice(0, 16)})` };
    }
    if (typeof text !== 'string' || !text.trim()) continue;
    out.set(id, text.trim().slice(0, 2000));
  }
  return { ok: true, explanations: out };
}

/**
 * Attach `ai_summary` to findings in place, and report what happened.
 *
 * Only the top 20 by priority are sent. That is a cost bound, and the manifest
 * says how many were explained so a reader never assumes the un-summarised ones
 * were judged unimportant by a model — they were simply not shown to it.
 */
export async function explainFindings(findings, { generate = chatOnce, limit = 20 } = {}) {
  const subset = findings.slice(0, limit);
  if (!subset.length) return { status: 'disabled', tokens_used: 0 };

  const facts = subset.map((f) => ({
    id: f.fingerprint,
    rule: f.rule_id,
    domain: f.domain,
    severity: f.severity,
    record_count: f.target_ids.length,
  }));
  const known = new Map(subset.map((f) => [f.fingerprint, f]));

  try {
    const raw = String(await generate({
      system: SYSTEM,
      user: JSON.stringify(facts),
      maxTokens: 2048,
      decoding: { temperature: 0 },
    }) || '').trim();

    if (!raw) {
      return {
        status: 'unavailable',
        tokens_used: null,
        error: 'The model returned nothing. Every deterministic finding is unaffected — they were read off the instance, not generated.',
      };
    }

    /* A weak model can return HTTP 200 with a repetition loop mid-answer
       (trap #22). Beside real findings that reads as one. */
    const loop = detectDegenerateRepetition(raw);
    if (!loop.ok) {
      return {
        status: 'unavailable',
        tokens_used: null,
        error: `The model's summary collapsed into a repetition loop (${loop.reason}). The deterministic findings are unaffected.`,
      };
    }

    const check = validateReply(raw, known);
    if (!check.ok) {
      return {
        status: 'unavailable',
        tokens_used: null,
        error: `The summary was rejected because ${check.reason}. The deterministic findings are unaffected.`,
      };
    }

    for (const [id, text] of check.explanations) known.get(id).ai_summary = text;

    return {
      status: 'complete',
      label: 'AI-generated plain-language summaries of findings the rules detected. The findings are deterministic; these sentences are not.',
      explained_findings: check.explanations.size,
      considered: subset.length,
      total_findings: findings.length,
      input_hash: digest(facts),
      tokens_used: null,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      tokens_used: null,
      error: `AI explanation unavailable (${err?.message || err}). Every deterministic finding is retained.`,
    };
  }
}
