/**
 * Getting a JSON object out of whatever the model actually returned.
 *
 * Shared by the understanding pass and the planner because both ask for strict
 * JSON from `gpt-oss:120b-cloud`, and that model provably ignores `seed` — the
 * same prompt returns a different wrapper each time. Measured across this
 * project, all of these have come back for a prompt that said "no prose, no
 * markdown fences":
 *
 *   {"steps":[...]}                       bare, as asked
 *   ```json\n{"steps":[...]}\n```         fenced
 *   Here is the plan:\n{"steps":[...]}    preamble
 *   {"steps":[...]}\n\nLet me know if…    TRAILING PROSE  <- the one that broke
 *
 * The last one is why this file exists. The first version only trimmed when the
 * body did not START with `{`, so trailing text sailed through to JSON.parse
 * and failed the whole plan with "Unexpected non-whitespace character after
 * JSON at position 468" — a message that tells the user nothing and loses work
 * the model actually did correctly.
 *
 * So the object is found by MATCHING BRACES rather than by slicing to the last
 * one. `lastIndexOf('}')` is wrong for `{...}` followed by another `{...}`, and
 * a naive depth count is wrong for a brace inside a string — and a transcript
 * quote is exactly where a `{` or a `"` shows up.
 */

/**
 * The first complete, balanced JSON object in `text`, or null.
 *
 * String-aware: braces inside quoted strings do not change the depth, and an
 * escaped quote does not end the string.
 */
export function firstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // truncated — an unterminated object is not a usable answer
}

/**
 * Parse a model completion into an object, or throw something a user can read.
 *
 * The error messages matter: this runs behind a button, and "the model did not
 * return valid JSON" with the reason is actionable where a raw SyntaxError
 * about a character position is not.
 */
export function parseModelJson(raw, { what = 'object' } = {}) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('the model returned nothing');

  // A fence, when present, is the most reliable boundary the model gives us.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);

  for (const candidate of candidates) {
    for (const body of [candidate, firstJsonObject(candidate)]) {
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch { /* try the next shape */ }
    }
  }

  throw new Error(
    `the model did not return valid JSON for the ${what}. `
    + `It replied with ${text.length} characters starting "${text.slice(0, 60).replace(/\s+/g, ' ')}…"`,
  );
}
