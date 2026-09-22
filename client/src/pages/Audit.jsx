import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { SkeletonRows, LoadingRegion } from '../components/states.jsx';
import DataTable from '../components/DataTable.jsx';
import RecordDrawer from '../components/RecordDrawer.jsx';

/**
 * D-5 — the audit page.
 *
 * The acceptance test is a sentence: reconstruct everything a past session did
 * to the instance — with sys_ids and who approved — from this page alone. Three
 * decisions follow directly from that and are worth stating.
 *
 * **Approval is never rounded up.** `auto` means auto-approve was on and no
 * human ever saw the gate. Rendering that as "approved" would describe a
 * decision that did not happen, which on the one page whose job is trust is
 * the worst available lie. It gets its own badge and its own colour.
 *
 * **Rows written before D-5 say so.** `result`, `instance` and `actor` did not
 * exist until migration 5, so older events have no result to show. An empty
 * cell there means "not recorded", not "nothing came back" — and this page
 * prints which, because those are opposite facts (trap #2's shape, again).
 *
 * **The export is what is on screen.** The CSV honours the same filters rather
 * than dumping the table, because an export that silently differs from the
 * page is worse than no export.
 */

/**
 * What a capture row says, in one line.
 *
 * The "data" case is the one that has to be legible without expanding: a
 * mutation that produced no update is a normal, correct outcome for an
 * incident, and a row that just read "not captured" would look like a fault.
 */
function captureSummary(row) {
  let r = null;
  try { r = typeof row.result === 'string' ? JSON.parse(row.result) : row.result; } catch { /* shown raw below */ }
  return r?.message || 'capture';
}

function CaptureBadge({ row }) {
  let r = null;
  try { r = typeof row.result === 'string' ? JSON.parse(row.result) : row.result; } catch { /* fall through */ }
  if (row.status === 'skipped' || r?.reason === 'data') {
    return (
      <span className="badge" title="Update sets carry configuration only. Task data has no update row to capture.">
        not captured · data
      </span>
    );
  }
  if (row.status === 'error') return <span className="badge red" title={r?.message}>capture failed</span>;
  if (r?.moved > 0) return <span className="badge green" title={r?.message}>captured {r.moved}</span>;
  return <span className="badge" title={r?.message}>nothing to capture</span>;
}

const KIND_LABEL = {
  flow_build: 'flow build + install',
  flow_verify: 'flow verification',
  flow_smoke: 'flow smoke test',
  flow_delete: 'flow delete + reinstall',
  sla_verify: 'SLA verification',
  ui_policy_create: 'UI policy build + install',
  ui_policy_update: 'UI policy update + install',
  ui_policy_delete: 'UI policy delete + reinstall',
};

function ApprovalBadge({ row }) {
  if (row.source === 'build' && row.approval === 'ui') {
    return <span className="badge blue" title="Driven by hand from a SAOS module page.">by hand</span>;
  }
  if (!row.mutating) return <span style={{ color: 'var(--muted)' }}>—</span>;
  switch (row.approval) {
    case 'approved':
      return <span className="badge green" title="A human clicked Approve at the amber gate.">approved</span>;
    case 'rejected':
      return <span className="badge red" title="A human clicked Reject; the tool never ran.">rejected</span>;
    case 'auto':
      return (
        <span className="badge amber" title="Auto-approve was on. No human saw this before it ran.">
          auto · ungated
        </span>
      );
    default:
      return <span className="badge">unrecorded</span>;
  }
}

function StatusBadge({ status }) {
  const tone = status === 'ok' ? 'green'
    : status === 'error' ? 'red'
      : status === 'rejected' ? 'red'
        : status === 'running' ? 'amber' : '';
  return <span className={`badge ${tone}`}>{status || '—'}</span>;
}

