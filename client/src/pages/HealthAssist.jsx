import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { SkeletonLines, EmptyState } from '../components/states.jsx';
import { toast } from '../components/toast.js';
import RemediationDrawer from '../components/RemediationDrawer.jsx';
import {
  useHealthRun, isActive, startHealthRun, stopHealthRun, discoverHealthRun, getHealthRun,
} from '../components/healthRun.js';

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

/* Fallback scope list for the moment before meta arrives. The server's list
   replaces it immediately; this only stops the switch from flashing empty. */
const SCOPE_FALLBACK = [
  { key: 'all', label: 'All' }, { key: 'cmdb', label: 'CMDB' },
  { key: 'itom', label: 'ITOM' }, { key: 'itsm', label: 'ITSM' }, { key: 'platform', label: 'Platform' },
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

/**
 * The score over time.
 *
 * A line, because this is change-over-time and nothing else reads as one. ONE
 * series, so there is no legend — the heading names it — and only the endpoint
 * is direct-labelled rather than every point.
 *
 * THE GAPS ARE THE POINT. A run whose score was withheld (incomplete coverage)
 * breaks the line instead of being dropped or drawn as zero. Joining across it
 * would assert continuity through a period where we could not actually see the
 * estate, which is the one thing this whole module refuses to do.
 */
function Trend({ points: raw, scope = 'cmdb', label = 'CMDB' }) {
  /* One line per scope. An older run recorded only the CMDB score, so the other
     scopes read `null` there — a real gap, not a back-filled number. */
  const points = (raw || []).map((p) => ({
    ...p,
    score: p.scopes ? (p.scopes[scope] ?? null) : (scope === 'cmdb' ? p.score : null),
  }));
  if (points.length < 2) return null;
  const W = 100;
  const H = 30;
  const scored = points.filter((p) => p.score != null);
  if (scored.length < 2) return null;

  const lo = Math.min(...scored.map((p) => p.score));
  const hi = Math.max(...scored.map((p) => p.score));
  const span = Math.max(1, hi - lo);
  const x = (i) => (points.length === 1 ? 0 : (i / (points.length - 1)) * W);
  const y = (v) => H - ((v - lo) / span) * (H - 6) - 3;

  /* Split into unbroken runs, so a withheld score leaves a real gap. */
  const segments = [];
  let current = [];
  points.forEach((p, i) => {
    if (p.score == null) { if (current.length) segments.push(current); current = []; return; }
    current.push(`${x(i)},${y(p.score)}`);
  });
  if (current.length) segments.push(current);

  const last = points[points.length - 1];
  const withheld = points.filter((p) => p.score == null).length;

  return (
    <div className="hs-trend">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${label} score across the last ${points.length} checks`}>
        {segments.map((seg, i) => (
          <polyline key={i} points={seg.join(' ')} fill="none"
            stroke="var(--verdigris)" strokeWidth="1.4" vectorEffect="non-scaling-stroke"
            strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {points.map((p, i) => (p.score == null ? null : (
          <circle key={p.runId} cx={x(i)} cy={y(p.score)} r="1.6"
            fill="var(--verdigris)" vectorEffect="non-scaling-stroke">
            <title>{`${new Date(p.at).toLocaleDateString()} — score ${p.score}, ${p.findings} finding(s)`}</title>
          </circle>
        )))}
      </svg>
      <div className="hs-trend-cap">
        {label} score across the last {points.length} check{points.length === 1 ? '' : 's'}
        {last.score != null ? ` · now ${last.score}` : ''}
        {withheld > 0 && (
          <span className="hs-muted">
            {' '}· {withheld} withheld (incomplete coverage), shown as a gap
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The lifecycle control on a finding.
 *
 * Muting is PRESENTATION, never deletion — the finding is still detected,
 * still counted and still one click from visible. A reason is required for the
 * two states that amount to a decision, because "somebody accepted this" is
 * only useful if the next person can find out who and why.
 */
function StateControl({ finding, vocabulary, onChange, busy }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState('acknowledged');
  const [reason, setReason] = useState('');
  const current = finding.lifecycle?.state || 'open';
  const needsReason = ['muted', 'accepted'].includes(state);

  if (!open) {
    return (
      <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        {current === 'open' ? 'Set status' : 'Change status'}
      </button>
    );
  }

  return (
    <div className="hs-state-edit" onClick={(e) => e.stopPropagation()} role="presentation">
      <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
        {vocabulary.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
      </select>
      {needsReason && (
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Why? (required)" />
      )}
      <button type="button" className="btn primary sm" aria-busy={busy}
        disabled={busy || (needsReason && !reason.trim())}
        onClick={() => { onChange(finding, state, reason); setOpen(false); setReason(''); }}>
        Save
      </button>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

/**
 * THE SCOPE SWITCH.
 *
 * The labels come from the server (`meta.scopes`) like every other word on this
 * page. Each button carries its own finding count, so switching is a choice
 * made with the numbers in view rather than a guess about where the problems
 * are.
 */
function ScopeSwitch({ scopes, value, onChange, counts }) {
  return (
    <div className="hs-scope" role="tablist" aria-label="Health Assist scope">
      {scopes.map((s) => (
        <button
          key={s.key}
          type="button"
          role="tab"
          aria-selected={value === s.key}
          className={`hs-scope-btn${value === s.key ? ' is-on' : ''}`}
          onClick={() => onChange(s.key)}
          title={s.description}
        >
          <span>{s.label}</span>
          {counts?.[s.key] != null && <em>{counts[s.key].toLocaleString()}</em>}
        </button>
      ))}
    </div>
  );
}

/**
 * One tile per scope, for the All view.
 *
 * Deliberately NOT one averaged number. CMDB and ITSM are record scores, ITOM
 * is a check score and Platform has none, so an average of them would be a
 * number that means nothing — each is shown on its own, with its own basis.
 */
function ScopeTiles({ summaries, scopes, onPick }) {
  return (
    <div className="hs-tiles">
      {scopes.filter((s) => s.key !== 'all').map((s) => {
        const sum = summaries?.[s.key];
        const v = verdict(sum?.score);
        return (
          <button key={s.key} type="button" className="hs-tile" onClick={() => onPick(s.key)} title={s.description}>
            <span className="hs-tile-label">{s.label}</span>
            <span className={`hs-tile-score${v ? ` tone-${v.tone}` : ' hs-score-none'}`}>
              {sum?.score != null ? <>{sum.score}<small>%</small></> : '—'}
            </span>
            <span className="hs-tile-word">
              {v ? v.word : (sum?.score_kind === 'none' ? 'No score for this area' : 'No score this run')}
            </span>
            <span className="hs-tile-count">{(sum?.findings ?? 0).toLocaleString()} found</span>
          </button>
        );
      })}
    </div>
  );
}

export default function HealthAssist() {
  const navigate = useNavigate();
  /* The scope lives in the URL, so a view survives a refresh and can be shared
     as a link: /health?scope=itom opens straight onto ITOM. */
  const [params, setParams] = useSearchParams();

  const [meta, setMeta] = useState(null);
  const [run, setRun] = useState(null);
  const [findings, setFindings] = useState([]);
  const [total, setTotal] = useState(0);
  /* The run lives in an app-wide store, not in this component — leaving the
     page or reloading the tab no longer loses it. See components/healthRun.js. */
  const healthRun = useHealthRun();
  const running = isActive(healthRun);
  const progress = healthRun.progress;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ domain: '', severity: '', rule: '' });
  const [showSkipped, setShowSkipped] = useState(false);

  /* The opened finding. `null` means the overview; anything else replaces it
     with the detail view, because two scroll positions on one page is how a
     reader loses their place. */
  const [openFinding, setOpenFinding] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [tab, setTab] = useState('ai');   // which solution lane is showing
  const [remediating, setRemediating] = useState(false);  // the review drawer
  const [points, setPoints] = useState([]);         // score over time
  const [showQuiet, setShowQuiet] = useState(false);
  const [stateBusy, setStateBusy] = useState('');
  /* Which finished run this page has already reloaded for. Starts at the
     current count, so opening the page after a check finished does not
     reload twice — the mount effect already reads the latest run. */
  const seenFinish = useRef(getHealthRun().finishedSeq);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, latest, tr] = await Promise.all([
          api.get('/health/meta'), api.get('/health/runs/latest'),
          api.get('/health/trend').catch(() => ({ points: [] })),
        ]);
        if (!alive) return;
        setMeta(m);
        setPoints(tr.points || []);
        if (latest.run) { setRun(latest.run); setFindings(latest.findings || []); setTotal(latest.total || 0); }
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const scopeList = meta?.scopes?.length ? meta.scopes : SCOPE_FALLBACK;
  const scope = scopeList.some((x) => x.key === params.get('scope')) ? params.get('scope') : 'all';

  const severities = meta?.severities?.length ? meta.severities : SEVERITY_FALLBACK;
  const sevByKey = useMemo(
    () => Object.fromEntries(severities.map((s) => [s.key, s])),
    [severities],
  );

  const loadFindings = useCallback(async (runId, next, scopeKey) => {
    const qs = new URLSearchParams();
    if (scopeKey && scopeKey !== 'all') qs.set('scope', scopeKey);
    if (next.domain) qs.set('domain', next.domain);
    if (next.rule) qs.set('rule', next.rule);
    if (next.severity) qs.set('severity', next.severity);
    qs.set('limit', '200');
    const data = await api.get(`/health/runs/${runId}/findings?${qs}`);
    setFindings(data.findings || []);
    setTotal(data.total || 0);
  }, []);

  const applyFilter = async (patch) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    if (run) { try { await loadFindings(run.id, next, scope); } catch (e) { setError(e.message); } }
  };

  /*
   * Switching scope.
   *
   * The AREA filter is cleared, because an area belongs to one scope and would
   * otherwise leave ITOM filtered to "CMDB quality" — an empty list that looks
   * like a clean estate. Severity carries over; it means the same everywhere.
   */
  const pickScope = (key) => {
    const next = new URLSearchParams(params);
    if (key === 'all') next.delete('scope'); else next.set('scope', key);
    setParams(next, { replace: true });
    setFilter((cur) => ({ ...cur, domain: '', rule: '' }));
    setOpenFinding(null);
  };

  /* The list follows the scope. Keyed on the run too, so a fresh check reloads
     the view you were on rather than dropping back to All. */
  useEffect(() => {
    if (!run?.id) return;
    loadFindings(run.id, { ...filter, domain: '', rule: '' }, scope).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, run?.id]);

  /* Opening the page picks up a check that is already running — started
     before a refresh, from another tab, or before you went elsewhere. */
  useEffect(() => { discoverHealthRun(); }, []);

  /* When a run finishes — wherever you were when it did — show its result.
     The toast and the desktop notification come from the store, once. */
  useEffect(() => {
    if (healthRun.finishedSeq === seenFinish.current) return;
    seenFinish.current = healthRun.finishedSeq;
    const { runId, status, message } = healthRun;
    if (status === 'cancelled' || !runId) return;
    (async () => {
      try {
        const fresh = (await api.get(`/health/runs/${runId}`)).run;
        if (status === 'completed') {
          setRun(fresh);
          await loadFindings(runId, filter, scope);
          try { setPoints((await api.get('/health/trend')).points || []); } catch { /* the trend is not load-bearing */ }
        } else if (status === 'failed') {
          setError(message || fresh?.error || 'The health check did not finish.');
        }
      } catch (e) {
        if (status === 'failed') setError(message || e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healthRun.finishedSeq]);

  const start = () => {
    setError(''); setOpenFinding(null); setDetail(null);
    startHealthRun();
  };

  /** Change a finding's lifecycle state. Presentation only — nothing is deleted. */
  const changeState = async (finding, state, reason) => {
    setStateBusy(finding.fingerprint);
    try {
      const res = await api.patch(`/health/findings/${finding.fingerprint}/state`, {
        state, reason, ruleId: finding.rule_id,
      });
      setFindings((cur) => cur.map((f) => (f.fingerprint === finding.fingerprint
        ? { ...f, lifecycle: res.state, quiet: ['muted', 'accepted'].includes(res.state.state) }
        : f)));
      toast.success(`Marked ${state}. It is still detected and still counted.`);
    } catch (e) { setError(e.message); toast.error('The status was not saved.'); }
    finally { setStateBusy(''); }
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
  const scopeInfo = scopeList.find((x) => x.key === scope) || scopeList[0];
  /* Every number below comes from the SERVER's summary for this scope, which
     was computed over every finding the run detected — never from the page of
     findings this screen happens to have loaded. */
  const summary = manifest?.scopes?.[scope] ?? null;
  const sevCounts = summary?.severity_counts || manifest?.severity_counts || {};
  const score = scope === 'all' ? null : (summary ? summary.score : metrics.cmdb_quality_score);
  const v = verdict(score);
  const scopeCounts = manifest?.scopes
    ? Object.fromEntries(Object.entries(manifest.scopes).map(([k, x]) => [k, x.findings]))
    : null;

  const coverageRows = useMemo(
    () => Object.values(coverage)
      .filter((c) => c.status !== 'not_requested')
      .filter((c) => !scopeInfo?.tables || scopeInfo.tables.includes(c.table)),
    [coverage, scopeInfo],
  );
  /* What the run detected, not what it stored — the number that was wrong
     ("1000 things found" for 12,194) came from the stored count. */
  const detected = manifest?.findings_detected ?? manifest?.findings_stored ?? 0;
  const stored = manifest?.findings_stored ?? detected;

  const stateVocab = meta?.findingStates?.length ? meta.findingStates : [
    { key: 'acknowledged', label: 'Acknowledged' },
    { key: 'muted', label: 'Muted' },
    { key: 'accepted', label: 'Accepted risk' },
    { key: 'open', label: 'Open' },
  ];
  const stateLabel = (k) => stateVocab.find((v) => v.key === k)?.label || k;

  /* Muted findings are HIDDEN by default and never deleted — one click brings
     them back, and they stay in every count above. */
  const quietCount = findings.filter((f) => f.quiet).length;
  const visibleFindings = showQuiet ? findings : findings.filter((f) => !f.quiet);

  const exportHref = run
    ? (() => {
      const qs = new URLSearchParams(Object.entries(filter).filter(([, x]) => x));
      if (scope !== 'all') qs.set('scope', scope);
      const q = qs.toString();
      return `/api/health/runs/${run.id}/export.csv${q ? `?${q}` : ''}`;
    })()
    : '#';
  const unreadable = coverageRows.filter((c) => !USABLE.includes(c.status));

  const sevRows = severities
    .map((s) => ({ ...s, count: sevCounts[s.key] || 0 }))
    .filter((s) => s.count > 0 || ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(s.key));
  const sevMax = Math.max(1, ...sevRows.map((s) => s.count));

  const domainRows = (summary?.domains || manifest?.domains || []).filter((d) => d.findings > 0)
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
        <div className="card-title">Health Assist</div>
        <div className="row">
          <button className="btn primary" onClick={start} aria-busy={running} disabled={running}>
            {running ? 'Checking…' : run ? 'Check again' : 'Run health check'}
          </button>
          {running && (
            /* An explicit request, not a disconnect: leaving the page no longer
               stops a check, so Stop has to say so on purpose. The server stops
               at the next table boundary; a health check only reads, so nothing
               is left half-done. */
            <button type="button" className="btn ghost" onClick={stopHealthRun} disabled={!healthRun.runId}>
              Stop
            </button>
          )}
          {run && (
            <span className="mono hs-muted">
              last checked {new Date(run.startedAt).toLocaleString()}
            </span>
          )}
        </div>
        {/* This used to say "it never writes, and it has no tool that could",
            which stopped being true when remediation shipped. The words now
            come from the server, which states both halves. */}
        <div className="note hs-mt">
          Reads {meta?.tables?.length ?? 0} allow-listed tables across CMDB, ITOM, ITSM and platform hygiene.{' '}
          {meta?.note || 'Checks only read. A fix is proposed first, and nothing changes until you approve it.'}
        </div>
        {running && progress && (
          <div className="note hs-mt">
            {progress.stage}{progress.table ? ` · ${progress.table}` : ''} — {progress.percent ?? 0}%
            <span className="hs-muted"> · keeps running if you leave this page</span>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>

      {run && (
        <ScopeSwitch scopes={scopeList} value={scope} onChange={pickScope} counts={scopeCounts} />
      )}

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
                 number does not need eight colours. In the All view it is one
                 tile per scope instead, never an average of them. ─────────── */}
          {scope === 'all' ? (
            <div className="card">
              <div className="card-title">Health by area</div>
              <p className="hs-lead">
                Each area is scored its own way — CMDB and ITSM by records, ITOM by capability checks — so they are shown
                side by side rather than averaged into one number that would mean nothing. Pick one to look inside it.
              </p>
              <ScopeTiles summaries={manifest?.scopes} scopes={scopeList} onPick={pickScope} />
              <div className="hs-facts hs-mt">
                <div><b>{detected.toLocaleString()}</b><span>things found</span></div>
                <div><b>{(metrics.visible_cis ?? 0).toLocaleString()}</b><span>CIs read</span></div>
                <div><b>{(metrics.visible_relationships ?? 0).toLocaleString()}</b><span>connections</span></div>
                <div><b>{unreadable.length}</b><span>tables unreadable</span></div>
              </div>
            </div>
          ) : (
            <div className="card hs-scorecard">
              <div className="hs-score-block">
                {score == null ? (
                  <>
                    <div className="hs-score hs-score-none">—</div>
                    <div className="hs-score-word">{summary?.score_kind === 'none' ? 'No score' : 'No score this run'}</div>
                  </>
                ) : (
                  <>
                    <div className={`hs-score tone-${v.tone}`}>{score}<span className="hs-score-pct">%</span></div>
                    <div className={`hs-score-word tone-${v.tone}`}>{v.word}</div>
                  </>
                )}
                <div className="hs-score-cap">{scopeInfo?.label} score</div>
              </div>

              <div className="hs-score-side">
                <p className="hs-lead">
                  {score == null
                    ? <><b>No score.</b> {summary?.score_withheld_because || metrics.score_withheld_because}</>
                    : <>{summary?.score_definition || metrics.score_definition} <b>{summary?.score_basis}</b></>}
                </p>
                <div className="hs-facts">
                  <div><b>{(summary?.findings ?? 0).toLocaleString()}</b><span>found in {scopeInfo?.label}</span></div>
                  <div><b>{coverageRows.length}</b><span>tables read</span></div>
                  <div><b>{unreadable.length}</b><span>tables unreadable</span></div>
                  {scope === 'cmdb' && (
                    <div><b>{(metrics.visible_cis ?? 0).toLocaleString()}</b><span>CIs read</span></div>
                  )}
                </div>

                {/* ITOM is scored by CHECKS, so the checks are the explanation.
                    A check that could not be evaluated says why and is left out
                    of the score — it is never shown as a pass. */}
                {summary?.checks?.length > 0 && (
                  <ul className="hs-checks">
                    {summary.checks.map((c) => (
                      <li key={c.key} className={`hs-check is-${c.result}`}>
                        <span className="hs-check-mark" aria-hidden="true">
                          {c.result === 'pass' ? '✓' : c.result === 'fail' ? '✗' : '–'}
                        </span>
                        <span className="hs-check-label">{c.label}</span>
                        <span className="hs-check-why">
                          {c.result === 'pass' && 'passes'}
                          {c.result === 'fail' && `fails · ${c.failedBy.join(', ')}`}
                          {c.result === 'not_applicable' && `not counted · ${c.reason}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* WHAT IS PULLING THE SCORE DOWN. A bare 0.3% says nothing a
                    person can act on; "3,233 CIs have no owner" does. Shares
                    overlap — one record can fail several rules — so they are
                    not meant to add up, and the caption says so. */}
                {summary?.score_drivers?.length > 0 && (
                  <div className="hs-drivers">
                    <div className="hs-sub">What is pulling the score down</div>
                    {summary.score_drivers.map((d) => {
                      const tone = sevByKey[d.severity]?.tone || 'info';
                      const top = summary.score_drivers[0].records || 1;
                      return (
                        <button
                          key={d.rule_id}
                          type="button"
                          className={`hs-driver${filter.rule === d.rule_id ? ' is-active' : ''}`}
                          onClick={() => applyFilter({ rule: filter.rule === d.rule_id ? '' : d.rule_id })}
                          title={`${d.rule_id} — click to see these findings`}
                        >
                          <span className="hs-driver-label">{d.label}</span>
                          <span className="hs-bar-track">
                            <span className={`hs-bar-fill tone-${tone}`} style={{ width: `${Math.max(2, (d.records / top) * 100)}%` }} />
                          </span>
                          <span className="hs-driver-n">
                            {d.records.toLocaleString()}{d.share != null ? ` · ${d.share}%` : ''}
                          </span>
                        </button>
                      );
                    })}
                    <p className="hs-fine">
                      Records affected per rule, as a share of what was read. One record can fail several rules, so these
                      overlap and do not add up. Click one to see those findings.
                    </p>
                  </div>
                )}

                {summary?.score_kind !== 'none' && (
                  <Trend points={points} scope={scope} label={scopeInfo?.label} />
                )}
              </div>
            </div>
          )}

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
            <div className="card-title">What we could read{scope !== 'all' ? ` · ${scopeInfo?.label}` : ''}</div>
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
            <div className="card-title hs-findings-head">
              <span>
                What we found{scope !== 'all' ? ` in ${scopeInfo?.label}` : ''} · {total.toLocaleString()}
                {(filter.severity || filter.domain || filter.rule) && <span className="hs-muted"> (filtered)</span>}
                {filter.rule && (
                  <button type="button" className="btn ghost sm hs-inline-clear" onClick={() => applyFilter({ rule: '' })}>
                    {filter.rule} ×
                  </button>
                )}
                {quietCount > 0 && (
                  <span className="hs-muted"> · {quietCount} muted or accepted</span>
                )}
                {stored < detected && (
                  /* Only when a pathological instance exceeds the storage cap.
                     Every count above is still the full number. */
                  <span className="hs-muted"> · {stored.toLocaleString()} of {detected.toLocaleString()} stored</span>
                )}
              </span>
              <span className="hs-head-actions">
                {quietCount > 0 && (
                  <button type="button" className="btn ghost sm" onClick={() => setShowQuiet((v) => !v)}>
                    {showQuiet ? 'Hide' : 'Show'} muted
                  </button>
                )}
                {/* The export honours the filters on screen. An export that does
                    not match what you were looking at is a different report. */}
                <a className="btn ghost sm" href={exportHref} download>Export CSV</a>
              </span>
            </div>

            {visibleFindings.length === 0 ? (
              <EmptyState
                title={total === 0 && !filter.severity && !filter.domain
                  ? `Nothing found${scope !== 'all' ? ` in ${scopeInfo?.label}` : ''} in what was read.`
                  : quietCount > 0 && findings.length === quietCount
                    ? 'Everything here is muted or accepted.'
                    : 'Nothing matches this filter.'}
                hint={total === 0 && !filter.severity && !filter.domain
                  ? 'That is a statement about the tables above, not about the whole instance. Check what we could read before treating it as a clean bill of health.'
                  : quietCount > 0 && findings.length === quietCount
                    ? 'They are still detected and still counted — "Show muted" brings them back.'
                    : 'Clear the filter to see the rest.'}
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Severity</th>
                    <th>What is wrong</th>
                    <th style={{ width: 96 }}>Records</th>
                    <th style={{ width: 150 }}>Status</th>
                    <th style={{ width: 40 }} aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {visibleFindings.map((f) => {
                    const s = sevByKey[f.severity] || { label: f.severity, tone: 'info', glyph: '●' };
                    const lc = f.lifecycle?.state || 'open';
                    return (
                      <tr key={f.fingerprint} className={`click${f.quiet ? ' hs-quiet' : ''}`}
                        onClick={() => openDetail(f.fingerprint)}>
                        <td>
                          <span className={`hs-sev-tag sm tone-${s.tone}`}>
                            <span aria-hidden="true">{s.glyph}</span> {s.label}
                          </span>
                        </td>
                        <td>
                          {f.title}
                          {f.lifecycle?.reason && (
                            <span className="hs-muted"> · {f.lifecycle.reason}</span>
                          )}
                        </td>
                        <td className="mono">{f.target_ids?.length ?? 0}</td>
                        <td>
                          {lc !== 'open' && (
                            <span className="hs-lc">{stateLabel(lc)}</span>
                          )}
                          <StateControl
                            finding={f}
                            vocabulary={stateVocab}
                            onChange={changeState}
                            busy={stateBusy === f.fingerprint}
                          />
                        </td>
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
