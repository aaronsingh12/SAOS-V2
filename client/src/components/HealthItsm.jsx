import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { toast } from './toast.js';

/**
 * The ITSM section of Health Assist — the 139-rule catalogue as the scan left it.
 *
 * Everything here is READ from what the server stored: the run's
 * `manifest.itsm` (every rule's status, verdict, population, blocker, confidence,
 * parameters and dependencies), `manifest.links` (the cross-domain links) and
 * `/health/itsm/parameters`. Nothing is re-decided in the browser: a rule that
 * could not run says why, a rule that ran but established nothing says so, and
 * none of it is shown as a pass. The ITSM score on the card above stays the
 * eleven original rules' number — the catalogue reports verdicts, not a score.
 */

const OUTCOMES = [
  { key: 'fail', label: 'Fail', tone: 'critical', glyph: '✗' },
  { key: 'pass', label: 'Pass', tone: 'ok', glyph: '✓' },
  { key: 'inconclusive', label: 'Inconclusive', tone: 'warn', glyph: '?' },
  { key: 'unconfigured', label: 'Needs a parameter', tone: 'moderate', glyph: '◇' },
  { key: 'unavailable', label: 'Cannot run here', tone: 'info', glyph: '–' },
  { key: 'skipped', label: 'Input did not run', tone: 'info', glyph: '–' },
  { key: 'error', label: 'Error', tone: 'major', glyph: '!' },
];
const OUTCOME = Object.fromEntries(OUTCOMES.map((o) => [o.key, o]));

const UNDETERMINED_LABEL = {
  empty_population: 'nothing in scope',
  nothing_judgeable: 'nothing it could judge',
  below_minimum_volume: 'below the minimum volume',
  insufficient_history: 'needs more scans',
  input_inconclusive: 'an input established nothing',
  population_unknown: 'the population could not be counted',
  population_undeclared: 'no population declared',
};
const BLOCKER_LABEL = {
  undefined_object: 'object not defined by the workbook',
  undefined_table: 'table not usable on this instance',
  undefined_dependency: 'dependency not defined',
  specification_gap: 'specification gap',
  unconfigured_parameter: 'parameter has no value',
  instance_value: 'value not on this instance',
  capability: 'the instance cannot answer',
  read: 'a read failed',
  input: 'an input rule did not run',
  error: 'engine error',
};

/** The one outcome a rule row shows: its verdict when it evaluated, else its status. */
export function outcomeOf(r) {
  if (r.status === 'evaluated') return OUTCOME[r.verdict] || OUTCOME.inconclusive;
  if (r.status === 'unconfigured') return OUTCOME.unconfigured;
  if (r.status === 'error') return OUTCOME.error;
  if (r.status === 'skipped' || r.status === 'not_run') return OUTCOME.skipped;
  return OUTCOME.unavailable;
}

const determinate = (r) => Boolean(r.population?.determinate_when_empty) && r.population.total === 0;

/** Why a rule landed where it did, in one line. */
export function whyOf(r) {
  if (r.status !== 'evaluated') {
    const b = r.blocker;
    return `${BLOCKER_LABEL[b?.kind] || r.status}${r.reason ? ` — ${r.reason}` : ''}`;
  }
  if (r.verdict === 'fail') return `${r.findings} finding${r.findings === 1 ? '' : 's'}`;
  if (r.undetermined) return `${UNDETERMINED_LABEL[r.undetermined.kind] || r.undetermined.kind} — ${r.undetermined.reason}`;
  if (r.verdict === 'inconclusive' && r.scope?.partial) return `covers only part of its detection (${r.scope.kind})${r.scope.not_covered ? ` — ${r.scope.not_covered}` : ''}`;
  if (determinate(r)) return `nothing to check — ${r.population.determinate_when_empty}`;
  if (r.verdict === 'pass') return 'no offender among what it judged';
  return r.verdict || '';
}

const popText = (p) => (p ? `${p.judged ?? '?'} of ${p.total ?? '?'} ${p.unit || ''}`.trim() : '—');
const show = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* ══ THE CATALOGUE ════════════════════════════════════════════════════════ */

