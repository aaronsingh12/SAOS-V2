import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, sse } from '../api.js';
import { SkeletonLines, EmptyState } from '../components/states.jsx';
import { toast } from '../components/toast.js';
import RemediationDrawer from '../components/RemediationDrawer.jsx';

/**
 * Health Assist — estate health over the bound instance.
 *
 * IT PROPOSES; IT DOES NOT APPLY. Generating a remediation plan changes
 * nothing: the AI reads the records, works out what it would set, and shows the
 * list. The instance is touched only after a human has read that list, edited
 * whatever they disagree with, and pressed Approve and apply — and then only
 * through the ordinary plan executor, which owns the gate, the read-back and
 * the audit trail. Approval is the boundary, not the kind of finding.
 *
 * THE RULE THIS PAGE IS BUILT AROUND: coverage is shown before findings, never
 * after. A list of problems with no account of what was read is unreadable —
 * you cannot tell a clean estate from an extraction that managed three rows,
 * and a partial read plus an absence rule ("no relationships") is how "we could
 * not see the table" becomes "your CMDB is broken".
 *
 * ON THE CHARTS. Severity is a STATUS scale, not a set of categories, so it
 * wears reserved status colours and every mark carries its word, its glyph and
 * its number. Identity never rests on hue — which is what makes Critical and
 * Major legible to a colourblind reader even though both sit at the red end.
 * The findings table below is the charts' table-view twin: every value in a bar
 * is also readable as text.
 */

/* ── Severity vocabulary ───────────────────────────────────────────────────
 * The words come from the SERVER (`meta.severities`). The page may not coin
 * vocabulary of its own — "Major" is the label for HIGH, and a private copy
 * would drift the first time a rule changed severity. This is only the
 * fallback order for rendering before meta has loaded.                       */
const SEVERITY_FALLBACK = [
  { key: 'CRITICAL', label: 'Critical', tone: 'critical', glyph: '▲' },
  { key: 'HIGH', label: 'Major', tone: 'major', glyph: '▲' },
  { key: 'MEDIUM', label: 'Moderate', tone: 'moderate', glyph: '●' },
  { key: 'LOW', label: 'Low', tone: 'low', glyph: '●' },
  { key: 'INFO', label: 'Info', tone: 'info', glyph: '·' },
];

/** Coverage statuses that mean rows were usable. Everything else is a reason. */
const USABLE = ['complete', 'limited', 'truncated'];

const COVERAGE_LABEL = {
  complete: 'read in full',
  limited: 'partly read',
  truncated: 'truncated',
  not_requested: 'not requested',
  unauthorized: 'not authorised',
  forbidden: 'no permission',
  unavailable: 'not on this instance',
  invalid_query: 'query refused',
  rate_limited: 'rate limited',
  upstream_error: 'error',
};

const coverageTone = (status) => {
  if (status === 'complete') return 'ok';
  if (USABLE.includes(status)) return 'warn';
  if (status === 'not_requested') return 'idle';
  return 'bad';
};

/**
 * A plain-English reading of the score.
 *
 * Deliberately coarse. A score of 84 and a score of 86 do not mean different
 * things, and a verdict that changed between them would imply a precision this
 * number does not have.
 */
function verdict(score) {
  if (score == null) return null;
  if (score >= 90) return { word: 'Healthy', tone: 'ok', line: 'Most configuration items came back clean.' };
  if (score >= 75) return { word: 'Mostly healthy', tone: 'ok', line: 'A minority of items need attention.' };
  if (score >= 50) return { word: 'Needs attention', tone: 'warn', line: 'A large share of items triggered a rule.' };
  return { word: 'Needs work', tone: 'bad', line: 'Most configuration items triggered at least one rule.' };
}

const minutes = (m) => {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
};

/* ── Marks ─────────────────────────────────────────────────────────────────
 * Thin bars, a 4px rounded data-end, a 2px surface gap, the value direct-
 * labelled at the end. No number floats free of its label.                   */
