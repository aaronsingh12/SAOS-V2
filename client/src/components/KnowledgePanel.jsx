/**
 * PHASE 19 — INSTANCE KNOWLEDGE, on screen.
 *
 * §41 asks the UI to label authority clearly, and that is the whole design:
 * every item is rendered under a heading naming WHERE IT CAME FROM rather than
 * what it is about. §80.4 makes presenting retrieved text as live fact a
 * release blocker, and the way that failure actually happens is not a lie — it
 * is a confident paragraph under a heading that does not say it is
 * documentation.
 *
 * THE CLIENT HAS NO OPINION. Authority, freshness and `authorises` are rendered
 * verbatim from the server. Nothing here derives a label, because a label this
 * component computed could disagree with the evidence, and the version a person
 * reads would be the one that was wrong. The same rule LintPanel follows, for
 * the same reason.
 *
 * §42's account of what was used is collapsed by default: a reader who wants to
 * know why an answer says what it says can open it, and one who does not is not
 * made to scroll past it.
 */
import { useState } from 'react';

/* Strongest authority first, always. Mirrors the server renderer exactly. */
const SECTIONS = [
  { authority: 'live', heading: 'Live evidence', note: 'Read from the instance for this question.' },
  { authority: 'managed_source', heading: 'Managed source', note: 'From the source this project builds from.' },
  { authority: 'ledger', heading: 'Verified instance knowledge', note: 'Measured on an instance and recorded with its evidence.' },
  { authority: 'documentation', heading: 'Documentation', note: 'Describes a release on an instance configured the way it assumes.' },
  { authority: 'historical', heading: 'Historical notes', note: 'What happened before. Not a rule.' },
  { authority: 'model', heading: 'Model knowledge', note: 'A prior, with no artifact behind it.' },
];

const AUTHORITY_CLASS = {
  live: 'kn-live',
  managed_source: 'kn-managed',
  ledger: 'kn-ledger',
  documentation: 'kn-doc',
  historical: 'kn-historical',
  model: 'kn-model',
};

