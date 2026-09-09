/**
 * PHASE 14 — WHAT WAS ASKED, AND ABOUT WHICH RECORD.
 *
 * Deliberately deterministic and deliberately small. No model call happens
 * here, for two reasons.
 *
 * FIRST, IT WOULD BE A SECOND PLACE THAT CAN BE WRONG. A model asked "which
 * incident is this about?" can answer with an incident that was never
 * mentioned, and that answer would then be investigated and reported on with
 * every appearance of rigour. A regular expression over the user's own words
 * cannot hallucinate an identifier.
 *
 * SECOND, THE FORMATS ARE FACTS, NOT JUDGEMENTS. `INC` followed by digits is
 * the ServiceNow incident number format, and 32 hexadecimal characters is a
 * sys_id. Recognising those is not interpreting the platform; it is reading.
 *
 * When nothing recognisable is present, this module says so. It does not guess
 * "probably the most recent incident" — §26 makes an ambiguous request a stop
 * condition, and a diagnosis of the wrong record is worse than no diagnosis.
 */
import { MODES } from './schemas.js';

/** `INC0010038`, and the same shape for the other task-like prefixes. */
const NUMBER = /\b((?:INC|PRB|CHG|RITM|REQ|SCTASK|TASK)\d{4,})\b/i;
/** A sys_id is 32 hex characters. Phase 12 established this as the identity test. */
const SYS_ID = /\b([0-9a-f]{32})\b/i;

/** Which table a task number prefix belongs to. Read off the prefix, nothing inferred. */
const PREFIX_TABLE = Object.freeze({
  INC: 'incident',
  PRB: 'problem',
  CHG: 'change_request',
  RITM: 'sc_req_item',
  REQ: 'sc_request',
  SCTASK: 'sc_task',
  TASK: 'task',
});

/**
 * Phrases that mean "there is something wrong", and the field each is about.
 *
 * SCOPED TO WHAT THIS PHASE SUPPORTS. §27 makes Phase 14 incident-first and
 * names the fields; this table covers those and nothing else. A complaint that
 * matches nothing here still produces a symptom — the user's own sentence —
 * with no field, and a symptom with no field is simply one that cannot be
 * checked mechanically. That is honest, and `checkSymptom` returns null for it
 * rather than pretending to have verified anything.
 */
const SYMPTOM_FIELDS = Object.freeze([
  { re: /\b(not|isn'?t|never|failed to be|no one|nobody)\b[^.?!]*\bassign/i, field: 'assigned_to', expect: 'empty' },
  { re: /\bunassigned\b/i, field: 'assigned_to', expect: 'empty' },
  { re: /\bno\s+(assignee|owner|assigned\s+to)\b/i, field: 'assigned_to', expect: 'empty' },
  { re: /\bno\s+(assignment\s+)?group\b/i, field: 'assignment_group', expect: 'empty' },
  { re: /\bno\s+caller\b/i, field: 'caller_id', expect: 'empty' },
  { re: /\bmissing\s+caller\b/i, field: 'caller_id', expect: 'empty' },
  { re: /\bno\s+(configuration\s+item|ci)\b/i, field: 'cmdb_ci', expect: 'empty' },
]);

/**
 * Read the request.
 *
 * @returns {{ subject, symptom, mode, ok, reason }}
 *
 * `ok:false` means the request named no record this module could recognise.
 * The caller stops there — §26's ambiguous-request condition — rather than
 * investigating something plausible.
 */
export function readIntent(text, { remediate = false } = {}) {
  const said = String(text ?? '').trim();
  const mode = remediate ? MODES.REMEDIATE : MODES.DIAGNOSE;

  const numberHit = NUMBER.exec(said);
  const sysIdHit = SYS_ID.exec(said);

  let subject = null;
  if (numberHit) {
    const number = numberHit[1].toUpperCase();
    const prefix = /^[A-Z]+/.exec(number)[0];
    subject = { type: PREFIX_TABLE[prefix] ?? 'task', identifier: number, by: 'number' };
  } else if (sysIdHit) {
    /*
     * A sys_id identifies a ROW but not a TABLE — the same 32 characters mean
     * nothing without knowing where to look. Phase 14 is incident-first, so
     * `incident` is stated as the assumption rather than presented as known.
     */
    subject = { type: 'incident', identifier: sysIdHit[1].toLowerCase(), by: 'sys_id', assumedTable: true };
  }

  if (!subject) {
    return {
      ok: false,
      reason: 'no_subject',
      note: 'The request does not name a record to investigate. Give an incident number '
        + '(for example INC0010038) or a sys_id.',
      subject: null,
      symptom: null,
      mode,
    };
  }

  const matched = SYMPTOM_FIELDS.find((s) => s.re.test(said));
  const symptom = {
    statement: said,
    source: 'user',
    ...(matched ? { field: matched.field, expect: matched.expect } : {}),
  };

  return { ok: true, subject, symptom, mode };
}

/**
 * Does this request ask for a change, rather than an explanation?
 *
 * Used only to REFUSE — a diagnose-mode request that reads like a repair order
 * is answered with a diagnosis and a recommendation, never with a mutation.
 * Nothing here can cause a write; the read-only gate does that, and this only
 * lets the Doctor say why it is not doing what was asked.
 */
export function looksLikeRemediation(text) {
  return /\b(assign|set|change|update|fix|close|resolve|reopen|escalate|reassign)\b/i.test(String(text ?? ''));
}
