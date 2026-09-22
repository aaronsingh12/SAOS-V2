import { useEffect, useState } from 'react';
import { api, sse } from '../api.js';
import { confirmDestructive, CONSEQUENCE } from './confirm.js';
import { SkeletonLines, LoadingRegion, EmptyState } from './states.jsx';

/**
 * Catalog UI policy builder, scoped to one item.
 *
 * Choice-aware by construction: the value control is a dropdown of the
 * variable's REAL choices wherever the variable has any, so the common way to
 * write a condition that can never be true — comparing a select box against a
 * display label instead of its stored value — is not reachable from this form.
 * Free text is only offered where the variable genuinely has no closed set.
 */

const stateLabel = { ignore: 'leave alone', true: 'yes', false: 'no' };

function VariablePicker({ variables, value, onChange, placeholder }) {
  return (
    <select className="select" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {variables.map((v) => (
        <option key={v.sys_id} value={v.sys_id}>
          {v.question_text} · {v.name}
        </option>
      ))}
    </select>
  );
}

/** One WHEN row. The value control follows the chosen variable's own type. */
function ConditionRow({ variables, operators, row, onChange, onRemove, first }) {
  const v = variables.find((x) => x.sys_id === row.variable);
  const op = operators.find((o) => o.op === row.operator) || operators[0];
  return (
    <div className="policy-row">
      {!first && (
        <select className="select policy-join" value={row.join || 'AND'} onChange={(e) => onChange({ ...row, join: e.target.value })}>
          <option value="AND">and</option>
          <option value="OR">or</option>
        </select>
      )}
      {first && <span className="policy-join policy-when">when</span>}
      <VariablePicker variables={variables} value={row.variable} onChange={(id) => onChange({ ...row, variable: id, value: '' })} placeholder="pick a variable…" />
      <select className="select policy-op" value={row.operator} onChange={(e) => onChange({ ...row, operator: e.target.value })}>
        {operators.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {op.takesValue !== false && (
        v?.choices?.length
          ? (
            <select className="select" value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })}>
              <option value="">pick a value…</option>
              {v.choices.map((c) => (
                <option key={c.value} value={c.value}>{c.text} ({c.value})</option>
              ))}
            </select>
          )
          : <input className="input mono" placeholder="value" value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} />
      )}
      <button className="btn ghost sm" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

/** One THEN row. */
function ActionRow({ variables, states, row, onChange, onRemove }) {
  return (
    <div className="policy-row">
      <span className="policy-join">then</span>
      <VariablePicker variables={variables} value={row.variable} onChange={(id) => onChange({ ...row, variable: id })} placeholder="pick a variable…" />
      {['visible', 'mandatory', 'disabled'].map((field) => (
        <label key={field} className="policy-state">
          <span>{field === 'disabled' ? 'read-only' : field}</span>
          <select className="select" value={row[field]} onChange={(e) => onChange({ ...row, [field]: e.target.value })}>
            {states.map((s) => <option key={s.value} value={s.value}>{stateLabel[s.value] || s.label}</option>)}
          </select>
        </label>
      ))}
      <button className="btn ghost sm" onClick={onRemove} aria-label="Remove action">✕</button>
    </div>
  );
}

const emptyCondition = () => ({ variable: '', operator: '=', value: '', join: 'AND' });
const emptyAction = () => ({ variable: '', visible: 'ignore', mandatory: 'ignore', disabled: 'ignore' });

