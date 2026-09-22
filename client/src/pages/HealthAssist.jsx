import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { SkeletonLines, EmptyState } from '../components/states.jsx';
import { toast } from '../components/toast.js';
import RemediationDrawer from '../components/RemediationDrawer.jsx';
import BulkFixDrawer from '../components/BulkFixDrawer.jsx';
import { ItsmCatalogue, ItsmParameters, CrossDomainLinks, ItsmFindingDetail } from '../components/HealthItsm.jsx';
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
  { key: 'SYSTEMIC', label: 'Systemic', tone: 'systemic', glyph: '◆', gate: true },
  { key: 'CRITICAL', label: 'Critical', tone: 'critical', glyph: '▲' },
  { key: 'HIGH', label: 'High', tone: 'major', glyph: '▲' },
  { key: 'MEDIUM', label: 'Moderate', tone: 'moderate', glyph: '●' },
  { key: 'LOW', label: 'Low', tone: 'low', glyph: '●' },
  { key: 'INFO', label: 'Info', tone: 'info', glyph: '·' },
];

/* The five bands the dashboard charts. Systemic is included on purpose: it is
   a gate rather than a deduction, but it is still a finding with a count, and
   a chart that hid it would hide the most serious thing the scan can say.
   Info is not a band — it is reachable through "View all findings". */
