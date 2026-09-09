/**
 * THE REDACTOR. Pure string and object work: no imports, no I/O, no model.
 *
 * IT LIVES IN `memory/` RATHER THAN IN `agent/evidence/`, AND THAT IS A
 * LAYERING DECISION, not a filing one.
 *
 * It was written for the evidence layer and lived there, which was correct
 * while evidence was its only consumer. Phase 19 gave it a second one:
 * knowledge ingestion has to strip credentials out of a corpus document BEFORE
 * it is stored, indexed and embedded (§51), and `knowledge/` sits BELOW the
 * evidence layer — an architecture test asserts that nothing in `servicenow/`,
 * `memory/` or `knowledge/` imports `agent/evidence/`, because evidence reads
 * those layers and the arrow must point one way.
 *
 * Importing upward would have inverted that. Copying it would have created the
 * second redaction implementation §51 explicitly forbids — and a second one is
 * a second thing that falls behind the key list. So the implementation moved to
 * the layer below both consumers, and `agent/evidence/redact.js` re-exports it,
 * leaving every existing importer and every existing test untouched.
 */
/**
 * Key names whose values never appear in evidence.
 *
 * Matched case-insensitively as a SUBSTRING of the key, so `clientSecret`,
 * `client_secret`, `CLIENT_SECRET` and `oauthClientSecret` are all caught by
 * one entry. Over-matching is the safe direction here: redacting a field called
 * `password_policy_name` costs a reader nothing they cannot get elsewhere,
 * while missing one costs a credential.
 */
export const SECRET_KEYS = Object.freeze([
  'password',
  'passwd',
  'secret',
  'apikey',
  'api_key',
  'token',
  'authorization',
  'auth_header',
  'credential',
  'clientsecret',
  'client_secret',
  'private_key',
  'privatekey',
  'session_token',
  /*
   * PHASE 10 — cookies. Named by §9 and found uncovered by the release audit.
   *
   * There is no DEMONSTRATED path today: this client authenticates with a
   * Basic or Bearer header and its errors do not surface response headers, so
   * a `Set-Cookie` never reaches the projection. It is added because the cost
   * is one key and the shape is unmistakably a credential — a latent gap in an
   * externally observable security boundary is worth closing before it becomes
   * a live one.
   *
   * Key-based, like every other entry, so it cannot corrupt a sys_id.
   */
  'cookie',
  'access_token',
  'refresh_token',
  'bearer',
]);

/** What a redacted value is replaced with. Visible, so absence stays distinct. */
export const REDACTED = '[redacted]';

/**
 * PHASE 9 — the field/value pair shape, and why it needs its own rule.
 *
 * The read-back verifier reports its verdict as a LIST OF PAIRS —
 * `{ field: 'api_key', value: 'sk-live-…' }` — and the evidence builder
 * reshapes those into `{ name, expected, actual }`. Both forms defeat
 * key-based redaction completely: the secret's NAME has become a value under
 * the innocent key `field`, and the secret itself sits under `value`.
 *
 * A secret planted in a write's `requested` fields therefore travelled all the
 * way into the verification verdict, the assertion list and the ledger's
 * `after_state`, in plain text. Found by planting one and sweeping for it.
 *
 * So: when an object NAMES a field, and that name is a secret key, the
 * value-bearing siblings are redacted. This is a narrow, structural rule about
 * one serialisation this codebase uses — not a widening of the value
 * heuristic, which would still match every sys_id.
 */
const FIELD_NAME_KEYS = Object.freeze(['field', 'name']);
const FIELD_VALUE_KEYS = Object.freeze(['value', 'expected', 'actual', 'requested', 'before', 'after']);

const isSecretKey = (key) => {
  const k = String(key).toLowerCase().replace(/[-\s]/g, '_');
  return SECRET_KEYS.some((s) => k.includes(s));
};

/**
 * Values that are a credential regardless of their key.
 *
 * Deliberately just ONE case: an HTTP auth header serialised into a string.
 * Broader value-sniffing was considered and rejected — a regex for "looks like
 * a token" flags every sys_id and every base64 payload, which would redact most
 * of the evidence this phase exists to expose.
 */
const AUTH_VALUE = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/g;

