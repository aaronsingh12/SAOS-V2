/**
 * PHASE 19 — WHICH QUESTIONS RETRIEVAL IS NOT ALLOWED TO ANSWER (§18, §19).
 *
 * The distinction this file draws is the difference between a knowledge system
 * that helps and one that is dangerous. Both kinds of question look identical
 * arriving:
 *
 *   "What does our runbook say about assigning incidents?"   answerable from
 *                                                            knowledge
 *   "Can I write incident.priority?"                         NOT answerable
 *                                                            from knowledge
 *
 * The second has a correct answer that lives on the instance and changes
 * without warning. Documentation that answers it confidently is the single
 * most dangerous artifact this system can produce, because it reads exactly
 * like the first — and §80.2 makes documentation overriding live state a
 * release blocker.
 *
 * ═══ THE CLASSIFIER IS PLATFORM-CONTROLLED (§16) ═══
 *
 * §16 permits the model to interpret a query and requires the FILTERS to be
 * platform-controlled. This is a filter, so there is no model in it: a list of
 * named patterns, each carrying the reason it exists, matched against the
 * question. A model could be persuaded that a question about writability is
 * really a question about process. A regex cannot.
 *
 * ═══ IT FAILS TOWARDS LIVE TRUTH ═══
 *
 * The consequence of classifying LIVE_TRUTH_REQUIRED wrongly is a live read
 * that was not strictly needed. The consequence of the opposite mistake is an
 * answer about someone else's instance stated as fact about yours. So anything
 * naming a field, a table, a record or a capability in a question about what IS
 * or what is PERMITTED is live-truth-required, and only questions that are
 * unambiguously about process, history or documentation are not.
 */
import { QUESTION } from './schemas.js';

/**
 * Patterns that make a question answerable only from the instance.
 *
 * Each is named, so a classification can say WHICH rule fired — a classifier
 * that cannot explain itself cannot be argued with, and this one will
 * occasionally be wrong in a way somebody needs to correct.
 */
const LIVE_REQUIRED = Object.freeze([
  {
    id: 'writability',
    re: /\b(can|could|may|should|am i able to)\b[^?]{0,40}\b(write|set|update|change|modify|populate|assign)\b/i,
    why: 'Whether a field accepts a write is a property of this instance\'s dictionary and its business rules, and it changes without notice.',
  },
  {
    id: 'field_writable',
    re: /\b(is|are)\b[^?]{0,40}\b(writable|writeable|read[\s-]?only|mandatory|required|editable)\b/i,
    why: 'Writability and read-only status are read from the live dictionary; documentation describes a default configuration this instance may not have.',
  },
  {
    id: 'destructive',
    re: /\b(can|may|should)\b[^?]{0,30}\b(delete|remove|drop|purge|deactivate)\b/i,
    why: 'Whether something can be deleted depends on live ACLs and live references, not on documentation.',
  },
  {
    id: 'capability',
    re: /\b(is|are)\b[^?]{0,40}\b(capability|capabilities|available|supported|installed|enabled|activated)\b/i,
    why: 'A feature that exists in the platform but not in this build or on this instance is, from here, a feature that does not exist. Only capability discovery answers it.',
  },
  {
    id: 'field_type',
    re: /\bwhat\b[^?]{0,20}\b(type|datatype|data type|length|max length|choices?|values?)\b[^?]{0,40}\b(is|of|for|does|has)\b/i,
    why: 'A field\'s type and choice list are dictionary readings. Documentation describes a release, not this instance.',
  },
  {
    id: 'existence',
    re: /\b(does|do|is|are)\b[^?]{0,40}\b(exist|exists|present|there)\b/i,
    why: 'Whether a table, field or record exists here is a live read; a documented field may be absent on this instance and vice versa.',
  },
  {
    id: 'identity',
    re: /\b(which|what|who)\b[^?]{0,30}\b(user|group|record|sys_id|assignee|approver)\b[^?]{0,30}\b(should|do|does|is|to)\b/i,
    why: 'Naming a specific record means resolving an identity against the instance. A name from documentation resolves to nothing, or to the wrong record.',
  },
  {
    id: 'table_name',
    re: /\bwhat\b[^?]{0,20}\b(table|field|column)\b[^?]{0,20}\b(name|is|called)\b/i,
    why: 'Table and field names differ between instances and between releases; the dictionary is the only authority for this one.',
  },
  {
    /*
     * §82's own headline question — "Why does priority behave this way on my
     * instance?" — and it belongs here rather than with the process questions.
     * It asks what THIS instance does, which the instance is the only authority
     * for; documentation can explain the mechanism, and cannot establish that
     * the mechanism is the one running here.
     */
    id: 'instance_behaviour',
    re: /\bbehav(e|es|ing|iour|ior)\b[^?]{0,40}\b(on|for|in)\b[^?]{0,20}\b(my|this|our|the)\b[^?]{0,20}\binstance\b/i,
    why: 'How something behaves on this instance is established by reading this instance. Documentation explains a mechanism; it cannot confirm that the mechanism is the one in force here.',
  },
  {
    id: 'current_state',
    re: /\b(current|currently|right now|at the moment|state of|status of)\b/i,
    why: 'A question about the current state of anything is a question about the instance now, which nothing stored can answer.',
  },
]);