const DASHBOARD_SEVERITIES = ['SYSTEMIC', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** How many rows the dashboard's Top findings shows. The full list is one click away. */
const TOP_N = 10;
/** How many modules Module health shows before "Show all". */
const MODULES_SHOWN = 8;
/** How many "important assessment items" the summary lists before deferring to the categories. */
const IMPORTANT_SHOWN = 6;

/**
 * The findings list is paged: this many rows per request, and "Load more"
 * appends the next page. The search is the server's (`?q=`), over every
 * stored row of the scan — see loadFindings.
 */
const FINDINGS_PAGE = 200;
const SEARCH_DEBOUNCE_MS = 300;

/* ── Language ──────────────────────────────────────────────────────────────
 * The server describes an open trust gate in its own words. This page says the
 * same thing neutrally: the gate is open, so the assessment is incomplete and
 * the score cannot yet be quoted. Only the wording changes — never the state,
 * the count, or the arithmetic behind it.                                    */
const GATE_OPEN_WORD = 'Assessment incomplete';
function neutral(text) {
  if (text == null) return text;
  return String(text)
    .replace(/score not trustworthy/gi, 'score unavailable')
    .replace(/not trustworthy yet/gi, GATE_OPEN_WORD)
    .replace(/not trustworthy/gi, 'assessment incomplete');
}

/**
 * SYSTEMIC POSTURE (18 Sep). Systemic, but neither gating nor scored: a trend
 * or a governance percentage that says where the estate is heading. Shown
 * beside the gate, never inside it.
 */
function PosturePanel({ posture = [], activeRule, onPick, bare = false }) {
  if (!posture.length) return null;
  const Wrap = bare ? 'div' : 'details';
  return (
    <Wrap className={bare ? 'hd-assess-body' : 'card hs-escalated hd-collapsible'}>
      {!bare && <summary className="hs-sub">Systemic posture · {posture.length} finding{posture.length === 1 ? '' : 's'}</summary>}
      <ul className="hs-gate-list">
        {posture.map((p) => (
          <li key={p.fingerprint}>
            <button type="button" className={`hs-gate-item${activeRule === p.rule_id ? ' is-active' : ''}`} onClick={() => onPick(p.rule_id)}>
              <code>{p.rule_id}</code> {p.title}
            </button>
          </li>
        ))}
      </ul>
      <p className="hs-fine">Where the estate is heading, not whether today's score can be believed: these do not gate and do not deduct.</p>
    </Wrap>
  );
}

/**
 * ESCALATED — SYSTEMIC. Findings whose OWN context pushed them to Systemic. They
 * COUNTED (each zeroed its record), so they are not gate blockers; they head the
 * findings, apart from the gate, with the chain that got them there.
 *
 * CLASS-WIDE PATTERNS sit beside them, labelled apart: a defect rate is a
 * property of the class, so a pattern raises where it is reported and never
 * what a record is charged.
 */
function EscalatedBand({ escalated = [], patterns = [], activeRule, onPick, sevByKey, bare = false }) {
  if (!escalated.length && !patterns.length) return null;
  const groups = new Map();
  for (const e of escalated) {
    const g = groups.get(e.rule_id) || { ...e, count: 0, records: 0 };
    g.count += 1;
    g.records += e.records;
    groups.set(e.rule_id, g);
  }
  const parts = [];
  if (escalated.length) parts.push(`Escalated to Systemic · ${escalated.length}`);
  if (patterns.length) parts.push(`Class-wide patterns · ${patterns.length}`);
  const Wrap = bare ? 'div' : 'details';
  return (
    <Wrap className={bare ? 'hd-assess-body' : 'card hs-escalated hd-collapsible'}>
      {!bare && <summary className="hs-sub">{parts.join('  ·  ')}</summary>}
      {escalated.length > 0 && (
      <>
      {!bare && <div className="hs-sub">Escalated — Systemic · {escalated.length} finding{escalated.length === 1 ? '' : 's'}</div>}
      <ul className="hs-gate-list">
        {[...groups.values()].map((g) => (
          <li key={g.rule_id}>
            <button type="button" className={`hs-gate-item${activeRule === g.rule_id ? ' is-active' : ''}`} onClick={() => onPick(g.rule_id)}>
              <code>{g.rule_id}</code> {g.title} · {g.count}
              <span className="hs-chain">
                {sevByKey[g.chain.base]?.label || g.chain.base} → Systemic
                {g.chain.escalators.length ? ` · ↑ ${g.chain.escalators.map((m) => m.label).join(' · ↑ ')}` : ''}
                {g.chain.de_escalators.length ? ` · ↓ ${g.chain.de_escalators.map((m) => m.label).join(' · ↓ ')}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="hs-fine">Each one zeroed its record in its dimension. They are not gate blockers.</p>
      </>
      )}
      {patterns.length > 0 && (
        <>
          {!bare && <div className="hs-sub">Class-wide patterns · {patterns.length}</div>}
          <ul className="hs-gate-list">
            {patterns.map((p) => (
              <li key={p.fingerprint}>
                <button type="button" className={`hs-gate-item${activeRule === p.rule_id ? ' is-active' : ''}`} onClick={() => onPick(p.rule_id)}>
                  <code>{p.rule_id}</code> {p.title}
                  <span className="hs-gate-chip sm">pattern — does not zero records</span>
                  <span className="hs-chain">
                    {sevByKey[p.severity]?.label || p.severity} · {p.affected} of {p.class_size ?? '?'} in {p.class}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="hs-fine">A defect rate is a property of the class. Each affected record keeps its own finding and its own base deduction.</p>
        </>
      )}
    </Wrap>
  );
}

/** D1–D10: weight, how many of the dimension's rules are built, and the score or why there is none. */
const TRACK_LABEL = {
  'gate-config': 'health configuration', governance: 'governance posture', platform: 'platform indicator',
  trend: 'drift & regression', 'csdm-maturity': 'CSDM maturity', context: 'context (shown, not scored)', pending: 'awaiting a scoring decision',
  posture: 'Systemic posture (not gated, not scored)',
};

/**
 * THE THREE VARIANTS OF ONE NUMBER (CMDB-116).
 *
 * The composite is the figure somebody screenshots, so it is never shown alone.
 * The same arithmetic appears three ways — raw, coverage-qualified and
 * gate-qualified — and the GATE variant is visually dominant, because when the
 * trust gate is open the other two describe a number nobody should act on.
 *
 * CMDB-116 is `derived` and deducts nothing: this is presentation, not scoring.
 */
function TrustVariants({ composite }) {
  const variants = composite?.variants ?? [];
  if (!variants.length) return null;
  return (
    <div className="hs-variants">
      {variants.map((v) => (
        <div key={v.key} className={`hs-variant${v.dominant ? ' is-dominant' : ''}`}>
          <div className="hs-variant-head">
            <span className="hs-variant-label">{neutral(v.label)}</span>
            <span className="hs-variant-value">{v.value == null ? '—' : `${v.value}%`}</span>
          </div>
          <div className="hs-variant-qual">{v.qualifier}</div>
          <p className="hs-fine">{neutral(v.caveat)}</p>
        </div>
      ))}
      {composite.weights_caveat && <p className="hs-fine hs-variant-foot">{composite.weights_caveat}</p>}
    </div>
  );
}

function Dimensions({ q }) {
  if (!q?.dimensions?.length) return null;
  const tracks = Object.entries(q.tracks || {}).filter(([, n]) => n > 0);
  return (
    <div className="hs-dims">
      <div className="hs-sub">CMDB Quality by dimension</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Dimension</th><th>Weight</th><th>Rules built</th><th>Score</th><th>How</th></tr></thead>
          <tbody>
            {q.dimensions.map((d) => (
              <tr key={d.key} className={d.measured ? '' : 'hs-dim-off'}>
                <td><b>{d.key}</b> {d.label}</td>
                <td className="mono">{d.weight}</td>
                <td className="mono">{d.rules_built} of {d.rules_total}</td>
                <td>{d.measured
                  ? <><b>{d.score}</b>{q.gate && !q.gate.trustworthy ? <span className="hs-muted"> · gate open</span> : null}</>
                  : <span className="hs-muted">not measured</span>}
                </td>
                <td className="hs-muted">
                  {d.measured && d.blend && `records ${d.record_part} × ${d.blend.record * 100}% + KPI ${d.kpi_part} × ${d.blend.kpi * 100}%`}
                  {d.measured && !d.blend && (d.kpi_part != null ? `KPI only (${d.kpis.map((k) => `${k.rule_id} ${k.pass_pct}%`).join(', ')})` : 'record average')}
                  {!d.measured && d.not_measured_because}
                  {d.scope_note && <div className="hs-fine">{d.scope_note}</div>}
                  {d.caveats?.map((c) => <div key={c} className="hs-guard-open">{c}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hs-fine">
        A dimension with no built rule is not measured — it is never counted as a clean 100. The trust gate (Group 1)
        sits outside the 100. {q.in_scope?.basis ? `In scope: ${q.in_scope.basis}.` : ''}
        {q.density?.defects_per_100_records != null
          ? ` Secondary: ${q.density.defects_per_100_records} defects and ${q.density.weighted_per_100_records} weighted points per 100 in-scope records.`
          : ''}
      </p>
      {tracks.length > 0 && (
        <p className="hs-fine">
          Not part of this data-quality score:{' '}
          {tracks.map(([t, n]) => `${n} ${TRACK_LABEL[t] || t}`).join(' · ')}.
        </p>
      )}
    </div>
  );
}

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

/**
 * ONE STATUS VOCABULARY FOR EVERY AREA, everywhere an area is named.
 *
 * The server's states, mapped once so the same state always gets the same
 * word and the same tone — on the area chart, the score card and the tiles:
 *
 *   no result for the area                        → Not scanned
 *   score_kind 'none' — no score BY DESIGN         → Score unavailable   (Platform)
 *   score withheld — coverage, truncation, empty   → Assessment incomplete
 *   score present, trust gate open                 → Assessment incomplete (the number is shown, qualified)
 *   score present                                  → Healthy · Mostly healthy · Needs attention · Needs work
 *
 * "Assessment incomplete" is one state with two causes, so it wears one
 * colour: the assessment tone, purple, because a base-Systemic blocker is what
 * opens the gate. The short `why` carries the cause; it never changes the word.
 */
function areaStatus(sum) {
  if (!sum) return { key: 'unscanned', word: 'Not scanned', tone: 'idle', why: 'This area has no result yet.' };
  if (sum.score == null) {
    return sum.score_kind === 'none'
      ? { key: 'no-score', word: 'Score unavailable', tone: 'idle', why: neutral(sum.score_withheld_because) || 'This area is not scored.' }
      : { key: 'incomplete', word: GATE_OPEN_WORD, tone: 'systemic', why: neutral(sum.score_withheld_because) || 'The score was withheld on this run.' };
  }
  if (sum.gate && !sum.gate.trustworthy) {
    const n = sum.gate.blockers?.length ?? 0;
    return { key: 'incomplete', word: GATE_OPEN_WORD, tone: 'systemic', why: `${n} trust blocker${n === 1 ? '' : 's'} must be cleared before this score can be quoted.` };
  }
  const v = verdict(sum.score);
  return { key: v.tone === 'ok' ? 'healthy' : v.tone, word: v.word, tone: v.tone, why: v.line };
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
      className={`hs-bar tone-${tone}${active ? ' is-active' : ''}${onClick ? ' is-clickable' : ''}`}
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
      <span className="hs-bar-value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
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
 * THE GAPS ARE THE POINT. A run whose score was withheld (incomplete coverage,
 * or a point made under an earlier scoring model — the server blanks those)
 * breaks the line instead of being dropped or drawn as zero. Joining across it
 * would assert continuity through a period where we could not actually see the
 * estate, which is the one thing this whole module refuses to do.
 */
function Trend({ points: raw, scope = 'cmdb', label = 'CMDB' }) {
  /* One line per scope. An older run recorded only the CMDB score, so the other
     scopes read `null` there — a real gap, not a back-filled number. */
  /* A module's line uses only the scans that measured it: an ITSM-only scan
     is not a gap in the CMDB line, it is simply not a CMDB point. */
  const points = (raw || []).filter((p) => !p.modules || scope === 'all' || p.modules.includes(scope)).map((p) => ({
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
            {' '}· {withheld} withheld or from an earlier scoring model, shown as a gap
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

/* ── Scan options ──────────────────────────────────────────────────────────
 * Which modules the next scan checks, remembered per browser. Full System Scan
 * is simply every module; unticking one of them unticks it.                  */
const SCAN_PREFS = 'nha.healthScan';
const MODULE_FALLBACK = ['cmdb', 'itom', 'itsm', 'platform'];

function loadScanPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCAN_PREFS) || 'null');
    const modules = Array.isArray(raw?.modules) ? raw.modules.filter((m) => MODULE_FALLBACK.includes(m)) : MODULE_FALLBACK;
    return { modules: modules.length ? modules : MODULE_FALLBACK, reuse: raw?.reuse !== false };
  } catch {
    return { modules: MODULE_FALLBACK, reuse: true };
  }
}

function saveScanPrefs(prefs) {
  try { localStorage.setItem(SCAN_PREFS, JSON.stringify(prefs)); } catch { /* a convenience, not state */ }
}

function ScanOptions({ scopes, modules, selected, onChange, reuse, onReuse, disabled }) {
  const all = modules.every((m) => selected.includes(m));
  const label = (m) => scopes.find((x) => x.key === m)?.label || m.toUpperCase();
  const toggle = (m) => onChange(selected.includes(m) ? selected.filter((x) => x !== m) : modules.filter((x) => x === m || selected.includes(x)));
  return (
    <fieldset className="hs-scanopts" disabled={disabled}>
      <legend className="hs-muted">Scan</legend>
      <label className="hs-scanopt is-full">
        <input type="checkbox" checked={all} onChange={() => onChange(all ? [] : [...modules])} />
        <span>Full System Scan</span>
      </label>
      {modules.map((m) => (
        <label key={m} className="hs-scanopt">
          <input type="checkbox" checked={selected.includes(m)} onChange={() => toggle(m)} />
          <span>{label(m)}</span>
        </label>
      ))}
      <label className="hs-scanopt is-reuse" title="Each module is first checked for changes (row counts and newest update per table). A module with no changes keeps its last result instead of being read again.">
        <input type="checkbox" checked={reuse} onChange={(e) => onReuse(e.target.checked)} />
        <span>Skip modules with no changes</span>
      </label>
    </fieldset>
  );
}

/** When each module's current result was read, and when it was last verified unchanged. */
function ModuleTimes({ info, scopes, only = null }) {
  if (!info) return null;
  const label = (m) => scopes.find((x) => x.key === m)?.label || m.toUpperCase();
  const keys = Object.keys(info).filter((m) => !only || m === only);
  return (
    <div className="hs-modtimes">
      {keys.map((m) => {
        const x = info[m];
        return (
          <span key={m} className="hs-modtime" title={x?.reasons?.length ? `Last re-read because: ${x.reasons.join('; ')}` : ''}>
            <b>{label(m)}</b>
            {x?.checkedAt
              ? <> checked {new Date(x.checkedAt).toLocaleString()}{x.verifiedAt ? <em> · no changes as of {new Date(x.verifiedAt).toLocaleString()}</em> : null}</>
              : <em> not scanned yet</em>}
            {x?.degraded?.length ? <em className="hs-degraded"> · {x.degraded.length} read(s) failed — it will be read again</em> : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * THE SCAN STATE — the incremental configuration table, per allow-listed
 * table: whether change checking is on, its last complete read, whether the
 * instance logs its deletions, and what the last change check found.
 */
function ScanStateCard({ open, onToggle, bare = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (!open || data) return;
    api.get('/health/scan-state').then(setData).catch((e) => setErr(e.message));
  }, [open, data]);
  const flip = async (row) => {
    setBusy(row.table);
    try {
      await api.patch(`/health/scan-state/${encodeURIComponent(row.table)}`, { enabled: !row.enabled });
      setData((cur) => ({ ...cur, tables: cur.tables.map((t) => (t.table === row.table ? { ...t, enabled: !row.enabled } : t)) }));
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const when = (v) => (v ? new Date(v).toLocaleString() : '—');
  return (
    <div className={bare ? 'hd-subsection' : 'card'}>
      <div className={`${bare ? 'hs-sub' : 'card-title'} hs-findings-head`}>
        <span>Scan state</span>
        <button type="button" className="btn ghost sm" onClick={onToggle} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
      </div>
      <p className="hs-lead">
        Before reading a module, each of its tables is asked for its row count and newest update. A module whose tables
        and governance reads are all unchanged keeps its last result. Switching a table off means it is always read in full.
      </p>
      {open && err && <p className="error-text">{err}</p>}
      {open && !data && !err && <SkeletonLines lines={4} />}
      {open && data && (
        <div className="table-wrap">
          <table className="table hs-scanstate">
            <thead>
              <tr>
                <th>Table</th><th>Modules</th><th>Change check</th><th>Last complete read</th><th>Rows</th>
                <th>Newest update</th><th>Deletion log</th><th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {data.tables.map((t) => (
                <tr key={t.table}>
                  <td className="mono">{t.table}</td>
                  <td>{t.modules.join(', ') || '—'}</td>
                  <td>
                    <label className="hs-scanopt">
                      <input type="checkbox" checked={t.enabled} disabled={busy === t.table} onChange={() => flip(t)} />
                      <span>{t.enabled ? 'on' : 'off'}</span>
                    </label>
                  </td>
                  <td>{when(t.last_read_at)}</td>
                  <td className="mono">{t.unreadable ? 'unreadable' : (t.rows ?? '—')}</td>
                  <td className="mono">{t.newest_change || '—'}</td>
                  <td>{t.deletion_log == null ? 'unknown' : (t.deletion_log ? 'logged' : 'count check')}</td>
                  <td>
                    {t.last_check_at
                      ? <>{t.last_check_changed ? 'changed' : 'unchanged'}<span className="hs-muted"> · {when(t.last_check_at)}</span>
                        {t.last_check_reason && <div className="hs-fine">{t.last_check_reason}</div>}</>
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Dashboard pieces ──────────────────────────────────────────────────────
 * Presentation only. Every number they draw is handed in from the server's
 * manifest; nothing here computes a score, a count or an order.             */

/** "Sep 20, 2026 at 5:14 PM" — the header's compact timestamp. */
function fmtWhen(d) {
  if (!d) return null;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4.5" width="18" height="17" rx="2.5" /><path d="M16 2.5v4M8 2.5v4M3 10h18" />
  </svg>
);

/**
 * The Run scan split button. The primary half runs the scan as configured;
 * the arrow opens the SAME scan options that used to sit in a row under the
 * header — which modules, and whether unchanged modules are skipped. Same
 * inputs, same handlers, same preferences: only where they live has changed.
 */
function RunScanMenu({ running, disabled, onRun, label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`hd-run${open ? ' is-open' : ''}`} ref={ref}>
      <button type="button" className="btn primary hd-run-main" onClick={onRun} disabled={disabled} aria-busy={running}>
        {running ? 'Scanning…' : label}
      </button>
      <button type="button" className="btn primary hd-run-arrow" onClick={() => setOpen((v) => !v)}
        aria-expanded={open} aria-haspopup="true" aria-label="Scan options" title="Choose what to scan">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && <div className="hd-run-menu">{children}</div>}
    </div>
  );
}

/** Fires once, when the element first scrolls into view; true at once where IntersectionObserver is missing. */
function useInView(ref) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setInView(true); io.disconnect(); }
    }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/**
 * HEALTH BY AREA — one column per area the server scored, the score above it.
 *
 * The baseline is ZERO, always: a bar that starts anywhere else lies about the
 * ratio between two bars. What adapts is the TOP of the axis — the next 25
 * above the highest score, never more than 100 — so four scores in the
 * forties are not four stubs under an empty half-chart. The axis is labelled,
 * so the reader can see which scale they are on.
 *
 * An area with no score (Platform has none by design) keeps its column and
 * says so; drawing it as zero would make "not scored" look like "failed".
 */
function AreaBars({ summaries, scopes, onPick }) {
  const ref = useRef(null);
  const inView = useInView(ref);
  const areas = scopes.filter((s) => s.key !== 'all');
  const rows = areas.map((s) => {
    const sum = summaries?.[s.key];
    const st = areaStatus(sum);
    return {
      key: s.key, label: s.label, description: `${s.description || s.label} — ${st.why}`,
      score: sum?.score ?? null, findings: sum?.findings ?? 0, scanned: Boolean(sum),
      tone: st.tone, word: st.word,
    };
  });
  const scored = rows.filter((r) => r.score != null);
  const top = scored.length
    ? Math.max(25, Math.min(100, Math.ceil(Math.max(...scored.map((r) => r.score)) / 25) * 25))
    : 100;
  const ticks = [0, 1, 2, 3, 4].map((i) => (top * i) / 4);
  return (
    <div className={`hd-areas${inView ? ' is-in' : ''}`} ref={ref}>
      <div className="hd-areas-plot" role="img"
        aria-label={`Health by area: ${rows.map((r) => `${r.label} ${r.score != null ? `${r.score}%` : 'no score'}`).join(', ')}`}>
        <div className="hd-areas-grid" aria-hidden="true">
          {ticks.map((t) => (
            <div key={t} className="hd-areas-tick" style={{ bottom: `${(t / top) * 100}%` }}><span>{t}%</span></div>
          ))}
        </div>
        <div className="hd-areas-cols" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
          {rows.map((r, i) => {
            const pct = r.score == null ? 0 : Math.max(1.5, Math.min(100, (r.score / top) * 100));
            return (
              <button key={r.key} type="button" className={`hd-area tone-${r.tone}${r.score == null ? ' is-none' : ''}`}
                onClick={() => onPick(r.key)} title={r.description}
                style={{ '--hd-h': `${pct}%`, '--hd-delay': `${i * 90}ms` }}>
                <span className="hd-area-val">{r.score != null ? <>{r.score}<small>%</small></> : '—'}</span>
                <span className="hd-area-fill" />
              </button>
            );
          })}
        </div>
      </div>
      <div className="hd-areas-names" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((r) => (
          <div key={r.key} className={`hd-area-name tone-${r.tone}`}>
            <b>{r.label}</b>
            <span className="hd-area-word">{r.word}</span>
            <span className="hd-area-n">{r.scanned ? `${r.findings.toLocaleString()} found` : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * FINDINGS BY SEVERITY — a donut, five slices, the total in the middle.
 *
 * Severity is a status scale, so every slice carries its word, its glyph and
 * its number in the legend beside it; the hue alone is never asked to tell
 * Critical from High. Click a slice or a legend row to filter the findings
 * below; the same one again, or "All", puts everything back.
 *
 * Drawn with one <circle> per slice on a 100-unit path, so a slice's length is
 * its share and its offset is the sum of the shares before it. The entrance
 * runs the dash from nothing to its length, in order around the ring, once.
 */
function SeverityDonut({ rows, total, active, onPick }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(t);
  }, []);
  const sum = rows.reduce((n, r) => n + r.count, 0);
  const nonZero = rows.filter((r) => r.count > 0).length;
  const GAP = nonZero > 1 ? 1 : 0;                       // a 2px surface gap between slices
  let cursor = 0;
  const slices = rows.map((r) => {
    const pct = sum ? (r.count / sum) * 100 : 0;
    const len = pct === 0 ? 0 : (pct > GAP * 2 ? pct - GAP : pct / 2);
    const s = { ...r, pct, len, start: cursor };
    cursor += pct;
    return s;
  });
  return (
    <div className="hd-donut-wrap">
      <div className="hd-donut">
        <svg viewBox="0 0 100 100" role="img"
          aria-label={`Findings by severity: ${rows.map((r) => `${r.label} ${r.count.toLocaleString()}`).join(', ')}`}>
          <circle className="hd-donut-track" cx="50" cy="50" r="40" />
          <g transform="rotate(-90 50 50)">
          {slices.filter((s) => s.len > 0).map((s) => (
            <circle
              key={s.key}
              className={`hd-donut-seg tone-${s.tone}${active === s.key ? ' is-on' : ''}${active && active !== s.key ? ' is-off' : ''}`}
              cx="50" cy="50" r="40" pathLength="100"
              strokeDasharray={drawn ? `${s.len} ${100 - s.len}` : '0 100'}
              strokeDashoffset={-(s.start + GAP / 2)}
              style={{ transitionDelay: drawn ? `${s.start * 7}ms` : '0ms' }}
              onClick={() => onPick(s.key)}
              tabIndex={0}
              role="button"
              aria-pressed={active === s.key}
              aria-label={`${s.label}: ${s.count.toLocaleString()} (${s.pct.toFixed(1)}%)`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s.key); } }}
            >
              <title>{`${s.label} · ${s.count.toLocaleString()} (${s.pct.toFixed(1)}%)`}</title>
            </circle>
          ))}
          </g>
        </svg>
        <div className="hd-donut-center">
          <span>Total findings</span>
          <b>{total.toLocaleString()}</b>
        </div>
      </div>
      <ul className={`hd-legend${drawn ? ' is-in' : ''}`}>
        {slices.map((s, i) => (
          <li key={s.key} style={{ '--hd-delay': `${120 + i * 60}ms` }}>
            <button type="button"
              className={`hd-legend-row tone-${s.tone}${active === s.key ? ' is-on' : ''}${active && active !== s.key ? ' is-off' : ''}`}
              onClick={() => onPick(s.key)} aria-pressed={active === s.key} title={s.blurb}>
              <i aria-hidden="true" />
              <span className="hd-legend-label"><span className="hs-glyph" aria-hidden="true">{s.glyph}</span>{s.label}</span>
              <b>{s.count.toLocaleString()}</b>
              <em>{sum ? `${s.pct < 1 && s.pct > 0 ? '<1' : Math.round(s.pct)}%` : '—'}</em>
            </button>
          </li>
        ))}
        <li style={{ '--hd-delay': `${120 + slices.length * 60}ms` }}>
          <button type="button" className={`hd-legend-row hd-legend-all${!active ? ' is-on' : ''}`}
            onClick={() => onPick(null)} aria-pressed={!active}>
            <i aria-hidden="true" />
            <span className="hd-legend-label">All severities</span>
            <b>{sum.toLocaleString()}</b>
            <em />
          </button>
        </li>
      </ul>
    </div>
  );
}

export default function HealthAssist() {
  const navigate = useNavigate();
  /* The scope lives in the URL, so a view survives a refresh and can be shared
     as a link: /health?scope=itom opens straight onto ITOM. */
  const [params, setParams] = useSearchParams();

  const [meta, setMeta] = useState(null);
  /* Each module keeps its own latest result. `modulesInfo` says which run holds
     it and when; `composed` is the All view built from all four; `moduleRun` is
     the run behind the module tab on screen. */
  const [modulesInfo, setModulesInfo] = useState(null);
  const [composed, setComposed] = useState(null);
  const [moduleRun, setModuleRun] = useState(null);
  const [detailRunId, setDetailRunId] = useState(null);
  const [scanModules, setScanModules] = useState(() => loadScanPrefs().modules);
  const [reuse, setReuse] = useState(() => loadScanPrefs().reuse);
  const [showScanState, setShowScanState] = useState(false);
  const [showCoverage, setShowCoverage] = useState(false);
  const [findings, setFindings] = useState([]);
  const [total, setTotal] = useState(0);
  /* A filter click is a fetch, and on a large estate a slow one. The page
     says so, and only the LATEST request may land: two quick clicks must not
     leave the earlier severity's rows under the later severity's heading. */
  const [findingsBusy, setFindingsBusy] = useState(false);
  const [findingsMoreBusy, setFindingsMoreBusy] = useState(false);
  const findingsSeq = useRef(0);
  const [showAllModules, setShowAllModules] = useState(false);
  /* Which assessment category is open, if any, and the findings search. Both
     are presentation: the server's data is untouched by either. */
  const [assessOpen, setAssessOpen] = useState(null);
  const [query, setQuery] = useState('');
  /* The run lives in an app-wide store, not in this component — leaving the
     page or reloading the tab no longer loses it. See components/healthRun.js. */
  const healthRun = useHealthRun();
  const running = isActive(healthRun);
  const progress = healthRun.progress;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ domain: '', severity: '', rule: '' });

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
  /*
   * BULK FIX SELECTION. Keyed on run + fingerprint (the All view lists rows
   * from several runs), and independent of the rows on screen: a filter, a
   * search or "Load more" changes what is visible, not what is chosen. It is
   * cleared when the scope changes or a new scan lands, because a selection
   * made against one set of results should not carry into another.
   *
   * `bulkItems` is a SNAPSHOT taken when the drawer opens, so the batch under
   * review cannot change under the reviewer while they read it.
   */
  const [selected, setSelected] = useState(() => new Map());
  const [bulkItems, setBulkItems] = useState(null);
  const bulkMax = meta?.bulk?.max ?? 25;
  /* Which finished run this page has already reloaded for. Starts at the
     current count, so opening the page after a check finished does not
     reload twice — the mount effect already reads the latest run. */
  const seenFinish = useRef(getHealthRun().finishedSeq);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, mods, tr] = await Promise.all([
          api.get('/health/meta'), api.get('/health/modules'),
          api.get('/health/trend').catch(() => ({ points: [] })),
        ]);
        if (!alive) return;
        setMeta(m);
        setPoints(tr.points || []);
        setModulesInfo(mods.modules || null);
        setComposed(mods.view || null);
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const scopeList = meta?.scopes?.length ? meta.scopes : SCOPE_FALLBACK;
  const scope = scopeList.some((x) => x.key === params.get('scope')) ? params.get('scope') : 'all';
  /* Which surface is showing: the dashboard, or the full findings table it
     links to. In the URL like the scope, so "View all findings" survives a
     refresh and can be shared. Same data, same filters — only the framing. */
  const view = params.get('view') === 'findings' ? 'findings' : 'dashboard';
  const setView = (next) => {
    const qs = new URLSearchParams(params);
    if (next === 'findings') qs.set('view', 'findings'); else qs.delete('view');
    setParams(qs, { replace: true });
  };
  /* The page scrolls inside .content, not the window — so that is what is
     sent back to the top when the table replaces the dashboard. */
  const showAllFindings = () => {
    setView('findings');
    document.querySelector('.content')?.scrollTo({ top: 0 });
  };
  const showDashboard = () => setView('dashboard');
  const moduleKeys = meta?.modules?.length ? meta.modules : MODULE_FALLBACK;
  /* The All tab shows the composed view; a module tab shows that module's own run. */
  const moduleRunId = scope === 'all' ? null : (modulesInfo?.[scope]?.runId ?? null);
  /* Never the previous tab's run while this tab's is still loading. */
  const run = scope === 'all' ? composed : (moduleRun && moduleRun.id === moduleRunId ? moduleRun : null);

  const reloadModules = useCallback(async () => {
    const mods = await api.get('/health/modules');
    setModulesInfo(mods.modules || null);
    setComposed(mods.view || null);
    return mods;
  }, []);

  /* A module tab loads the run that holds that module's current result. */
  useEffect(() => {
    if (scope === 'all') return;
    if (!moduleRunId) { setModuleRun(null); return; }
    if (moduleRun?.id === moduleRunId) return;
    let alive = true;
    api.get(`/health/runs/${moduleRunId}`)
      .then((r) => { if (alive) setModuleRun(r.run); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, moduleRunId]);

  const severities = meta?.severities?.length ? meta.severities : SEVERITY_FALLBACK;
  const sevByKey = useMemo(
    () => Object.fromEntries(severities.map((s) => [s.key, s])),
    [severities],
  );
  /* Module labels for the findings tables, from the server's vocabulary. */
  const domainLabel = useMemo(
    () => Object.fromEntries((meta?.domains || []).map((d) => [d.domain, d.label])),
    [meta],
  );

  /*
   * Findings come from each module's own current result; every row names its
   * run.
   *
   * The SEARCH goes to the server with the filters. It used to run over the
   * rows already loaded, and measured on a 22,782-finding CMDB view that meant
   * a SYSTEMIC duplicate-CI set ranked #560 could not be found by its title,
   * the CI's name, its serial or its sys_id — every search returned 0, which
   * reads as "not detected". `offset` is the other half of the same fix: the
   * first page is a page, not a ceiling, and "Load more" appends the next.
   */
  const loadFindings = useCallback(async (next, scopeKey, { q = '', offset = 0 } = {}) => {
    const qs = new URLSearchParams();
    if (scopeKey && scopeKey !== 'all') qs.set('scope', scopeKey);
    if (next.domain) qs.set('domain', next.domain);
    if (next.rule) qs.set('rule', next.rule);
    if (next.severity) qs.set('severity', next.severity);
    if (q.trim()) qs.set('q', q.trim());
    qs.set('limit', String(FINDINGS_PAGE));
    if (offset) qs.set('offset', String(offset));
    const seq = ++findingsSeq.current;
    if (offset) setFindingsMoreBusy(true); else setFindingsBusy(true);
    try {
      const data = await api.get(`/health/modules/findings?${qs}`);
      if (seq !== findingsSeq.current) return;   // superseded by a later click
      setFindings((cur) => (offset ? [...cur, ...(data.findings || [])] : (data.findings || [])));
      setTotal(data.total || 0);
    } finally {
      if (seq === findingsSeq.current) { setFindingsBusy(false); setFindingsMoreBusy(false); }
    }
  }, []);

  const applyFilter = async (patch) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    if (run) { try { await loadFindings(next, scope, { q: query }); } catch (e) { setError(e.message); } }
  };

  /* Typing searches the whole scan, not the page: debounced so a word is one
     request, not one per keystroke. The first render is left to the view
     effect below — this only fires once the query has actually changed. */
  const queryRef = useRef(query);
  useEffect(() => {
    if (queryRef.current === query) return undefined;
    queryRef.current = query;
    if (!run) return undefined;
    const t = setTimeout(() => {
      loadFindings(filter, scope, { q: query }).catch((e) => setError(e.message));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const loadMoreFindings = () => {
    if (!run || findingsMoreBusy) return;
    loadFindings(filter, scope, { q: query, offset: findings.length }).catch((e) => setError(e.message));
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
    setSelected(new Map());
  };

  /* The list follows the scope. Keyed on the run too, so a fresh check reloads
     the view you were on rather than dropping back to All. */
  const viewKey = scope === 'all' ? `all:${composed?.startedAt ?? ''}:${Object.values(modulesInfo || {}).map((x) => x.runId).join(',')}` : `${scope}:${moduleRunId ?? ''}`;
  useEffect(() => {
    setSelected(new Map());
    if (!run) { setFindings([]); setTotal(0); return; }
    loadFindings({ ...filter, domain: '', rule: '' }, scope, { q: query }).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, Boolean(run)]);

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
          await reloadModules();
          const verified = fresh?.manifest?.verified_modules || [];
          if (verified.length) {
            const names = verified.map((m) => scopeList.find((x) => x.key === m)?.label || m).join(', ');
            toast.success(`No changes in ${names} since the last scan — ${verified.length === 1 ? 'that result stands' : 'those results stand'}, verified now.`);
          }
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

  const chooseModules = (list) => { setScanModules(list); saveScanPrefs({ modules: list, reuse }); };
  const chooseReuse = (on) => { setReuse(on); saveScanPrefs({ modules: scanModules, reuse: on }); };
  const start = (only = null) => {
    const list = Array.isArray(only) ? only : scanModules;
    if (!list.length) { setError('Tick at least one module to scan.'); return; }
    setError(''); setOpenFinding(null); setDetail(null);
    const full = moduleKeys.every((m) => list.includes(m));
    startHealthRun({ modules: full ? 'all' : list, reuse });
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

  /* ── Bulk fix: selecting, and opening the batch ─────────────────────── */
  const selKey = (f) => `${f.run_id || run?.id}:${f.fingerprint}`;
  const isSelected = (f) => selected.has(selKey(f));
  /** Only findings with an automated fix can be chosen — `fixable` comes from
      the server's own registry, so the checkbox and the proposal agree. */
  const selectable = (f) => Boolean(f.fixable);
  const toggleSelect = (f) => {
    if (!selectable(f)) return;
    setSelected((cur) => {
      const next = new Map(cur);
      const k = selKey(f);
      if (next.has(k)) next.delete(k);
      else next.set(k, { key: k, runId: f.run_id || run?.id, fingerprint: f.fingerprint, title: f.title, rule_id: f.rule_id, severity: f.severity, table: f.table });
      return next;
    });
  };
  /** Select or clear every selectable row currently on screen. */
  const toggleSelectAll = (rows) => {
    const eligible = rows.filter(selectable);
    const allOn = eligible.length > 0 && eligible.every(isSelected);
    setSelected((cur) => {
      const next = new Map(cur);
      for (const f of eligible) {
        const k = selKey(f);
        if (allOn) next.delete(k);
        else if (!next.has(k)) next.set(k, { key: k, runId: f.run_id || run?.id, fingerprint: f.fingerprint, title: f.title, rule_id: f.rule_id, severity: f.severity, table: f.table });
      }
      return next;
    });
  };
  const clearSelection = () => setSelected(new Map());
  const openBulkFix = () => {
    if (!selected.size) return;
    if (selected.size > bulkMax) {
      setError(`A bulk fix covers at most ${bulkMax} findings at a time — ${selected.size} are selected. Clear some, fix these, re-scan, then continue.`);
      return;
    }
    setError('');
    setBulkItems([...selected.values()]);
  };
  /** After a batch: applied findings leave the selection; the rest stay chosen so they can be retried. */
  const onBulkSettled = (results) => {
    setSelected((cur) => {
      const next = new Map(cur);
      for (const r of results) if (r.status === 'applied') next.delete(r.key);
      return next;
    });
  };

  const openDetail = async (fingerprint) => {
    /* A finding is read from the run that produced it — in the All view the
       modules' results can come from different scans. */
    const rid = findings.find((x) => x.fingerprint === fingerprint)?.run_id || run?.id;
    setDetailRunId(rid);
    setOpenFinding(fingerprint);
    setDetail(null);
    setDetailBusy(true);
    setTab('ai');
    try {
      setDetail(await api.get(`/health/runs/${rid}/findings/${fingerprint}`));
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
    navigate(`/agent?health=${encodeURIComponent(detailRunId)}:${encodeURIComponent(openFinding)}`);
  };

  const manifest = run?.manifest;
  const metrics = manifest?.metrics || {};
  const coverage = manifest?.coverage || {};
  /* A module tab lists its own skipped checks — the server names each one's scope. */
  const skipped = (manifest?.skipped_checks || []).filter((s) => scope === 'all' || !s.scope || s.scope === scope);
  const scopeInfo = scopeList.find((x) => x.key === scope) || scopeList[0];
  /* Every number below comes from the SERVER's summary for this scope, which
     was computed over every finding the run detected — never from the page of
     findings this screen happens to have loaded. */
  const summary = manifest?.scopes?.[scope] ?? null;
  const sevCounts = summary?.severity_counts || manifest?.severity_counts || {};
  /* The All scope's score is the server's overall (overall-health.js) — never computed here. */
  const score = summary ? summary.score : (scope === 'all' ? null : metrics.cmdb_quality_score);
  /* Tab counts come from the composed view, so every tab shows its own module's latest count. */
  const countSource = composed?.manifest?.scopes || manifest?.scopes;
  const scopeCounts = countSource
    ? Object.fromEntries(Object.entries(countSource).map(([k, x]) => [k, x.findings]))
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
      return run.id
        ? `/api/health/runs/${run.id}/export.csv${q ? `?${q}` : ''}`
        : `/api/health/modules/export.csv${q ? `?${q}` : ''}`;
    })()
    : '#';
  const unreadable = coverageRows.filter((c) => !USABLE.includes(c.status));

  /* The five bands, always all five, in the server's words and the server's
     counts. Systemic stays a gate over the score — but it is also a count, and
     the chart shows it. A band with nothing in it shows a zero, not a gap. */
  const sevRows = DASHBOARD_SEVERITIES
    .map((k) => sevByKey[k] || SEVERITY_FALLBACK.find((s) => s.key === k))
    .map((s) => ({ ...s, count: sevCounts[s.key] || 0 }));
  const gate = summary?.gate ?? null;
  /* The CMDB Quality model belongs to the CMDB view and the All view (where
     its gate is a caveat on everything that reads the CMDB). A module run's
     manifest carries it too, but ITOM, ITSM and Platform must not wear CMDB's
     coverage caveats or dimensions. */
  const cmdbQ = (scope === 'cmdb' || scope === 'all') ? (summary?.cmdb_quality ?? manifest?.cmdb_quality ?? null) : null;
  const coverageLabel = cmdbQ?.composite?.coverage_label ?? null;
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
          ← Back to {view === 'findings' ? 'all findings' : 'the dashboard'}
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
                {f.catalogued && (
                  <>
                    {f.base_severity !== f.severity && (
                      <span>base <b>{sevByKey[f.base_severity]?.label || f.base_severity}</b> → effective <b>{sev.label}</b></span>
                    )}
                    {f.gate && <span className="hs-gate-chip">trust gate — outside the score</span>}
                    {f.escalated_to_systemic && <span className="hs-gate-chip">escalated to Systemic — zeroes its record, does not gate</span>}
                    {f.posture && <span className="hs-gate-chip">Systemic posture — does not gate, does not score</span>}
                    {f.pattern && <span className="hs-gate-chip">class-wide pattern — does not zero records</span>}
                    {!f.pattern && f.deduction_severity && f.deduction_severity !== f.severity && (
                      <span>charged as <b>{sevByKey[f.deduction_severity]?.label || f.deduction_severity}</b></span>
                    )}
                    <span>{f.dimension ? `dimension ${f.dimension}` : `Group ${f.catalogue_group}`}</span>
                    {f.lane && <span>lane {f.lane}</span>}
                  </>
                )}
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

                {r.catalogue && (
                  <>
                    <div className="hs-sub">How this rule works (SAOS catalogue)</div>
                    <table className="table hs-articulation">
                      <tbody>
                        <tr><th>Source tables</th><td>{r.catalogue.sourceTables}</td></tr>
                        <tr><th>Detection logic</th><td className="mono">{r.catalogue.detectionLogic}</td></tr>
                        <tr><th>Threshold</th><td>{r.catalogue.threshold}</td></tr>
                        <tr><th>Confidence basis</th><td>{r.catalogue.confidenceBasis}</td></tr>
                        <tr>
                          <th>False-positive guard</th>
                          <td>
                            {r.catalogue.falsePositiveGuard}
                            {f.false_positive_guard && (
                              <div className={f.false_positive_guard.evaluated ? 'hs-muted' : 'hs-guard-open'}>
                                {f.false_positive_guard.evaluated ? 'Checked: ' : 'Not checked by machine: '}
                                {f.false_positive_guard.note}
                              </div>
                            )}
                          </td>
                        </tr>
                        {f.modifiers && (f.modifiers.escalators?.length > 0 || f.modifiers.de_escalators?.length > 0) && (
                          <tr>
                            <th>Modifiers applied</th>
                            <td>
                              {[...(f.modifiers.escalators || []).map((m) => `↑ ${m}`), ...(f.modifiers.de_escalators || []).map((m) => `↓ ${m}`)].join(' · ')}
                            </td>
                          </tr>
                        )}
                        <tr><th>Cross-domain link</th><td>{r.catalogue.crossDomainLink}</td></tr>
                      </tbody>
                    </table>
                  </>
                )}

                {f.itsm && <ItsmFindingDetail f={f} />}

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
              runId={detailRunId}
              finding={f}
              onClose={() => setRemediating(false)}
            />
          </>
        )}
      </div>
    );
  }

  /* ══ OVERVIEW ═══════════════════════════════════════════════════════════
   * One section after another, top to bottom: header, scope, overall health,
   * health by area, findings by severity, top findings, module health, the
   * assessment detail, scan coverage. Nothing sits side by side that would
   * have to fight for width. Every number is the server's — this is
   * presentation. */
  const isAll = scope === 'all';
  const lastScanAt = run?.startedAt ? new Date(run.startedAt) : null;
  const scannedModules = moduleKeys.filter((m) => modulesInfo?.[m]?.runId);
  const hasAnyRun = scannedModules.length > 0;
  const pageTitle = isAll ? 'Full System Scan' : `${scopeInfo?.label} scan`;
  const activeSev = filter.severity ? (sevByKey[filter.severity] || { key: filter.severity, label: filter.severity, tone: 'info' }) : null;
  const activeDomain = filter.domain ? (domainRows.find((d) => d.domain === filter.domain)?.label || domainLabel[filter.domain] || filter.domain) : null;
  const topFindings = visibleFindings.slice(0, TOP_N);
  const status = areaStatus(summary);
  /* The overall's state comes from the server (scopes.all.status): the same
     precedence an area uses — Not scanned → Score unavailable → Assessment
     incomplete → the health band — decided once, not re-decided here. */
  const overallStatus = isAll ? (summary?.status ?? null) : null;
  const searchTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  /* Already searched by the server; nothing is filtered again here. */
  const searchedFindings = visibleFindings;
  const readInFull = coverageRows.filter((c) => c.status === 'complete').length;
  const readPartly = coverageRows.filter((c) => USABLE.includes(c.status) && c.status !== 'complete').length;
  /* Picking a severity from the donut or its legend: the same filter the old
     bars set, which the existing loader turns into ?severity= on the server. */
  const pickSeverity = (key) => applyFilter({ severity: !key || filter.severity === key ? '' : key });
  /* ── Assessment details: what the data actually holds for this view. ─────
   * Each category is a count over something the server already returned; a
   * category with nothing in it is not shown. Clicking one reveals the same
   * detail that used to be dumped on the page, and nothing else moves. */
  const pickRule = (rule) => applyFilter({ rule: filter.rule === rule ? '' : rule });
  const blockers = gate && !gate.trustworthy ? gate.blockers : [];
  const failingChecks = !isAll ? (summary?.checks || []).filter((c) => c.result === 'fail') : [];
  const applicableChecks = !isAll ? (summary?.checks || []).filter((c) => c.result !== 'not_applicable') : [];
  const partlyRead = coverageRows.filter((c) => USABLE.includes(c.status) && c.status !== 'complete');
  const hasScoreBuild = Boolean(
    (isAll || scope === 'cmdb') && cmdbQ?.composite?.variants?.length
    || (!isAll && cmdbQ?.dimensions?.length)
    || (!isAll && summary?.score_drivers?.length)
    || (!isAll && (summary?.score_definition || metrics.score_definition)),
  );
  const assessCats = [
    blockers.length && { key: 'blockers', label: 'Trust blockers', n: blockers.length, tone: 'systemic',
      hint: 'Base-Systemic findings that decide whether the CMDB score can be believed.' },
    (scope === 'cmdb' || isAll) && cmdbQ?.escalated?.length && { key: 'escalated', label: 'Escalated to Systemic', n: cmdbQ.escalated.length, tone: 'systemic',
      hint: 'Record findings their own context pushed to Systemic. Each zeroed its record; none gate.' },
    (scope === 'cmdb' || isAll) && cmdbQ?.patterns?.length && { key: 'patterns', label: 'Class-wide patterns', n: cmdbQ.patterns.length, tone: 'systemic',
      hint: 'A defect rate across a whole class. Raises where it is reported, never what a record is charged.' },
    (scope === 'cmdb' || isAll) && cmdbQ?.posture?.length && { key: 'posture', label: 'Systemic posture', n: cmdbQ.posture.length, tone: 'systemic',
      hint: 'Where the estate is heading. Shown, never gated, never scored.' },
    applicableChecks.length && { key: 'checks', label: 'Checks failing', n: failingChecks.length, of: applicableChecks.length,
      tone: failingChecks.length ? 'bad' : 'ok', hint: 'Capability checks this area is scored on.' },
    skipped.length && { key: 'skipped', label: 'Checks not run', n: skipped.length, tone: 'warn',
      hint: 'Rules that could not be evaluated on this run, and why.' },
    unreadable.length && { key: 'unread', label: 'Tables not read', n: unreadable.length, tone: 'bad',
      hint: 'Tables the scan could not open. Rules that depend on them did not run.' },
    partlyRead.length && { key: 'partial', label: 'Tables partly read', n: partlyRead.length, tone: 'warn',
      hint: 'Tables read in part. Their scores are withheld or qualified.' },
    hasScoreBuild && { key: 'score', label: 'How the score is built', n: null, tone: 'idle',
      hint: 'Definition, qualification and drivers of this score.' },
  ].filter(Boolean);
  const hasAssessment = assessCats.length > 0;
  /* The items worth reading first: every trust blocker (grouped by rule), every
     failing check, every table that could not be read. Capped; the categories
     above hold the rest. */
  const blockerGroups = [...blockers.reduce((m, b) => {
    const g = m.get(b.rule_id) || { rule_id: b.rule_id, title: b.title, count: 0, headline: false };
    g.count += 1; g.headline = g.headline || Boolean(b.headline);
    m.set(b.rule_id, g);
    return m;
  }, new Map()).values()];
  const importantItems = [
    ...blockerGroups.map((g) => ({
      key: `b:${g.rule_id}`, tone: 'systemic', tag: 'Trust blocker', title: g.title, code: g.rule_id,
      note: `${g.count > 1 ? `${g.count} findings` : '1 finding'}${g.headline ? ' · headline measure' : ''}`,
      onClick: () => pickRule(g.rule_id), active: filter.rule === g.rule_id,
    })),
    ...failingChecks.map((c) => ({
      key: `c:${c.key}`, tone: 'bad', tag: 'Check failing', title: c.label, code: c.failedBy.join(', '),
      note: 'counted against the score',
    })),
    ...unreadable.map((c) => ({
      key: `u:${c.table}`, tone: 'bad', tag: 'Not read', title: c.table, code: COVERAGE_LABEL[c.status] || c.status,
      note: c.error || 'rules that need it did not run',
    })),
  ];
  const shownImportant = importantItems.slice(0, IMPORTANT_SHOWN);
  const openCat = assessCats.find((c) => c.key === assessOpen) || null;
  const sevFilterBar = (
    <div className="hd-sevchips" role="group" aria-label="Filter findings by severity">
      <button type="button" className={`hd-chip${!filter.severity ? ' is-on' : ''}`}
        onClick={() => applyFilter({ severity: '' })} aria-pressed={!filter.severity}>
        All <em>{(summary?.findings ?? detected).toLocaleString()}</em>
      </button>
      {sevRows.map((s) => (
        <button key={s.key} type="button"
          className={`hd-chip tone-${s.tone}${filter.severity === s.key ? ' is-on' : ''}`}
          onClick={() => applyFilter({ severity: filter.severity === s.key ? '' : s.key })}
          aria-pressed={filter.severity === s.key} title={s.blurb}>
          <span className="hs-glyph" aria-hidden="true">{s.glyph}</span>{s.label} <em>{s.count.toLocaleString()}</em>
        </button>
      ))}
    </div>
  );

  /* ── Bulk fix: the checkbox column, the button and the selection bar ──
     Shared by the top-findings table and the full table, so the same
     selection is visible from both. The button is always present and disabled
     when nothing is chosen — a control that appears only once it is usable is
     a control nobody discovers. */
  const selectBox = (f) => (
    <input
      type="checkbox"
      className="hd-check"
      checked={isSelected(f)}
      disabled={!selectable(f)}
      onChange={() => toggleSelect(f)}
      aria-label={selectable(f) ? `Select ${f.rule_id} for bulk fix` : `${f.rule_id} has no automated fix`}
      title={selectable(f) ? undefined : 'No automated fix for this rule — the manual steps are the remedy.'}
    />
  );
  const selectAllBox = (rows) => {
    const eligible = rows.filter(selectable);
    const on = eligible.filter(isSelected).length;
    const all = eligible.length > 0 && on === eligible.length;
    return (
      <input
        type="checkbox"
        className="hd-check"
        checked={all}
        disabled={eligible.length === 0}
        ref={(el) => { if (el) el.indeterminate = on > 0 && !all; }}
        onChange={() => toggleSelectAll(rows)}
        aria-label={all ? 'Clear the selectable findings on screen' : 'Select every fixable finding on screen'}
        title={eligible.length === 0 ? 'Nothing on screen has an automated fix.' : `${eligible.length} of ${rows.length} on screen can be fixed automatically`}
      />
    );
  };
  const bulkFixButton = (
    <button
      type="button"
      className="btn primary sm"
      onClick={openBulkFix}
      disabled={selected.size === 0 || running}
      title={selected.size === 0 ? 'Tick findings to fix them together.' : running ? 'Wait for the scan to finish.' : undefined}
    >
      Bulk fix{selected.size ? ` (${selected.size})` : ''}
    </button>
  );
  /* How many chosen findings are NOT on screen right now — a filter, a search
     or a scope tab can hide part of a selection, and a bar that only counted
     visible rows would make the batch look smaller than it is. */
  const onScreen = new Set(findings.map(selKey));
  const hidden = [...selected.keys()].filter((k) => !onScreen.has(k)).length;
  const selectionBar = selected.size > 0 ? (
    <div className="hd-selbar" role="status">
      <b>{selected.size}</b> selected{hidden > 0 && <span className="hs-muted"> · {hidden} not in the current view</span>}
      {selected.size > bulkMax && <span className="hd-selbar-warn"> · over the limit of {bulkMax} per batch</span>}
      <span className="hd-selbar-actions">
        <button type="button" className="btn ghost sm" onClick={clearSelection}>Clear selection</button>
      </span>
    </div>
  ) : null;

  /* The full findings table — the charts' table-view twin. Every row, every
     filter, the lifecycle controls and the export. Reached from "View all
     findings" and from the URL (?view=findings). */
  const findingsTable = (
    <div className="card hd-section">
      <div className="hd-section-head hs-findings-head">
        <div>
          <h2 className="hd-h2">
            All findings{scope !== 'all' ? ` · ${scopeInfo?.label}` : ''}
            <span className="hd-count">{findingsBusy ? '…' : total.toLocaleString()}</span>
          </h2>
          <div className="hd-section-sub">
            {(filter.severity || filter.domain || filter.rule) ? 'Filtered' : 'Everything the scan found, most urgent first'}
            {activeDomain && <> · area <b>{activeDomain}</b></>}
            {filter.rule && (
              <button type="button" className="btn ghost sm hs-inline-clear" onClick={() => applyFilter({ rule: '' })}>
                {filter.rule} ×
              </button>
            )}
            {quietCount > 0 && <span className="hs-muted"> · {quietCount} muted or accepted</span>}
            {stored < detected && (
              /* Only for a run recorded under the former 25,000-row storage
                 cap: its counts are the full number, its rows are not. A new
                 run stores every finding it counts. */
              <span className="hs-muted"> · {stored.toLocaleString()} of {detected.toLocaleString()} stored</span>
            )}
          </div>
        </div>
        <span className="hs-head-actions">
          {filter.domain && (
            <button type="button" className="btn ghost sm" onClick={() => applyFilter({ domain: '' })}>Clear area</button>
          )}
          {quietCount > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => setShowQuiet((v) => !v)}>
              {showQuiet ? 'Hide' : 'Show'} muted
            </button>
          )}
          {/* The export honours the filters on screen. An export that does
              not match what you were looking at is a different report. */}
          <a className="btn ghost sm" href={exportHref} download>Export CSV</a>
          {bulkFixButton}
        </span>
      </div>
      {selectionBar}

      <div className="hd-findings-tools">
        {sevFilterBar}
        <label className="hd-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input type="search" className="input" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search findings — title, rule, module, table…" aria-label="Search findings" />
          {query && (
            <button type="button" className="hd-search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>
          )}
        </label>
      </div>
      {searchTerms.length > 0 && !findingsBusy && (
        <p className="hd-search-note">
          <b>{total.toLocaleString()}</b> finding{total === 1 ? '' : 's'} in this scan match
          {activeSev ? <> within <b className={`tone-${activeSev.tone} hd-tone-text`}>{activeSev.label}</b></> : null}
          {activeDomain ? <> in <b>{activeDomain}</b></> : null}.
          <span className="hs-muted"> Searched every stored finding — titles, rules, tables, and the CI names, serials, addresses and sys_ids in the evidence.</span>
        </p>
      )}

      {findingsBusy ? (
        <div className="hd-loading" aria-busy="true"><SkeletonLines lines={10} /></div>
      ) : searchedFindings.length === 0 ? (
        <EmptyState
          title={searchTerms.length
            ? `No finding in this scan matches “${query.trim()}”.`
            : total === 0 && !filter.severity && !filter.domain
              ? `Nothing found${scope !== 'all' ? ` in ${scopeInfo?.label}` : ''} in what was read.`
              : quietCount > 0 && findings.length === quietCount
                ? 'Everything here is muted or accepted.'
                : 'Nothing matches this filter.'}
          hint={searchTerms.length
            ? (filter.severity || filter.domain
              ? 'Every stored finding was searched, within the severity and area selected. Try fewer or different words, or clear the filter.'
              : 'Every stored finding was searched. Try fewer or different words, or clear the search.')
            : total === 0 && !filter.severity && !filter.domain
              ? 'That is a statement about the tables that were read, not about the whole instance. Check the scan coverage before treating it as a clean bill of health.'
              : quietCount > 0 && findings.length === quietCount
                ? 'They are still detected and still counted — "Show muted" brings them back.'
                : 'Clear the filter to see the rest.'}
          actionLabel={searchTerms.length ? 'Clear search' : undefined}
          onAction={searchTerms.length ? () => setQuery('') : undefined}
        />
      ) : (
        <div className="table-wrap">
          <table className="table hd-table">
            <thead>
              <tr>
                <th style={{ width: 34 }} className="hd-select">{selectAllBox(searchedFindings)}</th>
                <th style={{ width: 120 }}>Severity</th>
                <th>Finding</th>
                <th style={{ width: 180 }}>Area</th>
                <th style={{ width: 90 }}>Records</th>
                <th style={{ width: 170 }}>Status</th>
                <th style={{ width: 36 }} aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {searchedFindings.map((f, i) => {
                const s = sevByKey[f.severity] || { label: f.severity, tone: 'info', glyph: '●' };
                const lc = f.lifecycle?.state || 'open';
                return (
                  /* Keyed on position too: a run can store one fingerprint on
                     more than one row (seen: CMDB-092/093/094), and pages only
                     ever append, so a row's index never changes under it. */
                  <tr key={`${f.fingerprint}:${i}`} className={`click${f.quiet ? ' hs-quiet' : ''}${isSelected(f) ? ' is-selected' : ''}`}
                    onClick={() => openDetail(f.fingerprint)}>
                    <td className="hd-select" onClick={(e) => e.stopPropagation()}>{selectBox(f)}</td>
                    <td>
                      <span className={`hs-sev-tag sm tone-${s.tone}`}>
                        <span aria-hidden="true">{s.glyph}</span> {s.label}
                      </span>
                    </td>
                    <td>
                      {f.gate && <span className="hs-gate-chip sm">gate</span>}
                      {f.escalated_to_systemic && <span className="hs-gate-chip sm">escalated</span>}
                      {f.title}
                      <span className="hd-row-meta"><code>{f.rule_id}</code>{f.table ? <> · <code>{f.table}</code></> : null}</span>
                      {f.lifecycle?.reason && (
                        <span className="hs-muted"> · {f.lifecycle.reason}</span>
                      )}
                    </td>
                    <td className="hs-muted">{domainLabel[f.domain] || f.domain || '—'}</td>
                    <td className="mono">{(f.target_ids?.length ?? 0).toLocaleString()}</td>
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
        </div>
      )}
      {findings.length < total && !findingsBusy && (
        <p className="hs-fine hd-load-more">
          Showing {findings.length.toLocaleString()} of {total.toLocaleString()}.{' '}
          <button type="button" className="btn ghost sm" onClick={loadMoreFindings} disabled={findingsMoreBusy}>
            {findingsMoreBusy ? 'Loading…' : `Load ${Math.min(FINDINGS_PAGE, total - findings.length).toLocaleString()} more`}
          </button>
          <span className="hs-muted"> Or export the CSV for the full list.</span>
        </p>
      )}
    </div>
  );

  return (
    <div className="stack hd">
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div className="card hd-header">
        <div className="hd-header-main">
          <div className="hd-header-text">
            <h1 className="hd-title">{pageTitle}</h1>
            <p className="hd-subtitle">
              {isAll
                ? 'Comprehensive health check across your ServiceNow instance'
                : scopeInfo?.description || `Health check of the ${scopeInfo?.label} area of your ServiceNow instance`}
            </p>
          </div>
          <div className="hd-actions">
            <div className="hd-lastscan" title={lastScanAt ? lastScanAt.toLocaleString() : 'No scan has run yet'}>
              <span className="hd-lastscan-ic"><CalendarIcon /></span>
              <span className="hd-lastscan-text">
                <span className="hd-lastscan-label">Last scan</span>
                <b>{lastScanAt ? fmtWhen(lastScanAt) : 'Not yet'}</b>
              </span>
            </div>
            {running && (
              /* An explicit request, not a disconnect: leaving the page no longer
                 stops a check, so Stop has to say so on purpose. The server stops
                 at the next table boundary; a health check only reads, so nothing
                 is left half-done. */
              <button type="button" className="btn ghost" onClick={stopHealthRun} disabled={!healthRun.runId}>
                Stop
              </button>
            )}
            <RunScanMenu running={running} disabled={running || !scanModules.length} onRun={() => start()}
              label={hasAnyRun ? 'Run scan' : 'Run scan'}>
              <ScanOptions
                scopes={scopeList}
                modules={moduleKeys}
                selected={scanModules}
                onChange={chooseModules}
                reuse={reuse}
                onReuse={chooseReuse}
                disabled={running}
              />
            </RunScanMenu>
          </div>
        </div>
        {running && progress && (
          <div className="hd-progress" role="status" aria-live="polite">
            <div className="hd-progress-track"><span style={{ width: `${Math.max(2, progress.percent ?? 0)}%` }} /></div>
            <div className="hd-progress-cap">
              Scanning{progress.percent != null ? ` · ${progress.percent}%` : ''} — {progress.stage}{progress.table ? ` · ${progress.table}` : ''}
              <span className="hs-muted"> · keeps running if you leave this page</span>
            </div>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>

      {(composed || moduleRun) && (
        <ScopeSwitch scopes={scopeList} value={scope} onChange={pickScope} counts={scopeCounts} />
      )}

      {!run && !running && !error && (scope === 'all' ? !composed : !moduleRunId) && (
        <div className="card">
          {scope === 'all' || !composed ? (
            <EmptyState
              title="No scan has run against this instance."
              hint="A scan reads your CMDB, services, integrations and platform tables, then reports what it found. Nothing is written."
              actionLabel="Run scan"
              onAction={() => start()}
            />
          ) : (
            <EmptyState
              title={`${scopeInfo?.label} has not been scanned on this instance yet.`}
              hint="Each area keeps its own result. Scanning this one leaves the others as they are."
              actionLabel={`Scan ${scopeInfo?.label}`}
              onAction={() => start([scope])}
            />
          )}
        </div>
      )}

      {run && view === 'findings' && (
        <>
          <button type="button" className="btn ghost sm hs-back" onClick={showDashboard}>← Back to dashboard</button>
          {findingsTable}
        </>
      )}

      {run && view !== 'findings' && (
        <>
          {/* ── OVERALL HEALTH. On the All view: the server's overall
                 (overall-health.js) — the mean share of attainable health over
                 the scored areas, with its assessment state, the areas beside
                 it, and coverage and Systemic posture kept apart from the
                 number. On a module view: that area's own score. ─────────── */}
          {isAll ? (
            <section className="card hd-section hd-overall-card">
              <div className="hd-section-head">
                <h2 className="hd-h2">Overall health</h2>
              </div>
              <div className="hd-overall hd-overall-all">
                <div className="hd-hero"
                  title="Mean share of attainable health across the assessed areas, with each area counted once. It is not a percentage of records or checks.">
                  {overallStatus && score != null ? (
                    <>
                      <div className={`hd-hero-num tone-${overallStatus.tone}`}>{score}<span className="hs-score-pct">%</span></div>
                      <div className={`hd-status tone-${overallStatus.tone}`}
                        title={overallStatus.state === 'incomplete'
                          ? 'One or more scored areas have an assessment blocker or incomplete measurement, so the overall result should be treated as provisional.'
                          : (summary?.health_band ? `${summary.health_band.word}: ${overallStatus.reason}` : undefined)}>
                        <i aria-hidden="true" />{overallStatus.word}
                      </div>
                      <p className="hd-hero-line">
                        {overallStatus.state === 'incomplete'
                          ? <>{overallStatus.reason}{summary?.health_band ? <span className="hs-muted"> · measured part sits in the {summary.health_band.word.toLowerCase()} band</span> : null}</>
                          : summary?.attribution
                            ? <><b className="hd-attribution">{summary.attribution.word}</b><span className="hs-muted"> · {overallStatus.reason}</span></>
                            : overallStatus.reason}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="hd-hero-num hd-hero-na">N/A</div>
                      <div className={`hd-status tone-${overallStatus?.tone ?? 'idle'}`}><i aria-hidden="true" />{overallStatus?.word ?? 'Score unavailable'}</div>
                      <p className="hd-hero-line">{overallStatus?.reason ?? neutral(summary?.score_withheld_because) ?? 'No scored area has a result yet.'}</p>
                    </>
                  )}
                </div>
                <div className="hd-breakdown" role="list" aria-label="Areas">
                  {moduleKeys.map((m) => {
                    const sum = manifest?.scopes?.[m] ?? null;
                    const st = areaStatus(sum);
                    const b = summary?.module_breakdown?.[m];
                    return (
                      <button key={m} type="button" role="listitem" className={`hd-breakdown-row tone-${st.tone}${b?.included ? '' : ' is-out'}`}
                        onClick={() => pickScope(m)} title={`${scopeList.find((x) => x.key === m)?.description || m} — ${st.why}${b?.included ? ` · weight ${Math.round((b.effective_weight ?? 0) * 100)}%` : ' · not in the overall'}`}>
                        <span className="hd-breakdown-label">{scopeList.find((x) => x.key === m)?.label || m.toUpperCase()}</span>
                        <span className="hd-breakdown-meter" aria-hidden="true">
                          {sum?.score != null && <span style={{ width: `${Math.max(2, Math.min(100, sum.score))}%` }} />}
                        </span>
                        <b className="hd-breakdown-score">{sum?.score != null ? sum.score : '—'}</b>
                        <span className="hd-breakdown-word">{st.word}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="hd-overall-chips">
                <span className="hd-ochip" title="Coverage shows how much of the applicable instance was assessed. It is separate from health.">
                  <span>Coverage</span><b>{summary?.coverage_share != null ? `${Math.round(summary.coverage_share * 100)}%` : '—'}</b>
                </span>
                <span className="hd-ochip tone-systemic" title="Assessment blockers affect assessment status. Systemic posture is shown separately; findings already included in module scores are not counted again.">
                  <span>Systemic</span>
                  <b>{summary?.systemic
                    ? `${summary.systemic.blockers} blocker${summary.systemic.blockers === 1 ? '' : 's'} · ${summary.systemic.posture} posture`
                    : '—'}</b>
                </span>
                <span className="hd-ochip" title={summary?.scoring ? `${summary.scoring.model} · equal weights over ${summary.scoring.participants?.length ?? 0} scored areas · key ${summary.scoring.key}` : 'No overall model yet'}>
                  <span>Model</span><b>{summary?.scoring?.model ? `v${summary.scoring.model.split('/')[1] ?? '1'}` : '—'}</b>
                </span>
                {lastScanAt && <span className="hd-ochip"><span>Last scan</span><b>{fmtWhen(lastScanAt)}</b></span>}
              </div>
              <Trend points={points} scope="all" label="Overall" />
            </section>
          ) : (
          <section className="card hd-section hd-overall-card">
            <div className="hd-section-head">
              <h2 className="hd-h2">Overall health</h2>
            </div>
            <div className="hd-overall">
              <div className="hd-hero">
                {score == null ? (
                  <>
                    <div className="hd-hero-num hd-hero-na">N/A</div>
                    <div className={`hd-status tone-${status.tone}`}><i aria-hidden="true" />{status.word}</div>
                    <p className="hd-hero-line">{status.why}</p>
                  </>
                ) : (
                  <>
                    <div className={`hd-hero-num tone-${status.tone}`}>{score}<span className="hs-score-pct">%</span></div>
                    <div className={`hd-status tone-${status.tone}`}><i aria-hidden="true" />{status.word}</div>
                    <p className="hd-hero-line">{scopeInfo?.label} score{coverageLabel ? ` · ${coverageLabel}` : ''}</p>
                  </>
                )}
              </div>
              <div className="hd-facts">
                <div><b>{(summary?.findings ?? 0).toLocaleString()}</b><span>findings in {scopeInfo?.label}</span></div>
                <div><b>{(scope === 'cmdb' ? (metrics.visible_cis ?? 0) : coverageRows.length).toLocaleString()}</b><span>{scope === 'cmdb' ? 'CIs read' : 'tables read'}</span></div>
                <div className={unreadable.length ? 'tone-warn' : ''}><b>{unreadable.length}</b><span>tables unreadable</span></div>
                <div><b className="hd-fact-when">{lastScanAt ? fmtWhen(lastScanAt) : '—'}</b><span>last scan</span></div>
              </div>
            </div>
            {/* No per-area trend here (21 Sep 2026): the line under an area's
                score was removed as noise. The estate's trend stays on the
                Full System Scan card; the per-area history is still stored. */}
          </section>
          )}

          {/* ── HEALTH BY AREA. One column per area the server scored. ───── */}
          {isAll && (
            <section className="card hd-section">
              <div className="hd-section-head hs-findings-head">
                <div>
                  <h2 className="hd-h2">Health by area</h2>
                  <span className="hd-section-sub">Each area's own score. Pick one to look inside it.</span>
                </div>
              </div>
              <AreaBars summaries={manifest?.scopes} scopes={scopeList} onPick={pickScope} />
            </section>
          )}

          {/* ── FINDINGS BY SEVERITY. Five slices, the total in the middle.
                 Click a slice to filter the top findings below. ─────────── */}
          <section className="card hd-section">
            <div className="hd-section-head hs-findings-head">
              <div>
                <h2 className="hd-h2">Findings by severity</h2>
                <span className="hd-section-sub">
                  {activeSev
                    ? <>Showing <b className={`tone-${activeSev.tone} hd-tone-text`}>{activeSev.label}</b> findings below. Click it again, or All severities, to show every severity.</>
                    : 'Click a severity to show only those findings below.'}
                </span>
              </div>
              {activeSev && (
                <button type="button" className="btn ghost sm" onClick={() => pickSeverity(null)}>Show all</button>
              )}
            </div>
            <SeverityDonut
              rows={sevRows}
              total={summary?.findings ?? detected}
              active={filter.severity || null}
              onPick={pickSeverity}
            />
          </section>

          {/* ── TOP FINDINGS. The first ten, in the server's priority order,
                 of whatever the severity above selected. ────────────────── */}
          <section className="card hd-section">
            <div className="hd-section-head hs-findings-head">
              <div>
                <h2 className="hd-h2">
                  Top findings
                  {activeSev && <span className={`hs-sev-tag sm tone-${activeSev.tone} hd-h2-tag`}><span aria-hidden="true">{activeSev.glyph}</span> {activeSev.label}</span>}
                </h2>
                <span className="hd-section-sub">
                  {findingsBusy
                    ? <>Loading{activeSev ? ` ${activeSev.label.toLowerCase()}` : ''} findings…</>
                    : total > 0
                      ? <>Showing {Math.min(TOP_N, visibleFindings.length)} of {total.toLocaleString()}{activeSev ? ` ${activeSev.label.toLowerCase()}` : ''} finding{total === 1 ? '' : 's'}, most urgent first.</>
                      : 'Most urgent first.'}
                  {activeDomain && <> · module <b>{activeDomain}</b> <button type="button" className="btn ghost sm hs-inline-clear" onClick={() => applyFilter({ domain: '' })}>×</button></>}
                  {filter.rule && <> · rule <button type="button" className="btn ghost sm hs-inline-clear" onClick={() => applyFilter({ rule: '' })}>{filter.rule} ×</button></>}
                  {quietCount > 0 && <span className="hs-muted"> · {quietCount} muted or accepted hidden</span>}
                </span>
              </div>
              <span className="hs-head-actions">
                <button type="button" className="btn ghost sm" onClick={showAllFindings}>View all findings →</button>
                {bulkFixButton}
              </span>
            </div>
            {selectionBar}

            {findingsBusy ? (
              <div className="hd-loading" aria-busy="true"><SkeletonLines lines={6} /></div>
            ) : topFindings.length === 0 ? (
              <EmptyState
                title={total === 0 && !filter.severity && !filter.domain && !filter.rule
                  ? `Nothing found${scope !== 'all' ? ` in ${scopeInfo?.label}` : ''} in what was read.`
                  : quietCount > 0 && findings.length === quietCount
                    ? 'Everything here is muted or accepted.'
                    : `No ${activeSev ? activeSev.label.toLowerCase() : ''} findings match.`}
                hint={total === 0 && !filter.severity && !filter.domain && !filter.rule
                  ? 'That is a statement about the tables that were read, not about the whole instance. Check the scan coverage below before treating it as a clean bill of health.'
                  : quietCount > 0 && findings.length === quietCount
                    ? 'They are still detected and still counted — "View all findings" can show them.'
                    : 'Pick another severity, or All, to see the rest.'}
              />
            ) : (
              <div className="table-wrap">
                <table className="table hd-table hd-top">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }} className="hd-select">{selectAllBox(topFindings)}</th>
                      <th style={{ width: 120 }}>Severity</th>
                      <th>Finding</th>
                      <th style={{ width: 200 }}>Module</th>
                      <th style={{ width: 96 }}>Records</th>
                      <th style={{ width: 36 }} aria-label="Open" />
                    </tr>
                  </thead>
                  <tbody>
                    {topFindings.map((f) => {
                      const s = sevByKey[f.severity] || { label: f.severity, tone: 'info', glyph: '●' };
                      const lc = f.lifecycle?.state || 'open';
                      return (
                        <tr key={f.fingerprint} className={`click${f.quiet ? ' hs-quiet' : ''}${isSelected(f) ? ' is-selected' : ''}`}
                          onClick={() => openDetail(f.fingerprint)}>
                          <td className="hd-select" onClick={(e) => e.stopPropagation()}>{selectBox(f)}</td>
                          <td>
                            <span className={`hs-sev-tag sm tone-${s.tone}`}>
                              <span aria-hidden="true">{s.glyph}</span> {s.label}
                            </span>
                          </td>
                          <td>
                            {f.gate && <span className="hs-gate-chip sm">gate</span>}
                            {f.escalated_to_systemic && <span className="hs-gate-chip sm">escalated</span>}
                            {f.title}
                            {lc !== 'open' && <span className="hs-lc hd-lc">{stateLabel(lc)}</span>}
                          </td>
                          <td className="hs-muted">{domainLabel[f.domain] || f.domain || '—'}</td>
                          <td className="mono">{(f.target_ids?.length ?? 0).toLocaleString()}</td>
                          <td className="hs-muted">→</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!findingsBusy && total > topFindings.length && (
              <div className="hd-section-foot">
                <span className="hs-muted">{(total - topFindings.length).toLocaleString()} more{activeSev ? ` ${activeSev.label.toLowerCase()}` : ''} finding{total - topFindings.length === 1 ? '' : 's'} not shown here.</span>
                <button type="button" className="btn ghost sm" onClick={showAllFindings}>View all findings →</button>
              </div>
            )}
          </section>

          {/* ── MODULE HEALTH. Magnitude by module — one series, one colour.
                 Colouring each bar by its own size would double-encode
                 length as hue. Click to filter the top findings. ─────────── */}
          <section className="card hd-section">
            <div className="hd-section-head hs-findings-head">
              <div>
                <h2 className="hd-h2">Module health</h2>
                <span className="hd-section-sub">
                  Findings per module{scope !== 'all' ? ` in ${scopeInfo?.label}` : ''}. Click a module to show only its findings above.
                </span>
              </div>
              {filter.domain && (
                <button type="button" className="btn ghost sm" onClick={() => applyFilter({ domain: '' })}>Clear module filter</button>
              )}
            </div>
            {domainRows.length === 0 ? (
              <p className="hs-muted">No module reported a finding{scope !== 'all' ? ` in ${scopeInfo?.label}` : ''}.</p>
            ) : (
              <div className={`hs-bars hd-modbars${domainRows.length > 6 ? ' is-dense' : ''}`}>
                {(showAllModules || filter.domain ? domainRows : domainRows.slice(0, MODULES_SHOWN)).map((d) => (
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
            )}
            {domainRows.length > MODULES_SHOWN && !filter.domain && (
              <div className="hd-section-foot">
                <span className="hs-muted">
                  {showAllModules
                    ? `All ${domainRows.length} modules with findings.`
                    : `${domainRows.length - MODULES_SHOWN} more module${domainRows.length - MODULES_SHOWN === 1 ? '' : 's'} with fewer findings.`}
                </span>
                <button type="button" className="btn ghost sm" onClick={() => setShowAllModules((x) => !x)} aria-expanded={showAllModules}>
                  {showAllModules ? 'Show fewer' : `Show all ${domainRows.length}`}
                </button>
              </div>
            )}
          </section>

          {/* ── ITSM: the catalogue, its parameters, and the links it states. ── */}
          {scope === 'itsm' && (
            <ItsmCatalogue
              itsm={manifest?.itsm}
              activeRule={filter.rule}
              onPickRule={(rule) => applyFilter({ rule: filter.rule === rule ? '' : rule })}
            />
          )}
          {scope === 'itsm' && <ItsmParameters />}
          {(scope === 'itsm' || scope === 'cmdb') && (
            <CrossDomainLinks links={manifest?.links} onOpenFinding={openDetail} />
          )}

          {/* ── ASSESSMENT DETAILS — hidden on every Health Assist module for now.
                Commented out, not removed: delete the leading "// " on the lines
                below to bring it back. The data it reads (assessCats, openCat,
                importantItems, assessOpen) is still computed above. ────────── */}
          {
          //   {/* ── ASSESSMENT DETAILS. Summary first: one tile per category the
          //         data actually holds. Then the items worth reading first. Then,
          //         on demand, the same detail that used to be dumped here —
          //         blockers, escalations, patterns, posture, checks, coverage
          //         gaps, how the score is built. ───────────────────────────── */}
          //   {hasAssessment && (
          //     <section className="card hd-section hd-assess">
          //       <div className="hd-section-head hs-findings-head">
          //         <div>
          //           <h2 className="hd-h2">Assessment details</h2>
          //           <span className="hd-section-sub">What qualifies this assessment{scope !== 'all' ? ` of ${scopeInfo?.label}` : ''}. Pick a category to see the detail.</span>
          //         </div>
          //         {openCat && (
          //           <button type="button" className="btn ghost sm" onClick={() => setAssessOpen(null)}>Close detail</button>
          //         )}
          //       </div>
          // 
          //       <div className="hd-assess-cats" role="group" aria-label="Assessment categories">
          //         {assessCats.map((c) => (
          //           <button key={c.key} type="button"
          //             className={`hd-assess-cat tone-${c.tone}${assessOpen === c.key ? ' is-on' : ''}`}
          //             onClick={() => setAssessOpen(assessOpen === c.key ? null : c.key)}
          //             aria-pressed={assessOpen === c.key} title={c.hint}>
          //             <span className="hd-assess-cat-label"><i aria-hidden="true" />{c.label}</span>
          //             <b className="hd-assess-cat-n">
          //               {c.n == null ? <span className="hd-assess-cat-more" aria-hidden="true">→</span> : c.n.toLocaleString()}
          //               {c.of != null && <small> / {c.of}</small>}
          //             </b>
          //           </button>
          //         ))}
          //       </div>
          // 
          //     {!openCat && shownImportant.length > 0 && (
          //       <div className="hd-assess-important">
          //         <div className="hs-sub">Important assessment items</div>
          //         <ol className="hd-important">
          //           {shownImportant.map((it, i) => (
          //             <li key={it.key}>
          //               {it.onClick ? (
          //                 <button type="button" className={`hd-important-row tone-${it.tone}${it.active ? ' is-active' : ''}`}
          //                   onClick={it.onClick} title="Click to show these findings in Top findings">
          //                   <span className="hd-important-n">{i + 1}</span>
          //                   <span className="hd-important-tag">{it.tag}</span>
          //                   <span className="hd-important-title">{it.title}<code>{it.code}</code></span>
          //                   <span className="hd-important-note">{it.note}</span>
          //                 </button>
          //               ) : (
          //                 <div className={`hd-important-row tone-${it.tone}`}>
          //                   <span className="hd-important-n">{i + 1}</span>
          //                   <span className="hd-important-tag">{it.tag}</span>
          //                   <span className="hd-important-title">{it.title}<code>{it.code}</code></span>
          //                   <span className="hd-important-note">{it.note}</span>
          //                 </div>
          //               )}
          //             </li>
          //           ))}
          //         </ol>
          //         {importantItems.length > shownImportant.length && (
          //           <p className="hs-fine">{importantItems.length - shownImportant.length} more in the categories above.</p>
          //         )}
          //       </div>
          //     )}
          // 
          //     {openCat && (
          //       <div className="hd-assess-detail" key={openCat.key}>
          //         <div className="hd-assess-detail-head">
          //           <span className={`hd-assess-detail-title tone-${openCat.tone}`}>
          //             <i aria-hidden="true" />{openCat.label}{openCat.n != null && <b>{openCat.n.toLocaleString()}{openCat.of != null ? ` of ${openCat.of}` : ''}</b>}
          //           </span>
          //           <span className="hs-muted">{openCat.hint}</span>
          //         </div>
          // 
          //         {openCat.key === 'blockers' && (
          //           <div className="hd-assess-body">
          //             <p className="hs-lead">
          //               These findings mean the mechanism that should keep the CMDB honest is itself broken. They do not deduct
          //               points — they decide whether the score can be believed. Click one to show its findings in Top findings.
          //             </p>
          //             <ul className="hs-gate-list">
          //               {blockers.map((b) => (
          //                 <li key={b.fingerprint}>
          //                   <button type="button" className={`hs-gate-item${filter.rule === b.rule_id ? ' is-active' : ''}`}
          //                     onClick={() => pickRule(b.rule_id)}>
          //                     <code>{b.rule_id}</code> {b.title}{b.headline ? <span className="hs-gate-chip sm">headline measure</span> : null}
          //                   </button>
          //                 </li>
          //               ))}
          //             </ul>
          //             {gate?.headline && (
          //               <p className="hs-fine">
          //                 <b>Headline — impact analysis:</b> affected services are found for {gate.headline.numerator} of {gate.headline.denominator}{' '}
          //                 ({Number(gate.headline.pass_pct).toFixed(1)}%) {gate.headline.basis}. {gate.headline.alerts}
          //               </p>
          //             )}
          //           </div>
          //         )}
          //         {openCat.key === 'escalated' && (
          //           <EscalatedBand escalated={cmdbQ?.escalated || []} patterns={[]} activeRule={filter.rule} sevByKey={sevByKey} onPick={pickRule} bare />
          //         )}
          //         {openCat.key === 'patterns' && (
          //           <EscalatedBand escalated={[]} patterns={cmdbQ?.patterns || []} activeRule={filter.rule} sevByKey={sevByKey} onPick={pickRule} bare />
          //         )}
          //         {openCat.key === 'posture' && (
          //           <PosturePanel posture={cmdbQ?.posture || []} activeRule={filter.rule} onPick={pickRule} bare />
          //         )}
          //         {openCat.key === 'checks' && (
          //           /* ITOM is scored by CHECKS, so the checks are the explanation.
          //              A check that could not be evaluated says why and is left out
          //              of the score — it is never shown as a pass. */
          //           <div className="hd-assess-body">
          //             <ul className="hs-checks">
          //               {(summary?.checks || []).map((c) => (
          //                 <li key={c.key} className={`hs-check is-${c.result}`}>
          //                   <span className="hs-check-mark" aria-hidden="true">
          //                     {c.result === 'pass' ? '✓' : c.result === 'fail' ? '✗' : '–'}
          //                   </span>
          //                   <span className="hs-check-label">{c.label}</span>
          //                   <span className="hs-check-why">
          //                     {c.result === 'pass' && 'passes'}
          //                     {c.result === 'fail' && `fails · ${c.failedBy.join(', ')}`}
          //                     {c.result === 'not_applicable' && `not counted · ${c.reason}`}
          //                   </span>
          //                 </li>
          //               ))}
          //             </ul>
          //           </div>
          //         )}
          //         {openCat.key === 'skipped' && (
          //           <div className="hd-assess-body table-wrap">
          //             <table className="table">
          //               <thead><tr><th>Check</th><th>Table</th><th>Why it did not run</th></tr></thead>
          //               <tbody>
          //                 {skipped.map((s, i) => (
          //                   <tr key={`${s.rule}-${s.table}-${i}`}>
          //                     <td className="mono">{s.rule || '—'}</td>
          //                     <td className="mono">{s.table || '—'}</td>
          //                     <td>
          //                       {COVERAGE_LABEL[s.reason] || s.reason}
          //                       {s.excluded_records ? ` · ${s.excluded_records} record(s) excluded` : ''}
          //                     </td>
          //                   </tr>
          //                 ))}
          //               </tbody>
          //             </table>
          //           </div>
          //         )}
          //         {(openCat.key === 'unread' || openCat.key === 'partial') && (
          //           <div className="hd-assess-body">
          //             <div className="hs-cov">
          //               {(openCat.key === 'unread' ? unreadable : partlyRead).map((c) => (
          //                 <span key={c.table} className={`hs-cov-chip tone-${coverageTone(c.status)}`} title={c.error || c.scope || ''}>
          //                   <b>{c.table}</b>
          //                   <span>{COVERAGE_LABEL[c.status] || c.status}</span>
          //                   {c.records != null && (
          //                     <em>{c.records}{c.reported_total != null && c.reported_total !== c.records ? ` / ${c.reported_total}` : ''}</em>
          //                   )}
          //                 </span>
          //               ))}
          //             </div>
          //             <p className="hs-fine">
          //               {openCat.key === 'unread'
          //                 ? 'A table that is absent on this instance and one this account may not read are different problems — hover a chip to see which. Rules that depend on these tables did not run.'
          //                 : 'Only part of these tables was read, so a score over them would describe our access rather than the estate. They are excluded from the denominators that need them in full.'}
          //             </p>
          //           </div>
          //         )}
          //         {openCat.key === 'score' && (
          //           <div className="hd-assess-body">
          //             {!isAll && (summary?.score_definition || metrics.score_definition) && (
          //               <p className="hs-lead"><b>Definition.</b> {neutral(summary?.score_definition || metrics.score_definition)} {summary?.score_basis && <b>{summary.score_basis}</b>}</p>
          //             )}
          //             {!isAll && scope === 'itsm' && summary?.itsm_quality && (
          //               /* ITSM Quality (itsm-quality.js): the two parts, the population they
          //                  describe, and what the catalogue could not establish. */
          //               <p className="hs-fine">
          //                 <b>Parts.</b> Record part {summary.itsm_quality.record_part ?? '—'} over {summary.itsm_quality.population.records.toLocaleString()} records
          //                 {summary.itsm_quality.rule_part != null && <> · rule part {summary.itsm_quality.rule_part} over {summary.itsm_quality.rules.rule_part_pass + summary.itsm_quality.rules.rule_part_fail} estate-level rules</>}
          //                 {' '}· {summary.itsm_quality.rules.evaluated} of {summary.itsm_quality.rules.catalogue} catalogue rules evaluated
          //                 {summary.itsm_quality.rules.inconclusive ? `, ${summary.itsm_quality.rules.inconclusive} inconclusive` : ''}
          //                 {summary.itsm_quality.rules.unconfigured ? `, ${summary.itsm_quality.rules.unconfigured} awaiting a parameter` : ''}
          //                 {summary.itsm_quality.rules.unavailable ? `, ${summary.itsm_quality.rules.unavailable} unavailable here` : ''}
          //                 {summary.itsm_quality.systemic.findings ? ` · ${summary.itsm_quality.systemic.findings} Systemic finding${summary.itsm_quality.systemic.findings === 1 ? '' : 's'} beside the score, not in it` : ''}
          //                 {summary.itsm_quality.records.merged_by_family ? ` · ${summary.itsm_quality.records.merged_by_family} duplicate charge${summary.itsm_quality.records.merged_by_family === 1 ? '' : 's'} merged` : ''}.
          //               </p>
          //             )}
          //             {/* CMDB-116: the composite three ways. Shown wherever the CMDB score
          //                 is, All view included — the screenshot surface must say whether
          //                 the number can be believed. */}
          //             {(isAll || scope === 'cmdb') && cmdbQ?.composite?.variants?.length > 0 && (
          //               <details className="hd-details" open={isAll}>
          //                 <summary>CMDB score — how far can it be quoted?</summary>
          //                 <TrustVariants composite={cmdbQ.composite} />
          //               </details>
          //             )}
          //             {!isAll && cmdbQ?.dimensions?.length > 0 && (
          //               <details className="hd-details">
          //                 <summary>CMDB Quality by dimension</summary>
          //                 <Dimensions q={cmdbQ} />
          //               </details>
          //             )}
          //             {/* WHAT IS PULLING THE SCORE DOWN. A bare 0.3% says nothing a
          //                 person can act on; "3,233 CIs have no owner" does. Shares
          //                 overlap — one record can fail several rules — so they are
          //                 not meant to add up, and the caption says so. */}
          //             {!isAll && summary?.score_drivers?.length > 0 && (
          //               <details className="hd-details" open={!cmdbQ}>
          //                 <summary>{cmdbQ ? 'Legacy CMDB checks — not yet part of the CMDB Quality score' : 'What is pulling the score down'}</summary>
          //                 <div className="hs-drivers">
          //                   {summary.score_drivers.map((d) => {
          //                     const tone = sevByKey[d.severity]?.tone || 'info';
          //                     const top = summary.score_drivers[0].records || 1;
          //                     return (
          //                       <button
          //                         key={d.rule_id}
          //                         type="button"
          //                         className={`hs-driver${filter.rule === d.rule_id ? ' is-active' : ''}`}
          //                         onClick={() => pickRule(d.rule_id)}
          //                         title={`${d.rule_id} — click to see these findings`}
          //                       >
          //                         <span className="hs-driver-label">{d.label}</span>
          //                         <span className="hs-bar-track">
          //                           <span className={`hs-bar-fill tone-${tone}`} style={{ width: `${Math.max(2, (d.records / top) * 100)}%` }} />
          //                         </span>
          //                         <span className="hs-driver-n">
          //                           {d.records.toLocaleString()}{d.share != null ? ` · ${d.share}%` : ''}
          //                         </span>
          //                       </button>
          //                     );
          //                   })}
          //                   <p className="hs-fine">
          //                     Records affected per rule, as a share of what was read. One record can fail several rules, so these
          //                     overlap and do not add up. Click one to see those findings.
          //                   </p>
          //                 </div>
          //               </details>
          //             )}
          //           </div>
          //         )}
          //       </div>
          //     )}
          //   </section>
          // )}
          }

          {/* ── SCAN & DATA COVERAGE. A summary; the detail is one click down.
                 Findings are only ever about what was read, and a table we
                 could not open is not a clean table. ────────────────────── */}
          <section className="card hd-section">
            <div className="hd-section-head hs-findings-head">
              <div>
                <h2 className="hd-h2">Scan &amp; data coverage{scope !== 'all' ? ` · ${scopeInfo?.label}` : ''}</h2>
                <span className="hd-section-sub">
                  {run?.status === 'partial'
                    ? 'Some tables could not be read, so findings describe only what was read.'
                    : 'Findings describe only what was read. A table that could not be opened is not a clean table.'}
                </span>
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setShowCoverage((x) => !x)} aria-expanded={showCoverage}>
                {showCoverage ? 'Hide details' : 'Show details'}
              </button>
            </div>
            <div className="hd-facts hd-facts-cov">
              <div className="tone-ok"><b>{readInFull}</b><span>tables read in full</span></div>
              <div className={readPartly ? 'tone-warn' : ''}><b>{readPartly}</b><span>partly read</span></div>
              <div className={unreadable.length ? 'tone-bad' : ''}><b>{unreadable.length}</b><span>unreadable</span></div>
              <div className={skipped.length ? 'tone-warn' : ''}><b>{skipped.length}</b><span>check{skipped.length === 1 ? '' : 's'} did not run</span></div>
            </div>
            <ModuleTimes info={modulesInfo} scopes={scopeList} only={scope === 'all' ? null : scope} />
            {/* This used to say "it never writes, and it has no tool that could",
                which stopped being true when remediation shipped. The words now
                come from the server, which states both halves. */}
            <p className="hs-fine">
              Reads {meta?.tables?.length ?? 0} allow-listed tables across CMDB, ITOM, ITSM and platform hygiene.{' '}
              {meta?.note || 'Checks only read. A fix is proposed first, and nothing changes until you approve it.'}
            </p>
            {run?.error && <p className="error-text">{run.error}</p>}

            {showCoverage && (
              <div className="hd-cov-detail">
                <div className="hs-sub">Tables</div>
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
                {skipped.length > 0 && (
                  <>
                    <div className="hs-sub">{skipped.length} check{skipped.length === 1 ? '' : 's'} that did not run</div>
                    <div className="table-wrap">
                      <table className="table">
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
                    </div>
                  </>
                )}
                <ScanStateCard open={showScanState} onToggle={() => setShowScanState((v) => !v)} bare />
              </div>
            )}
          </section>
        </>
      )}

      {/*
        * THE BATCH REVIEW. The same review the single drawer gives, once per
        * chosen finding — proposals, editable values, the executor's card for
        * every write, and a per-finding result. The page hands it a snapshot
        * and learns what settled; it streams nothing itself.
        */}
      <BulkFixDrawer
        open={Boolean(bulkItems)}
        items={bulkItems || []}
        onClose={() => setBulkItems(null)}
        onSettled={onBulkSettled}
      />
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
