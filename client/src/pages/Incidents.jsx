import { useEffect, useState } from 'react';
import { api, val, disp } from '../api.js';
import { confirmDestructive, CONSEQUENCE } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import ReferenceField from '../components/ReferenceField.jsx';
import { SkeletonRows, LoadingRegion, EmptyState } from '../components/states.jsx';
import DataTable from '../components/DataTable.jsx';
import RecordDrawer from '../components/RecordDrawer.jsx';

const EMPTY = {
  short_description: '', description: '', category: '', state: '1',
  impact: '3', urgency: '3', work_notes: '',
  caller_id: null, assignment_group: null, assigned_to: null,
};

function choicesFor(schema, field) {
  return schema?.fields?.find((f) => f.name === field)?.choices || [];
}

/* Priority tone. Module level because the column definitions below are. */
const badgeFor = (p) => (p === '1' ? 'red' : p === '2' ? 'amber' : '');

/*
 * Columns for the shared table. `text` is what sorting compares and filtering
 * matches; `cell` is only how it is drawn — so the badges below stay badges
 * while sorting still works on the underlying value.
 */
const INCIDENT_COLUMNS = [
  { key: 'number', header: 'Number', width: 130, text: (r) => disp(r, 'number'),
    cell: (r) => <span className="mono">{disp(r, 'number')}</span> },
  { key: 'short_description', header: 'Short description', width: 420,
    text: (r) => disp(r, 'short_description') },
  { key: 'state', header: 'State', width: 130, text: (r) => disp(r, 'state'),
    cell: (r) => <span className="badge">{disp(r, 'state')}</span> },
  { key: 'priority', header: 'Pri', width: 80, text: (r) => val(r, 'priority'),
    cell: (r) => <span className={`badge ${badgeFor(val(r, 'priority'))}`}>{val(r, 'priority')}</span> },
];