/**
 * PHASE 15 — A SECRET NAMED INSIDE FREE TEXT.
 *
 * Still key-based, and that is the whole point. Phase 15 puts flow error
 * messages, journal entries and audit values into evidence, and §55 warns that
 * those free-text fields carry credentials — an integration that fails while
 * logging its own configuration writes `password=hunter2` into `error_message`,
 * where no amount of KEY inspection helps because the only key present is
 * `error_message`. Measured before this existed: that string reached evidence
 * intact.
 *
 * This does NOT broaden into the value-sniffing the note above rightly rejects.
 * It fires only where the text itself names one of `SECRET_KEYS` and then
 * ASSIGNS to it — `password=`, `api_key:`, `token =` — and redacts as far as
 * the next delimiter. Innocent prose survives, because innocent prose does not
 * assign a value to something called `password`; a sys_id survives, because a
 * sys_id is not preceded by a secret's name; and "the password policy name is
 * Standard" survives, because it assigns nothing.
 */
const NAMED_SECRET = new RegExp(
  `\\b(${SECRET_KEYS.map((k) => k.replace(/_/g, '[_-]?')).join('|')})\\s*[=:]\\s*`
  + '("[^"]*"|\'[^\']*\'|[^\\s,;&)\\]}]+)',
  'gi',
);

function redactString(s) {
  return s
    .replace(AUTH_VALUE, (m) => `${m.split(/\s+/)[0]} ${REDACTED}`)
    .replace(NAMED_SECRET, (whole, key, value) => {
      /*
       * AUTH_VALUE ran first and owns the header shape. Re-redacting its output
       * would rewrite `Authorization: Basic [redacted]` into
       * `Authorization=[redacted] [redacted]` — still safe, but it destroys the
       * `Basic [redacted]` form that the suite pins as proof the header path
       * works, and turns one clear marker into two confusing ones.
       */
      if (value === REDACTED || /^(Basic|Bearer)$/i.test(value)) return whole;
      return `${key}=${REDACTED}`;
    });
}

/**
 * Redact a value of any shape.
 *
 * Depth-bounded and cycle-safe: evidence is assembled from stored JSON, which
 * cannot contain a cycle, but a bound means a pathological structure degrades
 * to a marker instead of exhausting the stack while serving a request.
 */
export function redact(value, { depth = 0, seen = new WeakSet() } = {}) {
  if (depth > 12) return '[truncated: too deeply nested]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  /*
   * PHASE 9 — `seen` tracks the ANCESTOR CHAIN, not every object ever visited.
   *
   * It used to be the latter, which conflated two different things: a genuine
   * cycle (a -> b -> a) and a shared reference (two lists holding the same
   * object). Evidence is full of the second — `failed_assertions` is a FILTER
   * of `assertions`, so both arrays hold the same objects — and the second
   * visit was being replaced with the string '[circular]'. The symptom was a
   * failed assertion arriving with no field name.
   *
   * Adding on the way down and removing on the way back up detects real cycles
   * exactly as before, and leaves shared structure alone.
   */
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const done = (result) => { seen.delete(value); return result; };

  if (Array.isArray(value)) return done(value.map((v) => redact(v, { depth: depth + 1, seen })));

  /*
   * Does this object describe a FIELD whose name is itself a secret? If so its
   * value-bearing siblings go too — see FIELD_NAME_KEYS above.
   */
  const namesASecretField = FIELD_NAME_KEYS.some(
    (k) => typeof value[k] === 'string' && isSecretKey(value[k]),
  );

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) { out[k] = REDACTED; continue; }
    if (namesASecretField && FIELD_VALUE_KEYS.includes(k)) { out[k] = REDACTED; continue; }
    out[k] = redact(v, { depth: depth + 1, seen });
  }
  return done(out);
}

/**
 * Does this object still contain something that looks like a credential?
 *
 * The assertion side of the same rule, used by the suite rather than by the
 * projection. A redaction that is only ever applied is a redaction nobody can
 * prove; this makes it checkable.
 */
export function findSecrets(value, { path = '$', out = [] } = {}) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (AUTH_VALUE.test(value) && !value.includes(REDACTED)) out.push({ path, reason: 'auth header' });
    AUTH_VALUE.lastIndex = 0;
    return out;
  }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSecrets(v, { path: `${path}[${i}]`, out }));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k) && v !== REDACTED) out.push({ path: `${path}.${k}`, reason: 'secret key' });
    else findSecrets(v, { path: `${path}.${k}`, out });
  }
  return out;
}
