/**
 * PHASE 19 — THE ANSWER, WITH ITS SOURCES KEPT APART.
 *
 * §21 asks for a structured answer whose evidence chain survives even when the
 * prose does not. This file builds it, and the shape is the safety argument:
 * `live_facts` and `knowledge` are separate arrays that are never merged,
 * because §80.4 makes presenting retrieved text as live fact a release blocker
 * and the cheapest way to cause exactly that is one list and a hopeful renderer.
 *
 * ═══ WHAT HAPPENS WHEN THEY DISAGREE (§24, §71) ═══
 *
 * Not a preference — an adjudication, performed by `precedence.js`'s existing
 * `resolveConflict`, which this file calls rather than reimplements. The
 * outcome is always the same shape: the higher rung wins, the lower one is kept
 * and shown as overruled, and the disagreement is REPORTED. §24's closing line
 * is "do not hide the conflict", and a conflict that is resolved silently is
 * hidden however correct the resolution was.
 *
 * ═══ WHAT RETRIEVAL IS NEVER ALLOWED TO DO ═══
 *
 * Answer a LIVE_TRUTH_REQUIRED question on its own. When the classifier says a
 * question is about what is true on the instance now and no live reading was
 * supplied, the verdict is INSUFFICIENT_EVIDENCE — not a documentation answer
 * with a caveat attached. §68 asks for exactly that, and a caveat is not a
 * substitute: a reader takes the answer and leaves the caveat.
 */
import { resolveConflict, canAuthorize } from '../../knowledge/precedence.js';
import {
  AUTHORITY, VERDICTS, FRESHNESS, QUESTION, emptyAnswer,
  authorisingSourceOf, itemCanAuthorize, isVerified,
} from './schemas.js';
import { classifyQuestion, subjectsOf } from './classify.js';
import { retrieve } from './retrieve.js';

const now = () => Date.now();

/**
 * Answer a question from live evidence and stored knowledge.
 *
 * @param liveEvidence  injected: (subjects, question) => KnowledgeItem[] built
 *                      with `fromLiveReading`. The ONLY way a live fact enters
 *                      this domain, and the reason nothing here imports a
 *                      client.
 */
