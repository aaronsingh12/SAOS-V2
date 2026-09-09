import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { confirmAction, confirmDestructive } from './confirm.js';
import { toast } from './toast.js';
import {
  previewName, validateCreateForm, toCreateSpec, describeModify, describeDropGate,
} from './tableForms.js';

/**
 * The write forms for the Tables pane (Phase T2).
 *
 * Every submit here posts to ONE endpoint, /api/dba/action, which hands the
 * named tool to the agent loop's own `executeTool` — the same approval gate the
 * chat card resolves. Nothing in this file performs a write, decides whether
 * one is allowed, or reimplements a rule: the form's job is to make an invalid
 * request unrepresentable, and the tool's job is to be the only thing that can
 * change the instance.
 *
 * The verification shown after a write is the TOOL'S read-back, labelled with
 * where it came from. A "submitted successfully" that trusts the writer is the
 * thing this whole project exists to not do.
 */

/**
 * One POST, one shape, one place the result is interpreted.
 *
 * ── WHY THIS POLLS ───────────────────────────────────────────────────────────
 *
 * A create, an add or a modify installs the WHOLE application and takes six to
 * eight minutes. MEASURED: the first live create through this endpoint returned
 * UND_ERR_HEADERS_TIMEOUT to the caller at five minutes while the install went
 * on to succeed — the §44 shape one layer up, where the client gives up on a
 * request the server completes and the user is told a failure that did not
 * happen. So the server starts a job and this polls it.
 *
 * The server waits a few seconds before handing out a job id, so a fast answer
 * arrives in one round trip. That is a courtesy, not a guarantee: a drop
 * refusal was MEASURED at 34 seconds, because the gate builds an impact report
 * before it can say what is missing. Anything slower simply polls.
 */
async function runAction(tool, input, onProgress = () => {}) {
  const started = await api.post('/dba/action', { tool, input });
  if (started.status !== 'running') return started;

  onProgress(started.message);
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    let poll;
    try {
      poll = await api.get(`/dba/action/${started.jobId}`);
    } catch {
      // A lost job is NOT a failed write. The instance is the authority.
      return {
        ok: false,
        message: 'The job could not be polled. This does NOT mean the change failed — read the table back rather '
          + 'than retrying, because a retry would re-apply whatever already landed.',
      };
    }
    if (poll.status === 'done') return poll;
    if (poll.status === 'unknown') return { ok: false, message: poll.message };
  }
}

function Problems({ problems }) {
  if (!problems?.length) return null;
  return (
    <div className="note warn" style={{ marginTop: 8 }}>
      <b>{problems.length} thing(s) to fix</b>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
        {problems.map((p, i) => <li key={i}>{p.message}</li>)}
      </ul>
    </div>
  );
}

/**
 * The result of a write, reported as the tool reported it.
 *
 * `ok` here is the READ-BACK's verdict, not the request's status code — a tool
 * can return 200 having refused, and a red install with a green read-back is a
 * success. Both are rendered as what they are.
 */
export function ActionResult({ result }) {
  if (!result) return null;
  const r = result.result ?? {};
  const good = result.ok === true;
  return (
    <div className={`note${good ? '' : ' warn'}`} style={{ marginTop: 10 }}>
      <b>{good ? 'Verified on the instance' : `Not applied — ${r.stage || 'refused'}`}</b>
      {result.verifiedBy && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>Verified by: {result.verifiedBy}</p>
      )}
      {r.corrections?.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12.5 }}>
          <b>The spec was normalized before building:</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {r.corrections.map((c, i) => <li key={i}><span className="mono">{c.what}</span>: {String(c.from)} → {String(c.to)} — {c.why}</li>)}
          </ul>
        </div>
      )}
      {r.errors?.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>{r.errors.map((x, i) => <li key={i}>{x}</li>)}</ul>
      )}
      {r.statement && <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{r.statement}</p>}
      {r.doNotWorkAround && <p style={{ fontSize: 12, color: 'var(--amber)', margin: '6px 0 0' }}>{r.doNotWorkAround}</p>}
      {result.message && !r.stage && <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{result.message}</p>}
      {r.verification?.checked?.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
          {r.verification.checked.map((c, i) => (
            <li key={i}><span className="mono">{c.option}</span>: asked {JSON.stringify(c.requested)}, instance says {JSON.stringify(c.onInstance)} {c.agrees ? '✓' : '✗'}</li>
          ))}
        </ul>
      )}
      {r.wholeAppNote && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>{r.wholeAppNote}</p>}
    </div>
  );
}

