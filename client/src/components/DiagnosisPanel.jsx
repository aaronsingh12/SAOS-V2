/**
 * PHASE 14 — THE DOCTOR'S ANSWER, on screen.
 *
 * §45 asks for a presentation inside the existing AgentChat experience that
 * distinguishes Observed, Possible, Likely, Unknown and Recommendation, and
 * communicates four things: what I found, what it means, what I cannot
 * establish, what I recommend.
 *
 * THE WHOLE POINT IS THE DISTINCTION. A diagnosis that renders facts and
 * inferences in the same typeface has thrown away the one property this phase
 * spent its effort establishing — so an observation and a guess never look
 * alike here, and the strength of a guess is on its face rather than implied by
 * the confidence with which it is worded.
 *
 * IT RENDERS ONLY WHAT THE SERVER DECIDED. `cause_label`, `status`,
 * `confidence` and `support_level` all arrive computed; nothing is derived in
 * the browser. A client that recomputed a label could disagree with the
 * evidence rule, and the version a person reads is the one that would be wrong.
 *
 * Reuses the existing `ev-*` styles so it sits inside the current visual
 * language rather than introducing a second one.
 */
import { useState } from 'react';

/** The five words §45 asks the reader to be able to tell apart. */
const TONE = {
  FACT: { label: 'Observed', className: 'dx-observed' },
  supported: { label: 'Likely', className: 'dx-likely' },
  plausible: { label: 'Possible', className: 'dx-possible' },
  unknown: { label: 'Unknown', className: 'dx-unknown' },
  rejected: { label: 'Ruled out', className: 'dx-rejected' },
};

const OUTCOME_TONE = {
  ROOT_CAUSE_ESTABLISHED: 'dx-likely',
  LIKELY_CAUSE_IDENTIFIED: 'dx-likely',
  POSSIBLE_CAUSE: 'dx-possible',
  MULTIPLE_PLAUSIBLE_CAUSES: 'dx-possible',
  INSUFFICIENT_EVIDENCE: 'dx-unknown',
  NO_PROBLEM_FOUND: 'dx-observed',
  INVESTIGATION_BLOCKED: 'dx-unknown',
};

const shown = (f) => {
  const v = f.display && f.display !== String(f.value) ? f.display : f.value;
  return v === '' || v === null || v === undefined ? null : String(v);
};

export default function DiagnosisPanel({ diagnosis }) {
  const [showAll, setShowAll] = useState(false);
  if (!diagnosis) return null;

  const facts = diagnosis.facts ?? [];
  const cited = new Set([
    ...(diagnosis.conclusion?.supporting_evidence ?? []),
    ...(diagnosis.hypotheses ?? []).flatMap((h) => h.evidence_for ?? []),
  ]);
  const symptomField = diagnosis.symptom?.field ?? null;
  const relevant = facts.filter((f) => cited.has(f.id) || (symptomField && f.field === symptomField));
  const visible = showAll ? facts : (relevant.length ? relevant : facts.slice(0, 8));

  const live = (diagnosis.hypotheses ?? []).filter((h) => h.status !== 'rejected');
  const rejected = (diagnosis.hypotheses ?? []).filter((h) => h.status === 'rejected');

  return (
    <div className="dx">
      {/* WHAT IT MEANS — first, because it is the answer. */}
      <div className="ev-block">
        <div className={`dx-verdict ${OUTCOME_TONE[diagnosis.outcome] ?? 'dx-unknown'}`}>
          {diagnosis.cause_label}
        </div>
        <p className="dx-statement">{diagnosis.conclusion?.statement}</p>
        {diagnosis.stopped && (
          <p className="dx-stopped">
            The investigation stopped: {diagnosis.stopped.note}
          </p>
        )}
      </div>

      {/* WHAT I FOUND */}
      {visible.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">What I found</div>
          {visible.map((f) => (
            <div className="ev-field" key={f.id}>
              <span className="ev-label">{f.field}</span>
              <span className="ev-value">
                {shown(f) ?? <em className="dx-empty">empty</em>}
                {/* Provenance stays visible: an observation a reader cannot
                    trace is indistinguishable from an assertion. */}
                <span className="dx-source" title={`${f.source?.tool} @ ${f.source?.step}`}>
                  {f.source?.table ?? 'record'}
                </span>
              </span>
            </div>
          ))}
          {facts.length > visible.length && (
            <button type="button" className="dx-more" onClick={() => setShowAll(true)}>
              Show all {facts.length} observations
            </button>
          )}
        </div>
      )}

      {/* PHASE 15 — TIMELINE (§29). Rendered only when events were collected;
          an empty timeline panel would say "we looked and found nothing" about
          an investigation that never looked. */}
      {(diagnosis.timeline?.events?.length ?? 0) > 0 && (
        <div className="ev-block">
          <div className="ev-section">Timeline</div>
          <ol className="dx-timeline">
            {diagnosis.timeline.events.map((e, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}>
                <span className="dx-time">{e.at ? String(e.at).slice(11, 16) : '—'}</span>
                <span className="dx-hyp-text">{e.label}</span>
              </li>
            ))}
          </ol>
          <p className="dx-caveat">
            Order only — one thing happening before another is not evidence that it caused it.
          </p>
        </div>
      )}

      {/* ASSESSMENT — every explanation with its earned standing on its face. */}
      {(live.length > 0 || rejected.length > 0) && (
        <div className="ev-block">
          <div className="ev-section">Assessment</div>
          {live.map((h) => (
            <div className="dx-hyp" key={h.id}>
              <span className={`dx-tag ${TONE[h.status]?.className ?? 'dx-unknown'}`}>
                {TONE[h.status]?.label ?? h.status}
              </span>
              <span className="dx-hyp-text">{h.statement}</span>
              <span className="dx-evidence">
                {h.evidence_for?.length ?? 0} for
                {h.evidence_against?.length ? ` · ${h.evidence_against.length} against` : ''}
                {h.missing_evidence?.length ? ` · ${h.missing_evidence.length} unanswered` : ''}
              </span>
            </div>
          ))}
          {/* Ruled out is shown, never hidden — "I considered that and the
              evidence says otherwise" is one of the most useful things here. */}
          {rejected.map((h) => (
            <div className="dx-hyp dx-struck" key={h.id}>
              <span className="dx-tag dx-rejected">Ruled out</span>
              <span className="dx-hyp-text">{h.statement}</span>
            </div>
          ))}
        </div>
      )}

      {/* WHAT I CANNOT ESTABLISH */}
      {diagnosis.unknowns?.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">What I cannot establish</div>
          <ul className="ev-list">
            {diagnosis.unknowns.map((u, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}>
                {u.statement} <span className="dx-source">{u.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* WHAT I RECOMMEND */}
      {diagnosis.recommendations?.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">Recommendation</div>
          {diagnosis.recommendations.map((r, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div className="dx-rec" key={i}>
              <span className="dx-hyp-text">{r.statement}</span>
              {/* A change is never offered as a button here. It becomes a plan,
                  and the plan raises the existing approval card. */}
              {r.mutation && <span className="dx-tag dx-approval">Needs your approval</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
