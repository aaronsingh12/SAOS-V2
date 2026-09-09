/**
 * PHASE 20 — FROM A SENTENCE TO A REQUIREMENT SET (§4).
 *
 * §4 grants the model exactly one job and then constrains it: "The LLM may
 * interpret the user's natural language into this structure. Platform
 * validation must follow."
 *
 * So this file has two halves and the order matters. `readRequirements` asks a
 * model to READ a request. `validateRequirements` then refuses anything the
 * platform cannot stand behind — and it runs on every path, including the
 * deterministic fallback, because a validator that only inspects model output
 * is a validator that trusts whatever else produced the input.
 *
 * ═══ WHAT THE MODEL MAY AND MAY NOT DECIDE ═══
 *
 * May: what the user asked for. Which actors, which data, which processes.
 * That is reading comprehension and there is no other way to do it.
 *
 * May not: whether any of it can be built, what a table is called, what a field
 * type is, whether an artifact already exists, or whether the result works.
 * Those are §12, §17, §16, §6 and §36 respectively, and each is decided
 * elsewhere against the live instance. Nothing in a requirement set is
 * executable — it is a description of a want.
 *
 * A REQUIREMENT IS NOT A COMPONENT. The architect turns one into the other, and
 * keeping them apart is what lets the architecture be checked against the
 * instance before anybody is asked to approve it.
 */
import { emptyRequirements, isRequirements } from './schemas.js';

/** The shape the model is asked for. Narrow, and every field is a list of prose. */
export function requirementsSystem() {
  return [
    'You read a request for a ServiceNow application and restate it as structured requirements.',
    'You are NOT designing the application and NOT deciding what can be built.',
    '',
    'Answer with JSON only:',
    '{',
    '  "name": "<the application\'s name, as a person would say it>",',
    '  "purpose": "<one sentence on what it is for>",',
    '  "actors": ["<who uses it, one per entry>"],',
    '  "data": ["<what it stores, one thing per entry>"],',
    '  "processes": ["<what happens, one step per entry>"],',
    '  "security": ["<who may do what, one rule per entry>"],',
    '  "interfaces": ["<how people interact with it>"],',
    '  "acceptance_criteria": ["<observable statements that would show it works>"]',
    '}',
    '',
    'RULES:',
    '  1. Restate ONLY what the request says or plainly implies. Do not add features.',
    '  2. Do not invent table names, field names, field types or role names. Those are decided',
    '     against the live instance later, and a name you invent here would be a name nobody checked.',
    '  3. Do not say whether anything can be built. You do not know what this environment supports.',
    '  4. An acceptance criterion must be OBSERVABLE — something a person could look at a record and',
    '     check. "The manager approves" is observable. "The app is intuitive" is not.',
    '  5. If the request DESCRIBES an application but does not name it, give a short working title of your',
    '     own drawn from what it describes ("Equipment Request Application"). A person will see it and can',
    '     rename it. Only answer { "name": null } when the request describes no application at all.',
  ].join('\n');
}

/** Pull the object out of whatever the model wrapped it in. */
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Normalise whatever came back into the §4 shape, dropping anything else. */
export function normalizeRequirements(raw) {
  return {
    ...emptyRequirements(),
    name: text(raw?.name),
    purpose: text(raw?.purpose),
    actors: list(raw?.actors),
    data: list(raw?.data),
    processes: list(raw?.processes),
    security: list(raw?.security),
    interfaces: list(raw?.interfaces),
    acceptance_criteria: list(raw?.acceptance_criteria),
  };
}

/**
 * Read a request.
 *
 * `by` records which reader produced the result, so an evaluation can tell how
 * often the model was needed and a surprising architecture can be traced to the
 * right half.
 */
