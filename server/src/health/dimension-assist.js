import { chatOnce } from '../agent/providers/index.js';
import { log } from '../logging.js';
import { ruleCatalogue, getCatalogueRule, publicRule } from './rule-catalogue.js';
import { NAME_MAX, DESCRIPTION_MAX } from './finding-dimensions.js';

/**
 * AI ASSISTANCE FOR DESIGNING A CUSTOM DIMENSION — a helper, never a classifier.
 *
 * Given a dimension name and description written by a person, the model may
 * suggest a clearer name, a clearer description, and the rule ids that fit —
 * each with a reason. Nothing is saved here. The person reviews, edits and
 * saves through the ordinary dimension route, whose server-side validation is
 * the only way a mapping reaches the database. Once saved, the mapping is
 * plain data: no scan, list or count ever calls a model to classify a finding.
 *
 * WHAT THE MODEL SEES: the rule CATALOGUE — ids, generic titles, what each
 * rule means, module, group, CMDB quality dimension (D1–D10), table names. Those are product
 * definitions, identical on every instance. It never sees a finding, a record,
 * a sys_id, a CI or user name, evidence, or a credential; this module does not
 * import the store or the instance client, and a test asserts both.
 *
 * WHAT IS ACCEPTED BACK: strict JSON of exactly one shape. One unknown rule id,
 * a duplicate, a missing field or an unexpected key discards the WHOLE reply —
 * the same stance explain.js takes: a model that invented one rule has shown
 * it is not reading the list it was given, so its other choices are not
 * evidence either.
 */

export const ASSIST_TIMEOUT_MS = 90_000;
export const REASON_MAX = 300;
export const SUGGESTIONS_MAX = 60;

const SYSTEM = [
  'You help design a dimension that groups ServiceNow health-check RULES by theme.',
  'You are given a dimension name, a description, and a catalogue of rules (one per line:',
  'rule id | module | group | title — meaning). Choose ONLY rules whose definition fits the dimension.',
  'Never invent a rule id: every id you return must appear in the catalogue exactly as written.',
  'You may propose a clearer name and a clearer description; keep the person\'s intent.',
  'Answer with ONE JSON object and nothing else, exactly this shape:',
  '{"suggestedName":"…","suggestedDescription":"…","rules":[{"ruleId":"…","reason":"…"}]}',
  `Name at most ${NAME_MAX} characters. Each reason one short sentence. At most ${SUGGESTIONS_MAX} rules.`,
  'If no rule fits, return "rules": [].',
].join(' ');

/** One catalogue line per rule — definition text only, clipped. */
export function catalogueForPrompt(rules = ruleCatalogue()) {
  return rules.map((r) => {
    const p = publicRule(r, { meaningChars: 160 });
    const where = [p.module, p.groupName || p.group, p.qualityDimension].filter(Boolean).join(' / ');
    return `${p.ruleId} | ${where} | ${p.title} — ${p.whatItMeans}`;
  }).join('\n');
}

export function buildAssistPrompt({ name, description }) {
  return {
    system: SYSTEM,
    user: [
      `Dimension name: ${String(name ?? '').trim()}`,
      `Dimension description: ${String(description ?? '').trim()}`,
      '',
      'Rule catalogue:',
      catalogueForPrompt(),
    ].join('\n'),
  };
}

