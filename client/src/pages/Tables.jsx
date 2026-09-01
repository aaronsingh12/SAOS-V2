import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { SkeletonRows, SkeletonLines, EmptyState } from '../components/states.jsx';
import ScopeBadge from '../components/ScopeBadge.jsx';
import { useBinding } from '../hooks/useBinding.js';
import { classificationBadge, describeIndexes, filterTables } from '../components/tableClassification.js';

/**
 * Tables — Database Administration, READ ONLY (Phase T1).
 *
 * Every number on this page comes from the same Layer-1 functions the agent's
 * DBA tools call, through /api/dba. There is no second data path, so the pane
 * and the chat cannot answer the same question differently.
 *
 * ── WHAT THIS PAGE REFUSES TO DO ─────────────────────────────────────────────
 *
 * It does not mutate. No create, no add column, no modify, no drop — not
 * disabled buttons, not hidden ones: they do not exist. Schema changes are
 * gated operations that run through the tools with an approval flow and, for
 * a drop, an operator escalation; a browser pane that could reach them by
 * accident would be a way around the gate rather than through it. That is
 * Phase T2.
 *
 * ── AND THE ONE IT REFUSES TO FAKE ───────────────────────────────────────────
 *
 * "Nothing found" and "could not read" are different facts and are drawn
 * differently everywhere here. The index panel is the sharpest case: sys_index
 * is 403 over REST on this instance, so unavailable is a routine outcome — and
 * every table has at least a primary key, which makes a rendered zero a lie
 * rather than a small number.
 */

const TABS = [
  ['fields', 'Fields'],
  ['references', 'References'],
  ['hierarchy', 'Hierarchy'],
  ['indexes', 'Indexes'],
  ['map', 'Schema map'],
  ['about', 'Classification'],
];

const KINDS = [['all', 'All'], ['custom', 'Custom'], ['ootb', 'OOTB']];

