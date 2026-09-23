import { useMemo, useState } from 'react';
import DimensionIcon from './DimensionIcon.jsx';
import SeverityDonut from './SeverityDonut.jsx';
import {
  UNCLASSIFIED_ID, TYPE_LABEL, SORTS, visualOf, searchDimensions, orderDimensions,
  shareOf, fmtPct, dimensionMatrix, matrixCsv,
} from './healthDimensions.js';

/*
 * THE FINDING-DIMENSION VIEWS — presentation only.
 *
 * Every number here arrives from /api/health/dimensions (one GROUP BY over the
 * findings in view); every click calls back into the page's ONE filter state,
 * the same one the findings list, the export and the bulk-fix selection read.
 * Nothing here fetches, decides what a dimension contains, or reaches the fix
 * path — a dimension only ever changes which findings are listed.
 */

const nf = (n) => Number(n || 0).toLocaleString();

/* ── A tinted icon tile ─────────────────────────────────────────────────── */
export function DimensionTile({ dimension, size = 'md' }) {
  const v = visualOf(dimension);
  return (
    <span className={`hx-tile hx-tile-${size} hx-t-${v.tint}`} aria-hidden="true">
      <DimensionIcon name={v.icon} size={size === 'lg' ? 26 : size === 'sm' ? 16 : 22} />
    </span>
  );
}

export function TypeBadge({ type, suffix = '' }) {
  return <span className={`hx-badge hx-badge-${type}`}>{TYPE_LABEL[type] || type}{suffix}</span>;
}