export function ItsmCatalogue({ itsm, activeRule, onPickRule }) {
  const [outcome, setOutcome] = useState('');
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState('');
  const [all, setAll] = useState(false);

  const rules = itsm?.rules || [];
  const agg = itsm?.aggregation || {};
  const groups = useMemo(() => [...new Set(rules.map((r) => r.group))], [rules]);
  const counts = useMemo(() => {
    const c = {};
    for (const r of rules) { const k = outcomeOf(r).key; c[k] = (c[k] || 0) + 1; }
    return c;
  }, [rules]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => (!outcome || outcomeOf(r).key === outcome)
      && (!group || r.group === group)
      && (!q || r.rule_id.toLowerCase().includes(q) || String(r.title).toLowerCase().includes(q)));
  }, [rules, outcome, group, query]);

  if (!itsm) {
    return (
      <div className="card">
        <div className="card-title">ITSM catalogue</div>
        <p className="hs-lead">
          This ITSM result was stored before the 139-rule catalogue ran inside the scan. Check ITSM again to see every
          catalogue rule, what it judged, and why any could not run.
        </p>
      </div>
    );
  }

  const evaluated = agg.by_status?.evaluated ?? rules.filter((r) => r.evaluated).length;
  const established = (agg.by_verdict?.pass ?? 0) + (agg.by_verdict?.fail ?? 0);
  const limit = all ? shown.length : 40;

  return (
    <div className="card">
      <div className="card-title">ITSM catalogue · {rules.length} rules</div>
      <p className="hs-lead">
        Every rule in the ITSM workbook, as this scan ran it. A rule that could not run says why; a rule that ran but had
        nothing to judge is inconclusive, never a pass. These verdicts are reported, not scored — the ITSM score above is
        still the eleven original rules.
      </p>
      <div className="hs-facts">
        <div><b>{rules.length}</b><span>in the catalogue</span></div>
        <div><b>{agg.executable ?? '—'}</b><span>can run</span></div>
        <div><b>{agg.configured ?? '—'}</b><span>have every parameter</span></div>
        <div><b>{evaluated}</b><span>ran on this instance</span></div>
        <div><b>{established}</b><span>established pass or fail</span></div>
        <div><b>{agg.findings ?? 0}</b><span>findings</span></div>
      </div>
      {agg.reconciliation && !agg.reconciliation.complete && (
        <p className="error-text">The rule list does not reconcile with the catalogue — missing {agg.reconciliation.missing.join(', ') || 'none'}, duplicated {agg.reconciliation.duplicates.join(', ') || 'none'}.</p>
      )}

      <div className="chips hs-mt">
        <button type="button" className={`chip${outcome === '' ? ' is-on' : ''}`} onClick={() => setOutcome('')}>All · {rules.length}</button>
        {OUTCOMES.filter((o) => counts[o.key]).map((o) => (
          <button key={o.key} type="button" className={`chip tone-${o.tone}${outcome === o.key ? ' is-on' : ''}`}
            onClick={() => setOutcome(outcome === o.key ? '' : o.key)}>
            <span className="hs-glyph" aria-hidden="true">{o.glyph}</span> {o.label} · {counts[o.key]}
          </button>
        ))}
      </div>
      <div className="row hs-itsm-filters">
        <select className="select" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Catalogue group">
          <option value="">Every group</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input className="input" placeholder="Find a rule — ITSM-130 or words" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a rule" />
        <span className="hs-muted">{shown.length} shown</span>
      </div>

      <div className="table-wrap">
        <table className="table hs-itsm-table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>Outcome</th>
              <th>Rule</th>
              <th style={{ width: 150 }}>Judged</th>
              <th style={{ width: 80 }}>Findings</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r) => {
              const o = outcomeOf(r);
              const isOpen = open === r.rule_id;
              return [
                <tr key={r.rule_id} className={`click${activeRule === r.rule_id ? ' is-active' : ''}`} onClick={() => setOpen(isOpen ? '' : r.rule_id)} aria-expanded={isOpen}>
                  <td><span className={`hs-sev-tag sm tone-${o.tone}`}><span aria-hidden="true">{o.glyph}</span> {o.label}</span></td>
                  <td>
                    <code>{r.rule_id}</code> {r.title}
                    <div className="hs-itsm-group">{r.group} · {r.engine}</div>
                  </td>
                  <td className="mono">{r.evaluated ? popText(r.population) : '—'}</td>
                  <td>
                    {r.findings > 0 ? (
                      <button type="button" className="btn ghost sm" title="Show these findings"
                        onClick={(e) => { e.stopPropagation(); onPickRule?.(r.rule_id); }}>
                        {r.findings} →
                      </button>
                    ) : <span className="hs-muted">0</span>}
                  </td>
                  <td className="hs-itsm-why">{whyOf(r)}</td>
                </tr>,
                isOpen && (
                  <tr key={`${r.rule_id}-detail`} className="hs-itsm-detail">
                    <td colSpan={5}><RuleDetail r={r} history={itsm.measure_history} /></td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <button type="button" className="btn ghost sm hs-mt" onClick={() => setAll(true)}>Show all {shown.length}</button>
      )}
      {(agg.passes_determinate_when_empty || []).length > 0 && (
        <p className="hs-fine">
          Passing with nothing to check, because the workbook makes that state determinate:{' '}
          {agg.passes_determinate_when_empty.map((x) => x.rule_id).join(', ')}.
        </p>
      )}
    </div>
  );
}