export async function answerQuestion({
  question,
  stores = {},
  scope = {},
  liveEvidence = null,
  limits = {},
  signal = null,
  emit = () => {},
} = {}) {
  const started = now();
  const base = emptyAnswer();
  base.question = String(question ?? '');

  const classification = classifyQuestion(question);
  base.classification = classification;
  const subjects = subjectsOf(question);

  /* ---- 1. retrieval, isolated to this instance ---- */
  const retrieval = await retrieve({ query: question, stores, scope, limits, signal });
  base.retrieval = {
    mode: retrieval.mode,
    degraded: retrieval.degraded,
    considered: retrieval.considered,
    admitted: retrieval.admitted,
    isolated_out: retrieval.isolated_out,
    unavailable: retrieval.unavailable,
    complete: retrieval.complete,
    timings: retrieval.timings,
  };
  base.scope = retrieval.scope;
  base.knowledge = retrieval.items;
  base.sources = retrieval.items.map(citationOf);

  if (signal?.aborted) {
    /* §74 — a cancelled retrieval is not a completed one, and what was gathered
     * is kept rather than thrown away. */
    return { ...base, verdict: VERDICTS.CANCELLED, stopped: { reason: 'cancelled', note: 'The question was cancelled; what had been retrieved is kept and nothing was concluded.' }, timings: { total_ms: now() - started } };
  }

  /* ---- 2. live evidence (§17) ---- */
  const tLive = now();
  let live = [];
  if (typeof liveEvidence === 'function') {
    try {
      live = (await liveEvidence({ subjects, question, scope })) ?? [];
    } catch (err) {
      base.unknowns.push({
        statement: `Live evidence could not be read: ${err.message}`,
        reason: 'live_read_failed',
      });
    }
  }
  base.live_facts = live;
  const liveTiming = now() - tLive;

  /* ---- 3. §18/§68 — a live question with no live reading cannot be answered ---- */
  if (classification.live_required && !live.length) {
    return {
      ...base,
      verdict: VERDICTS.INSUFFICIENT_EVIDENCE,
      answer: insufficientText(classification, retrieval),
      unknowns: [
        ...base.unknowns,
        {
          statement: 'This question asks what is true on the instance right now, and no live reading was available.',
          reason: 'live_truth_required',
          why: classification.why,
        },
      ],
      timings: { ...retrieval.timings, live_ms: liveTiming, total_ms: now() - started },
    };
  }

  /* ---- 4. §24 — adjudicate where live and stored knowledge disagree ---- */
  const tConf = now();
  const conflicts = adjudicate({ question, live, knowledge: retrieval.items, subjects });
  base.conflicts = conflicts;

  /* §12 — an item the live instance contradicts is STALE. This is the only
   * place freshness is downgraded, and it is downgraded by EVIDENCE (a live
   * reading disagreed) rather than by a date. */
  if (conflicts.length) {
    const overruledIds = new Set(conflicts.flatMap((c) => (c.overruled ?? []).map((o) => o.ref)));
    base.knowledge = base.knowledge.map((k) => (overruledIds.has(k.id)
      ? { ...k, freshness: { ...k.freshness, state: FRESHNESS.STALE, stale_because: 'the live instance contradicts it' } }
      : k));
  }
  const conflictTiming = now() - tConf;

  /* ---- 5. the verdict ---- */
  const verdict = decide({ live, knowledge: base.knowledge, conflicts, retrieval });

  return {
    ...base,
    verdict,
    answer: null, /* the prose is the renderer's job; the evidence chain is this file's */
    inferences: inferencesFrom({ live, knowledge: base.knowledge, classification }),
    unknowns: [...base.unknowns, ...unknownsFrom({ retrieval, live, classification })],
    timings: {
      ...retrieval.timings, live_ms: liveTiming, conflict_ms: conflictTiming, total_ms: now() - started,
    },
  };
}

/* ------------------------------------------------------------------ *
 * §24 / §25 — conflict
 * ------------------------------------------------------------------ */

/**
 * Where a live reading and a stored item make claims about the same subject.
 *
 * SUBJECT MATCHING IS DELIBERATELY NARROW. Two items are about the same thing
 * when they name the same table.field or the same title — not when their text
 * merely overlaps. A loose match would manufacture conflicts between a page
 * about priority and a fact about urgency, and a report full of invented
 * disagreements is worse than one that misses a real one: the real one is still
 * visible in the sources, and the invented ones train a reader to skip the
 * section.
 */
export function adjudicate({ question, live, knowledge, subjects = [] }) {
  const out = [];
  for (const fact of live) {
    /*
     * THE SUBJECT COMES FROM THE QUESTION, NOT FROM STRING SIMILARITY.
     *
     * MEASURED, and it is why this is not a text-matching problem. A live fact
     * titled `incident.priority` and a documentation page titled "Incident
     * priority" are about the same thing and share no comparable key: one is
     * dotted, one is prose. Matching them by shape found nothing, so the exact
     * conflict §55 and §64 are about — live says derived, docs say writable —
     * went unreported.
     *
     * Anchoring on the subjects the QUESTION named fixes it in the narrow
     * direction rather than the loose one: two items are about the same thing
     * when they both talk about the thing that was asked about. A page that
     * mentions neither is not dragged in, and a page about a different field is
     * not either.
     */
    const subject = subjectOf(fact, subjects) ?? subjectKey(fact);
    if (!subject) continue;

    const rivals = knowledge.filter((k) => mentions(k, subject) && contradicts(fact, k));
    if (!rivals.length) continue;

    const resolution = resolveConflict({
      question: `${question} (${subject})`,
      claims: [
        {
          source: authorisingSourceOf(fact),
          says: fact.content,
          evidence: JSON.stringify(fact.freshness?.verification_source ?? {}),
          ref: fact.id,
        },
        ...rivals.map((k) => ({
          source: authorisingSourceOf(k),
          says: k.content,
          evidence: isVerified(k) ? JSON.stringify(k.freshness.verification_source) : undefined,
          ref: k.id,
        })),
      ],
    });

    out.push({
      conflict: true,
      subject,
      authority_winner: resolution.winner?.source ?? null,
      higher_authority: resolution.winner
        ? { ref: resolution.winner.ref, source: resolution.winner.source, says: resolution.winner.says }
        : null,
      lower_authority: (resolution.overruled ?? []).map((o) => ({ ref: o.ref, source: o.source, says: o.says })),
      overruled: resolution.overruled ?? [],
      demoted: resolution.demoted ?? [],
      verdict: resolution.verdict,
      explanation: resolution.reason,
      ask: resolution.ask ?? null,
      /* §35 — a resolved conflict still authorises nothing. Carried explicitly
       * so a caller cannot read "live won" as "therefore proceed". */
      authorises: false,
    });
  }
  return out;
}