export default function KnowledgePanel({ knowledge, onAsk }) {
  const [showSources, setShowSources] = useState(false);
  if (!knowledge) return null;

  const {
    verdict, question, live_facts: live = [], knowledge: items = [],
    conflicts = [], unknowns = [], retrieval, classification, scope, stopped,
  } = knowledge;

  if (verdict === 'CANCELLED') {
    return (
      <div className="knowledge">
        <div className="ev-block">
          <div className="ev-section">Instance knowledge</div>
          <p className="dx-statement">{stopped?.note ?? 'The question was cancelled.'}</p>
        </div>
      </div>
    );
  }

  /* §80.8 — a store that FAILED is never drawn as a store that found nothing. */
  if (verdict === 'RETRIEVAL_UNAVAILABLE') {
    return (
      <div className="knowledge">
        <div className="ev-block">
          <div className="ev-section">Knowledge unavailable</div>
          <p className="dx-statement">
            Retrieval could not run, so nothing is known either way about this question.
            This is not the same as finding nothing.
          </p>
          <ul className="kn-unknowns">
            {(retrieval?.unavailable ?? []).map((u) => (
              <li key={u.store}>{u.store}: {u.reason}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  const all = [...live, ...items];
  const counts = SECTIONS
    .map((s) => ({ ...s, n: all.filter((i) => i?.provenance?.authority === s.authority).length }))
    .filter((s) => s.n > 0);

  return (
    <div className="knowledge">
      <div className="ev-block">
        <div className="ev-section">Instance knowledge</div>
        {question ? <p className="kn-question">{question}</p> : null}

        {/* §41 — which instance this answer is about, before any of it is read. */}
        {scope?.instance ? (
          <p className="kn-scope">Scoped to {scope.instance}. Global knowledge is admitted for any instance.</p>
        ) : (
          <p className="kn-scope">This session is not bound to an instance, so only global knowledge is shown.</p>
        )}

        {verdict === 'INSUFFICIENT_EVIDENCE' ? (
          <div className="kn-insufficient">
            <strong>Insufficient evidence.</strong>{' '}
            {knowledge.answer ?? 'This question needs a live reading that was not available.'}
          </div>
        ) : null}

        {/* §24 — the conflict, before anything it affects. */}
        {conflicts.map((c) => (
          <div className="kn-conflict" key={c.subject}>
            <div className="kn-conflict-head">Conflict — {c.subject}</div>
            <p className="kn-conflict-lead">The current instance differs from the retrieved knowledge.</p>
            {c.higher_authority ? (
              <div className="kn-line kn-live">
                <span className="kn-tag">live instance</span> {c.higher_authority.says}
              </div>
            ) : null}
            {(c.lower_authority ?? []).map((l) => (
              <div className="kn-line kn-overruled" key={l.ref}>
                <span className="kn-tag">overruled · {l.source}</span> {l.says}
              </div>
            ))}
            <p className="kn-conflict-why">{c.explanation}</p>
            {c.ask ? <p className="kn-conflict-ask">This needs a person: {c.ask}</p> : null}
          </div>
        ))}

        {/* The evidence, by authority. */}
        {SECTIONS.map((section) => {
          const group = all.filter((i) => i?.provenance?.authority === section.authority);
          if (!group.length) return null;
          return (
            <div className="kn-section" key={section.authority}>
              <div className="kn-section-head">{section.heading}</div>
              <div className="kn-section-note">{section.note}</div>
              {group.map((item) => (
                <div className={`kn-item ${AUTHORITY_CLASS[section.authority] ?? ''}`} key={item.id}>
                  <div className="kn-item-head">
                    <span className="kn-item-title">{item.title ?? item.id}</span>
                    {item.freshness?.state === 'stale' ? <span className="kn-badge kn-stale">stale</span> : null}
                    {item.freshness?.state === 'fresh' && item.freshness?.verified_at
                      ? <span className="kn-badge kn-fresh">verified {String(item.freshness.verified_at).slice(0, 10)}</span>
                      : null}
                  </div>
                  <p className="kn-item-body">{item.content}</p>
                  <div className="kn-item-meta">
                    <span>{item.provenance?.source}</span>
                    {item.scope?.instance ? <span>scope: {item.scope.instance}</span> : null}
                    {!item.scope?.instance && item.scope?.level ? <span>scope: {String(item.scope.level).toLowerCase()}</span> : null}
                    {item.duplicates ? <span>{item.duplicates + 1} sources agreed</span> : null}
                    {item.provenance?.ref?.startsWith('http')
                      ? <a href={item.provenance.ref} target="_blank" rel="noreferrer">source</a>
                      : null}
                  </div>
                  {item.freshness?.stale_because
                    ? <div className="kn-item-stale">stale: {item.freshness.stale_because}</div>
                    : null}
                </div>
              ))}
            </div>
          );
        })}

        {/* §43 — nothing found is stated, never implied by an empty panel. */}
        {!all.length ? (
          <p className="kn-empty">No relevant instance-specific knowledge was found.</p>
        ) : null}

        {unknowns.length ? (
          <div className="kn-section">
            <div className="kn-section-head">Not established</div>
            <ul className="kn-unknowns">
              {unknowns.map((u) => <li key={u.statement}>{u.statement}</li>)}
            </ul>
          </div>
        ) : null}

        {/* §42 — collapsible. */}
        {counts.length || retrieval ? (
          <div className="kn-sources">
            <button type="button" className="kn-toggle" onClick={() => setShowSources((v) => !v)}>
              {showSources ? '▾' : '▸'} Sources used
            </button>
            {showSources ? (
              <ul className="kn-source-list">
                {counts.map((c) => <li key={c.authority}>{c.n} × {c.heading.toLowerCase()}</li>)}
                {retrieval?.considered
                  ? <li>{retrieval.considered} considered, {retrieval.admitted} admitted after instance isolation</li>
                  : null}
                {(retrieval?.isolated_out ?? []).map((d) => (
                  <li key={d.id}>excluded — {d.title ?? d.id}: {d.reason}</li>
                ))}
                {retrieval?.degraded
                  ? <li>retrieval was degraded: keyword matching only, no embeddings</li>
                  : null}
                {(retrieval?.unavailable ?? []).map((u) => (
                  <li key={u.store}>the {u.store} store was unavailable: {u.reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* §82's closing line, and it is not decoration: it is the sentence that
            stops a reader taking a documentation paragraph for live truth. */}
        <p className="kn-authority">
          {live.length
            ? 'The live instance is the authoritative source for the current behaviour.'
            : classification?.classification === 'LIVE_TRUTH_REQUIRED'
              ? 'Nothing above establishes the current behaviour. Read the instance before acting on any of it.'
              : 'None of the above was confirmed against the instance as it is right now.'}
        </p>
      </div>
    </div>
  );
}

/**
 * The compact form another view embeds (§38, §39, §40).
 *
 * Still labelled, deliberately. A lint finding that quotes instance knowledge
 * without saying it is knowledge has done the exact thing §38 forbids.
 */
export function KnowledgeAside({ panel }) {
  if (!panel) return null;
  if (panel.empty) {
    return (
      <div className="kn-aside">
        <div className="kn-aside-head">Relevant knowledge</div>
        <p className="kn-empty">{panel.text}</p>
      </div>
    );
  }
  return (
    <div className="kn-aside">
      <div className="kn-aside-head">{panel.heading}</div>
      {panel.entries.map((e) => (
        <div className={`kn-item ${AUTHORITY_CLASS[e.authority] ?? ''}`} key={`${e.title}-${e.ref}`}>
          <div className="kn-item-head">
            <span className="kn-tag">{e.label}</span>
            <span className="kn-item-title">{e.title}</span>
          </div>
          <p className="kn-item-body">{e.content}</p>
          <div className="kn-item-meta">
            <span>{e.source}</span>
            {e.scope ? <span>scope: {e.scope}</span> : null}
          </div>
        </div>
      ))}
      <p className="kn-aside-note">{panel.note}</p>
    </div>
  );
}