/** Pull the one JSON object out of a reply that may be fenced. */
function extractJson(raw) {
  const text = String(raw ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const ALLOWED_TOP = new Set(['suggestedName', 'suggestedDescription', 'rules']);
const ALLOWED_RULE = new Set(['ruleId', 'reason']);

/**
 * Strictly validate a model reply. Returns `{ ok: true, value }` or
 * `{ ok: false, reason }` — never a partially accepted suggestion.
 */
export function validateAssistReply(raw) {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'the reply was not a JSON object' };

  const extra = Object.keys(obj).filter((k) => !ALLOWED_TOP.has(k));
  if (extra.length) return { ok: false, reason: `the reply carried unexpected fields (${extra.join(', ')})` };
  if (typeof obj.suggestedName !== 'string' || !obj.suggestedName.trim()) return { ok: false, reason: 'suggestedName was missing' };
  if (typeof obj.suggestedDescription !== 'string') return { ok: false, reason: 'suggestedDescription was missing' };
  if (!Array.isArray(obj.rules)) return { ok: false, reason: 'rules was missing or not a list' };
  if (obj.rules.length > SUGGESTIONS_MAX) return { ok: false, reason: `it suggested ${obj.rules.length} rules, more than the ${SUGGESTIONS_MAX} allowed` };

  const seen = new Set();
  const unknown = [];
  const rules = [];
  for (const r of obj.rules) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: 'a rule entry was not an object' };
    const extraR = Object.keys(r).filter((k) => !ALLOWED_RULE.has(k));
    if (extraR.length) return { ok: false, reason: `a rule entry carried unexpected fields (${extraR.join(', ')})` };
    if (typeof r.ruleId !== 'string' || !r.ruleId.trim()) return { ok: false, reason: 'a rule entry had no ruleId' };
    if (typeof r.reason !== 'string' || !r.reason.trim()) return { ok: false, reason: `${r.ruleId} had no reason` };
    const id = r.ruleId.trim();
    if (seen.has(id)) return { ok: false, reason: `${id} was suggested twice` };
    seen.add(id);
    const entry = getCatalogueRule(id);
    if (!entry) { unknown.push(id); continue; }
    rules.push({ ...publicRule(entry, { meaningChars: 200 }), reason: r.reason.trim().slice(0, REASON_MAX) });
  }
  if (unknown.length) {
    return { ok: false, reason: `it named ${unknown.length === 1 ? 'a rule' : `${unknown.length} rules`} that ${unknown.length === 1 ? 'does' : 'do'} not exist (${unknown.join(', ')})`, unknown };
  }
  return {
    ok: true,
    value: {
      suggestedName: obj.suggestedName.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX),
      suggestedDescription: obj.suggestedDescription.trim().slice(0, DESCRIPTION_MAX),
      rules,
    },
  };
}

export class AssistError extends Error {
  constructor(message, status = 502, detail = null) {
    super(message);
    this.name = 'AssistError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Ask the configured model for suggestions. `generate` is injectable so the
 * offline suite can drive every failure mode without a provider.
 */
export async function suggestDimension({ name, description } = {}, { generate = chatOnce, timeoutMs = ASSIST_TIMEOUT_MS } = {}) {
  const n = String(name ?? '').trim();
  const d = String(description ?? '').trim();
  if (!n && !d) throw new AssistError('Give the dimension a name or a description first — the suggestions are made from them.', 422);
  if (n.length > NAME_MAX) throw new AssistError(`A dimension name is at most ${NAME_MAX} characters.`, 422);
  if (d.length > DESCRIPTION_MAX) throw new AssistError(`A description is at most ${DESCRIPTION_MAX} characters.`, 422);

  const { system, user } = buildAssistPrompt({ name: n, description: d });
  let raw;
  try {
    raw = await generate({
      system, user, maxTokens: 4096, decoding: { temperature: 0 },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    /* The provider's own words (an endpoint, a retry count) go to the server
       log. The person is told what happened and what they can still do —
       except for a configuration gap they can fix, which is said as is. */
    log.warn('health', `dimension assist: model call failed — ${err?.message || err}`);
    const message = String(err?.message || '');
    const cause = /not set\. add it in settings|choose one in settings/i.test(message)
      ? message.replace(/\.+$/, '')
      : 'the configured model could not be reached';
    throw new AssistError(
      timedOut
        ? `Unable to generate AI suggestions: the model did not answer within ${Math.round(timeoutMs / 1000)} s. You can still choose rules yourself.`
        : `Unable to generate AI suggestions: ${cause}. You can still choose rules yourself.`,
      timedOut ? 504 : 502,
    );
  }
  if (!String(raw ?? '').trim()) {
    throw new AssistError('Unable to generate AI suggestions: the model returned nothing. You can still choose rules yourself.', 502);
  }
  const check = validateAssistReply(raw);
  if (!check.ok) {
    throw new AssistError(
      `The AI suggestions were rejected because ${check.reason}. Nothing was saved — try again, or choose rules yourself.`,
      502, check.unknown ? { unknown_rules: check.unknown } : null,
    );
  }
  return {
    ...check.value,
    label: 'AI-suggested. Review every rule before saving — nothing is saved until you do.',
  };
}