/**
 * Which of the question's subjects this item is about, if any.
 *
 * A `table.field` subject matches an item that names it in the dotted form, OR
 * that names both halves separately — "the priority field ... on the incident
 * form" is about `incident.priority` and never writes it that way.
 */
function subjectOf(item, subjects) {
  const hay = `${item?.title ?? ''} ${item?.content ?? ''}`.toLowerCase();
  for (const s of subjects) {
    if (s.kind === 'field') {
      const dotted = `${s.table}.${s.field}`;
      if (hay.includes(dotted)) return dotted;
      /* Both halves present, as whole words. Requiring both is what keeps this
       * from matching every page that happens to say "incident". */
      if (word(hay, s.table) && word(hay, s.field)) return dotted;
    } else if (s.kind === 'table' && word(hay, s.table)) {
      return s.table;
    }
  }
  return null;
}

/** Does this item talk about that subject? Same rule, applied to a rival. */
function mentions(item, subject) {
  const hay = `${item?.title ?? ''} ${item?.content ?? ''}`.toLowerCase();
  if (hay.includes(subject)) return true;
  const [table, field] = String(subject).split('.');
  if (!field) return word(hay, table);
  return word(hay, table) && word(hay, field);
}

const word = (hay, w) => new RegExp(`\\b${String(w).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(hay);

/** table.field, or the item's own title. Null when neither is identifiable. */
function subjectKey(item) {
  const t = item?.scope?.table;
  const f = /\b([a-z][a-z0-9_]{2,})\.([a-z][a-z0-9_]{2,})\b/i.exec(`${item?.title ?? ''} ${item?.content ?? ''}`);
  if (f) return `${f[1].toLowerCase()}.${f[2].toLowerCase()}`;
  if (t && item?.title) return `${t}:${String(item.title).toLowerCase()}`;
  return item?.title ? String(item.title).toLowerCase() : null;
}

/**
 * Do these two say opposite things?
 *
 * A deliberately small vocabulary of opposites, because a general contradiction
 * detector is a research project and a wrong one manufactures conflicts. What
 * it catches is the shape §2 and §55 are actually about: one source says a
 * thing is derived / read-only / unsupported, and another says it is writable /
 * editable / supported.
 */
const POLARITY = Object.freeze([
  { positive: /\b(writable|writeable|editable|can be set|settable|assignable)\b/i,
    negative: /\b(derived|calculated|computed|read[\s-]?only|not writable|cannot be set|overwritten)\b/i },
  { positive: /\b(supported|available|works|enabled)\b/i,
    negative: /\b(unsupported|unavailable|not supported|does not work|disabled|cannot)\b/i },
]);

export function contradicts(a, b) {
  const x = String(a?.content ?? '');
  const y = String(b?.content ?? '');
  return POLARITY.some(({ positive, negative }) => (positive.test(x) && negative.test(y))
    || (negative.test(x) && positive.test(y)));
}

/* ------------------------------------------------------------------ *
 * Verdict, inferences, unknowns
 * ------------------------------------------------------------------ */

function decide({ live, knowledge, conflicts, retrieval }) {
  /* §80.8 — a store that failed is not a store that found nothing. */
  if (!retrieval.complete && !knowledge.length && !live.length) return VERDICTS.RETRIEVAL_UNAVAILABLE;
  if (conflicts.length) return VERDICTS.ANSWERED_WITH_CONFLICT;
  if (live.length || knowledge.length) return VERDICTS.ANSWERED;
  return VERDICTS.NO_KNOWLEDGE;
}

/**
 * What follows from the evidence, marked as following rather than as read.
 *
 * §21 keeps inferences in their own array for the same reason live facts are in
 * theirs: an inference is the system's reasoning, and a reader deciding whether
 * to act needs to see which parts of an answer were read and which were
 * concluded.
 */
function inferencesFrom({ live, knowledge, classification }) {
  const out = [];
  if (live.length && knowledge.length) {
    out.push({
      statement: 'Stored knowledge and the live instance were both consulted; where they agree, the live reading is what establishes it.',
      basis: 'authority ordering',
    });
  }
  if (classification.live_required && live.length) {
    out.push({
      statement: 'This question required live truth and a live reading was available, so the answer rests on the reading rather than on the retrieved text.',
      basis: 'question classification',
    });
  }
  return out;
}

function unknownsFrom({ retrieval, live, classification }) {
  const out = [];
  for (const u of retrieval.unavailable) {
    out.push({
      statement: `The ${u.store} store could not be searched (${u.reason}), so anything it holds on this subject was not considered.`,
      reason: 'retrieval_unavailable',
    });
  }
  if (retrieval.degraded) {
    out.push({
      statement: 'The embedding model was unavailable, so documentation was matched by keyword only. Relevant pages phrased differently were not found.',
      reason: 'degraded_retrieval',
    });
  }
  if (retrieval.isolated_out.length) {
    out.push({
      statement: `${retrieval.isolated_out.length} item(s) were excluded because they were learned on a different instance.`,
      reason: 'instance_isolation',
    });
  }
  if (!classification.live_required && !live.length) {
    out.push({
      statement: 'No live reading was taken, so nothing here is confirmed against the instance as it is right now.',
      reason: 'no_live_reading',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * §20 — citations, never fabricated
 * ------------------------------------------------------------------ */

/**
 * One citation.
 *
 * Every field is copied from the item, and there is no branch that invents one.
 * §80.7 makes a fabricated citation a release blocker, and the way to make that
 * impossible is for the citation builder to have no access to anything except
 * the item it is citing.
 */
export function citationOf(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title ?? null,
    source: item.provenance?.source ?? null,
    authority: item.provenance?.authority ?? null,
    ref: item.provenance?.ref ?? null,
    store: item.provenance?.store ?? null,
    scope: item.scope?.level ?? null,
    instance: item.scope?.instance ?? null,
    verified_at: item.freshness?.verified_at ?? null,
    freshness: item.freshness?.state ?? null,
    /* §35 — stated per citation, so it travels with the text it labels. */
    authorises: itemCanAuthorize(item),
  };
}

function insufficientText(classification, retrieval) {
  const bits = [
    'This asks what is true on the instance right now, and no live reading was available to answer it.',
  ];
  if (classification.why?.length) bits.push(classification.why[0]);
  if (retrieval.items.length) {
    bits.push(`${retrieval.items.length} related item(s) were retrieved and are shown below as context. `
      + 'None of them establishes the current behaviour.');
  }
  return bits.join(' ');
}

export { canAuthorize, QUESTION, AUTHORITY };
export const _internals = { subjectKey, POLARITY, decide, inferencesFrom, unknownsFrom };