function RuleDetail({ r, history }) {
  const params = Object.entries(r.parameters || {});
  const trendKeys = Object.keys(history?.used || {}).concat(Object.keys(history?.set_aside || {})).filter((k) => k.startsWith(`${r.rule_id}:`));
  return (
    <div className="hs-itsm-rule">
      <table className="table hs-articulation">
        <tbody>
          <tr><th>State</th><td>{r.status}{r.verdict ? ` · ${r.verdict}` : ''} · classification {r.classification}{r.ms != null ? ` · ${r.ms} ms` : ''}</td></tr>
          {r.population && (
            <tr><th>Judged</th><td>{popText(r.population)}{r.population.basis ? <div className="hs-muted">{r.population.basis}</div> : null}</td></tr>
          )}
          {r.undetermined && (
            <tr><th>Nothing established</th><td>{UNDETERMINED_LABEL[r.undetermined.kind] || r.undetermined.kind} — {r.undetermined.reason}. Health was {r.undetermined.health}; the verdict is {r.undetermined.verdict}.</td></tr>
          )}
          {r.blocker && (
            <tr>
              <th>Why it did not run</th>
              <td>
                {BLOCKER_LABEL[r.blocker.kind] || r.blocker.kind}
                {r.blocker.step ? ` · stopped at ${r.blocker.step}` : ''}
                {r.blocker.fields?.length ? ` · fields ${r.blocker.fields.join(', ')}` : ''}
                {r.blocker.parameters?.length ? ` · parameters ${r.blocker.parameters.join(', ')}` : ''}
                {r.blocker.table ? ` · table ${r.blocker.table}` : ''}
                {r.reason ? <div className="hs-muted">{r.reason}</div> : null}
                {r.blocker.workbook_text ? <div className="hs-muted">Workbook: “{r.blocker.workbook_text}”</div> : null}
              </td>
            </tr>
          )}
          {r.scope?.partial && (
            <tr><th>Partial detection</th><td>{r.scope.kind} — {r.scope.not_covered}</td></tr>
          )}
          {r.confidence != null && <tr><th>Confidence</th><td>{r.confidence}</td></tr>}
          {r.unresolved_parameters?.length > 0 && (
            <tr><th>Needs a value</th><td>{r.unresolved_parameters.join(', ')} — set it under Rule parameters below; the next ITSM check uses it.</td></tr>
          )}
          {r.dependencies?.length > 0 && (
            <tr>
              <th>Consumes</th>
              <td>{r.dependencies.map((d) => `${d.rule_id} (${d.status}${d.verdict ? ` · ${d.verdict}` : ''}${d.confidence != null ? ` · confidence ${d.confidence}` : ''})`).join(', ')}</td>
            </tr>
          )}
          {r.kpis?.length > 0 && (
            <tr>
              <th>Measured</th>
              <td>
                {r.kpis.map((k, i) => (
                  <div key={i} className="mono">
                    {k.variant ? `[${k.variant}] ` : ''}{k.numerator ?? '—'} / {k.denominator ?? '—'}{k.pass_pct != null ? ` · ${k.pass_pct}% not offending` : ''}{k.basis ? ` — ${k.basis}` : ''}
                  </div>
                ))}
              </td>
            </tr>
          )}
          {r.variants?.length > 0 && (
            <tr><th>Variants</th><td>{r.variants.map((v) => `${v.variant}: ${v.status}, ${v.findings} finding(s)`).join(' · ')}</td></tr>
          )}
          {trendKeys.length > 0 && (
            <tr>
              <th>Trend history</th>
              <td>
                {trendKeys.map((k) => (
                  <div key={k}>
                    <code>{k}</code> — {history.used?.[k] ?? 0} earlier comparable reading(s)
                    {history.set_aside?.[k] ? ` · ${history.set_aside[k].count} set aside (${Object.entries(history.set_aside[k]).filter(([n]) => n !== 'count' && history.set_aside[k][n]).map(([n, c]) => `${c} ${n.replace('_', ' ')}`).join(', ')})` : ''}
                  </div>
                ))}
              </td>
            </tr>
          )}
          {r.evidence_missing?.length > 0 && <tr><th>Evidence fields absent</th><td>{r.evidence_missing.join(', ')}</td></tr>}
        </tbody>
      </table>
      {params.length > 0 && (
        <>
          <div className="hs-sub">Parameters used</div>
          <table className="table">
            <thead><tr><th>Parameter</th><th>Value</th><th>Source</th><th>Status</th></tr></thead>
            <tbody>
              {params.map(([k, p]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="mono">{show(p.value)}{p.unit ? ` ${p.unit}` : ''}</td>
                  <td>{p.source || '—'}</td>
                  <td>{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/* ══ RULE PARAMETERS ══════════════════════════════════════════════════════ */

/** A typed value from what was typed — the server validates it against the declaration either way. */
function parseValue(type, raw) {
  const s = String(raw).trim();
  if (['number', 'percent', 'duration'].includes(type)) return s === '' ? '' : Number(s);
  if (type === 'list') return s.split(',').map((x) => x.trim()).filter(Boolean);
  if (type === 'boolean') return ['true', 'yes', '1'].includes(s.toLowerCase());
  return s;
}

export function ItsmParameters() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [which, setWhich] = useState('blocking');

  const load = async () => {
    try { setData(await api.get('/health/itsm/parameters')); } catch (e) { toast.error(e.message); }
  };
  useEffect(() => { if (open && !data) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  const rows = (data?.parameters || []).filter((p) => (which === 'blocking' ? p.blocks_rule : which === 'instance' ? p.source === 'instance' : true));
  const blocking = (data?.parameters || []).filter((p) => p.blocks_rule).length;
  const id = (p) => `${p.rule_id}.${p.key}`;

  const save = async (p) => {
    const k = id(p);
    setBusy(k); setErrors((e) => ({ ...e, [k]: '' }));
    try {
      await api.put(`/health/itsm/parameters/${encodeURIComponent(p.rule_id)}/${encodeURIComponent(p.key)}`, { value: parseValue(p.type, drafts[k] ?? '') });
      toast.success(`${p.rule_id} ${p.key} saved. The next ITSM check uses it — the ITSM result is re-read because its parameters changed.`);
      setDrafts((d) => ({ ...d, [k]: '' }));
      await load();
    } catch (e) { setErrors((x) => ({ ...x, [k]: e.message })); }
    finally { setBusy(''); }
  };
  const clear = async (p) => {
    const k = id(p);
    setBusy(k);
    try {
      await api.del(`/health/itsm/parameters/${encodeURIComponent(p.rule_id)}/${encodeURIComponent(p.key)}`);
      toast.success(`${p.rule_id} ${p.key} cleared — back to the workbook's value.`);
      await load();
    } catch (e) { setErrors((x) => ({ ...x, [k]: e.message })); }
    finally { setBusy(''); }
  };

  return (
    <div className="card">
      <div className="card-title hs-findings-head">
        <span>Rule parameters</span>
        <button type="button" className="btn ghost sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
      </div>
      <p className="hs-lead">
        Thresholds and windows the workbook leaves to each instance. A rule whose parameter has no value does not run —
        nothing is assumed in its place. Values are stored for this instance only; nothing is written to ServiceNow.
      </p>
      {open && !data && <p className="hs-muted">Loading…</p>}
      {open && data && (
        <>
          <div className="chips">
            {[['blocking', `Blocking a rule · ${blocking}`], ['instance', `Set for this instance · ${(data.overrides || []).length}`], ['all', `All · ${data.parameters.length}`]].map(([k, label]) => (
              <button key={k} type="button" className={`chip${which === k ? ' is-on' : ''}`} onClick={() => setWhich(k)}>{label}</button>
            ))}
          </div>
          {(data.rejected || []).length > 0 && (
            <p className="note warn">
              {data.rejected.length} stored value(s) no longer match their declaration and are not used: {data.rejected.map((r) => `${r.rule_id} ${r.key}`).join(', ')}.
            </p>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Rule</th><th>Parameter</th><th>Workbook</th><th>Value</th><th style={{ width: 260 }}>Set</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const k = id(p);
                  return (
                    <tr key={k}>
                      <td className="mono">{p.rule_id}</td>
                      <td>
                        <code>{p.key}</code>
                        <div className="hs-muted">{p.type}{p.unit ? ` · ${p.unit}` : ''}{p.blocks_rule ? ' · blocks the rule' : ''}</div>
                      </td>
                      <td className="hs-itsm-why">{p.workbook_text || '—'}{p.declaration === 'UNDEFINED' ? <div className="hs-muted">No default in the workbook.</div> : null}</td>
                      <td className="mono">{p.status === 'RESOLVED' ? `${show(p.value)}${p.unit ? ` ${p.unit}` : ''} (${p.source})` : <em>no value</em>}</td>
                      <td>
                        <div className="hs-state-edit">
                          <input className="input" placeholder={p.type === 'list' ? 'a, b, c' : p.type} value={drafts[k] ?? ''}
                            onChange={(e) => setDrafts((d) => ({ ...d, [k]: e.target.value }))} aria-label={`Value for ${p.rule_id} ${p.key}`} />
                          <button type="button" className="btn sm" disabled={busy === k || !String(drafts[k] ?? '').trim()} onClick={() => save(p)}>Save</button>
                          {p.source === 'instance' && (
                            <button type="button" className="btn ghost sm" disabled={busy === k} onClick={() => clear(p)}>Clear</button>
                          )}
                        </div>
                        {errors[k] && <div className="error-text">{errors[k]}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <p className="hs-muted">Nothing here.</p>}
        </>
      )}
    </div>
  );
}

/* ══ CROSS-DOMAIN LINKS ═══════════════════════════════════════════════════ */

export function CrossDomainLinks({ links, onOpenFinding }) {
  const list = links?.links || [];
  if (!list.length) return null;
  return (
    <div className="card">
      <div className="card-title">Cross-domain links</div>
      <p className="hs-lead">
        Links the rule catalogues state between domains, joined over one scan's results. They add evidence and an order to
        work in; they never change a verdict, a severity or a score.
      </p>
      {list.map((l) => (
        <div key={l.id} className="hs-itsm-link">
          <div className="hs-findings-head">
            <span>
              <b>{l.title}</b>{' '}
              <span className="hs-muted">· <code>{l.source.rule}</code> ({l.source.domain}) ⋈ <code>{l.target.rule}</code> ({l.target.domain}) on {l.join.entity}</span>
            </span>
            <span className={`hs-sev-tag sm tone-${l.status === 'evaluated' ? (l.undetermined ? 'warn' : 'ok') : 'info'}`}>
              {l.status === 'evaluated' ? (l.undetermined ? 'nothing to join' : 'joined') : 'cannot join'}
            </span>
          </div>
          {l.status !== 'evaluated' && <p className="hs-muted">{l.blocker?.reason}</p>}
          {l.status === 'evaluated' && l.undetermined && <p className="hs-muted">{l.undetermined.reason}</p>}
          {l.status === 'evaluated' && l.summary && (
            <>
              <div className="hs-facts hs-mt">
                <div><b>{l.summary.joined}</b><span>CIs both rules flag</span></div>
                <div><b>{l.summary.records_on_joined}</b><span>incidents on them</span></div>
                <div><b>{l.summary.source_only}</b><span>only {l.source.rule} flags</span></div>
                <div><b>{l.summary.target_only}</b><span>only {l.target.rule} flags</span></div>
                {l.confidence != null && <div><b>{l.confidence}</b><span>confidence</span></div>}
              </div>
              {l.rows.length > 0 && (
                <div className="table-wrap hs-mt">
                  <table className="table">
                    <thead><tr><th>CI</th><th>Incidents</th><th>Edges</th><th>{l.target.rule} finding</th></tr></thead>
                    <tbody>
                      {l.rows.map((row) => (
                        <tr key={row.entity}>
                          <td className="mono">{row.entity}</td>
                          <td className="mono" title={row.record_ids.join(', ')}>{row.records}</td>
                          <td className="mono">{row.degree ?? '—'}</td>
                          <td>
                            {row.target_finding ? (
                              <button type="button" className="btn ghost sm" onClick={() => onOpenFinding?.(row.target_finding)}>
                                {row.target_title || 'Open'} →
                              </button>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {l.rows_truncated > 0 && <p className="hs-fine">{l.rows_truncated} more joined CI(s) not listed.</p>}
            </>
          )}
          <details className="hs-peek">
            <summary>What the catalogues say</summary>
            <ul className="hs-itsm-spec">
              {l.specification.map((s, i) => <li key={i}><span className="hs-muted">{s.source}:</span> “{s.text}”</li>)}
            </ul>
          </details>
        </div>
      ))}
    </div>
  );
}

/* ══ ONE ITSM FINDING ═════════════════════════════════════════════════════ */

function threshold(t) {
  if (!t || typeof t !== 'object') return show(t);
  const op = { gt: '>', gte: '≥', lt: '<', lte: '≤' }[t.op] || t.op;
  return `${op} ${t.value}${t.escalate_at != null ? ` (escalates at ${t.escalate_at})` : ''}`;
}

export function ItsmFindingDetail({ f }) {
  if (!f?.itsm) return null;
  const d = f.detail || {};
  const params = Object.entries(f.itsm.parameters_used || {});
  return (
    <>
      <div className="hs-sub">ITSM catalogue trace</div>
      <table className="table hs-articulation">
        <tbody>
          <tr><th>Rule</th><td><code>{f.itsm.rule_id}</code> · slot {f.itsm.slot} · {f.itsm.group}</td></tr>
          <tr><th>Engine</th><td>{f.itsm.engine} · finding kind {f.kind}</td></tr>
          <tr><th>Rule verdict</th><td>{f.itsm.verdict ?? '—'} · classification {f.itsm.classification}</td></tr>
          {(f.itsm.occurrences ?? 1) > 1 && (
            <tr><th>Occurrences</th><td>{f.itsm.occurrences} detections share this finding{f.itsm.variants?.length ? ` (variants ${f.itsm.variants.join(', ')})` : ''}; their evidence is merged below.</td></tr>
          )}
          {f.itsm.scope?.partial && <tr><th>Partial detection</th><td>{f.itsm.scope.kind} — {f.itsm.scope.not_covered}</td></tr>}
        </tbody>
      </table>

      <div className="hs-sub">What the rule measured</div>
      <table className="table hs-articulation">
        <tbody>
          {f.kind === 'aggregate' && (
            <>
              <tr><th>Measure</th><td>{d.measure}{d.group && Object.keys(d.group).length ? ` · ${Object.entries(d.group).map(([k, v]) => `${k} = ${v}`).join(', ')}` : ''}</td></tr>
              <tr><th>Observed</th><td className="mono">{show(d.observed)}{d.measure === 'percentage' || d.percentage != null ? '%' : ''}{d.unit ? ` ${d.unit}` : ''}</td></tr>
              <tr><th>Threshold</th><td className="mono">{threshold(d.expected)}{d.escalated ? ' · escalated' : ''}</td></tr>
              <tr><th>Population</th><td className="mono">{show(d.population)}{d.count != null ? ` · ${d.count} counted` : ''}</td></tr>
              {d.window && <tr><th>Window</th><td className="mono">{show(d.window)}</td></tr>}
              {d.basis && <tr><th>Basis</th><td>{d.basis}</td></tr>}
            </>
          )}
          {f.kind === 'configuration' && (
            <>
              <tr><th>Object</th><td className="mono">{d.object}</td></tr>
              <tr><th>Observed</th><td className="mono">{show(d.observed)}</td></tr>
              <tr><th>Expected</th><td>{show(d.expected)}</td></tr>
              {d.absent && <tr><th>Absent</th><td>The object has no rows.</td></tr>}
            </>
          )}
          {f.kind === 'historical' && (
            <>
              <tr><th>Field</th><td className="mono">{d.field ?? '—'}</td></tr>
              <tr><th>Window</th><td className="mono">{d.window ? `${d.window.start ?? '…'} → ${d.window.end ?? 'now'}` : 'the record’s whole history'}</td></tr>
              <tr><th>Transitions read</th><td className="mono">{d.transitions}</td></tr>
            </>
          )}
          {f.kind === 'relationship' && (
            <>
              <tr><th>Question</th><td>{d.relationship}</td></tr>
              <tr><th>From</th><td className="mono">{d.source ? `${d.source.table} ${d.source.sys_id}` : '—'}</td></tr>
              <tr><th>To</th><td className="mono">{d.target ? `${d.target.table} ${d.target.sys_id}` : '—'}</td></tr>
              <tr><th>Path</th><td className="mono">{d.path?.length ? d.path.map((p) => p.sys_id).join(' → ') : 'none'}{d.depth != null ? ` · depth ${d.depth}` : ''}</td></tr>
            </>
          )}
          {f.kind === 'cross_domain' && (
            <>
              <tr><th>Related domain</th><td>{d.related_domain}</td></tr>
              <tr><th>Source</th><td className="mono">{d.source}</td></tr>
              <tr><th>Provenance</th><td className="mono">{show(d.provenance)}</td></tr>
            </>
          )}
          {f.kind === 'record' && (
            <>
              <tr><th>Records</th><td className="mono">{d.record_count}</td></tr>
              <tr><th>Fields shown</th><td className="mono">{(d.fields || []).join(', ') || '—'}</td></tr>
            </>
          )}
        </tbody>
      </table>
      {f.kind === 'aggregate' && Array.isArray(d.distribution) && d.distribution.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Group</th><th>Count</th><th>Share</th></tr></thead>
            <tbody>
              {d.distribution.slice(0, 12).map((row, i) => (
                <tr key={i}>
                  <td className="mono">{row.group ? Object.entries(row.group).map(([k, v]) => `${k}=${v}`).join(', ') : show(row.value ?? row)}</td>
                  <td className="mono">{row.count ?? '—'}</td>
                  <td className="mono">{row.share != null ? `${row.share}%` : row.share_within_primary != null ? `${row.share_within_primary}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {params.length > 0 && (
        <>
          <div className="hs-sub">Parameters it used</div>
          <table className="table">
            <thead><tr><th>Parameter</th><th>Value</th><th>Source</th></tr></thead>
            <tbody>
              {params.map(([k, p]) => (
                <tr key={k}><td className="mono">{k}</td><td className="mono">{show(p.value)}{p.unit ? ` ${p.unit}` : ''}</td><td>{p.source || '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
