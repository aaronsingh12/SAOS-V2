import { useEffect, useState } from 'react';
import { api, val, disp } from '../api.js';
import { confirmDestructive, CONSEQUENCE } from './confirm.js';
import { toast } from './toast.js';
import { SkeletonLines, LoadingRegion, EmptyState } from './states.jsx';

/**
 * Variable list with inline editing, reordering and choice management.
 *
 * Two things here are deliberate. Reordering renumbers the WHOLE list on the
 * server rather than swapping a pair, because `order` is an integer and two
 * variables sharing a value render in an order the platform picks — which looks
 * exactly like the reorder having failed. And a variable is edited in place
 * rather than replaced: recreating it mints a new sys_id, and every UI policy
 * condition and action that named the old one keeps the reference and silently
 * stops matching.
 */

// 18/22 are lookup types: their values come from a table, not question_choice.
const CHOICE_TYPES = new Set([3, 5]);

function ChoiceEditor({ variableId, onChanged }) {
  const [choices, setChoices] = useState(null);
  const [draft, setDraft] = useState({ text: '', value: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get(`/catalog/variables/${variableId}/choices`).then(setChoices).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [variableId]);

  const add = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/catalog/variables/${variableId}/choices`, draft);
      setDraft({ text: '', value: '' });
      load(); onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const save = async (c, patch) => {
    setError('');
    try { await api.patch(`/catalog/choices/${c.sys_id}`, patch); load(); onChanged?.(); }
    catch (e) { setError(e.message); }
  };

  const remove = async (c) => {
    const ok = await confirmDestructive({
      action: 'Delete choice', subject: c.text, sysId: c.sys_id, detail: CONSEQUENCE.choice,
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/catalog/choices/${c.sys_id}`); load(); onChanged?.();
      toast.success(`Deleted choice "${c.text}".`);
    } catch (e) { setError(e.message); toast.error(e.message); }
  };

  if (!choices) return <><SkeletonLines lines={2} /><LoadingRegion label="Loading choices" /></>;

  return (
    <div className="choice-editor">
      <div className="label">Choices — the <span className="mono">value</span> is what a UI policy condition compares against</div>
      {choices.map((c) => (
        <div key={c.sys_id} className="choice-row">
          <input className="input" defaultValue={c.text} onBlur={(e) => e.target.value !== c.text && save(c, { text: e.target.value })} />
          <input className="input mono" defaultValue={c.value} onBlur={(e) => e.target.value !== c.value && save(c, { value: e.target.value })} />
          <button className="btn ghost sm" onClick={() => remove(c)} aria-label="Delete choice">✕</button>
        </div>
      ))}
      {choices.length === 0 && (
        <EmptyState
          title="No choices yet."
          hint="Until this list has entries the variable renders empty on the form — and a UI policy comparing against a value it does not have can never match."
        />
      )}
      <div className="choice-row">
        <input className="input" placeholder="Display text" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        <input className="input mono" placeholder="value (derived if blank)" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
        <button className="btn sm" onClick={add} aria-busy={busy} disabled={busy || !draft.text}>Add</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function EditForm({ v, onSave, onCancel, busy }) {
  const [form, setForm] = useState({
    question_text: disp(v, 'question_text'),
    order: Number(val(v, 'order')) || 100,
    mandatory: val(v, 'mandatory') === 'true',
    help_text: disp(v, 'help_text'),
    default_value: disp(v, 'default_value'),
  });
  return (
    <div className="variable-edit">
      <div className="grid2">
        <div className="field">
          <label className="label">Question text</label>
          <input className="input" value={form.question_text} onChange={(e) => setForm({ ...form, question_text: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Order</label>
          <input className="input" type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} />
        </div>
      </div>
      <div className="field">
        <label className="label">Help text</label>
        <input className="input" value={form.help_text} onChange={(e) => setForm({ ...form, help_text: e.target.value })} />
      </div>
      <div className="field">
        <label className="label">Default value</label>
        <input className="input mono" value={form.default_value} onChange={(e) => setForm({ ...form, default_value: e.target.value })} />
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={form.mandatory} onChange={(e) => setForm({ ...form, mandatory: e.target.checked })} /> Mandatory
        </label>
        <button className="btn primary sm" onClick={() => onSave(form)} aria-busy={busy} disabled={busy}>Save</button>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function VariableEditor({ catItemId, variables, typeLabel, onChanged, readOnly }) {
  const [editing, setEditing] = useState(null);
  const [openChoices, setOpenChoices] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  if (!variables?.length) {
    return (
      <EmptyState
        title="This item has no variables."
        hint="Add one below. Variables are what the requester fills in, and what UI policies address — by sys_id, not by name."
      />
    );
  }

  const ids = variables.map((v) => val(v, 'sys_id'));

  const move = async (index, delta) => {
    const next = [...ids];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await api.post(`/catalog/items/${catItemId}/variables/reorder`, { ids: next });
      // The whole list is renumbered and read back; a row whose order did not
      // store is named rather than folded into a green.
      if (!res.ok) {
        const bad = res.variables.filter((r) => !r.ok);
        setError(`${bad.length} variable(s) did not store the new order: ${bad.map((b) => `${b.sys_id} wanted ${b.order}, stored ${b.stored}`).join('; ')}`);
      } else {
        setNotice(`Reordered — ${res.variables.length} variables renumbered from 100 in steps of 100.`);
      }
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const save = async (sysId, form) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api.patch(`/catalog/variables/${sysId}`, {
        question_text: form.question_text,
        order: String(form.order),
        mandatory: String(form.mandatory),
        help_text: form.help_text,
        default_value: form.default_value,
      });
      setEditing(null);
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (v) => {
    const ok = await confirmDestructive({
      action: 'Delete variable',
      subject: disp(v, 'question_text') || disp(v, 'name'),
      sysId: val(v, 'sys_id'),
      detail: CONSEQUENCE.variable,
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/catalog/variables/${val(v, 'sys_id')}`); onChanged?.();
      toast.success(`Deleted variable "${disp(v, 'name')}".`);
    } catch (e) { setError(e.message); toast.error(e.message); }
  };

  return (
    <>
      <table className="table">
        <thead><tr><th /><th>Ord</th><th>Name</th><th>Question</th><th>Type</th><th /></tr></thead>
        <tbody>
          {variables.map((v, i) => {
            const sysId = val(v, 'sys_id');
            const typeCode = Number(val(v, 'type'));
            return (
              <tr key={sysId} className={editing === sysId ? 'selected' : ''}>
                <td>
                  {!readOnly && (
                    <div className="reorder">
                      <button className="btn ghost sm" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                      <button className="btn ghost sm" disabled={i === variables.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    </div>
                  )}
                </td>
                <td className="mono">{disp(v, 'order')}</td>
                <td className="mono">{disp(v, 'name')}</td>
                <td>
                  {disp(v, 'question_text')}
                  {val(v, 'mandatory') === 'true' && <span className="badge amber" style={{ marginLeft: 6 }}>req</span>}
                </td>
                <td>{typeLabel(val(v, 'type'))}</td>
                <td>
                  {!readOnly && (
                    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => setEditing(editing === sysId ? null : sysId)}>Edit</button>
                      {CHOICE_TYPES.has(typeCode) && (
                        <button className="btn ghost sm" onClick={() => setOpenChoices(openChoices === sysId ? null : sysId)}>Choices</button>
                      )}
                      <button className="btn danger sm" onClick={() => remove(v)}>✕</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {variables.map((v) => {
        const sysId = val(v, 'sys_id');
        if (editing !== sysId && openChoices !== sysId) return null;
        return (
          <div key={sysId} className="variable-panel">
            <div className="card-title" style={{ marginBottom: 8 }}>{disp(v, 'question_text') || disp(v, 'name')}</div>
            {editing === sysId && (
              <EditForm v={v} busy={busy} onCancel={() => setEditing(null)} onSave={(form) => save(sysId, form)} />
            )}
            {openChoices === sysId && <ChoiceEditor variableId={sysId} onChanged={onChanged} />}
          </div>
        );
      })}

      {notice && <p className="ok-text">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
    </>
  );
}
