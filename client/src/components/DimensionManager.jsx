import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { toast } from './toast.js';
import { confirmDestructive } from './confirm.js';
import DimensionIcon from './DimensionIcon.jsx';
import { DimensionTile, TypeBadge } from './DimensionViews.jsx';
import { searchDimensions, UNCLASSIFIED_ID } from './healthDimensions.js';

/*
 * MANAGE DIMENSIONS — the taxonomy as a table.
 *
 * Counts are over the findings of the current scope, from the same
 * /api/health/dimensions every other view reads. What a row may do follows the
 * server's rule, not the page's: System dimensions and the Unclassified
 * fallback can be viewed and used as a filter; only a Custom dimension can be
 * edited or deleted, and deleting one removes the grouping and nothing else.
 */

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'system', label: 'System' },
  { key: 'custom', label: 'Custom' },
];
const inTab = (d, tab) => tab === 'all' || (tab === 'custom' ? d.type === 'custom' : d.type !== 'custom');

/*
 * The row menu is FIXED-positioned from its button: the table scrolls
 * horizontally inside its card, and an absolutely placed popover would be
 * clipped by that box on the last rows. It opens upward when there is no room
 * below, and closes on scroll rather than drifting away from its row.
 */
const MENU_H = 190;
function ActionMenu({ d, onView, onFindings, onEdit, onRules, onDelete }) {
  const [pos, setPos] = useState(null);
  const open = Boolean(pos);
  const setOpen = (v) => {
    if (!v) { setPos(null); return; }
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const up = window.innerHeight - r.bottom < MENU_H + 12;
    setPos({ right: Math.max(8, window.innerWidth - r.right), ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  };
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setPos(null); };
    const esc = (e) => { if (e.key === 'Escape') setPos(null); };
    const gone = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', gone);
    };
  }, [open]);
  const item = (icon, label, fn, danger = false) => (
    <button type="button" role="menuitem" className={`hx-menu-item${danger ? ' is-danger' : ''}`} onClick={() => { setPos(null); fn(); }}>
      <DimensionIcon name={icon} size={15} /> {label}
    </button>
  );
  return (
    <span className="hx-menu" ref={ref}>
      <button type="button" className="hx-menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${d.name}`}
        onClick={() => setOpen(!open)}>
        <DimensionIcon name="dots" size={18} strokeWidth={2.6} />
      </button>
      {open && (
        <span className="hx-menu-pop" role="menu" style={pos}>
          {d.editable ? item('pencil', 'Edit', onEdit) : item('eye', 'View rules', onView)}
          {d.editable && item('listChecks', 'Manage rules', onRules)}
          {item('arrowRight', 'View findings', onFindings)}
          {d.editable && <span className="hx-menu-sep" />}
          {d.editable && item('trash', 'Delete', onDelete, true)}
        </span>
      )}
    </span>
  );
}

/* `showHead` false when the page header already carries the title (the
   Health page's breadcrumbed header does); Create then sits in the toolbar. */
