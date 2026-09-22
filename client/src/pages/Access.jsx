import { useState } from 'react';
import { api } from '../api.js';
import { TableField } from '../components/ReferenceField.jsx';
import { SkeletonLines, EmptyState } from '../components/states.jsx';
import ScopeBadge from '../components/ScopeBadge.jsx';
import { useScopeLabels } from '../hooks/useScopeLabels.js';

/**
 * Access — read and explain ACLs. There is deliberately no authoring here.
 *
 * The single most important thing this page does is never render an empty
 * report as an answer. `sys_security_acl` is itself ACL-protected, so a
 * connection without the elevation sees nothing — and "you cannot see the
 * rules" and "there are no rules" are opposite conclusions that look identical
 * in a table. The visibility banner is therefore always shown, not just when
 * something went wrong.
 */

const TABS = [
  ['report', 'Report'],
  ['diff', 'Role diff'],
  ['explain', 'Explain'],
];

export default function Access() {
  const [table, setTable] = useState({ id: 'incident', label: 'Incident' });
  const [tab, setTab] = useState('report');
  const [report, setReport] = useState(null);
  const [diff, setDiff] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [roles, setRoles] = useState({ a: 'admin', b: 'itil' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const run = async () => {
    if (!table?.id) return;
    setBusy('report'); setError(''); setReport(null); setDiff(null); setExplanation(null);
    try { setReport(await api.get(`/access/acl/${table.id}`)); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const runDiff = async () => {
    setBusy('diff'); setError(''); setDiff(null);
    try { setDiff(await api.get(`/access/diff/${table.id}?a=${encodeURIComponent(roles.a)}&b=${encodeURIComponent(roles.b)}`)); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const explain = async () => {
    setBusy('explain'); setError(''); setExplanation(null);
    try { setExplanation(await api.post('/access/explain', { report })); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">Access control · read only</div>
        <div className="row">
          <div style={{ flex: 1, minWidth: 260 }}>
            <TableField value={table} onChange={setTable} placeholder="Pick a table…" />
          </div>
          <button className="btn primary" onClick={run} aria-busy={busy === 'report'} disabled={busy === 'report' || !table?.id}>
            {busy === 'report' ? 'Reading…' : 'Read ACLs'}
          </button>
        </div>
        <div className="note" style={{ marginTop: 10 }}>
          SAOS reads and explains access rules. It does not write them — an ACL is the one artifact where a
          confidently wrong write is a security incident rather than a bug.
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>

      {busy === 'report' && !report && (
        <div className="card"><SkeletonLines lines={6} /></div>
      )}

      {!report && !busy && !error && (
        <div className="card">
          <EmptyState
            title="No report yet."
            hint="Pick a table and read its ACLs. The report walks the inheritance chain, so incident brings task's rules with it — and says which of them came from where."
            actionLabel="Read ACLs"
            onAction={run}
          />
        </div>
      )}

      {report && (
        <>
          <VisibilityBanner report={report} />

          <div className="tabs">
            {TABS.map(([id, label]) => (
              <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'report' && <ReportView report={report} />}

          {tab === 'diff' && (
            <div className="stack">
              <div className="card">
                <div className="row">
                  <input className="input mono" style={{ width: 200 }} value={roles.a}
                    onChange={(e) => setRoles({ ...roles, a: e.target.value })} placeholder="role A" />
                  <input className="input mono" style={{ width: 200 }} value={roles.b}
                    onChange={(e) => setRoles({ ...roles, b: e.target.value })} placeholder="role B" />
                  <button className="btn primary" onClick={runDiff} aria-busy={busy === 'diff'} disabled={busy === 'diff'}>
                    {busy === 'diff' ? 'Comparing…' : 'Compare'}
                  </button>
                </div>
              </div>
              {diff && <DiffView diff={diff} />}
            </div>
          )}

          {tab === 'explain' && (
            <div className="card">
              <div className="spread" style={{ marginBottom: 12 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>Plain language</div>
                <button className="btn" onClick={explain} aria-busy={busy === 'explain'} disabled={busy === 'explain'}>
                  {busy === 'explain' ? 'Generating…' : 'Explain in plain language'}
                </button>
              </div>
              {busy === 'explain' && <SkeletonLines lines={5} />}
              {!explanation && !error && (
                <EmptyState
                  title="Not generated yet."
                  hint="Sends the structured report above through your configured model. Read-only — nothing is written, and the model sees the report, not the instance."
                  actionLabel="Explain in plain language"
                  onAction={explain}
                />
              )}
              {explanation && (
                <>
                  {/* Labelled at the boundary: the report is a reading of the
                      instance, this paragraph is a reading of the report. */}
                  <div className="note warn" style={{ marginBottom: 12 }}>
                    <b>AI-generated.</b> {explanation.label}
                    {explanation.retried && <> Rejected once and regenerated: {explanation.retried}.</>}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{explanation.text}</div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Always rendered, never only on failure. A report that is silently partial is
 * the failure mode this whole feature has to avoid.
 */
function VisibilityBanner({ report }) {
  const tone = report.visibility === 'full' ? '' : 'warn';
  const headline = {
    full: `Full visibility — ${report.counts.total} rules across ${report.hierarchy.join(' → ')}.`,
    empty: `No ACLs on ${report.table} or its parents, and other tables' ACLs ARE readable here — so this is a real absence.`,
    restricted: 'No ACL rows are visible on this connection at all.',
    error: 'The ACL tables could not be read.',
  }[report.visibility];
  return (
    <div className={`note ${tone}`}>
      <b>{headline}</b>
      {report.notes.map((n, i) => <div key={i} style={{ marginTop: 6 }}>{n}</div>)}
    </div>
  );
}

function ReportView({ report }) {
  const c = report.counts;
  const all = [...report.recordAcls, ...report.fieldAcls];
  const scopeLabels = useScopeLabels(all.map((a) => a.applicationScope));
  // Which applications own the rules governing this table. Usually one, but an
  // inherited rule can come from another, and that is worth seeing before you
  // conclude a table is governed only by what you can edit.
  const scopes = [...new Set(all.map((a) => a.applicationScope).filter(Boolean))];
  return (
    <div className="stack">
      <div className="grid3">
        <Stat n={c.record} label="record ACLs" />
        <Stat n={c.field} label="field ACLs" />
        <Stat n={c.scriptGuarded} label="script-guarded" tone={c.scriptGuarded ? 'amber' : ''} />
        <Stat n={c.noRoleRequired} label="no role required" tone={c.noRoleRequired ? 'amber' : ''} />
        <Stat n={c.inactive} label="inactive" />
        <Stat n={c.conditionsOnUnknownFields} label="conditions on absent fields" tone={c.conditionsOnUnknownFields ? 'red' : ''} />
      </div>

      {scopes.length > 0 && (
        <div className="row" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          <span>governed by rules in</span>
          {scopes.map((sc) => <ScopeBadge key={sc} scope={scopeLabels[sc] || sc} />)}
        </div>
      )}

      <div className="card">
        <div className="card-title">Operation × role · record ACLs</div>
        <table className="table">
          <thead><tr><th>Operation</th><th>Role</th><th>Rules</th></tr></thead>
          <tbody>
            {report.operations.flatMap((op) => {
              const byRole = report.matrix[op] || {};
              const entries = Object.entries(byRole);
              if (!entries.length) return [];
              return entries.map(([role, hits]) => (
                <tr key={`${op}:${role}`}>
                  <td className="mono">{op}</td>
                  <td>
                    {role === '(no role required)'
                      ? <span className="badge amber">no role required</span>
                      : <span className="badge">{role}</span>}
                  </td>
                  <td>
                    {hits.map((h, i) => (
                      <span key={i} className="mono" style={{ marginRight: 10, color: 'var(--muted)' }}>
                        {h.definedOn}
                        {!h.active && ' · inactive'}
                        {h.condition && ' · condition'}
                        {h.hasScript && ' · script'}
                      </span>
                    ))}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
        {report.operations.length === 0 && <div className="empty">No operations to show.</div>}
      </div>

      <div className="card">
        <div className="card-title">Field ACLs · {report.fieldAcls.length}</div>
        <table className="table">
          <thead><tr><th>Field</th><th>Op</th><th>Roles</th><th>Condition</th><th>Flags</th></tr></thead>
          <tbody>
            {report.fieldAcls.map((a) => (
              <tr key={a.sys_id}>
                <td className="mono">{a.field}</td>
                <td className="mono">{a.operation}</td>
                <td>
                  {a.rolesUnknown
                    ? <span className="badge red">roles unknown</span>
                    : a.roles.length === 0
                      ? <span className="badge amber">none</span>
                      : a.roles.map((r) => <span key={r} className="badge" style={{ marginRight: 4 }}>{r}</span>)}
                </td>
                <td className="mono" style={{ fontSize: 11, maxWidth: 240, wordBreak: 'break-all' }}>
                  {a.condition || '—'}
                  {a.conditionCheck?.ok === false && (
                    <div className="error-text">names {a.conditionCheck.unknown.join(', ')} — the clause is dropped, so this rule is broader than it reads</div>
                  )}
                </td>
                <td>
                  {a.hasScript && <span className="badge amber" title={`${a.scriptLength} chars — presence only, the script is not evaluated`}>script</span>}
                  {!a.active && <span className="badge">inactive</span>}
                  {a.inherited && <span className="badge blue" title={`defined on ${a.definedOn}`}>inherited</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.fieldAcls.length === 0 && <div className="empty">No field-level ACLs.</div>}
      </div>

      <div className="card">
        <div className="card-title">Record ACLs · {report.recordAcls.length}</div>
        <table className="table">
          <thead><tr><th>Op</th><th>Defined on</th><th>Scope</th><th>Roles</th><th>Condition</th><th>Flags</th></tr></thead>
          <tbody>
            {report.recordAcls.map((a) => (
              <tr key={a.sys_id}>
                <td className="mono">{a.operation}</td>
                <td className="mono">{a.definedOn}</td>
                <td><ScopeBadge scope={scopeLabels[a.applicationScope] || a.applicationScope} /></td>
                <td>
                  {a.rolesUnknown
                    ? <span className="badge red">roles unknown</span>
                    : a.roles.length === 0
                      ? <span className="badge amber">none</span>
                      : a.roles.map((r) => <span key={r} className="badge" style={{ marginRight: 4 }}>{r}</span>)}
                </td>
                <td className="mono" style={{ fontSize: 11, maxWidth: 260, wordBreak: 'break-all' }}>
                  {a.condition || '—'}
                  {a.conditionCheck?.ok === false && (
                    <div className="error-text">names {a.conditionCheck.unknown.join(', ')} — dropped, so this rule is broader than it reads</div>
                  )}
                </td>
                <td>
                  {a.hasScript && <span className="badge amber" title={`${a.scriptLength} chars — presence only`}>script</span>}
                  {a.admin_overrides && <span className="badge" title="skipped entirely for admin">admin overrides</span>}
                  {a.decision_type === 'deny' && <span className="badge red">deny unless</span>}
                  {!a.active && <span className="badge">inactive</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffView({ diff }) {
  const [a, b] = diff.roles;
  return (
    <div className="stack">
      <div className="note warn">{diff.caveat}</div>
      {diff.roleNotes?.map((n, i) => <div key={i} className="note warn">{n}</div>)}

      <div className="card">
        <div className="card-title">Operations</div>
        <table className="table">
          <thead><tr><th>Operation</th><th>{a}</th><th>{b}</th><th>Open</th><th /></tr></thead>
          <tbody>
            {diff.operations.map((r) => (
              <tr key={r.operation}>
                <td className="mono">{r.operation}</td>
                <td>{r[a].length}</td>
                <td>{r[b].length}</td>
                <td>{r.noRoleRequired.length}</td>
                <td>
                  <span className={`badge ${r.difference.startsWith('only') ? 'amber' : r.difference === 'both' ? 'green' : ''}`}>
                    {r.difference}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {diff.operations.length === 0 && <div className="empty">Neither role is named on any record ACL for this table.</div>}
      </div>

      <div className="card">
        <div className="card-title">Field differences · {diff.summary.fieldDifferences}</div>
        <table className="table">
          <thead><tr><th>Field</th><th>Op</th><th>Difference</th></tr></thead>
          <tbody>
            {diff.fields.filter((f) => f.difference !== 'both').map((f) => (
              <tr key={f.sys_id}>
                <td className="mono">{f.field}</td>
                <td className="mono">{f.operation}</td>
                <td><span className="badge amber">{f.difference}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {diff.summary.fieldDifferences === 0 && <div className="empty">No field-level differences between these roles.</div>}
      </div>
    </div>
  );
}

function Stat({ n, label, tone }) {
  return (
    <div className="card stat">
      <b style={tone ? { color: `var(--${tone})` } : undefined}>{n}</b>
      <span>{label}</span>
    </div>
  );
}
