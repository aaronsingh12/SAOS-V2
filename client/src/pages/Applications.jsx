import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import ScopeBadge from '../components/ScopeBadge.jsx';
import DataTable from '../components/DataTable.jsx';

/**
 * Applications — every scope on the instance, and which ones we manage.
 *
 * Read-only on purpose. The page exists to answer "what scope is this in", a
 * question that decides where an artifact can travel, and getting that wrong is
 * how a change ends up in a set it cannot be moved out of.
 *
 * Two things it will not do quietly:
 *
 *   - Store applications come from `sys_scope`, not `sys_store_app`, because
 *     that table answers 403 to this user over REST. The footnote says so. An
 *     instance with 739 store apps and a page showing none would otherwise look
 *     exactly like an instance with none.
 *   - A workspace on disk whose scope is not installed here is called out
 *     rather than omitted — that is a real state (built, never deployed) and
 *     omitting it makes the registry look empty.
 */

const KINDS = [
  { key: '', label: 'All' },
  { key: 'custom', label: 'Custom' },
  { key: 'store', label: 'Store' },
  { key: 'scope', label: 'Global' },
];

/* The application list as columns. `text` is what sorting and filtering read;
   `cell` only draws, so a scope badge stays a badge while sorting compares the
   scope itself. */
const APP_COLUMNS = [
  { key: 'name', header: 'Application', width: 300, text: (a) => a.name,
    cell: (a) => (
      <>
        {a.name}
        {!a.active && <span className="badge amber" style={{ marginLeft: 8 }}>inactive</span>}
        {a.shortDescription && (
          <div className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>{a.shortDescription}</div>
        )}
      </>
    ) },
  { key: 'scope', header: 'Scope', width: 210, text: (a) => a.scope || '',
    cell: (a) => <ScopeBadge scope={a.scope} name={a.name} managed={a.managed} /> },
  { key: 'version', header: 'Version', width: 130, text: (a) => a.version || '—',
    cell: (a) => <span className="mono">{a.version || '—'}</span> },
  { key: 'vendor', header: 'Vendor', width: 170, text: (a) => a.vendor || '—' },
  { key: 'managed', header: 'Managed', width: 230,
    text: (a) => (a.managed ? 'SAOS' : '—'),
    cell: (a) => (a.managed ? (
      <>
        <span className="badge green">SAOS</span>
        {a.workspace && (
          <div className="mono" style={{ color: 'var(--muted)', fontSize: 11, marginTop: 3 }}>
            {a.workspace.id} · {a.workspace.sourceCount} source{a.workspace.sourceCount === 1 ? '' : 's'}
            {!a.workspace.installable && ' · deps missing'}
          </div>
        )}
      </>
    ) : <span style={{ color: 'var(--muted)' }}>—</span>) },
];

export default function Applications() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('custom');
  const [search, setSearch] = useState('');
  const [managedOnly, setManagedOnly] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/applications')
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // Filtering is local: the whole list is one read, and 743 rows filter faster
  // in the browser than they round-trip.
  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.applications.filter((a) => {
      if (kind && a.kind !== kind) return false;
      if (managedOnly && !a.managed) return false;
      if (q && !`${a.name} ${a.scope}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, kind, search, managedOnly]);

  if (error) return <div className="card"><div className="error-text">{error}</div></div>;

  return (
    <div className="stack">
      <div className="grid3">
        <div className="card"><div className="stat"><b>{data?.counts?.custom ?? '—'}</b><span>custom applications</span></div></div>
        <div className="card"><div className="stat"><b>{data?.counts?.store ?? '—'}</b><span>store applications</span></div></div>
        <div className="card"><div className="stat"><b>{data?.managedCount ?? '—'}</b><span>managed by SAOS</span></div></div>
      </div>

      {data?.orphanWorkspaces?.length > 0 && (
        <div className="note warn">
          <b>{data.orphanWorkspaces.length} SDK workspace{data.orphanWorkspaces.length === 1 ? '' : 's'} on disk with no application on this instance.</b>{' '}
          {data.orphanWorkspaces.map((w) => w.scope).join(', ')} — built, but never installed here.
        </div>
      )}

      {/* The same list, on the shared glass table: same container, header, row
          and hover treatment, same pagination and the same contained horizontal
          scroll as Incidents, SLA and Catalog. The read, the local filtering and
          every value drawn are untouched. */}
      <div className="page-full">
        <DataTable
          title="Applications"
          rows={rows}
          loading={loading}
          getRowId={(a) => a.sys_id}
          filterPlaceholder="Filter loaded applications…"
          empty={search ? `Nothing on this instance matches "${search}".` : 'No applications match. Try another filter.'}
          columns={APP_COLUMNS}
          toolbar={(
            <>
              {KINDS.map((k) => (
                <button
                  key={k.key || 'all'}
                  className={`btn sm${kind === k.key ? ' primary' : ''}`}
                  onClick={() => setKind(k.key)}
                >
                  {k.label}
                  {data && k.key && <span className="mono" style={{ marginLeft: 6, opacity: 0.6 }}>{data.counts[k.key] ?? 0}</span>}
                </button>
              ))}
              <label className="check">
                <input type="checkbox" checked={managedOnly} onChange={(e) => setManagedOnly(e.target.checked)} />
                managed only
              </label>
              <input
                className="input dt-tool-input" placeholder="name or scope"
                value={search} onChange={(e) => setSearch(e.target.value)}
              />
            </>
          )}
        />
      </div>

      {data?.visibility && (
        <div className="note">
          <b>Where this comes from.</b> {data.visibility.note}
          {data.visibility.droppedFields?.length > 0 && (
            <> This instance did not return: <span className="mono">{data.visibility.droppedFields.join(', ')}</span>.</>
          )}
          <div style={{ marginTop: 6, color: 'var(--muted)' }}>
            Anything SAOS creates over the Table API is born in <span className="mono">global</span> —
            the platform accepts a scope on a REST insert and silently ignores it. Scoped artifacts come from an SDK workspace.
          </div>
        </div>
      )}
    </div>
  );
}