export default function DimensionManager({ scope = 'all', reloadKey = 0, showHead = true, onCreate, onOpen, onViewFindings, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [has, setHas] = useState('any');

  const load = useCallback(async () => {
    setErr('');
    try {
      const qs = scope && scope !== 'all' ? `?scope=${encodeURIComponent(scope)}` : '';
      setData(await api.get(`/health/dimensions${qs}`));
    } catch (e) { setErr(`Unable to load dimensions. ${e.message}`); }
  }, [scope]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const all = data?.dimensions || [];
  const counts = Object.fromEntries(TABS.map((t) => [t.key, all.filter((d) => inTab(d, t.key)).length]));
  const rows = searchDimensions(all, search)
    .filter((d) => inTab(d, tab))
    .filter((d) => (has === 'with' ? d.findings > 0 : has === 'without' ? !d.findings : true))
    .sort((a, b) => {
      const rank = (d) => (d.type === 'built_in' ? 0 : d.type === 'custom' ? 1 : 2);
      return rank(a) - rank(b) || (b.findings || 0) - (a.findings || 0) || a.name.localeCompare(b.name);
    });

  const remove = async (d) => {
    const ok = await confirmDestructive({
      action: 'Delete dimension',
      subject: d.name,
      detail: 'Only the grouping is removed. Every finding stays exactly as it is — its status, its fix and its score are untouched. Rules that were only in this dimension show under Unclassified.',
      confirmLabel: 'Delete dimension',
    });
    if (!ok) return;
    try {
      await api.del(`/health/dimensions/${encodeURIComponent(d.id)}`);
      toast.success(`Deleted “${d.name}”. No finding was changed.`);
      await load();
      onChanged?.({ id: d.id, deleted: true });
    } catch (e) { toast.error(`The dimension could not be deleted. ${e.message}`); }
  };

  return (
    <section className="hx-manage">
      {showHead && <div className="hx-page-head">
        <div>
          <h2 className="hx-h1">Manage dimensions</h2>
          <p className="hx-sub">
            View, edit and organise system and custom dimensions. Dimensions group related findings across your
            ServiceNow instance by the kind of problem they describe.
          </p>
        </div>
        <button type="button" className="btn primary hx-btn-ic hx-btn-lg" onClick={onCreate}>
          <DimensionIcon name="plus" size={16} strokeWidth={2.4} /> Create dimension
        </button>
      </div>}

      <div className="hx-toolbar">
        <span className="hx-tabs" role="tablist" aria-label="Dimension type">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'is-on' : ''} onClick={() => setTab(t.key)}>
              {t.label} ({counts[t.key] ?? 0})
            </button>
          ))}
        </span>
        <span className="hx-toolbar-right">
          <label className="hx-search">
            <DimensionIcon name="search" size={15} />
            <input type="search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dimensions…" aria-label="Search dimensions" />
          </label>
          <label className="hx-filter">
            <DimensionIcon name="sliders" size={15} />
            <select className="select" value={has} onChange={(e) => setHas(e.target.value)} aria-label="Filter by findings">
              <option value="any">Filter: any findings</option>
              <option value="with">With findings</option>
              <option value="without">Without findings</option>
            </select>
          </label>
          {!showHead && (
            <button type="button" className="btn primary hx-btn-ic" onClick={onCreate}>
              <DimensionIcon name="plus" size={16} strokeWidth={2.4} /> Create dimension
            </button>
          )}
        </span>
      </div>

      {err && <p className="error-text">{err}</p>}

      <div className="hx-table-card">
        <div className="table-wrap">
          <table className="hx-table">
            <thead>
              <tr>
                <th style={{ width: 52 }}>#</th>
                <th>Dimension</th>
                <th style={{ width: 120 }}>Type</th>
                <th style={{ width: 90 }} className="hx-num">Rules</th>
                <th style={{ width: 110 }} className="hx-num">Findings</th>
                <th>Description</th>
                <th style={{ width: 80 }} className="hx-num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!data && !err && (
                <tr><td colSpan={7} className="hx-muted">Loading dimensions…</td></tr>
              )}
              {data && rows.length === 0 && (
                <tr><td colSpan={7}>
                  <div className="hx-empty">
                    <DimensionIcon name={tab === 'custom' ? 'user' : 'search'} size={22} />
                    <p>{tab === 'custom' && !search ? 'No custom dimensions yet. Create one to group rules your own way.' : 'No dimension matches.'}</p>
                    {tab === 'custom' && !search && <button type="button" className="btn primary sm" onClick={onCreate}>Create dimension</button>}
                  </div>
                </td></tr>
              )}
              {rows.map((d, i) => (
                <tr key={d.id} className={d.id === UNCLASSIFIED_ID ? 'is-unc' : ''}>
                  <td className="hx-muted">{i + 1}</td>
                  <td>
                    <button type="button" className="hx-dimcell" onClick={() => onOpen(d, d.editable ? 1 : null)}>
                      <DimensionTile dimension={d} size="sm" />
                      <span>{d.name}</span>
                    </button>
                  </td>
                  <td><TypeBadge type={d.type} /></td>
                  <td className="hx-num">{d.rule_count}</td>
                  <td className="hx-num">
                    <button type="button" className="hx-link hx-link-num" onClick={() => onViewFindings(d.id)} title={`View the ${d.name} findings`}>
                      {(d.findings || 0).toLocaleString()}
                    </button>
                  </td>
                  <td className="hx-desc" title={d.description}>{d.description}</td>
                  <td className="hx-num">
                    <ActionMenu
                      d={d}
                      onView={() => onOpen(d, null)}
                      onEdit={() => onOpen(d, 1)}
                      onRules={() => onOpen(d, 2)}
                      onFindings={() => onViewFindings(d.id)}
                      onDelete={() => remove(d)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data?.multi_label && (
        <p className="hx-fine">Finding counts are over the current scan. A finding can belong to more than one dimension, so these add up to more than the {(data.findings_total || 0).toLocaleString()} findings in view.</p>
      )}
    </section>
  );
}
