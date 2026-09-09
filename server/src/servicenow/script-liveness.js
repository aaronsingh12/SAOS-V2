import crypto from 'node:crypto';
import { jsLiteral, runServerScript } from './execution-harness.js';

/**
 * Script liveness — two independent nets against the SILENT NON-EXECUTION class.
 *
 * THE DEFECT THIS EXISTS FOR (measured, Phase 0 / trap ledger §16 #12). A
 * generated `sysauto_script` containing `{ case: 1 }` — a reserved word as an
 * unquoted object key — was accepted by the Table API, stored BYTE-IDENTICAL,
 * marked `active=true` … and never ran. No syslog row. No error. No partial
 * output. The harness then reported the one thing that was not true:
 *
 *   "a timeout here means the scheduler is not claiming the job at all"
 *
 * Three probes died this way before the cause was found. "Job stored active" is
 * not "job ran", and nothing on the instance will tell you the difference.
 *
 * So execution is never inferred. It is CONFIRMED, by two guards that fail
 * independently:
 *
 *   NET 1 — pre-dispatch validation. The script is parsed in Node before it is
 *           allowed near the instance. Nothing invalid is ever sent.
 *   NET 2 — the sentinel. Every dispatched script carries a unique GUID and
 *           echoes it on EVERY path, including its own catch. No echo back
 *           means the script did not run, whatever the scheduler says.
 *
 * WHY NET 1 IS TWO CHECKS, NOT ONE — and this is the load-bearing correction.
 *
 * `new Function(body)` alone does NOT catch the trap that motivated this
 * module. Measured in Node 24:
 *
 *   new Function('var o = { case: 1 };')   -> ACCEPTED
 *   new Function('var o = {};  o.case;')   -> ACCEPTED
 *
 * Reserved words as property names have been legal since ES5, so V8 is right to
 * accept them. The platform's script engine is ES3-era and is not. A validator
 * built only on `new Function` would have passed the exact script that
 * motivated it — a guard that certifies the absence of the bug it was written
 * for. Hence `lintEs3ReservedWords`, which encodes the ES3 rule V8 no longer
 * enforces.
 *
 * Both checks are pure and instance-free, so they are fully covered offline.
 */

/** Terminal classifications for one dispatched script. */
export const LIVENESS = {
  CONFIRMED: 'CONFIRMED',
  FAILED_WITH_ERROR: 'FAILED_WITH_ERROR',
  FAILED_SILENT_NONEXECUTION: 'FAILED_SILENT_NONEXECUTION',
  REJECTED_PRE_DISPATCH: 'REJECTED_PRE_DISPATCH',
};

/** Feature-agnostic default; the impersonation path passes its own. */
export const DEFAULT_MARKER = 'NHA_EXEC::';

/**
 * Reserved in ES3, legal as a property name in ES5+.
 *
 * This is exactly the set V8 stopped enforcing and Rhino did not, which is why
 * the gap is invisible until the instance silently drops the job.
 */
const ES3_RESERVED = new Set([
  'abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'double', 'else', 'enum', 'export', 'extends', 'false',
  'final', 'finally', 'float', 'for', 'function', 'goto', 'if', 'implements', 'import', 'in',
  'instanceof', 'int', 'interface', 'long', 'native', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'true', 'try', 'typeof', 'var', 'void', 'volatile', 'while', 'with',
]);

/**
 * Blank out string literals, template literals, regex literals and comments,
 * preserving offsets and newlines so reported positions stay truthful.
 *
 * Without this the linter flags its own error messages: a generated script
 * carrying the text `"{ case: 1 }"` inside a JSON payload is legal source, and
 * a validator that rejects it is a validator nobody can ship around.
 */
