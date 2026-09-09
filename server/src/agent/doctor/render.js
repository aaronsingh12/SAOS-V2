/**
 * PHASE 14 — THE ANSWER A PERSON READS.
 *
 * §46 describes what the response should feel like: what I found, what it
 * means, what I cannot establish, what I recommend. This renders exactly that,
 * and renders it FROM THE STRUCTURE — every line traces to a fact, a
 * hypothesis, an unknown or a recommendation that survived the checks in
 * `diagnosis.js`.
 *
 * WHY THE NARRATIVE IS ASSEMBLED HERE RATHER THAN WRITTEN BY THE MODEL. A
 * second model call to "write this up nicely" would be a second opportunity to
 * assert something the evidence does not support — and it would be the one the
 * user actually reads, which makes it the worst possible place for it. So the
 * prose is templated: selection is allowed, invention is not representable.
 *
 * Markdown, because the chat surface already renders it and §45 says to add a
 * Doctor presentation to the existing experience rather than a second one.
 */
import { OUTCOMES, CLAIM_TYPES } from './schemas.js';

/** How the outcome reads as a confidence sentence, in the reader's terms. */
const CONFIDENCE_LINE = Object.freeze({
  [OUTCOMES.ROOT_CAUSE_ESTABLISHED]:
    'High — the observed state is confirmed and the evidence has no gaps or contradictions.',
  [OUTCOMES.LIKELY_CAUSE_IDENTIFIED]:
    'Moderate — the observed state is confirmed, but something relevant could not be established.',
  [OUTCOMES.POSSIBLE_CAUSE]:
    'Low — the leading explanation rests on thin or contested evidence.',
  [OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES]:
    'Low — more than one explanation remains consistent with what was read.',
  [OUTCOMES.INSUFFICIENT_EVIDENCE]:
    'None — the evidence collected does not support any explanation.',
  [OUTCOMES.NO_PROBLEM_FOUND]:
    'High — the reported condition was checked directly and is not present.',
  [OUTCOMES.INVESTIGATION_BLOCKED]:
    'None — the investigation could not be carried out.',
});

/**
 * The facts worth showing.
 *
 * The ones the conclusion rests on, plus the symptom itself. A full incident is
 * around ninety observations and printing them all would bury the four that
 * matter — but the rest are not discarded, they remain in the evidence, which
 * is where a reader who wants to audit goes.
 */
function highlights(diagnosis, limit = 8) {
  const cited = new Set([
    ...(diagnosis.conclusion?.supporting_evidence ?? []),
    ...(diagnosis.hypotheses ?? []).flatMap((h) => h.evidence_for ?? []),
  ]);
  const symptomField = diagnosis.symptom?.field ?? null;
  const chosen = (diagnosis.facts ?? []).filter(
    (f) => cited.has(f.id) || (symptomField && f.field === symptomField));
  return (chosen.length ? chosen : (diagnosis.facts ?? [])).slice(0, limit);
}

/** One fact, as a bullet. Reads the display value where there is one. */
const bullet = (f) => {
  const shown = f.display && f.display !== String(f.value) ? f.display : f.value;
  if (shown === '' || shown === null || shown === undefined) return `- ${f.field}: *(empty)*`;
  return `- ${f.field}: ${shown}`;
};

/**
 * Render a finished diagnosis as Markdown.
 *
 * Never throws and never omits a section that has content. A run that stopped
 * early renders the stop reason where the assessment would be, so the shape of
 * the answer is the same whatever happened — a reader learns where to look once.
 */
