/**
 * PHASE 16 — NOWLINT, on screen.
 *
 * §37. The two filters are the design: SEVERITY and STATUS are independent
 * axes, so a reader can ask "what is definitely wrong" and "what would hurt
 * most" as separate questions. Collapsing them into one ordered list — which is
 * what most linters do — hides exactly the distinction this phase exists to
 * preserve.
 *
 * "Do not render unsupported certainty as confirmed" (§37) is enforced by
 * rendering `status` verbatim from the server and never deriving it here. The
 * client has no rule engine and no opinion; if it computed a status it could
 * disagree with the evidence, and the version a person reads would be the one
 * that was wrong.
 *
 * Findings are GROUPED BY CERTAINTY, worst-supported last. A confirmed problem
 * is work; a possible one is a question. Putting a speculative CRITICAL above a
 * confirmed HIGH would teach people to distrust the ordering, and a linter
 * nobody trusts is a linter nobody runs.
 */
import { useState } from 'react';

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUS_ORDER = ['CONFIRMED', 'LIKELY', 'POSSIBLE'];

const SEVERITY_CLASS = {
  CRITICAL: 'lint-critical',
  HIGH: 'lint-high',
  MEDIUM: 'lint-medium',
  LOW: 'lint-low',
  INFO: 'lint-info',
};

const KIND_LABEL = {
  RISK: 'Risk',
  BEST_PRACTICE: 'Best practice',
  PLATFORM_LIMITATION: 'Platform limitation',
};

export default function LintPanel({ lint }) {
  const [severity, setSeverity] = useState('All');
  const [status, setStatus] = useState('All');
  if (!lint) return null;

  if (lint.stopped) {
    return (
      <div className="lint">
        <div className="ev-block">
          <div className="ev-section">NowLint</div>
          <p className="dx-statement">{lint.stopped.note}</p>
          {lint.stopped.candidates?.length > 0 && (
            <ul className="ev-list">
              {lint.stopped.candidates.map((c) => (
                <li key={c.sys_id}>
                  {c.name} <span className="dx-source">{c.sys_id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const all = lint.findings ?? [];
  const shown = all.filter((f) => (severity === 'All' || f.severity === severity)
    && (status === 'All' || f.status === status));
  const s = lint.summary ?? {};

  return (
    <div className="lint">
      <div className="ev-block">
        <div className="ev-section">NowLint — {lint.flow?.name ?? 'flow'}</div>
        <p className="lint-counts">
          {s.confirmed ? <span className="lint-count lint-confirmed">{s.confirmed} confirmed</span> : null}
          {s.likely ? <span className="lint-count lint-likely">{s.likely} likely</span> : null}
          {s.possible ? <span className="lint-count lint-possible">{s.possible} possible</span> : null}
          {/* An unavailable check is shown beside the findings, never below the
              fold: §41 forbids a clean-looking result when checks did not run. */}
          {s.unknown ? <span className="lint-count lint-unknown">{s.unknown} unavailable</span> : null}
          {!all.length && !s.unknown ? <span className="lint-count">no findings</span> : null}
        </p>
      </div>

      {all.length > 0 && (
        <div className="ev-block lint-filters">
          <div className="lint-filter-row">
            {['All', ...SEVERITY_ORDER].map((v) => (
              <button
                key={v}
                type="button"
                className={`lint-chip${severity === v ? ' lint-chip-on' : ''}`}
                onClick={() => setSeverity(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="lint-filter-row">
            {['All', ...STATUS_ORDER].map((v) => (
              <button
                key={v}
                type="button"
                className={`lint-chip${status === v ? ' lint-chip-on' : ''}`}
                onClick={() => setStatus(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {STATUS_ORDER.map((group) => {
        const findings = shown.filter((f) => f.status === group);
        if (!findings.length) return null;
        return (
          <div className="ev-block" key={group}>
            <div className="ev-section">
              {group === 'CONFIRMED' ? 'Confirmed problems'
                : group === 'LIKELY' ? 'Likely problems' : 'Possible risks'}
            </div>
            {findings.map((f) => (
              <div className={`lint-card ${SEVERITY_CLASS[f.severity] ?? ''}`} key={f.id}>
                <div className="lint-head">
                  <span className="lint-sev">{f.severity}</span>
                  <span className="lint-rule">{f.rule_id}</span>
                  {KIND_LABEL[f.kind] && <span className="lint-kind">{KIND_LABEL[f.kind]}</span>}
                </div>
                <div className="lint-title">{f.title}</div>
                <div className="lint-body">{f.description}</div>
                {f.why_it_matters && (
                  <div className="lint-why"><strong>Why it matters:</strong> {f.why_it_matters}</div>
                )}
                {f.evidence?.length > 0 && (
                  <ul className="ev-list lint-evidence">
                    {f.evidence.map((e, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={i}>
                        <span className="lint-source">{e.source}</span>
                        {[e.step, [e.table, e.field].filter(Boolean).join('.'), e.input, e.detail]
                          .filter(Boolean).join(' · ')}
                      </li>
                    ))}
                  </ul>
                )}
                {f.recommendation?.statement && (
                  <div className="lint-fix"><strong>Recommended fix:</strong> {f.recommendation.statement}</div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {/* §39 — checks that could not run are a section, not a footnote. */}
      {lint.unknown_checks?.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">What I could not check</div>
          <ul className="ev-list">
            {lint.unknown_checks.map((u, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}><span className="lint-source">{u.rule_id}</span>{u.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="dx-caveat">
        {s.clean
          ? `No issues detected by the ${s.rules_run} rules that ran.`
          : 'No changes have been made.'}
      </p>
    </div>
  );
}