export function blankLiterals(src) {
  const s = String(src);
  const out = s.split('');
  let i = 0;
  const n = s.length;
  // Tracks whether a `/` starts a regex or is a division operator.
  let prevSignificant = '';

  const blankRange = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && s[j] !== '\n') j++;
      blankRange(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j++;
      blankRange(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) break;
        j++;
      }
      blankRange(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      prevSignificant = 'x'; // a string is a value, so a following / is division
      continue;
    }
    // A `/` after a value is division; after an operator or `(`/`,` it opens a regex.
    if (c === '/' && !/[\w)\]$]/.test(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') inClass = true;
        else if (s[j] === ']') inClass = false;
        else if (s[j] === '/' && !inClass) break;
        else if (s[j] === '\n') { j = i; break; } // not a regex after all
        j++;
      }
      if (j > i) {
        blankRange(i, Math.min(j + 1, n));
        i = Math.min(j + 1, n);
        prevSignificant = 'x';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Is the `{` at `braceIndex` the body of a `switch (...)`?
 *
 * `switch (x) { default: ... }` and `{ case y: }` inside one are legal ES3 —
 * `default` and `case` are keywords there, not property names. Without this the
 * linter refuses to dispatch a perfectly good script, which is a worse failure
 * than the one it is guarding against: this module is destined to sit in front
 * of every generated-script path in NHA.
 */
function isSwitchBlock(scrubbed, braceIndex) {
  const before = scrubbed.slice(0, braceIndex).replace(/\s+$/, '');
  if (!before.endsWith(')')) return false;
  let depth = 0;
  let i = before.length - 1;
  for (; i >= 0; i--) {
    const c = before[i];
    if (c === ')') depth++;
    else if (c === '(') { depth--; if (depth === 0) break; }
  }
  if (i < 0) return false;
  return /\bswitch\s*$/.test(before.slice(0, i));
}

/**
 * Reserved words used where ES3 forbids them: as an unquoted object-literal key
 * (`{ case: 1 }`) or as a dotted member accessor (`o.case`).
 *
 * The object-literal form is the one MEASURED to kill a job silently. The
 * member-accessor form is ES3-illegal by the same clause and is reported too —
 * flagged as `member` so a reader can tell proof from specification.
 */
export function lintEs3ReservedWords(body) {
  const src = String(body ?? '');
  const scrubbed = blankLiterals(src);
  const findings = [];

  // `{ case:` or `, case:` — an unquoted key. Excludes `?:` and labels by
  // requiring an object-literal opener before it.
  const keyRe = /([{,])\s*([A-Za-z_$][\w$]*)\s*:/g;
  let m;
  while ((m = keyRe.exec(scrubbed)) !== null) {
    const word = m[2];
    if (!ES3_RESERVED.has(word)) continue;
    // `switch (x) { default: ... }` / `{ case y: }` are legal ES3 keyword uses.
    if ((word === 'default' || word === 'case') && m[1] === '{' && isSwitchBlock(scrubbed, m.index)) continue;
    const at = m.index + m[0].indexOf(word);
    findings.push({
      word, kind: 'object-key', index: at, line: lineOf(src, at),
      message: `"${word}" is a reserved word used as an unquoted object key. The platform's script engine `
        + `rejects this and the job will be stored active and never run, silently. Quote it: '${word}':`,
    });
  }

  // `.case` — a dotted member accessor.
  const memberRe = /\.\s*([A-Za-z_$][\w$]*)/g;
  while ((m = memberRe.exec(scrubbed)) !== null) {
    const word = m[1];
    if (!ES3_RESERVED.has(word)) continue;
    const at = m.index + m[0].indexOf(word);
    findings.push({
      word, kind: 'member', index: at, line: lineOf(src, at),
      message: `"${word}" is a reserved word used as a dotted member accessor. ES3 forbids this; `
        + `use bracket notation: ["${word}"]`,
    });
  }

  return findings.sort((a, b) => a.index - b.index);
}

/**
 * NET 1. Parse in Node, then apply the ES3 rule V8 dropped.
 *
 * Returns a verdict rather than throwing so the caller can report it as a
 * refusal-to-dispatch, which is a different and more useful thing than a crash.
 */
export function validateScriptSyntax(body) {
  const src = String(body ?? '');
  if (!src.trim()) {
    return { ok: false, reason: 'empty', errors: [{ kind: 'empty', message: 'The script body is empty; nothing would run.' }] };
  }
  try {
    // eslint-disable-next-line no-new-func -- parse-only; never invoked.
    new Function(src);
  } catch (e) {
    return {
      ok: false,
      reason: 'syntax',
      errors: [{ kind: 'syntax', word: null, line: null, message: `${e.name}: ${e.message}` }],
    };
  }
  const es3 = lintEs3ReservedWords(src);
  if (es3.length) return { ok: false, reason: 'es3-reserved', errors: es3 };
  return { ok: true, reason: null, errors: [] };
}

/** A per-execution GUID. Hex only, so it can never need escaping. */
export function mintSentinel() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * NET 2. Declare `out`, run the body, and echo the sentinel on EVERY path.
 *
 * The echo lives here rather than in each feature's body precisely so that a
 * feature CANNOT forget it — a body that throws on its first line still reports.
 * The payload rides the harness's existing deletable `sys_user_preference`
 * sink; `gs.info` is additionally emitted because Phase 0 measured that the
 * instance keeps NO impersonation audit of its own, so a human-readable syslog
 * breadcrumb is the only trace that survives outside NHA. The sink stays the
 * machine-read channel because syslog cannot be deleted over REST (403).
 */
export function wrapWithSentinel({ body, sentinel, marker = DEFAULT_MARKER }) {
  if (!/^[0-9a-f]{32}$/.test(String(sentinel || ''))) {
    throw new Error(`Sentinel must be a 32-char hex GUID, got ${JSON.stringify(sentinel)}.`);
  }
  return [
    `var out = { sentinel: ${jsLiteral(sentinel)}, phase: 'init', error: null };`,
    'try {',
    body,
    "  if (out.phase === 'init') { out.phase = 'complete'; }",
    '} catch (e) { out.error = String(e); }',
    `try { gs.info(${jsLiteral(marker)} + JSON.stringify(out)); } catch (eLog) { out.logFailed = String(eLog); }`,
    `report.sentinel = ${jsLiteral(sentinel)};`,
    'report.payload = out;',
  ].join('\n');
}

/**
 * Classify one harness run. Absence of the sentinel is the whole point: it is
 * the only way to tell "the script did not run" from "the script ran and said
 * nothing", and the instance will not distinguish them for you.
 */
export function classifyExecution({ run, sentinel }) {
  if (!run || run.timedOut || !run.report) {
    return {
      liveness: LIVENESS.FAILED_SILENT_NONEXECUTION,
      payload: null,
      detail: 'No report came back. The job may never have executed — a syntax error the platform '
        + 'accepts at insert and then silently refuses to run looks exactly like this.',
    };
  }
  const payload = run.report.payload ?? null;
  if (!payload || payload.sentinel !== sentinel) {
    return {
      liveness: LIVENESS.FAILED_SILENT_NONEXECUTION,
      payload,
      detail: payload
        ? `Sentinel mismatch: expected ${sentinel}, got ${payload.sentinel}. This report belongs to a different execution.`
        : 'A report came back with no sentinel payload, so nothing proves this script ran.',
    };
  }
  if (payload.error) {
    return { liveness: LIVENESS.FAILED_WITH_ERROR, payload, detail: String(payload.error) };
  }
  if (run.report.ok === false) {
    return { liveness: LIVENESS.FAILED_WITH_ERROR, payload, detail: String(run.report.error ?? 'The harness reported failure.') };
  }
  return { liveness: LIVENESS.CONFIRMED, payload, detail: null };
}

/**
 * Dispatch a script only if it validates, and confirm it ran.
 *
 * `body` assigns onto the pre-declared `out`. Never returns "probably fine":
 * every outcome is one of the four LIVENESS values.
 */
export async function runConfirmedScript({
  body, label = 'script', marker = DEFAULT_MARKER, timeoutMs, emit = () => {},
} = {}) {
  const sentinel = mintSentinel();
  const wrapped = wrapWithSentinel({ body, sentinel, marker });

  // NET 1 — validate the FINAL text, the exact bytes that would be dispatched.
  const validation = validateScriptSyntax(wrapped);
  if (!validation.ok) {
    emit({ type: 'script_rejected_pre_dispatch', label, reason: validation.reason, errors: validation.errors });
    return {
      liveness: LIVENESS.REJECTED_PRE_DISPATCH,
      sentinel,
      payload: null,
      validation,
      dispatched: false,
      run: null,
      detail: validation.errors.map((e) => e.message).join(' | '),
    };
  }

  const run = await runServerScript({ body: wrapped, label, timeoutMs, emit });
  const verdict = classifyExecution({ run, sentinel });
  return { ...verdict, sentinel, validation, dispatched: true, run };
}