export function renderDiagnosis(diagnosis) {
  if (!diagnosis) return '_No diagnosis was produced._';
  const out = [];
  const subject = diagnosis.subject?.identifier
    ? `${diagnosis.subject.type} ${diagnosis.subject.identifier}`
    : 'the record';

  out.push('## Diagnosis');
  out.push('');
  out.push(diagnosis.conclusion?.statement ?? `Nothing was established about ${subject}.`);

  if (diagnosis.stopped) {
    out.push('');
    out.push('### The investigation stopped');
    out.push('');
    out.push(`${diagnosis.stopped.note}`);
    out.push('');
    out.push(`*Reason: \`${diagnosis.stopped.reason}\`*`);
  }

  const shown = highlights(diagnosis);
  if (shown.length) {
    out.push('');
    out.push('### What I found');
    out.push('');
    for (const f of shown) out.push(bullet(f));
    const rest = (diagnosis.facts?.length ?? 0) - shown.length;
    if (rest > 0) out.push(`- *(${rest} further observations were read and are in the evidence)*`);
  }

  /*
   * PHASE 15 — the timeline, between what was found and what it means (§29).
   *
   * Rendered only when there is one. §29 is explicit that a section with no
   * evidence should not appear: an empty "Timeline" heading tells a reader the
   * system looked and found nothing, when in fact it never looked.
   *
   * Events in the same second are grouped rather than ordered, because the
   * instance did not record which came first and inventing an order here is
   * exactly the sort of small fabrication that makes a whole report untrue.
   */
  const events = diagnosis.timeline?.events ?? [];
  if (events.length) {
    out.push('');
    out.push('### Timeline');
    out.push('');
    const sameInstant = new Set(
      (diagnosis.timeline.simultaneous ?? []).flatMap((g) => g.labels),
    );
    let lastAt = null;
    for (const e of events) {
      const at = e.at ? String(e.at).slice(11, 16) : '  —  ';
      const marker = sameInstant.has(e.label) && e.at === lastAt ? ' *(same instant)*' : '';
      out.push(`- \`${at}\` ${e.label}${marker}`);
      lastAt = e.at;
    }
    if (diagnosis.timeline.untimed) {
      out.push(`- *(${diagnosis.timeline.untimed} observation(s) carried no timestamp and are not placed)*`);
    }
    out.push('');
    out.push('*Order only. Something happening before another thing is not evidence that it caused it.*');
  }

  const live = (diagnosis.hypotheses ?? []).filter((h) => h.status !== 'rejected');
  const rejected = (diagnosis.hypotheses ?? []).filter((h) => h.status === 'rejected');
  if (live.length || rejected.length) {
    out.push('');
    out.push('### Assessment');
    out.push('');
    out.push(`**${diagnosis.cause_label}** — ${diagnosis.reason ?? ''}`.trim());
    if (live.length) {
      out.push('');
      for (const h of live) {
        out.push(`- ${h.statement}  *(${h.status}, ${h.confidence} confidence, `
          + `${h.evidence_for.length} supporting${h.evidence_against.length ? `, ${h.evidence_against.length} against` : ''})*`);
      }
    }
    /*
     * REJECTED HYPOTHESES ARE SHOWN, not hidden. "I considered that the
     * workflow failed and the evidence says otherwise" is one of the most
     * useful things a diagnostic tool can tell somebody, and dropping it would
     * make the report look like it never had the idea.
     */
    if (rejected.length) {
      out.push('');
      out.push('**Ruled out**');
      out.push('');
      for (const h of rejected) out.push(`- ~~${h.statement}~~ — contradicted by the evidence read`);
    }
  }

  const unknowns = (diagnosis.unknowns ?? []).filter((u) => u.type === CLAIM_TYPES.UNKNOWN || u.statement);
  if (unknowns.length) {
    out.push('');
    out.push('### What I cannot establish');
    out.push('');
    for (const u of unknowns) out.push(`- ${u.statement} *(${u.reason})*`);
  }

  if (diagnosis.recommendations?.length) {
    out.push('');
    out.push('### Recommendation');
    out.push('');
    for (const r of diagnosis.recommendations) {
      out.push(`- ${r.statement}${r.mutation ? '  **(requires your approval)**' : ''}`);
      for (const reason of (Array.isArray(r.reason) ? r.reason : [r.reason]).filter(Boolean)) {
        out.push(`  - ${reason}`);
      }
    }
  }

  out.push('');
  out.push('### Confidence');
  out.push('');
  out.push(CONFIDENCE_LINE[diagnosis.outcome] ?? 'Not assessed.');

  return out.join('\n');
}