export async function readRequirements({ request, chat = null, decoding = undefined, signal = null } = {}) {
  const said = String(request ?? '').trim();
  if (!said) {
    return { ok: false, reason: 'empty_request', note: 'There is no request to read.', requirements: null, by: 'deterministic' };
  }

  if (typeof chat !== 'function') {
    return {
      ok: false,
      reason: 'no_reader',
      note: 'No model was available to read the request into requirements, and this build does not guess '
        + 'an application\'s requirements from its title.',
      requirements: null,
      by: 'deterministic',
    };
  }

  let raw;
  try {
    raw = await chat({
      system: requirementsSystem(),
      user: `REQUEST (the user's own words):\n${said}`,
      maxTokens: 1200,
      decoding,
      signal,
    });
  } catch (err) {
    return { ok: false, reason: 'reader_failed', note: `The request could not be read: ${err.message}`, requirements: null, by: 'model_failed' };
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return { ok: false, reason: 'unparseable', note: 'The requirement reading did not come back as JSON.', requirements: null, by: 'model' };
  }

  const requirements = normalizeRequirements(parsed);
  /* The name is the USER'S application, not the model's restatement of the
   * request — but the model IS the only thing that can extract it, so it is
   * taken and then validated rather than trusted. */
  const check = validateRequirements(requirements);
  if (!check.ok) {
    return { ok: false, reason: 'insufficient', note: check.problems[0]?.message ?? 'The request could not be turned into requirements.', requirements, problems: check.problems, by: 'model' };
  }
  return { ok: true, requirements, by: 'model' };
}

/* ------------------------------------------------------------------ *
 * §4 — platform validation, on every path
 * ------------------------------------------------------------------ */

/**
 * Is this a requirement set the architect can work from?
 *
 * Deliberately structural rather than semantic. It checks that there is a name,
 * that something was asked for, and that nothing arrived in a shape the
 * architect would misread. It does NOT check that the requirements are a good
 * idea — that is what the architecture, the capability gate and the human
 * review are for, in that order.
 */
export function validateRequirements(requirements) {
  const problems = [];

  if (!requirements || typeof requirements !== 'object') {
    return { ok: false, problems: [{ code: 'not_requirements', message: 'There are no requirements to validate.' }] };
  }
  if (!requirements.name) {
    problems.push({
      code: 'no_name',
      message: 'The request does not name an application. Nothing can be scoped, named or built without one.',
    });
  }
  if (!requirements.data.length && !requirements.processes.length && !requirements.interfaces.length) {
    problems.push({
      code: 'nothing_requested',
      message: 'The request names no data to store, no process to run and no interface to build, so there is '
        + 'nothing to design.',
    });
  }

  /*
   * §35 — an acceptance criterion has to be checkable, and the commonest way it
   * is not is that it describes a feeling. This is a WARNING rather than a
   * refusal: a vague criterion is a gap in the test plan, not a reason to
   * decline to design the application.
   */
  const vague = requirements.acceptance_criteria.filter((c) => VAGUE.test(c));
  for (const c of vague) {
    problems.push({
      code: 'unobservable_criterion',
      message: `"${c}" is not observable, so no test could establish it. It is kept as a stated intention `
        + 'and will not appear in the test plan.',
      fatal: false,
    });
  }
  if (!requirements.acceptance_criteria.length) {
    problems.push({
      code: 'no_acceptance_criteria',
      message: 'The request states no acceptance criteria, so there is nothing to verify the application '
        + 'against beyond the existence of its components.',
      fatal: false,
    });
  }

  const fatal = problems.filter((p) => p.fatal !== false);
  return { ok: fatal.length === 0 && isRequirements(requirements), problems };
}

/** Phrases that describe a feeling rather than an observation. */
const VAGUE = /\b(intuitive|easy to use|user[- ]friendly|fast|modern|clean|nice|good|better|seamless|robust|scalable)\b/i;

/**
 * The criteria that could actually become tests (§35).
 *
 * Separated from the full list so the report can show both: what the user asked
 * for, and what this build can prove. Silently dropping the unobservable ones
 * would make the test plan look complete when it covers less than was asked.
 */
export function testableCriteria(requirements) {
  const all = requirements?.acceptance_criteria ?? [];
  const testable = all.filter((c) => !VAGUE.test(c));
  return {
    testable,
    untestable: all.filter((c) => VAGUE.test(c)),
    note: all.length === testable.length
      ? null
      : `${all.length - testable.length} of ${all.length} stated criteria describe a quality rather than an `
        + 'observation, so nothing can establish them.',
  };
}