/** A payload or a result, collapsed by default — these run to thousands of characters. */
function Block({ label, value, missingNote }) {
  const [open, setOpen] = useState(false);
  if (value === null || value === undefined || value === '') {
    return (
      <div className="audit-block">
        <div className="label">{label}</div>
        <p className="audit-missing">{missingNote || 'Not recorded.'}</p>
      </div>
    );
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  const lines = text.split('\n').length;
  return (
    <div className="audit-block">
      <button className="audit-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
        <span className="audit-size">{lines} line{lines === 1 ? '' : 's'} · {text.length} chars</span>
      </button>
      {open && <pre className="audit-dump mono">{text}</pre>}
    </div>
  );
}

/** The streamed evidence behind a build run, fetched only when asked for. */
function BuildEvents({ runId }) {
  const [state, setState] = useState({ loading: false, events: null, error: null });
  const [open, setOpen] = useState(false);

  const load = async () => {
    setOpen(!open);
    if (open || state.events) return;
    setState({ loading: true, events: null, error: null });
    try {
      const r = await api.get(`/audit/runs/${runId}`);
      setState({ loading: false, events: r.events, error: null });
    } catch (e) {
      setState({ loading: false, events: null, error: e.message });
    }
  };

  return (
    <div className="audit-block">
      <button className="audit-toggle" onClick={load} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> streamed events
        {state.events && <span className="audit-size">{state.events.length}</span>}
      </button>
      {open && state.loading && <><SkeletonRows rows={1} cols={1} /><LoadingRegion label="Loading events" /></>}
      {open && state.error && <p className="error-text">{state.error}</p>}
      {open && state.events && (
        <pre className="audit-dump mono">
          {state.events.map((e) => `${e.ts}  ${e.type || '(untyped)'}  ${JSON.stringify(e.payload)}`).join('\n')}
        </pre>
      )}
    </div>
  );
}

/* The columns. `text` is what sorting and filtering read; `cell` only draws,
   so a badge stays a badge while sorting compares the word behind it. */
const AUDIT_COLUMNS = [
  { key: 'when', header: 'When', width: 140, text: (r) => String(r.ts),
    cell: (r) => {
      const when = new Date(r.ts);
      return (
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>
          {when.toLocaleDateString()}<br />
          <span style={{ color: 'var(--muted)' }}>{when.toLocaleTimeString()}</span>
        </span>
      );
    } },
  { key: 'source', header: 'Source', width: 110, text: (r) => r.source,
    cell: (r) => <span className={`badge ${r.source === 'build' ? 'blue' : ''}`}>{r.source}</span> },
  { key: 'what', header: 'What', width: 320, text: (r) => r.name,
    cell: (r) => (
      <>
        <span className="mono">{r.name}</span>
        {r.source === 'build' && KIND_LABEL[r.kind] && <div className="audit-sub">{KIND_LABEL[r.kind]}</div>}
        {r.kind === 'capture' && <div className="audit-sub">{captureSummary(r)}</div>}
        {r.sessionTitle && <div className="audit-sub">{r.sessionTitle}</div>}
      </>
    ) },
  { key: 'kind', header: 'Kind', width: 130,
    text: (r) => (r.kind === 'capture' ? 'capture' : r.mutating ? 'mutation' : 'read'),
    cell: (r) => (r.kind === 'capture'
      ? <CaptureBadge row={r} />
      : r.mutating
        ? <span className="badge amber">mutation</span>
        : <span className="badge">read</span>) },
  { key: 'approval', header: 'Approval', width: 150, text: (r) => r.approval || '',
    cell: (r) => <ApprovalBadge row={r} /> },
  { key: 'status', header: 'Result', width: 120, text: (r) => r.status || '',
    cell: (r) => <StatusBadge status={r.status} /> },
  { key: 'sysIds', header: 'sys_ids touched', width: 260, sortable: false,
    text: (r) => r.sysIds.join(' '),
    cell: (r) => (r.sysIds.length === 0
      ? <span style={{ color: 'var(--muted)' }}>—</span>
      : <span className="mono audit-ids">{r.sysIds.join(' ')}</span>) },
];

/* The detail a row used to expand into, unchanged — same fields, same Blocks,
   same BuildEvents. It is drawn in the drawer now rather than in a second
   <tr>, which is the pattern every other list on this app uses. */
function RowDetail({ row }) {
  return (
    <>
      <dl className="kv" style={{ marginBottom: 10 }}>
        <div style={{ display: 'contents' }}><dt>instance</dt>
          <dd className="mono">{row.instance || <span className="audit-missing">not recorded</span>}</dd></div>
        <div style={{ display: 'contents' }}><dt>account</dt>
          <dd className="mono">{row.actor || <span className="audit-missing">not recorded</span>}</dd></div>
        <div style={{ display: 'contents' }}><dt>session</dt>
          <dd className="mono">{row.session || 'none — driven from a module page'}</dd></div>
        {row.source === 'build' && (
          <div style={{ display: 'contents' }}><dt>run</dt><dd className="mono">{row.id}</dd></div>
        )}
      </dl>
      {row.dropped > 0 && (
        <div className="note warn" style={{ marginBottom: 10 }}>
          {row.dropped} event{row.dropped === 1 ? '' : 's'} could not be written to the audit database during this
          run. What is below is incomplete — the server log has the reason.
        </div>
      )}
      <Block label="request" value={row.payload} />
      <Block
        label="result"
        value={row.result}
        missingNote={
          row.source === 'agent'
            ? 'Not recorded. Results were only stored from D-5 onwards, so this event predates the column — it does not mean the tool returned nothing.'
            : 'Not recorded.'
        }
      />
      {row.source === 'build' && <BuildEvents runId={row.id} />}
    </>
  );
}

export default function Audit() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [session, setSession] = useState('');
  const [mutatingOnly, setMutatingOnly] = useState(false);
  /* One selected event rather than a map of expanded ones: the detail is a
     drawer now, and a drawer shows one record. */
  const [detail, setDetail] = useState(null);

  const query = useCallback(() => {
    const p = new URLSearchParams();
    if (session) p.set('session', session);
    if (mutatingOnly) p.set('mutating', 'true');
    return p.toString();
  }, [session, mutatingOnly]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api.get(`/audit?${query()}`)); }
    catch (e) { setError(e.message); toast.error(e.message); }
    finally { setLoading(false); }
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const mutations = rows.filter((r) => r.mutating).length;
  const ungated = rows.filter((r) => r.approval === 'auto').length;

  return (
    <div className="stack">
      <div className="card">
        <div className="spread" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Audit</div>
          <div className="row">
            <button className="btn sm" onClick={load} aria-busy={loading} disabled={loading}>Refresh</button>
            {/* Content-Disposition on the server makes this a download; the
                query string is the page's own filters, so the file matches
                what is on screen rather than dumping the whole table. */}
            <a className="btn primary sm" href={`/api/audit/export.csv?${query()}`} download>
              Export CSV
            </a>
          </div>
        </div>

        <div className="row" style={{ marginBottom: 10 }}>
          <select className="select" style={{ maxWidth: 340 }} value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="">All activity</option>
            <option value="ui">Driven by hand (no agent session)</option>
            {(data?.sessions || []).map((s) => (
              <option key={s.id} value={s.id}>
                {(s.title || s.id).slice(0, 60)} — {s.events} event{s.events === 1 ? '' : 's'}
                {s.mutations > 0 ? `, ${s.mutations} mutating` : ''}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={mutatingOnly} onChange={(e) => setMutatingOnly(e.target.checked)} />
            Mutations only
          </label>
          <span className="badge" style={{ marginLeft: 'auto' }}>{rows.length} row{rows.length === 1 ? '' : 's'}</span>
          <span className="badge amber">{mutations} mutating</span>
          {ungated > 0 && (
            <span className="badge red" title="Auto-approve was on: these ran without anyone seeing the gate.">
              {ungated} ungated
            </span>
          )}
        </div>

        <div className="note">
          Every tool the agent ran and every build driven from a module page, against the bound instance. A row is a
          write only if it says <b>mutation</b>; <b>auto · ungated</b> means auto-approve was on and nobody saw the
          amber gate. SAOS has no user accounts, so "who" is recorded as the decision that was made and the
          ServiceNow account the write landed under — it does not invent a person.
        </div>

        {error && <p className="error-text">{error}</p>}
      </div>

      {/* The audit trail, on the shared glass table — same container, header,
          rows, hover, pagination and contained horizontal scroll as every other
          list in the app. The rows, the filters and every value drawn are the
          ones this page always had; what a row used to expand into is in the
          drawer below. */}
      <div className="page-full">
        <DataTable
          title="Audit trail"
          rows={rows}
          loading={loading}
          getRowId={(r) => `${r.source}:${r.id}`}
          activeId={detail ? `${detail.source}:${detail.id}` : null}
          onRowClick={setDetail}
          filterPlaceholder="Filter loaded events…"
          empty={session || mutatingOnly
            ? 'Nothing matches this filter. Clear the session filter or the mutations-only toggle to see the whole trail.'
            : 'Nothing has been done to an instance yet. Every tool the agent runs and every build driven from a module page is recorded here, with its request, its result and the sys_ids it touched.'}
          columns={AUDIT_COLUMNS}
        />
        {loading && <LoadingRegion label="Loading the audit trail" />}

        <RecordDrawer
          open={Boolean(detail)}
          onClose={() => setDetail(null)}
          title={detail ? detail.name : 'Audit event'}
          width={620}
        >
          {detail && <RowDetail row={detail} />}
        </RecordDrawer>
      </div>
    </div>
  );
}