/**
 * Patterns that make a question genuinely about process, history or docs.
 *
 * Checked AFTER the live patterns and never able to override one: a question
 * can be about the runbook AND about a field's writability, and when it is,
 * the live half is what decides how it must be answered.
 */
const CONTEXT_OK = Object.freeze([
  { id: 'process', re: /\b(standard|normal|usual|typical)\b[^?]{0,20}\b(process|procedure|practice|approach|way)\b/i },
  { id: 'runbook', re: /\brunbook|playbook|procedure\b/i },
  { id: 'history', re: /\b(last time|previously|before|historically|did we|have we|in the past|ever encountered)\b/i },
  { id: 'documentation', re: /\b(documentation|docs|documented|manual|guide)\b[^?]{0,20}\b(say|says|state|recommend|describe)\b/i },
  { id: 'known_trap', re: /\b(known|any)\b[^?]{0,20}\b(trap|gotcha|pitfall|issue|caveat|limitation)\b/i },
  { id: 'what_we_know', re: /\bwhat do we know\b/i },
]);

/**
 * Classify one question.
 *
 * @returns {{ classification, matched: string[], why: string[], live_required: boolean }}
 *
 * Both lists of matches are returned even when only one decides, because a
 * question that matched a process pattern AND a writability pattern is exactly
 * the case a reader will want to check — and the answer they get will be
 * shaped by the live half without that being obvious from the question.
 */
export function classifyQuestion(question) {
  const text = String(question ?? '');
  const live = LIVE_REQUIRED.filter((p) => p.re.test(text));
  const context = CONTEXT_OK.filter((p) => p.re.test(text));

  if (live.length) {
    return {
      classification: QUESTION.LIVE_TRUTH_REQUIRED,
      live_required: true,
      matched: live.map((p) => p.id),
      also_matched: context.map((p) => p.id),
      why: live.map((p) => p.why),
      note: 'This question asks what is true on the instance right now. Stored knowledge may explain the '
        + 'behaviour, but it cannot establish it — the instance has to be read.',
    };
  }

  return {
    classification: QUESTION.CONTEXT_OK,
    live_required: false,
    matched: context.map((p) => p.id),
    also_matched: [],
    why: [],
    note: context.length
      ? 'This question is about process, history or documentation, so stored knowledge can answer it — with its sources shown.'
      : 'Nothing in this question asks what is true on the instance right now, so stored knowledge may answer it. '
        + 'Its sources are shown so the answer can be weighed.',
  };
}

/**
 * What live evidence a live-truth question needs.
 *
 * Returns the SUBJECTS a caller should read, extracted from the question, so
 * the caller can go and read them. Nothing here reads anything — the extraction
 * is a string operation and the reading belongs to whoever holds the client.
 *
 * A `table.field` mention is the strong signal and is looked for first; a bare
 * table name is the weak one. Both are returned, in that order, so a caller can
 * try the specific read before the general one.
 */
export function subjectsOf(question) {
  const text = String(question ?? '');
  const out = [];

  for (const m of text.matchAll(/\b([a-z][a-z0-9_]{2,})\.([a-z][a-z0-9_]{2,})\b/gi)) {
    out.push({ kind: 'field', table: m[1].toLowerCase(), field: m[2].toLowerCase(), raw: m[0] });
  }
  for (const m of text.matchAll(/\b((?:sys_|u_|x_[a-z0-9_]+_|cmdb_|task_|sc_|kb_|alm_|chg_)[a-z0-9_]{2,}|incident|problem|change_request|sys_user)\b/gi)) {
    const name = m[1].toLowerCase();
    if (out.some((s) => s.table === name)) continue;
    out.push({ kind: 'table', table: name, field: null, raw: m[0] });
  }
  return out;
}

export const _internals = { LIVE_REQUIRED, CONTEXT_OK };