function Badge({ label, tone, title, dim = false }) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ''}`} title={title} style={dim ? { opacity: 0.75 } : undefined}>
      {label}
    </span>
  );
}

/** A labelled block that can say "unavailable" without pretending to be empty. */
function Panel({ title, children, note = null }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="card-title" style={{ marginBottom: 6 }}>{title}</div>
      {children}
      {note && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{note}</p>}
    </div>
  );
}

export default function Tables() {
  const { instance, scope: boundScope } = useBinding();
  // T1.4 — the binding is the single source of truth, so it is the cache key
  // for everything on this page. A new instance or scope must not be described
  // by the previous one's data, so the effects below re-run on it.
  const bindingKey = `${instance?.host ?? ''}::${boundScope?.scope ?? ''}`;

  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [scopes, setScopes] = useState([]);

  const [q, setQ] = useState('');
  const [scope, setScope] = useState('');
  const [kind, setKind] = useState('all');

  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('fields');
  const [detail, setDetail] = useState({});
  const [detailErr, setDetailErr] = useState({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [inherited, setInherited] = useState(true);

  /* ── the list ─────────────────────────────────────────────────────────── */

  const loadList = useCallback(async () => {
    setLoadingList(true); setListErr('');
    try {
      const r = await api.get('/dba/tables?max=2000');
      setList(r);
    } catch (e) {
      // An unreadable list is not an empty one.
      setList(null); setListErr(e.message);
    } finally { setLoadingList(false); }
  }, []);

  useEffect(() => {
    loadList();
    api.get('/dba/scopes').then((r) => setScopes(r.scopes || [])).catch(() => setScopes([]));
    // Selecting a table from a previous binding would show another instance's
    // schema under this one's header.
    setSelected(null); setDetail({}); setDetailErr({});
  }, [bindingKey, loadList]);

  const shown = useMemo(() => filterTables(list?.tables, { q, scope, kind }), [list, q, scope, kind]);

  /* ── the detail ───────────────────────────────────────────────────────── */

  const load = useCallback(async (name, which, path) => {
    try {
      const r = await api.get(path);
      setDetail((d) => ({ ...d, [`${name}:${which}`]: r }));
      setDetailErr((d) => ({ ...d, [`${name}:${which}`]: null }));
    } catch (e) {
      setDetail((d) => ({ ...d, [`${name}:${which}`]: null }));
      setDetailErr((d) => ({ ...d, [`${name}:${which}`]: e.message }));
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoadingDetail(true);
    const n = encodeURIComponent(selected);
    Promise.all([
      load(selected, 'table', `/dba/table/${n}`),
      load(selected, 'classify', `/dba/table/${n}/classify`),
    ]).finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selected, bindingKey, load]);

  // Each tab fetches its own read the first time it is opened — the schema map
  // and the index probe are expensive, and loading them for a table nobody
  // opened would spend the instance's time on nothing.
  useEffect(() => {
    if (!selected) return;
    const n = encodeURIComponent(selected);
    const key = `${selected}:${tab}`;
    const paths = {
      fields: `/dba/table/${n}/fields?inherited=${inherited ? '1' : '0'}`,
      references: `/dba/table/${n}/references`,
      hierarchy: `/dba/table/${n}/hierarchy`,
      indexes: `/dba/table/${n}/indexes`,
      map: `/dba/table/${n}/map`,
    };
    if (!paths[tab]) return;
    if (tab === 'fields') { load(selected, 'fields', paths.fields); return; }
    if (detail[key] === undefined && detailErr[key] === undefined) load(selected, tab, paths[tab]);
  }, [selected, tab, inherited, bindingKey, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = (which) => detail[`${selected}:${which}`];
  const e = (which) => detailErr[`${selected}:${which}`];

  /* ── render ───────────────────────────────────────────────────────────── */

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">Tables · read only</div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
          The schema of <span className="mono">{instance?.host || 'the bound instance'}</span>, read live through the
          same Layer-1 tools the agent uses. Nothing on this page changes anything — schema changes are gated
          operations and run through the agent.
        </p>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Filter by name or label…"
            value={q}
            onChange={(ev) => setQ(ev.target.value)}
          />
          <select className="select" style={{ maxWidth: 220 }} value={scope} onChange={(ev) => setScope(ev.target.value)}>
            <option value="">All scopes</option>
            {scopes.map((s) => <option key={s.sys_id} value={s.sys_id}>{s.scope}{s.name && s.name !== s.scope ? ` — ${s.name}` : ''}</option>)}
          </select>
          {KINDS.map(([k, label]) => (
            <button key={k} className={`btn sm${kind === k ? ' primary' : ''}`} onClick={() => setKind(k)}>{label}</button>
          ))}
          <button className="btn sm" onClick={loadList} disabled={loadingList} style={{ marginLeft: 'auto' }}>
            {loadingList ? 'Reading…' : 'Refresh'}
          </button>
        </div>

        {list && (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>
            {shown.length} of {list.count} table(s)
            {list.complete === false && (
              <span className="badge amber" style={{ marginLeft: 6 }} title={list.incompleteReason || 'The read hit its ceiling.'}>
                partial read — {list.expectedTotal ?? '?'} exist
              </span>
            )}
          </p>
        )}
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        {/* ── list ── */}
        <div className="card" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          {loadingList && !list && <SkeletonRows rows={8} cols={2} />}
          {listErr && (
            <EmptyState
              icon="!"
              title="The table list could not be read."
              hint={`${listErr} — this is a failed read, not an empty instance.`}
              onAction={loadList}
              actionLabel="Try again"
            />
          )}
          {!loadingList && !listErr && shown.length === 0 && (
            <EmptyState
              icon="·"
              title="No tables match these filters."
              hint="The instance was read successfully; nothing matched what you asked for."
            />
          )}
          {shown.map((t) => {
            const b = classificationBadge(t.classification);
            return (
              <button
                key={t.name}
                className={`row-item${selected === t.name ? ' active' : ''}`}
                onClick={() => { setSelected(t.name); setTab('fields'); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  background: selected === t.name ? 'var(--line)' : 'transparent',
                  border: 0, borderBottom: '1px solid var(--line)', padding: '8px 6px',
                  textAlign: 'left', cursor: 'pointer', color: 'inherit',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 12.5 }}>{t.name}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>
                    {t.label}{t.extends ? ` · extends ${t.extends}` : ' · standalone'}
                  </span>
                </span>
                <Badge label={b.label} tone={b.tone} title={b.title} dim={!b.checked} />
              </button>
            );
          })}
        </div>

        {/* ── detail ── */}
        <div className="card">
          {!selected && (
            <EmptyState icon="·" title="Select a table" hint="Its fields, references, hierarchy, indexes and schema map are read live from the instance." />
          )}

          {selected && (
            <>
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontSize: 14 }}>{selected}</span>
                {d('table')?.scope && <ScopeBadge scope={d('table').scope} />}
                {d('classify') && (() => {
                  const b = classificationBadge(d('classify'));
                  return <Badge label={b.label} tone={b.tone} title={b.title} />;
                })()}
              </div>

              <div className="row" style={{ gap: 4, margin: '10px 0', flexWrap: 'wrap' }}>
                {TABS.map(([k, label]) => (
                  <button key={k} className={`btn sm${tab === k ? ' primary' : ''}`} onClick={() => setTab(k)}>{label}</button>
                ))}
              </div>

              {loadingDetail && !d('table') && <SkeletonLines lines={4} />}
              {e('table') && <p className="error-text">{e('table')}</p>}

              {tab === 'fields' && (
                <Panel title="Fields">
                  <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <input type="checkbox" checked={inherited} onChange={(ev) => setInherited(ev.target.checked)} />
                    include inherited fields
                  </label>
                  {e('fields') && <p className="error-text">{e('fields')}</p>}
                  {!d('fields') && !e('fields') && <SkeletonLines lines={5} />}
                  {d('fields') && (
                    <>
                      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>
                        {d('fields').fieldCount ?? d('fields').fields?.length ?? 0} field(s) over {(d('fields').extendsChain || [selected]).join(' → ')}
                        {d('fields').truncated && <span className="badge amber" style={{ marginLeft: 6 }}>partial read</span>}
                      </p>
                      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                        {(d('fields').fields || []).map((f) => (
                          <div key={f.element} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                            <span className="mono" style={{ flex: 1, minWidth: 0 }}>{f.element}</span>
                            <span style={{ color: 'var(--muted)' }}>{f.type}{f.maxLength ? `(${f.maxLength})` : ''}</span>
                            {f.reference && <span className="badge blue mono" title={`references ${f.reference}`}>→ {f.reference}</span>}
                            {f.mandatory && <span className="badge amber">required</span>}
                            {f.display && <span className="badge green">display</span>}
                            {f.inherited && <span className="badge" title={`defined on ${f.definedOn}`}>from {f.definedOn}</span>}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </Panel>
              )}

              {tab === 'references' && (
                <Panel title="References">
                  {e('references') && <p className="error-text">{e('references')}</p>}
                  {!d('references') && !e('references') && <SkeletonLines lines={4} />}
                  {d('references') && (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Outbound — what this table points at</div>
                      {(d('references').outbound || []).length === 0 && <p style={{ fontSize: 12 }}>None.</p>}
                      {(d('references').outbound || []).map((o) => (
                        <div key={o.element} style={{ fontSize: 12, padding: '3px 0' }}>
                          <span className="mono">{o.element}</span> <span style={{ color: 'var(--muted)' }}>→</span>{' '}
                          <span className="mono">{o.to}</span>
                          {o.inherited && <span className="badge" style={{ marginLeft: 6 }}>from {o.definedOn}</span>}
                        </div>
                      ))}
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                        Inbound — what points at this table ({d('references').inboundCount ?? 0})
                        {d('references').inboundComplete === false && (
                          <span className="badge amber" style={{ marginLeft: 6 }} title={d('references').inboundIncompleteReason || ''}>
                            floor, not a total
                          </span>
                        )}
                        {d('references').inboundCountDrift ? (
                          <span className="badge" style={{ marginLeft: 6 }} title={d('references').inboundCountDriftNote}>
                            ±{d('references').inboundCountDrift} drift
                          </span>
                        ) : null}
                      </div>
                      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                        {(d('references').inbound || []).slice(0, 300).map((i, n) => (
                          <div key={`${i.table}.${i.element}.${n}`} style={{ fontSize: 12, padding: '2px 0' }}>
                            <span className="mono">{i.table}.{i.element}</span>
                            {i.mandatory && <span className="badge amber" style={{ marginLeft: 6 }}>required</span>}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </Panel>
              )}

              {tab === 'hierarchy' && (
                <Panel title="Hierarchy">
                  {e('hierarchy') && <p className="error-text">{e('hierarchy')}</p>}
                  {!d('hierarchy') && !e('hierarchy') && <SkeletonLines lines={3} />}
                  {d('hierarchy') && (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Extends chain (up)</div>
                      <div className="mono" style={{ fontSize: 12.5, padding: '4px 0' }}>
                        {(d('hierarchy').extendsChain || [selected]).join('  →  ')}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Children (down)</div>
                      {(d('hierarchy').children || []).length === 0 && <p style={{ fontSize: 12 }}>No child tables.</p>}
                      {(d('hierarchy').children || []).map((c) => (
                        <div key={c.name} className="mono" style={{ fontSize: 12, padding: '2px 0' }}>{c.name}</div>
                      ))}
                      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
                        Children are listed to depth {d('hierarchy').depthRequested}; anything deeper is not shown.
                      </p>
                    </>
                  )}
                </Panel>
              )}

              {tab === 'indexes' && (
                <Panel title="Indexes">
                  {e('indexes') && <p className="error-text">{e('indexes')}</p>}
                  {!d('indexes') && !e('indexes') && <SkeletonLines lines={3} />}
                  {d('indexes') && (() => {
                    const v = describeIndexes(d('indexes'));
                    if (v.kind === 'list') {
                      return (
                        <>
                          <p style={{ fontSize: 12, color: 'var(--muted)' }}>{v.count} index definition record(s).</p>
                          {v.indexes.map((i, n) => (
                            <div key={n} style={{ fontSize: 12, padding: '2px 0' }}>
                              <span className="mono">{i.column}</span>{i.unique && <span className="badge green" style={{ marginLeft: 6 }}>unique</span>}
                              <span style={{ color: 'var(--muted)' }}> · {i.table}</span>
                            </div>
                          ))}
                          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{v.note}</p>
                        </>
                      );
                    }
                    // Unavailable and zero are BOTH amber and both explain
                    // themselves. Neither is ever drawn as "0 indexes".
                    return (
                      <div className="note warn">
                        <b>{v.title}</b>
                        <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{v.reason}</p>
                        {v.note && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>{v.note}</p>}
                        {v.isHarness && (
                          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
                            This is a failure of the server-side execution harness, not a finding about this table.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </Panel>
              )}

              {tab === 'map' && (
                <Panel title="Schema map">
                  {e('map') && <p className="error-text">{e('map')}</p>}
                  {!d('map') && !e('map') && <SkeletonLines lines={6} />}
                  {d('map') && (
                    <>
                      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>
                        {d('map').nodeCount} table(s), {d('map').edgeCount} edge(s), depth {d('map').depth}
                      </p>
                      <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
                        {(d('map').nodes || []).map((n) => (
                          <div key={n.table} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span className="mono" style={{ flex: 1, minWidth: 0 }}>{n.table}</span>
                            {n.isRoot && <span className="badge blue">root</span>}
                            {/* The map's own classification, shown as it came. */}
                            {n.classification && <span className="badge" title={`scope ${n.scope}`}>{n.classification}</span>}
                            {n.exists === false && <span className="badge amber">not on this instance</span>}
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Edges</div>
                      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                        {(d('map').edges || []).map((g, n) => (
                          <div key={n} className="mono" style={{ fontSize: 11.5, padding: '1px 0' }}>
                            {g.from} <span style={{ color: 'var(--muted)' }}>—{g.kind}→</span> {g.to}
                            {g.via ? <span style={{ color: 'var(--muted)' }}> ({g.via})</span> : null}
                          </div>
                        ))}
                      </div>
                      {d('map').note && <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{d('map').note}</p>}
                    </>
                  )}
                </Panel>
              )}

              {tab === 'about' && (
                <Panel title="Classification, scope and ownership">
                  {e('classify') && <p className="error-text">{e('classify')}</p>}
                  {!d('classify') && !e('classify') && <SkeletonLines lines={4} />}
                  {d('classify') && (
                    <>
                      <div style={{ fontSize: 12.5 }}>
                        <b>{d('classify').category}</b>
                        {d('classify').customized === true && ' · has customization records'}
                      </div>
                      <p style={{ fontSize: 12.5, marginTop: 6 }}>{d('classify').safeToModify?.reason}</p>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Evidence</div>
                      {(d('classify').evidence || []).map((ev, n) => (
                        <div key={n} className="mono" style={{ fontSize: 11.5, padding: '2px 0' }}>{ev}</div>
                      ))}
                      {d('table') && (
                        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                          {d('table').extends ? `Extends ${d('table').extends}.` : 'Standalone — extends nothing.'}
                          {' '}sys_id <span className="mono">{d('table').sys_id}</span>
                        </p>
                      )}
                    </>
                  )}
                </Panel>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