/* ── KPI row ────────────────────────────────────────────────────────────── */
export function DimensionKpis({ data, onPickUnclassified, unclassifiedActive }) {
  const dims = data?.dimensions || [];
  const system = dims.filter((d) => d.type === 'built_in').length;
  const custom = dims.filter((d) => d.type === 'custom').length;
  const unc = data?.unclassified?.findings ?? 0;
  const kpis = [
    { key: 'total', icon: 'database', tint: 'green', value: nf(data?.findings_total), label: 'Total findings', note: 'in the current view' },
    { key: 'system', icon: 'box', tint: 'blue', value: nf(system), label: 'System dimensions', note: 'built in' },
    { key: 'custom', icon: 'user', tint: 'violet', value: nf(custom), label: 'Custom dimensions', note: 'global' },
    { key: 'unc', icon: 'folder', tint: 'orange', value: nf(unc), label: 'Unclassified findings', note: `${nf(data?.unclassified?.catalogue_rules)} rules in no dimension` },
  ];
  return (
    <div className="hx-kpis">
      {kpis.map((k) => (
        <div key={k.key} className="hx-kpi">
          <span className={`hx-tile hx-tile-md hx-t-${k.tint}`} aria-hidden="true"><DimensionIcon name={k.icon} size={20} /></span>
          <div className="hx-kpi-text">
            <b>{k.value}</b>
            <span>{k.label}</span>
            <em>{k.note}</em>
          </div>
          {k.key === 'unc' && unc > 0 && (
            <button type="button" className={`hx-kpi-link${unclassifiedActive ? ' is-on' : ''}`} onClick={onPickUnclassified}>
              {unclassifiedActive ? 'Showing' : 'View'} <DimensionIcon name="arrowRight" size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── One dimension card ─────────────────────────────────────────────────── */
function DimensionCard({ d, total, active, onPick, layout }) {
  const v = visualOf(d);
  const pct = shareOf(d.findings, total);
  return (
    <button
      type="button"
      className={`hx-card hx-t-${v.tint}${active ? ' is-active' : ''}${d.id === UNCLASSIFIED_ID ? ' is-unc' : ''}${layout === 'list' ? ' is-row' : ''}`}
      onClick={() => onPick(d.id)}
      aria-pressed={active}
      title={d.description}
    >
      <DimensionTile dimension={d} size={layout === 'list' ? 'sm' : 'md'} />
      <span className="hx-card-body">
        <span className="hx-card-name">
          {d.name}
          {d.type === 'custom' && <TypeBadge type="custom" />}
        </span>
        <span className="hx-card-meta">
          <span><b>{nf(d.findings)}</b> finding{d.findings === 1 ? '' : 's'}</span>
          <em>{fmtPct(pct)}</em>
        </span>
        <span className="hx-bar" aria-hidden="true"><i style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%` }} /></span>
      </span>
      <span className="hx-card-arrow" aria-hidden="true"><DimensionIcon name="chevronRight" size={18} /></span>
    </button>
  );
}

/* ── The grid, with its own sort, layout and the unclassified row ───────── */
export function DimensionGrid({ data, search, selected, onPick }) {
  const [sort, setSort] = useState('findings-desc');
  const [layout, setLayout] = useState('grid');
  const dims = data?.dimensions || [];
  const total = data?.findings_total || 0;
  const visible = searchDimensions(dims, search);
  const { themed, unclassified } = orderDimensions(visible, sort);
  const system = dims.filter((d) => d.type === 'built_in').length;
  const custom = dims.filter((d) => d.type === 'custom').length;

  return (
    <section className="hx-section">
      <div className="hx-section-head">
        <div>
          <h2 className="hx-h2">All dimensions</h2>
          <p className="hx-sub">
            {system} system dimension{system === 1 ? '' : 's'}, {custom} custom · Findings may appear in more than one dimension.
          </p>
        </div>
        <div className="hx-head-tools">
          <label className="hx-sort">
            <span>Sort by</span>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <span className="hx-seg" role="group" aria-label="Layout">
            <button type="button" className={layout === 'grid' ? 'is-on' : ''} aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}>
              <DimensionIcon name="grid" size={15} /> Grid
            </button>
            <button type="button" className={layout === 'list' ? 'is-on' : ''} aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>
              <DimensionIcon name="list" size={15} /> List
            </button>
          </span>
        </div>
      </div>

      {themed.length === 0 && !unclassified ? (
        <div className="hx-empty">
          <DimensionIcon name="search" size={22} />
          <p>{search ? `No dimension matches “${search}”.` : 'No dimensions to show.'}</p>
        </div>
      ) : (
        <div className={layout === 'list' ? 'hx-list' : 'hx-grid'}>
          {themed.map((d) => (
            <DimensionCard key={d.id} d={d} total={total} active={selected === d.id} onPick={onPick} layout={layout} />
          ))}
        </div>
      )}

      {(unclassified || data?.multi_label) && (
        <div className="hx-grid-foot">
          {unclassified && (
            <DimensionCard d={unclassified} total={total} active={selected === UNCLASSIFIED_ID} onPick={onPick} layout="grid" />
          )}
          <div className="hx-info" role="note">
            <span className="hx-info-ic"><DimensionIcon name="info" size={18} /></span>
            <p>
              {data?.multi_label
                ? <>Some findings appear in more than one dimension, so dimension totals add up to more than the <b>{nf(total)}</b> findings in view. Each is still one finding with one status and one fix.</>
                : <>A finding can appear in more than one dimension. Each is still one finding with one status and one fix.</>}
              {data?.unclassified?.observed_rules?.length > 0 && (
                <> {data.unclassified.observed_rules.length} rule{data.unclassified.observed_rules.length === 1 ? ' is' : 's are'} in no dimension yet, so {data.unclassified.observed_rules.length === 1 ? 'its' : 'their'} findings show under Unclassified.</>
              )}
            </p>
            <details className="hx-learn">
              <summary>Learn more</summary>
              <p>
                A dimension groups health <b>rules</b> by the kind of problem they find. Every finding a rule produces
                appears under that rule's dimensions, so a rule in two dimensions puts its findings in both. Dimensions
                never change a finding, its severity, its score, its status or how it is fixed — they only change which
                findings a list shows. Rules no dimension claims, including rules added after the taxonomy was
                reviewed, appear under Unclassified.
              </p>
            </details>
          </div>
        </div>
      )}
    </section>
  );
}

/* ── Segmented severity bar ─────────────────────────────────────────────── */
function SegBar({ severity = {}, bands, scale = 1 }) {
  const total = bands.reduce((s, b) => s + (severity[b.key] || 0), 0);
  return (
    <span className="hx-seg-bar" style={{ width: `${Math.max(scale * 100, total ? 3 : 0)}%` }} aria-hidden="true">
      {bands.map((b) => (severity[b.key] ? (
        <i key={b.key} className={`tone-${b.tone}`} style={{ flexGrow: severity[b.key] }} />
      ) : null))}
    </span>
  );
}

/* ── Analytics: distribution + top dimensions ───────────────────────────── */
export function DimensionAnalytics({ data, bands, activeSeverity, onPickSeverity, onPickDimension, selected }) {
  const [all, setAll] = useState(false);
  const rows = bands.map((b) => ({ ...b, count: data?.severity_totals?.[b.key] || 0 }));
  const ranked = orderDimensions((data?.dimensions || []).filter((d) => d.findings > 0)).themed;
  const shown = all ? ranked : ranked.slice(0, 5);
  const max = Math.max(1, ...ranked.map((d) => d.findings));
  return (
    <div className="hx-two">
      <section className="hx-panel">
        <div className="hx-panel-head">
          <h3 className="hx-h3">Findings distribution</h3>
          <span className="hx-sub">By severity, each finding counted once</span>
        </div>
        {(data?.findings_total || 0) === 0
          ? <p className="hx-muted">No findings in view.</p>
          : <SeverityDonut rows={rows} total={data.findings_total} active={activeSeverity || null} onPick={onPickSeverity} centerLabel="findings" />}
      </section>
      <section className="hx-panel">
        <div className="hx-panel-head">
          <h3 className="hx-h3">Top dimensions by severity</h3>
          {ranked.length > 5 && (
            <button type="button" className="hx-link" onClick={() => setAll((x) => !x)}>
              {all ? 'Show top 5' : `View all ${ranked.length}`} <DimensionIcon name="arrowRight" size={14} />
            </button>
          )}
        </div>
        {shown.length === 0 ? <p className="hx-muted">No dimension has findings in view.</p> : (
          <ul className="hx-topdims">
            {shown.map((d) => (
              <li key={d.id}>
                <button type="button" className={`hx-topdim${selected === d.id ? ' is-on' : ''}`} onClick={() => onPickDimension(d.id)}
                  title={bands.map((b) => `${b.label} ${nf(d.severity?.[b.key])}`).join(' · ')}>
                  <span className="hx-topdim-name">{d.name}</span>
                  <span className="hx-topdim-track"><SegBar severity={d.severity} bands={bands} scale={d.findings / max} /></span>
                  <b>{nf(d.findings)}</b>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="hx-legend-inline">
          {bands.map((b) => <span key={b.key} className={`tone-${b.tone}`}><i />{b.label}</span>)}
        </div>
      </section>
    </div>
  );
}

/* ── The selected dimension ─────────────────────────────────────────────── */
export function DimensionDetail({
  dimension, bands, activeSeverity, activeRule, activeDomain, domainLabel = {},
  onPickSeverity, onPickRule, onPickDomain, onManage,
}) {
  const [allRules, setAllRules] = useState(false);
  if (!dimension) {
    return (
      <section className="hx-panel hx-detail-empty">
        <DimensionIcon name="target" size={24} />
        <div>
          <b>Select a dimension to explore it</b>
          <p className="hx-muted">Its severity breakdown, the rules its findings come from and the modules they sit in appear here, and the findings below narrow to it.</p>
        </div>
      </section>
    );
  }
  const rows = bands.map((b) => ({ ...b, count: dimension.severity?.[b.key] || 0 }));
  const rules = dimension.rule_counts || [];
  const shownRules = allRules ? rules : rules.slice(0, 5);
  const ruleMax = Math.max(1, ...rules.map((r) => r.n));
  const domains = dimension.domains || [];
  const typeWord = dimension.type === 'built_in' ? 'System dimension' : dimension.type === 'custom' ? 'Custom dimension' : 'Fallback';

  return (
    <section className="hx-detail" aria-label={`${dimension.name} details`}>
      <div className="hx-detail-head">
        <DimensionTile dimension={dimension} size="lg" />
        <div className="hx-detail-title">
          <h2 className="hx-h2">
            {dimension.name}
            <span className={`hx-badge hx-badge-${dimension.type}`}>{typeWord}</span>
          </h2>
          <p className="hx-sub">{dimension.description}</p>
          {dimension.editable && (
            <button type="button" className="hx-link" onClick={() => onManage?.(dimension.id)}>
              Edit this dimension <DimensionIcon name="arrowRight" size={14} />
            </button>
          )}
        </div>
        <div className="hx-metrics">
          <div className="hx-metric hx-metric-total"><b>{nf(dimension.findings)}</b><span>Total findings</span></div>
          {rows.map((r) => (
            <button key={r.key} type="button" className={`hx-metric tone-${r.tone}${activeSeverity === r.key ? ' is-on' : ''}`}
              onClick={() => onPickSeverity(r.key)} aria-pressed={activeSeverity === r.key}>
              <b>{nf(r.count)}</b><span><i />{r.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="hx-three">
        <section className="hx-panel">
          <div className="hx-panel-head"><h3 className="hx-h3">Findings by severity</h3></div>
          {dimension.findings === 0
            ? <p className="hx-muted">No findings in view for this dimension.</p>
            : <SeverityDonut rows={rows} total={dimension.findings} active={activeSeverity || null} onPick={onPickSeverity} centerLabel="findings" showAll={false} />}
        </section>

        <section className="hx-panel">
          <div className="hx-panel-head">
            <h3 className="hx-h3">Top rules in this dimension</h3>
            {rules.length > 5 && (
              <button type="button" className="hx-link" onClick={() => setAllRules((x) => !x)}>
                {allRules ? 'Show top 5' : `View all ${rules.length}`} <DimensionIcon name="arrowRight" size={14} />
              </button>
            )}
          </div>
          {rules.length === 0 ? <p className="hx-muted">No rule in this dimension produced a finding in view.</p> : (
            <ul className="hx-rules">
              {shownRules.map((r) => (
                <li key={r.rule_id}>
                  <button type="button" className={`hx-rule${activeRule === r.rule_id ? ' is-on' : ''}`} onClick={() => onPickRule(r.rule_id)}
                    aria-pressed={activeRule === r.rule_id} title={`Show only ${r.rule_id}`}>
                    <code>{r.rule_id}</code>
                    <span className="hx-rule-track"><i style={{ width: `${(r.n / ruleMax) * 100}%` }} /></span>
                    <b>{nf(r.n)}</b>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="hx-panel">
          <div className="hx-panel-head"><h3 className="hx-h3">Related modules</h3></div>
          {domains.length === 0 ? <p className="hx-muted">No module holds findings for this dimension in view.</p> : (
            <div className="hx-mods">
              {domains.map((m) => (
                <button key={m.domain} type="button" className={`hx-mod${activeDomain === m.domain ? ' is-on' : ''}`}
                  onClick={() => onPickDomain(m.domain)} aria-pressed={activeDomain === m.domain}
                  title={`Show only ${domainLabel[m.domain] || m.domain}`}>
                  <span className="hx-mod-name">{domainLabel[m.domain] || m.domain}</span>
                  <b>{nf(m.n)}</b>
                </button>
              ))}
            </div>
          )}
          <p className="hx-fine">The areas this dimension's findings come from. Pick one to narrow the list.</p>
        </section>
      </div>
    </section>
  );
}

/* ── BOTH: the dimension × severity matrix ──────────────────────────────── */
export function DimensionMatrix({ data, bands, search, activeDimension, activeSeverity, onPickCell, onPickDimension }) {
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' });
  const visible = useMemo(() => searchDimensions(data?.dimensions || [], search), [data, search]);
  const { rows } = dimensionMatrix(visible, bands.map((b) => b.key), { sortKey: sort.key, dir: sort.dir });
  const sortBy = (key) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '');
  const ariaSort = (key) => (sort.key === key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');

  const exportCsv = () => {
    const blob = new Blob([matrixCsv(rows, bands)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `findings-by-dimension-and-severity-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="hx-panel hx-matrix-panel">
      <div className="hx-panel-head">
        <div>
          <h3 className="hx-h3">Dimension × severity</h3>
          <span className="hx-sub">Sort by any column. A cell filters the findings below to that dimension at that severity.</span>
        </div>
        <button type="button" className="btn ghost sm hx-btn-ic" onClick={exportCsv} disabled={!rows.length}>
          <DimensionIcon name="download" size={15} /> Export
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="hx-muted">{search ? `No dimension matches “${search}”.` : 'No findings in view, so no dimension has anything to show.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="hx-matrix">
            <thead>
              <tr>
                <th scope="col" className="hx-mx-name">Dimension</th>
                {bands.map((b) => (
                  <th key={b.key} scope="col" aria-sort={ariaSort(b.key)}>
                    <button type="button" className={`hx-mx-sort tone-${b.tone}`} onClick={() => sortBy(b.key)}>
                      <i aria-hidden="true" />{b.label}{arrow(b.key)}
                    </button>
                  </th>
                ))}
                <th scope="col" aria-sort={ariaSort('total')}>
                  <button type="button" className="hx-mx-sort" onClick={() => sortBy('total')}>Total{arrow('total')}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={activeDimension === r.id ? 'is-row-on' : ''}>
                  <th scope="row" className="hx-mx-name">
                    <button type="button" className="hx-mx-dim" onClick={() => onPickDimension(r.id)} title={`Show ${r.name}`}>
                      <DimensionTile dimension={r} size="sm" />
                      <span>{r.name}</span>
                      {r.type === 'custom' && <TypeBadge type="custom" />}
                    </button>
                  </th>
                  {r.cells.map((c) => {
                    const band = bands.find((b) => b.key === c.severity);
                    const on = activeDimension === r.id && activeSeverity === c.severity;
                    return (
                      <td key={c.severity}>
                        <button type="button"
                          className={`hx-cell tone-${band.tone}${c.n === 0 ? ' is-zero' : ''}${on ? ' is-on' : ''}`}
                          aria-pressed={on}
                          aria-label={`${r.name}, ${band.label}: ${nf(c.n)} finding${c.n === 1 ? '' : 's'}`}
                          onClick={() => onPickCell(r.id, c.severity, on)}>
                          {nf(c.n)}
                        </button>
                      </td>
                    );
                  })}
                  <td className="hx-mx-total">{nf(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.multi_label && (
        <p className="hx-fine">Findings may appear in more than one dimension, so the Total column adds up to more than the {nf(data.findings_total)} findings in view.</p>
      )}
    </section>
  );
}