function Bar({ glyph, label, value, max, tone, onClick, active, hint }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`hs-bar${active ? ' is-active' : ''}${onClick ? ' is-clickable' : ''}`}
      onClick={onClick || undefined}
      type={onClick ? 'button' : undefined}
      title={hint || undefined}
      aria-pressed={onClick ? Boolean(active) : undefined}
    >
      <span className="hs-bar-name">
        {glyph && <span className={`hs-glyph tone-${tone}`} aria-hidden="true">{glyph}</span>}
        {label}
      </span>
      <span className="hs-bar-track">
        <span className={`hs-bar-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="hs-bar-value">{value}</span>
    </Tag>
  );
}

export default function HealthAssist() {
  const navigate = useNavigate();

  const [meta, setMeta] = useState(null);
  const [run, setRun] = useState(null);
  const [findings, setFindings] = useState([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ domain: '', severity: '' });
  const [showSkipped, setShowSkipped] = useState(false);

  /* The opened finding. `null` means the overview; anything else replaces it
     with the detail view, because two scroll positions on one page is how a
     reader loses their place. */
  const [openFinding, setOpenFinding] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [tab, setTab] = useState('ai');   // which solution lane is showing
  const [remediating, setRemediating] = useState(false);  // the review drawer

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, latest] = await Promise.all([api.get('/health/meta'), api.get('/health/runs/latest')]);
        if (!alive) return;
        setMeta(m);
        if (latest.run) { setRun(latest.run); setFindings(latest.findings || []); setTotal(latest.total || 0); }
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const severities = meta?.severities?.length ? meta.severities : SEVERITY_FALLBACK;
  const sevByKey = useMemo(
    () => Object.fromEntries(severities.map((s) => [s.key, s])),
    [severities],
  );

  const loadFindings = useCallback(async (runId, next) => {
    const qs = new URLSearchParams();
    if (next.domain) qs.set('domain', next.domain);
    if (next.severity) qs.set('severity', next.severity);
    qs.set('limit', '200');
    const data = await api.get(`/health/runs/${runId}/findings?${qs}`);
    setFindings(data.findings || []);
    setTotal(data.total || 0);
  }, []);

  const applyFilter = async (patch) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    if (run) { try { await loadFindings(run.id, next); } catch (e) { setError(e.message); } }
  };

  const start = async () => {
    setRunning(true); setError(''); setOpenFinding(null); setDetail(null);
    setProgress({ stage: 'starting', percent: 0 });
    let runId = null;
    try {
      await sse('/health/runs', {}, (evt) => {
        if (evt.type === 'run_started') runId = evt.runId;
        else if (evt.type === 'progress') setProgress(evt);
        else if (evt.type === 'error') throw new Error(evt.message);
      });
      if (runId) {
        setRun((await api.get(`/health/runs/${runId}`)).run);
        await loadFindings(runId, filter);
        toast.success('Health check complete.');
      }
    } catch (e) {
      setError(e.message);
      toast.error('The health check did not finish.');
      if (runId) { try { setRun((await api.get(`/health/runs/${runId}`)).run); } catch { /* nothing more to show */ } }
    } finally { setRunning(false); setProgress(null); }
  };

  const openDetail = async (fingerprint) => {
    setOpenFinding(fingerprint);
    setDetail(null);
    setDetailBusy(true);
    setTab('ai');
    try {
      setDetail(await api.get(`/health/runs/${run.id}/findings/${fingerprint}`));
    } catch (e) { setError(e.message); setOpenFinding(null); }
    finally { setDetailBusy(false); }
  };

  /*
   * Hand the finding to the agent.
   *
   * Navigation only — the draft is fetched by the Agent page on arrival and
   * PLACED in the composer for the user to read. This page cannot write to the
   * instance, and handing over a prompt must not become a way around that.
   */
  const askAgent = () => {
    navigate(`/agent?health=${encodeURIComponent(run.id)}:${encodeURIComponent(openFinding)}`);
  };

  const manifest = run?.manifest;
  const metrics = manifest?.metrics || {};
  const coverage = manifest?.coverage || {};
  const skipped = manifest?.skipped_checks || [];
  const sevCounts = manifest?.severity_counts || {};
  const score = metrics.cmdb_quality_score;
  const v = verdict(score);

  const coverageRows = useMemo(
    () => Object.values(coverage).filter((c) => c.status !== 'not_requested'),
    [coverage],
  );
  const unreadable = coverageRows.filter((c) => !USABLE.includes(c.status));

  const sevRows = severities
    .map((s) => ({ ...s, count: sevCounts[s.key] || 0 }))
    .filter((s) => s.count > 0 || ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(s.key));
  const sevMax = Math.max(1, ...sevRows.map((s) => s.count));

  const domainRows = (manifest?.domains || []).filter((d) => d.findings > 0)
    .sort((a, b) => b.findings - a.findings);
  const domainMax = Math.max(1, ...domainRows.map((d) => d.findings));

  if (loading) return <div className="card"><SkeletonLines lines={6} /></div>;

  /* ══ DETAIL VIEW ════════════════════════════════════════════════════════ */
  if (openFinding) {
    const f = detail?.finding;
    const r = detail?.remediation;
    const sev = f ? (sevByKey[f.severity] || { label: f.severity, tone: 'info', glyph: '●' }) : null;

    return (
      <div className="stack">
        <button type="button" className="btn ghost sm hs-back" onClick={() => { setOpenFinding(null); setDetail(null); }}>
          ← Back to all findings
        </button>

        {detailBusy && <div className="card"><SkeletonLines lines={8} /></div>}

        {f && r && (
          <>
            <div className="card hs-detail-head">
              <div className={`hs-sev-tag tone-${sev.tone}`}>
                <span aria-hidden="true">{sev.glyph}</span> {sev.label}
              </div>
              <h2 className="hs-detail-title">{r.headline}</h2>
              <p className="hs-detail-sub">{f.title}</p>
              <div className="hs-detail-meta">
                <span><b>{f.target_ids?.length ?? 0}</b> record{(f.target_ids?.length ?? 0) === 1 ? '' : 's'} affected</span>
                <span>rule <code>{f.rule_id}</code></span>
                <span>table <code>{f.table}</code></span>
              </div>
            </div>

            <div className="hs-split">
              {/* ── LEFT: what the problem is ───────────────────────────── */}
              <div className="card hs-pane">
                <div className="hs-pane-title">The problem</div>

                <p className="hs-lead">{r.problem}</p>

                <div className="hs-callout">
                  <b>Why it matters.</b> {r.why}
                </div>

                <div className="hs-sub">What the rule actually checked</div>
                <p className="hs-muted">{f.description}</p>

                <div className="hs-sub">Tables it read</div>
                <table className="table">
                  <thead><tr><th>Table</th><th>Fields</th><th>Why</th></tr></thead>
                  <tbody>
                    {r.tables.map((t) => (
                      <tr key={t.table}>
                        <td className="mono">{t.table}</td>
                        <td className="mono">{t.fields.join(', ') || '—'}</td>
                        <td>{t.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {f.impact && (
                  <>
                    <div className="hs-sub">Blast radius</div>
                    <p className="hs-muted">
                      Connected to <b>{f.impact.reachable_nodes}</b> record{f.impact.reachable_nodes === 1 ? '' : 's'} within{' '}
                      {f.impact.max_depth} hops. {f.impact.interpretation}.
                    </p>
                  </>
                )}

                {f.ai_summary && (
                  <div className="hs-callout">
                    <b>AI summary.</b> {f.ai_summary}{' '}
                    <em>Written from the finding above; the finding itself is deterministic.</em>
                  </div>
                )}

                <div className="hs-sub">Evidence · {f.evidence?.length ?? 0} field read(s)</div>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>sys_id</th><th>Field</th><th>Value</th></tr></thead>
                    <tbody>
                      {(f.evidence || []).slice(0, 25).map((e, i) => (
                        <tr key={`${e.sn_sys_id}-${e.field_name}-${i}`}>
                          <td className="mono">{e.sn_sys_id}</td>
                          <td className="mono">{e.field_name}</td>
                          <td className="mono">{e.field_value === '' ? <em>(empty)</em> : e.field_value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(f.evidence?.length ?? 0) > 25 && (
                  <p className="hs-muted">Showing the first 25 of {f.evidence.length} evidence rows.</p>
                )}
              </div>

              {/* ── RIGHT: how to fix it ────────────────────────────────── */}
              <div className="card hs-pane">
                <div className="hs-pane-title">The fix</div>

                <div className={`hs-decision tone-${r.decision === 'mechanical' ? 'ok' : 'warn'}`}>
                  <b>{r.decision === 'mechanical' ? 'This one has a definite fix.' : 'This one needs your judgement.'}</b>
                  <span>{r.decisionNote}</span>
                </div>

                {/*
                  * TIME, AS AN ESTIMATE.
                  *
                  * Stated as an estimate everywhere it appears, with its basis
                  * attached, because nothing here was timed. A confident number
                  * would be the one invented thing on a page whose whole point
                  * is that everything is derived.
                  */}
                <div className="hs-time">
                  <div className="hs-time-row">
                    <span className="hs-time-label">By hand</span>
                    <span className="hs-time-bar"><span className="hs-bar-fill tone-moderate" style={{ width: '100%' }} /></span>
                    <span className="hs-time-val">{minutes(r.effort.manualMinutes)}</span>
                  </div>
                  <div className="hs-time-row">
                    <span className="hs-time-label">With the agent</span>
                    <span className="hs-time-bar">
                      <span className="hs-bar-fill tone-ok"
                        style={{ width: `${Math.max(3, (r.effort.aiMinutes / Math.max(1, r.effort.manualMinutes)) * 100)}%` }} />
                    </span>
                    <span className="hs-time-val">{minutes(r.effort.aiMinutes)}</span>
                  </div>
                  <p className="hs-fine">
                    <b>Estimated, not measured.</b> {r.effort.basis} {r.effort.disclaimer}
                  </p>
                </div>

                <div className="hs-lanes" role="tablist">
                  <button type="button" role="tab" aria-selected={tab === 'ai'}
                    className={`hs-lane${tab === 'ai' ? ' is-on' : ''}`} onClick={() => setTab('ai')}>
                    {r.aiActionLabel}
                  </button>
                  <button type="button" role="tab" aria-selected={tab === 'manual'}
                    className={`hs-lane${tab === 'manual' ? ' is-on' : ''}`} onClick={() => setTab('manual')}>
                    Fix it myself
                  </button>
                </div>

                {tab === 'ai' ? (
                  <div className="hs-lane-body">
                    <p>
                      The AI reads these records, works out what it would change, and shows you the exact list —
                      record by record, field by field, with the current value beside the proposed one.
                    </p>
                    <p className="hs-fine">
                      <b>Nothing is applied by generating a plan.</b> You review it, edit any value you disagree with,
                      remove anything you do not want, and only then approve. Approval is the point at which the agent
                      is allowed to write, and it can only write the list you approved.
                    </p>
                    <button type="button" className="btn primary hs-cta" onClick={() => setRemediating(true)}>
                      Generate remediation plan →
                    </button>
                    {/*
                      * The old handoff, kept and demoted. A pre-written prompt
                      * is still the better tool for an open-ended question the
                      * change list cannot express — it just is not the default
                      * any more.
                      */}
                    <details className="hs-peek">
                      <summary>Or discuss it in the Agent instead</summary>
                      <pre className="hs-pre">{r.prompt}</pre>
                      <button type="button" className="btn sm hs-mt" onClick={askAgent}>
                        Open in Agent chat →
                      </button>
                    </details>
                  </div>
                ) : (
                  <div className="hs-lane-body">
                    <ol className="hs-steps">
                      {r.manualSteps.map((step, i) => (
                        <li key={i}>
                          <span className="hs-step-n">{i + 1}</span>
                          <span dangerouslySetInnerHTML={{ __html: mdLite(step) }} />
                        </li>
                      ))}
                    </ol>
                    <div className="hs-callout">
                      <b>How to check it worked.</b> {r.verify}
                    </div>
                  </div>
                )}

                {!r.known && (
                  <p className="hs-fine">
                    No hand-written guidance exists for this rule yet, so these are generic steps. The finding itself is
                    unaffected — it came from the rule pack and carries its own evidence.
                  </p>
                )}
              </div>
            </div>

            {/*
              * THE REVIEW WINDOW. `RecordDrawer` underneath — the same editing
              * surface six other pages open — so this is a seventh caller, not
              * a seventh editor.
              */}
            <RemediationDrawer
              open={remediating}
              runId={run.id}
              finding={f}
              onClose={() => setRemediating(false)}
            />
          </>
        )}
      </div>
    );
  }

  /* ══ OVERVIEW ═══════════════════════════════════════════════════════════ */
  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">Health Assist · read only</div>
        <div className="row">
          <button className="btn primary" onClick={start} aria-busy={running} disabled={running}>
            {running ? 'Checking…' : run ? 'Check again' : 'Run health check'}
          </button>
          {run && (
            <span className="mono hs-muted">
              last checked {new Date(run.startedAt).toLocaleString()}
            </span>
          )}
        </div>
        <div className="note hs-mt">
          Health Assist reads {meta?.tables?.length ?? 0} allow-listed tables off your instance and applies a fixed set of
          rules. It never writes, and it has no tool that could.
        </div>
        {running && progress && (
          <div className="note hs-mt">
            {progress.stage}{progress.table ? ` · ${progress.table}` : ''} — {progress.percent}%
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>

      {!run && !running && !error && (
        <div className="card">
          <EmptyState
            title="No health check has run against this instance."
            hint="A check reads your CMDB, services, integrations and platform tables, then reports what it found. Nothing is written."
            actionLabel="Run health check"
            onAction={start}
          />
        </div>
      )}

      {run && (
        <>
          {/* ── SCORECARD. The score is a hero number, not a chart — one
                 number does not need eight colours. ───────────────────────── */}
          <div className="card hs-scorecard">
            <div className="hs-score-block">
              {score == null ? (
                <>
                  <div className="hs-score hs-score-none">—</div>
                  <div className="hs-score-word">No score</div>
                </>
              ) : (
                <>
                  <div className={`hs-score tone-${v.tone}`}>{score}<span className="hs-score-pct">%</span></div>
                  <div className={`hs-score-word tone-${v.tone}`}>{v.word}</div>
                </>
              )}
              <div className="hs-score-cap">CMDB quality score</div>
            </div>

            <div className="hs-score-side">
              {score == null ? (
                <p className="hs-lead">
                  <b>No score this run.</b> {metrics.score_withheld_because}
                </p>
              ) : (
                <p className="hs-lead">{v.line} {metrics.score_definition}</p>
              )}
              <div className="hs-facts">
                <div><b>{metrics.visible_cis ?? '—'}</b><span>items read</span></div>
                <div><b>{metrics.visible_relationships ?? '—'}</b><span>connections</span></div>
                <div><b>{manifest?.findings_stored ?? 0}</b><span>things found</span></div>
                <div><b>{unreadable.length}</b><span>tables unreadable</span></div>
              </div>
            </div>
          </div>

          {/* ── SEVERITY. Status scale: colour + word + glyph + number, so
                 identity never rests on hue. Click to filter. ─────────────── */}
          <div className="card">
            <div className="card-title">How serious is it?</div>
            <p className="hs-lead">Click a row to see only those findings.</p>
            <div className="hs-bars">
              {sevRows.map((s) => (
                <Bar
                  key={s.key}
                  glyph={s.glyph}
                  label={s.label}
                  value={s.count}
                  max={sevMax}
                  tone={s.tone}
                  active={filter.severity === s.key}
                  hint={s.blurb}
                  onClick={() => applyFilter({ severity: filter.severity === s.key ? '' : s.key })}
                />
              ))}
            </div>
            {filter.severity && (
              <button type="button" className="btn ghost sm hs-mt" onClick={() => applyFilter({ severity: '' })}>
                Clear severity filter
              </button>
            )}
          </div>

          {/* ── DOMAIN. Magnitude by area — one series, one colour. Colouring
                 each bar by its own size would double-encode length as hue. ─ */}
          {domainRows.length > 0 && (
            <div className="card">
              <div className="card-title">Which area?</div>
              <div className="hs-bars">
                {domainRows.map((d) => (
                  <Bar
                    key={d.domain}
                    label={d.label}
                    value={d.findings}
                    max={domainMax}
                    tone="series"
                    active={filter.domain === d.domain}
                    onClick={() => applyFilter({ domain: filter.domain === d.domain ? '' : d.domain })}
                  />
                ))}
              </div>
              {filter.domain && (
                <button type="button" className="btn ghost sm hs-mt" onClick={() => applyFilter({ domain: '' })}>
                  Clear area filter
                </button>
              )}
            </div>
          )}

          {/* ── COVERAGE, before the findings. ─────────────────────────────── */}
          <div className="card">
            <div className="card-title">What we could read</div>
            <p className="hs-lead">
              Findings are only ever about what was read. A table we could not open is not a clean table.
            </p>
            <div className="hs-cov">
              {coverageRows.map((c) => (
                <span key={c.table} className={`hs-cov-chip tone-${coverageTone(c.status)}`} title={c.error || c.scope || ''}>
                  <b>{c.table}</b>
                  <span>{COVERAGE_LABEL[c.status] || c.status}</span>
                  {c.records != null && (
                    <em>{c.records}{c.reported_total != null && c.reported_total !== c.records ? ` / ${c.reported_total}` : ''}</em>
                  )}
                </span>
              ))}
            </div>

            {unreadable.length > 0 && (
              <p className="note">
                <b>{unreadable.length} table{unreadable.length === 1 ? '' : 's'} could not be read.</b>{' '}
                Rules that depend on {unreadable.length === 1 ? 'it' : 'them'} did not run. A table that is absent on this
                instance and one this account may not read are different problems — hover a chip to see which.
              </p>
            )}
            {run.error && <p className="error-text">{run.error}</p>}

            {skipped.length > 0 && (
              <>
                <button type="button" className="btn ghost sm hs-mt" onClick={() => setShowSkipped((x) => !x)}
                  aria-expanded={showSkipped}>
                  {showSkipped ? 'Hide' : 'Show'} {skipped.length} check{skipped.length === 1 ? '' : 's'} that did not run
                </button>
                {showSkipped && (
                  <table className="table hs-mt">
                    <thead><tr><th>Check</th><th>Table</th><th>Why it did not run</th></tr></thead>
                    <tbody>
                      {skipped.map((s, i) => (
                        <tr key={`${s.rule}-${s.table}-${i}`}>
                          <td className="mono">{s.rule || '—'}</td>
                          <td className="mono">{s.table || '—'}</td>
                          <td>
                            {COVERAGE_LABEL[s.reason] || s.reason}
                            {s.excluded_records ? ` · ${s.excluded_records} record(s) excluded` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>

          {/* ── FINDINGS. Also the charts' table-view twin. ────────────────── */}
          <div className="card">
            <div className="card-title">
              What we found · {total}
              {(filter.severity || filter.domain) && <span className="hs-muted"> (filtered)</span>}
            </div>

            {findings.length === 0 ? (
              <EmptyState
                title={total === 0 && !filter.severity && !filter.domain
                  ? 'Nothing found in what was read.'
                  : 'Nothing matches this filter.'}
                hint={total === 0 && !filter.severity && !filter.domain
                  ? 'That is a statement about the tables above, not about the whole instance. Check what we could read before treating it as a clean bill of health.'
                  : 'Clear the filter to see the rest.'}
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Severity</th>
                    <th>What is wrong</th>
                    <th style={{ width: 96 }}>Records</th>
                    <th style={{ width: 40 }} aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f) => {
                    const s = sevByKey[f.severity] || { label: f.severity, tone: 'info', glyph: '●' };
                    return (
                      <tr key={f.fingerprint} className="click" onClick={() => openDetail(f.fingerprint)}>
                        <td>
                          <span className={`hs-sev-tag sm tone-${s.tone}`}>
                            <span aria-hidden="true">{s.glyph}</span> {s.label}
                          </span>
                        </td>
                        <td>{f.title}</td>
                        <td className="mono">{f.target_ids?.length ?? 0}</td>
                        <td className="hs-muted">→</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The smallest possible markdown: `code` and **bold**, nothing else.
 *
 * The remediation steps are written by hand in this repository and are the only
 * thing passed through it — not model output and not instance data — so the
 * input is trusted. Everything that is not one of those two spans is ESCAPED
 * first, so even if that ever stopped being true the worst case is visible
 * markup rather than injected HTML.
 */
function mdLite(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