export default function PolicyBuilder({ catItemId, meta }) {
  const [data, setData] = useState(null);          // { variables, policies }
  const [draft, setDraft] = useState(null);
  const [check, setCheck] = useState(null);
  const [run, setRun] = useState(null);            // { events, result }
  const [error, setError] = useState('');

  const operators = meta.conditionOperators || [{ op: '=', label: 'is', takesValue: true }];
  const states = meta.actionStates || [{ value: 'ignore', label: 'Leave alone' }, { value: 'true', label: 'True' }, { value: 'false', label: 'False' }];

  const load = () => {
    setError('');
    api.get(`/catalog/items/${catItemId}/policies`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); setDraft(null); setRun(null); setCheck(null); /* eslint-disable-next-line */ }, [catItemId]);

  const startDraft = () => {
    setCheck(null); setRun(null);
    setDraft({ short_description: '', conditions: [emptyCondition()], actions: [emptyAction()], reverse_if_false: true });
  };

  const payload = () => ({
    catalog_item: catItemId,
    short_description: draft.short_description,
    conditions: draft.conditions.filter((c) => c.variable),
    actions: draft.actions.filter((a) => a.variable),
    reverse_if_false: draft.reverse_if_false,
  });

  const validate = async () => {
    setError('');
    try { setCheck(await api.post('/catalog/policies/validate', payload())); }
    catch (e) { setError(e.message); }
  };

  const stream = async (path, body, method) => {
    setRun({ events: [], result: null });
    setError('');
    try {
      await sse(path, body, (ev) => {
        setRun((r) => (ev.type === 'done'
          ? { ...r, result: ev.result }
          : ev.type === 'error'
            ? { ...r, result: { ok: false, message: ev.message, detail: ev.detail } }
            : { ...r, events: [...r.events, ev] }));
      }, method);
    } catch (e) { setError(e.message); }
    load();
  };

  const create = async () => {
    await stream('/catalog/policies', payload());
    setDraft(null);
  };

  const removePolicy = async (p) => {
    const ok = await confirmDestructive({
      action: 'Delete UI policy', subject: p.short_description, sysId: p.sys_id, detail: CONSEQUENCE.policy,
    });
    if (!ok) return;
    await stream(`/catalog/policies/${p.sys_id}`, null, 'DELETE');
  };

  if (error && !data) return <p className="error-text">{error}</p>;
  if (!data) return <><SkeletonLines lines={3} /><LoadingRegion label="Loading UI policies" /></>;

  const variables = data.variables || [];

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="spread">
        <div className="card-title" style={{ marginBottom: 0 }}>UI policies · {data.policies.length}</div>
        <button className="btn primary sm" onClick={draft ? () => setDraft(null) : startDraft} disabled={variables.length < 2}>
          {draft ? 'Cancel' : 'New policy'}
        </button>
      </div>

      {variables.length < 2 && (
        <div className="note">A policy needs at least two variables — one to test, one to change.</div>
      )}

      {data.policies.map((p) => (
        <div key={p.sys_id} className="policy-card">
          <div className="spread">
            <div>
              <b>{p.short_description}</b>
              {!p.active && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}
              {p.managed
                ? <span className="badge green" style={{ marginLeft: 6 }}>SAOS</span>
                : <span className="badge" style={{ marginLeft: 6 }} title="No Fluent source — read-only here">platform</span>}
            </div>
            {p.managed && <button className="btn danger sm" onClick={() => removePolicy(p)}>Delete</button>}
          </div>
          <div className="policy-readout">
            <span className="policy-when">when</span>{' '}
            {p.conditions.filter((c) => c.kind === 'condition').map((c, i) => (
              <span key={i}>
                {i > 0 && <span className="policy-join"> {c.join === 'OR' ? 'or' : 'and'} </span>}
                <b>{c.variable ? c.variable.question_text : `(unknown ${c.variableId?.slice(0, 8)}…)`}</b>{' '}
                {operators.find((o) => o.op === c.op)?.label || c.op}{' '}
                <span className="mono">{c.valueLabel || c.value}</span>
              </span>
            ))}
            {p.actions.map((a) => (
              <div key={a.sys_id} className="policy-then">
                → <b>{a.variableLabel}</b>{' '}
                {['visible', 'mandatory', 'disabled'].filter((f) => a[f] !== 'ignore')
                  .map((f) => `${f === 'disabled' ? 'read-only' : f} = ${a[f]}`).join(', ') || 'no change'}
              </div>
            ))}
            {p.reverse_if_false && <div className="policy-note">reverses when the condition stops being true</div>}
          </div>
          {p.problems.map((prob, i) => <div key={i} className="note" style={{ borderLeftColor: 'var(--red)', marginTop: 8 }}>{prob}</div>)}
        </div>
      ))}
      {data.policies.length === 0 && (
        <EmptyState
          title="No UI policies on this item."
          hint={variables.length < 2
            ? 'A policy needs at least two variables — one to test, one to act on. Add another variable first.'
            : 'A policy shows, hides, requires or locks one variable based on the value of another. It is built here and installed through the SDK.'}
          actionLabel={variables.length < 2 ? null : 'New policy'}
          onAction={startDraft}
        />
      )}

      {draft && (
        <div className="policy-card">
          <div className="field">
            <label className="label">Policy name</label>
            <input className="input" placeholder="Require justification for permanent access"
              value={draft.short_description} onChange={(e) => setDraft({ ...draft, short_description: e.target.value })} />
          </div>

          {draft.conditions.map((row, i) => (
            <ConditionRow key={i} first={i === 0} variables={variables} operators={operators} row={row}
              onChange={(next) => setDraft({ ...draft, conditions: draft.conditions.map((c, j) => (j === i ? next : c)) })}
              onRemove={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })} />
          ))}
          <button className="btn ghost sm" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, emptyCondition()] })}>+ condition</button>

          <div style={{ height: 10 }} />
          {draft.actions.map((row, i) => (
            <ActionRow key={i} variables={variables} states={states} row={row}
              onChange={(next) => setDraft({ ...draft, actions: draft.actions.map((a, j) => (j === i ? next : a)) })}
              onRemove={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })} />
          ))}
          <button className="btn ghost sm" onClick={() => setDraft({ ...draft, actions: [...draft.actions, emptyAction()] })}>+ action</button>

          <label className="check" style={{ margin: '12px 0' }}>
            <input type="checkbox" checked={draft.reverse_if_false} onChange={(e) => setDraft({ ...draft, reverse_if_false: e.target.checked })} />
            Put the variables back when the condition stops being true
          </label>

          <div className="row">
            <button className="btn" onClick={validate}>Check</button>
            <button className="btn primary" onClick={create} aria-busy={Boolean(run && !run.result)} disabled={Boolean(run && !run.result) || !draft.short_description}>
              {run && !run.result ? 'Installing…' : 'Create policy'}
            </button>
          </div>
          <div className="note" style={{ marginTop: 10 }}>
            This compiles and installs through the ServiceNow SDK and takes about a minute — catalog UI policy
            <span className="mono"> actions</span> cannot be written over REST at all, so there is no faster path.
          </div>

          {check && (
            <div className="stack" style={{ marginTop: 10, gap: 8 }}>
              {check.ok && !check.warnings.length && <p className="ok-text">Every variable and value in this policy is real.</p>}
              {check.errors.map((e, i) => <div key={i} className="note" style={{ borderLeftColor: 'var(--red)' }}>{e}</div>)}
              {check.warnings.map((w, i) => <div key={i} className="note warn">{w}</div>)}
            </div>
          )}
        </div>
      )}

      {run && (
        <div className="stack" style={{ gap: 8 }}>
          {run.events.map((ev, i) => (
            <div key={i} className="system-note mono">
              {ev.type === 'policy_building' ? 'compiling offline — nothing has reached the instance yet'
                : ev.type === 'policy_tier_check' ? 'confirming the SDK targets the connected instance…'
                  : ev.type === 'policy_installing' ? 'installing the application…'
                    : JSON.stringify(ev)}
            </div>
          ))}
          {run.result && (
            <>
              <p className={run.result.ok ? 'ok-text' : 'error-text'}>{run.result.message}</p>
              {run.result.warnings?.map((w, i) => <div key={`w${i}`} className="note warn">{w}</div>)}
              {run.result.diagnostics && <pre className="policy-diagnostics">{run.result.diagnostics}</pre>}
              {run.result.detail?.errors?.map((e, i) => <div key={i} className="note" style={{ borderLeftColor: 'var(--red)' }}>{e}</div>)}
              {run.result.readback && (
                <div className="note">
                  Read back: {run.result.readback.actionsFound}/{run.result.readback.actionsRequested} actions installed,
                  {' '}{run.result.readback.actionsWithoutVariable} not attached to a variable.
                </div>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