/* ── T2.1 create table ────────────────────────────────────────────────────── */

const BLANK_FIELD = { name: '', type: 'string', label: '', maxLength: '', mandatory: false, reference: '', choices: '' };

export function CreateTableForm({ constraints, onDone, onCancel }) {
  const [form, setForm] = useState({ name: '', label: '', extendsTable: '', display: '', fields: [{ ...BLANK_FIELD }] });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);

  const v = useMemo(() => validateCreateForm(form, constraints), [form, constraints]);
  const preview = previewName(form.name, constraints);
  const types = constraints?.columnTypes ?? [];
  const cap = constraints?.maxNameLength ?? 30;

  const setField = (i, patch) => setForm((f) => ({
    ...f, fields: f.fields.map((x, n) => (n === i ? { ...x, ...patch } : x)),
  }));

  const submit = async () => {
    // The form already made this unsubmittable; this is belt and braces.
    if (!v.ok) return;
    const spec = toCreateSpec(form, constraints);
    const go = await confirmAction({
      action: 'Create table',
      subject: spec.name,
      detail: `${spec.fields.length} column(s). This installs the ENTIRE application, not just this table, and the `
        + 'result is read back off the instance before it is reported.',
      confirmLabel: 'Create',
    });
    if (!go) return;
    setBusy(true); setResult(null);
    try {
      const r = await runAction('dba_create_table', { spec }, setProgress);
      setResult(r);
      if (r.ok) { toast.success(`${spec.name} created and verified.`); onDone?.(spec.name); }
      else toast.error(`${spec.name} was not created.`);
    } catch (e) {
      setResult({ ok: false, message: e.message });
      toast.error(e.message);
    } finally { setBusy(false); setProgress(''); }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-title">Create table</div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
        The scope prefix, the {cap}-character cap and the column types are the instance's own rules, read live —
        an invalid spec cannot be submitted from here.
      </p>

      <div className="grid2">
        <div className="field">
          <label className="label">Name</label>
          <input className="input mono" value={form.name} placeholder="emp_assets"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <p style={{ fontSize: 11.5, color: preview.name.length > cap ? 'var(--red)' : 'var(--muted)', marginTop: 4 }}>
            {preview.name || constraints?.namePrefix}{' '}
            <span>({preview.name.length}/{cap})</span>
          </p>
        </div>
        <div className="field">
          <label className="label">Label</label>
          <input className="input" value={form.label} placeholder="Employee Assets"
            onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label className="label">Extends <span style={{ color: 'var(--muted)' }}>· optional</span></label>
          <input className="input mono" value={form.extendsTable} placeholder="none — standalone"
            onChange={(e) => setForm({ ...form, extendsTable: e.target.value.trim() })} />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
            Leave empty unless you mean it. Extending inherits the parent's columns, display value and business rules.
          </p>
        </div>
        <div className="field">
          <label className="label">Display field <span style={{ color: 'var(--muted)' }}>· optional</span></label>
          <input className="input mono" value={form.display}
            onChange={(e) => setForm({ ...form, display: e.target.value.trim() })} />
        </div>
      </div>

      <div className="card-title" style={{ marginTop: 10 }}>Columns</div>
      {form.fields.map((f, i) => (
        <div key={i} className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
          <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
            <label className="label">name</label>
            <input className="input mono" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 0 130px', margin: 0 }}>
            <label className="label">type</label>
            <select className="select" value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
            <label className="label">label</label>
            <input className="input" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
          </div>
          {f.type === 'string' && (
            <div className="field" style={{ flex: '0 0 90px', margin: 0 }}>
              <label className="label">max</label>
              <input className="input" value={f.maxLength} onChange={(e) => setField(i, { maxLength: e.target.value })} />
            </div>
          )}
          {f.type === 'reference' && (
            <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
              <label className="label">references</label>
              <input className="input mono" value={f.reference} placeholder="sys_user"
                onChange={(e) => setField(i, { reference: e.target.value })} />
            </div>
          )}
          {f.type === 'choice' && (
            <div className="field" style={{ flex: '1 1 200px', margin: 0 }}>
              <label className="label">choices</label>
              <input className="input" value={f.choices} placeholder="0=Laptop, 1=Desktop"
                onChange={(e) => setField(i, { choices: e.target.value })} />
            </div>
          )}
          <button className="btn sm" onClick={() => setForm((x) => ({ ...x, fields: x.fields.filter((_, n) => n !== i) }))}
            disabled={form.fields.length === 1}>remove</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setForm((f) => ({ ...f, fields: [...f.fields, { ...BLANK_FIELD }] }))}>
        Add column
      </button>

      <Problems problems={v.problems} />

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={submit} disabled={!v.ok || busy} aria-busy={busy}
          title={v.ok ? 'Goes through the approval gate and is read back' : 'Fix the problems above first'}>
          {busy ? 'Building and installing…' : 'Create table'}
        </button>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {busy && progress && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{progress}</p>}
      <ActionResult result={result} />
    </div>
  );
}

/* ── T2.2 add field ───────────────────────────────────────────────────────── */

export function AddFieldForm({ table, constraints, onDone, onCancel }) {
  const [f, setF] = useState({ ...BLANK_FIELD });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const types = constraints?.columnTypes ?? [];

  const problems = [];
  if (!/^[a-z][a-z0-9_]*[a-z0-9]?$/.test(String(f.name || '').trim().toLowerCase())) {
    problems.push({ message: 'A valid lowercase column name is required.' });
  }
  if (!types.includes(f.type)) problems.push({ message: `"${f.type}" is not a column type this layer can emit.` });
  if (f.type === 'reference' && !f.reference.trim()) problems.push({ message: 'A reference column must name its target table.' });
  if (f.type === 'choice' && !f.choices.trim()) problems.push({ message: 'A choice column must supply choices.' });

  const submit = async () => {
    if (problems.length) return;
    const go = await confirmAction({
      action: 'Add column',
      subject: `${table}.${f.name}`,
      detail: 'Additive and safe. It is added by editing the Fluent source and reinstalling — never by writing to '
        + 'sys_dictionary. REMOVING it later is drop_column, which is irreversible and gated.',
      confirmLabel: 'Add column',
    });
    if (!go) return;
    setBusy(true); setResult(null);
    try {
      const field = {
        name: f.name.trim().toLowerCase(), type: f.type, label: f.label || f.name,
        ...(f.maxLength ? { maxLength: Number(f.maxLength) } : {}),
        ...(f.type === 'reference' ? { reference: f.reference.trim() } : {}),
        ...(f.type === 'choice' ? { choices: f.choices } : {}),
      };
      const r = await runAction('dba_add_field', { table, field }, setProgress);
      setResult(r);
      if (r.ok) { toast.success(`${table}.${field.name} added and verified.`); onDone?.(); }
      else toast.error('The column was not added.');
    } catch (e) { setResult({ ok: false, message: e.message }); toast.error(e.message); }
    finally { setBusy(false); setProgress(''); }
  };

  return (
    <div className="note" style={{ marginTop: 10 }}>
      <b>Add a column to <span className="mono">{table}</span></b>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
        <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
          <label className="label">name</label>
          <input className="input mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field" style={{ flex: '0 0 130px', margin: 0 }}>
          <label className="label">type</label>
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
          <label className="label">label</label>
          <input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </div>
        {f.type === 'string' && (
          <div className="field" style={{ flex: '0 0 90px', margin: 0 }}>
            <label className="label">max</label>
            <input className="input" value={f.maxLength} onChange={(e) => setF({ ...f, maxLength: e.target.value })} />
          </div>
        )}
        {f.type === 'reference' && (
          <div className="field" style={{ flex: '1 1 140px', margin: 0 }}>
            <label className="label">references</label>
            <input className="input mono" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </div>
        )}
        {f.type === 'choice' && (
          <div className="field" style={{ flex: '1 1 200px', margin: 0 }}>
            <label className="label">choices</label>
            <input className="input" value={f.choices} placeholder="0=Laptop, 1=Desktop"
              onChange={(e) => setF({ ...f, choices: e.target.value })} />
          </div>
        )}
      </div>
      <Problems problems={problems} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary sm" onClick={submit} disabled={problems.length > 0 || busy} aria-busy={busy}>
          {busy ? 'Installing…' : 'Add column'}
        </button>
        <button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {busy && progress && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{progress}</p>}
      <ActionResult result={result} />
    </div>
  );
}

/* ── T2.2 modify field (safe half) / T2.3 the gated half ──────────────────── */

export function ModifyFieldForm({ table, field, onDone, onCancel }) {
  const [req, setReq] = useState({ label: field.label ?? '', hint: field.hint ?? '', help: field.help ?? '', default: field.defaultValue ?? '', maxLength: field.maxLength ?? '' });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);

  const m = useMemo(() => describeModify(field, req), [field, req]);

  const submit = async () => {
    if (!m.submittable) return;
    const go = await confirmAction({
      action: 'Change column',
      subject: `${table}.${field.element}`,
      detail: `${m.safe.map((s) => `${s.option}: ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}`).join('; ')}. `
        + 'Every one of these can be set back with another change — nothing is destroyed.',
      confirmLabel: 'Apply',
    });
    if (!go) return;
    setBusy(true); setResult(null);
    try {
      const input = { table, field: field.element };
      for (const s of m.safe) {
        if (s.option === 'maxLength') input.max_length = Number(s.to);
        else input[s.option] = s.to;
      }
      const r = await runAction('dba_modify_field', input, setProgress);
      setResult(r);
      if (r.ok) { toast.success(`${table}.${field.element} changed and verified.`); onDone?.(); }
      else toast.error('The change was not applied.');
    } catch (e) { setResult({ ok: false, message: e.message }); toast.error(e.message); }
    finally { setBusy(false); setProgress(''); }
  };

  return (
    <div className="note" style={{ marginTop: 10 }}>
      <b>Change <span className="mono">{table}.{field.element}</span></b>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
        Label, hint, help, default and WIDENING are safe and reversible. Narrowing and changing the type are
        irreversible operations with their own gate — they cannot be applied from here.
      </p>
      <div className="grid2">
        <div className="field"><label className="label">label</label>
          <input className="input" value={req.label} onChange={(e) => setReq({ ...req, label: e.target.value })} /></div>
        <div className="field"><label className="label">hint</label>
          <input className="input" value={req.hint} onChange={(e) => setReq({ ...req, hint: e.target.value })} /></div>
        <div className="field"><label className="label">help</label>
          <input className="input" value={req.help} onChange={(e) => setReq({ ...req, help: e.target.value })} /></div>
        <div className="field"><label className="label">default</label>
          <input className="input" value={req.default} onChange={(e) => setReq({ ...req, default: e.target.value })} /></div>
        {field.maxLength != null && (
          <div className="field"><label className="label">maxLength (widen only, now {field.maxLength})</label>
            <input className="input" value={req.maxLength} onChange={(e) => setReq({ ...req, maxLength: e.target.value })} /></div>
        )}
      </div>

      {m.gated.length > 0 && (
        <div className="note warn" style={{ marginTop: 8 }}>
          <b>This is a gated, irreversible change</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            {m.gated.map((g, i) => (
              <li key={i}><span className="mono">{g.operation}</span> — {g.option} {JSON.stringify(g.from)} → {JSON.stringify(g.to)}. {g.why}</li>
            ))}
          </ul>
          <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{m.reason}</p>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary sm" onClick={submit} disabled={!m.submittable || busy} aria-busy={busy}
          title={m.submittable ? '' : (m.reason || 'Nothing to apply')}>
          {busy ? 'Installing…' : 'Apply change'}
        </button>
        <button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {busy && progress && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{progress}</p>}
      <ActionResult result={result} />
    </div>
  );
}

/* ── T2.3 remove field — the real gate, never a one-click delete ──────────── */

export function DropFieldPanel({ table, field, onDone, onCancel }) {
  const [gate, setGate] = useState(null);
  const [phrase, setPhrase] = useState('');
  const [ack, setAck] = useState(false);
  const [snapshotId, setSnapshotId] = useState(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  // Ask the gate what it wants, rather than the UI deciding what it thinks it
  // wants. The first call carries no confirmations on purpose: its refusal IS
  // the requirement list.
  useEffect(() => {
    let dead = false;
    runAction('dba_drop_field', { table, field: field.element })
      .then((r) => { if (!dead) { setResult(r); setGate(r.result?.gate ?? null); } })
      .catch((e) => { if (!dead) setResult({ ok: false, message: e.message }); });
    return () => { dead = true; };
  }, [table, field.element]);

  const g = describeDropGate(gate);

  const takeSnapshot = async () => {
    setBusy('snapshot');
    try {
      // dba_snapshot is  — a read-side capture — so it goes
      // through the read route, not the write endpoint, which refuses it.
      const r = await api.post('/dba/snapshot', { operation: 'drop_column', table, field: field.element });
      setSnapshotId(r.result?.snapshotId ?? null);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  };

  const drop = async () => {
    const go = await confirmDestructive({
      action: 'PERMANENTLY drop column',
      subject: `${table}.${field.element}`,
      detail: 'This creates no rollback context on any database engine and no delete-recovery mechanism covers '
        + 'schema. The snapshot is evidence of what was there, not a restore path.',
      confirmLabel: 'Drop it',
    });
    if (!go) return;
    setBusy('drop');
    try {
      const r = await runAction('dba_drop_field', {
        table, field: field.element, snapshot_id: snapshotId, typed_confirmation: phrase, impact_acknowledged: ack,
      });
      setResult(r); setGate(r.result?.gate ?? gate);
      if (r.ok) { toast.success(`${table}.${field.element} dropped.`); onDone?.(); }
    } catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  };

  return (
    <div className="note warn" style={{ marginTop: 10 }}>
      <b>Remove <span className="mono">{table}.{field.element}</span> — irreversible</b>
      <p style={{ fontSize: 12.5, margin: '6px 0' }}>
        {g.statement || 'Dropping a column cannot be undone. It creates no rollback context on any database engine.'}
      </p>

      <div style={{ fontSize: 12, color: 'var(--muted)' }}>The gate requires all four:</div>
      <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12.5 }}>
        {g.requirements.map((r) => (
          <li key={r.key} style={{ color: r.met ? 'var(--verdigris)' : 'inherit' }}>
            {r.met ? '✓' : '○'} <span className="mono">{r.key}</span> — {r.how}
            {r.operatorOnly && !r.met && <em> This one cannot be set from here, or by any tool.</em>}
          </li>
        ))}
      </ul>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <button className="btn sm" onClick={takeSnapshot} disabled={busy === 'snapshot' || Boolean(snapshotId)}>
          {snapshotId ? 'Snapshot taken' : busy === 'snapshot' ? 'Exporting…' : 'Take the pre-export snapshot'}
        </button>
      </div>
      {g.phrase && (
        <div className="field" style={{ marginTop: 8 }}>
          <label className="label">Type exactly: <span className="mono">{g.phrase}</span></label>
          <input className="input mono" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </div>
      )}
      <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        I have read the impact report and accept that this cannot be undone.
      </label>

      <div className="row" style={{ marginTop: 10 }}>
        {/* Deliberately NOT disabled on the client's own reading of the gate.
            The server's gate is the authority; pressing this when something is
            missing produces its refusal, which is the honest answer. */}
        <button className="btn amber sm" onClick={drop} disabled={busy === 'drop'} aria-busy={busy === 'drop'}>
          {busy === 'drop' ? 'Dropping…' : 'Drop the column'}
        </button>
        <button className="btn sm" onClick={onCancel} disabled={Boolean(busy)}>Cancel</button>
      </div>
      {busy && progress && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{progress}</p>}
      <ActionResult result={result} />
    </div>
  );
}