export default function Incidents() {
  const [schema, setSchema] = useState(null);
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ search: '', state: '', priority: '' });
  const [form, setForm] = useState(null);      // null = closed, {..EMPTY} or loaded record form
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setError(''); setLoading(true);
    try {
      const qs = new URLSearchParams({ ...filters, active: '', limit: '30' }).toString();
      setRows(await api.get(`/incidents?${qs}`));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    api.get('/system/schema/incident').then(setSchema).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.state, filters.priority]);

  const openNew = () => { setForm({ ...EMPTY }); setEditingId(null); setNotice(''); };
  /* One way to leave the drawer, shared by Escape, the backdrop and Close. */
  const closeForm = () => { setForm(null); setEditingId(null); };

  const openEdit = (r) => {
    setEditingId(val(r, 'sys_id'));
    setNotice('');
    setForm({
      short_description: disp(r, 'short_description'),
      description: '',
      category: val(r, 'category') || '',
      state: val(r, 'state') || '1',
      impact: val(r, 'impact') || '3',
      urgency: val(r, 'urgency') || '3',
      work_notes: '',
      caller_id: val(r, 'caller_id') ? { id: val(r, 'caller_id'), label: disp(r, 'caller_id') } : null,
      assignment_group: val(r, 'assignment_group') ? { id: val(r, 'assignment_group'), label: disp(r, 'assignment_group') } : null,
      assigned_to: val(r, 'assigned_to') ? { id: val(r, 'assigned_to'), label: disp(r, 'assigned_to') } : null,
      _number: disp(r, 'number'),
    });
    // Pull the full record so description prefills
    api.get(`/incidents/${val(r, 'sys_id')}`).then((full) => {
      setForm((f) => f ? { ...f, description: disp(full, 'description') } : f);
    }).catch(() => {});
  };

  const submit = async () => {
    setBusy(true); setError(''); setNotice('');
    const payload = {
      short_description: form.short_description,
      description: form.description,
      category: form.category,
      state: form.state,
      impact: form.impact,
      urgency: form.urgency,
      caller_id: form.caller_id?.id || '',
      assignment_group: form.assignment_group?.id || '',
      assigned_to: form.assigned_to?.id || '',
    };
    if (editingId && form.work_notes) payload.work_notes = form.work_notes;
    try {
      if (editingId) {
        const r = await api.patch(`/incidents/${editingId}`, payload);
        setNotice(`Updated ${disp(r, 'number')}`);
      } else {
        const r = await api.post('/incidents', payload);
        setNotice(`Created ${disp(r, 'number')}`);
        setForm(null);
      }
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    const ok = await confirmDestructive({
      action: 'Delete incident',
      subject: form._number,
      sysId: editingId,
      detail: CONSEQUENCE.incident,
    });
    if (!ok) return;
    setBusy(true); setError('');
    try {
      await api.del(`/incidents/${editingId}`);
      setForm(null); setEditingId(null);
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const stateChoices = choicesFor(schema, 'state');
  const prioChoices = choicesFor(schema, 'priority');
  const catChoices = choicesFor(schema, 'category');
  const impactChoices = choicesFor(schema, 'impact');
  const urgencyChoices = choicesFor(schema, 'urgency');


  return (
    <div className="stack">
      {/*
        * The list owns the whole content column now. The right-hand panel that
        * used to sit beside it — and that read "Nothing selected" whenever it
        * had nothing to show — is a drawer at the foot of this file.
        *
        * The loader, the filters and the records are untouched: DataTable is
        * handed `rows` exactly as they arrive from load().
        */}
      <div className="page-full">
        <DataTable
          title="Incidents"
          rows={rows}
          loading={loading}
          error={error}
          getRowId={(r) => val(r, 'sys_id')}
          activeId={editingId}
          onRowClick={openEdit}
          selectable
          filterPlaceholder="Filter loaded incidents…"
          empty="No incidents match these filters."
          columns={INCIDENT_COLUMNS}
          action={<button className="btn primary sm" onClick={openNew}>New incident</button>}
          toolbar={(
            <>
              <select className="select" style={{ width: 130 }} value={filters.state}
                onChange={(e) => setFilters({ ...filters, state: e.target.value })}>
                <option value="">All states</option>
                {stateChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <select className="select" style={{ width: 120 }} value={filters.priority}
                onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
                <option value="">All priority</option>
                {prioChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </>
          )}
        />

        {/*
          * The same form, the same handlers, the same save and delete — moved
          * into a drawer so it appears when a record is chosen and takes no
          * space when one is not. The "Nothing selected" state is gone with the
          * column that needed it.
          */}
        <RecordDrawer
          open={Boolean(form)}
          onClose={closeForm}
          title={editingId ? `Edit ${form?._number ?? ''}` : 'New incident'}
        >
          {form && (
            <>
              {editingId && (
                <div className="spread" style={{ marginBottom: 12 }}>
                  <span />
                  <button className="btn danger sm" onClick={remove} aria-busy={busy} disabled={busy}>Delete</button>
                </div>
              )}
              <div className="field">
                <label className="label">Short description</label>
                <input className="input" value={form.short_description} onChange={(e) => setForm({ ...form, short_description: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Description</label>
                <textarea className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Caller · sys_user</label>
                <ReferenceField table="sys_user" value={form.caller_id} onChange={(v) => setForm({ ...form, caller_id: v })} />
              </div>
              <div className="grid2">
                <div className="field">
                  <label className="label">Category</label>
                  <select className="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="">—</option>
                    {catChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">State</label>
                  <select className="select" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
                    {stateChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Impact</label>
                  <select className="select" value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>
                    {impactChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Urgency</label>
                  <select className="select" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
                    {urgencyChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="label">Assignment group · sys_user_group</label>
                <ReferenceField table="sys_user_group" value={form.assignment_group} onChange={(v) => setForm({ ...form, assignment_group: v })} />
              </div>
              <div className="field">
                <label className="label">Assigned to · sys_user</label>
                <ReferenceField table="sys_user" value={form.assigned_to} onChange={(v) => setForm({ ...form, assigned_to: v })} />
              </div>
              {editingId && (
                <div className="field">
                  <label className="label">Work notes (appended on save)</label>
                  <textarea className="textarea" value={form.work_notes} onChange={(e) => setForm({ ...form, work_notes: e.target.value })} />
                </div>
              )}
              <div className="row">
                <button className="btn primary" onClick={submit} aria-busy={busy} disabled={busy || !form.short_description}>
                  {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create incident'}
                </button>
                <button className="btn ghost" onClick={closeForm}>Close</button>
              </div>
              {notice && <p className="ok-text">{notice}</p>}
              {error && <p className="error-text">{error}</p>}
            </>
          )}
        </RecordDrawer>
      </div>
    </div>
  );
}
