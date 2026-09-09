import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { LoadingRegion } from './states.jsx';

/**
 * PHASE 8 — THE EVIDENCE PANEL.
 *
 * It reads `GET /api/agent/plan/:taskId/evidence` and renders what is there.
 * There is no second evidence store, no client-side recomputation and no
 * client-side status: every value below is printed from the server projection,
 * because a UI that derived its own verdict would be a second opinion competing
 * with the durable record.
 *
 * WHY FIVE SEPARATE COLUMNS RATHER THAN A TICK OR A CROSS. The whole point of
 * Phase 5 is that these are different questions with different answers:
 *
 *   EXECUTION     did the call happen?
 *   VERIFICATION  did the instance actually end up in the intended state?
 *   APPROVAL      who authorised it, and does that authorisation still apply?
 *   RECOVERY      did anything fail, and what was decided about it?
 *   EVIDENCE      how much of this is proven and how much is inferred?
 *
 * A run can be fully executed and entirely unverified. It can be verified and
 * still carry an uncertainty. Collapsing that into one success light is exactly
 * the lie this project exists to avoid, so the panel never does it — the header
 * shows the server's own final status, and the five sections stay apart.
 */

/* The vocabulary the server uses, mapped to the badge colours already in the
 * stylesheet. Anything unrecognised gets the neutral badge rather than a guess. */
const FINAL_TONE = {
  VERIFIED: 'green',
  PARTIALLY_VERIFIED: 'amber',
  UNVERIFIED: 'amber',
  FAILED: 'red',
  CANCELLED: '',
  BLOCKED: 'red',
};

const VERIFY_TONE = {
  applied: 'green',
  'self-verified': 'amber',
  transformed: 'amber',
  partial: 'amber',
  'no-op': 'red',
  unverified: '',
  // A strategy was declared and has not run yet. Neutral, and distinct from
  // `unverified`, which means it ran and proved nothing.
  pending: 'blue',
  none: '',
};

/* Keyed on the server's `execution_status`. Deliberately NOT shared with the
   verification tones below: they answer different questions and a shared map
   would invite treating them as one. */
const STEP_TONE = {
  completed: 'green',
  failed: 'red',
  cancelled: '',
  skipped: '',
  pending: '',
  ready: '',
  executing: 'blue',
  verifying: 'blue',
  awaiting_approval: 'amber',
};

/**
 * The recovery outcome vocabulary Phase 8 asked to be distinguishable at a
 * glance. Derived from the server's own fields — never recomputed from
 * execution, which is how "it ran again" turns into "it worked".
 */
function recoveryLabels(ev) {
  const out = [];
  const rec = ev.recovery ?? {};
  if (rec.recoveredSteps > 0) out.push(['RECOVERED', 'green']);
  if (rec.unrecoveredSteps > 0) out.push(['UNRECOVERED', 'red']);
  if ((ev.uncertainties ?? []).some((u) => u.kind === 'repeated_mutation')) out.push(['REPEATED_MUTATION', 'amber']);
  if (rec.replanRequired) out.push(['REPLAN_REQUIRED', 'amber']);
  if (ev.final?.status === 'BLOCKED') out.push(['BLOCKED', 'red']);
  if (ev.final?.status === 'CANCELLED') out.push(['CANCELLED', '']);
  return out;
}

const Field = ({ label, children }) => (
  <div className="ev-field">
    <span className="ev-label">{label}</span>
    <span className="ev-value">{children}</span>
  </div>
);

const dash = (v) => (v === null || v === undefined || v === '' ? <span className="muted">—</span> : v);

export default function EvidencePanel({ taskId, onClose }) {
  const [ev, setEv] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openStep, setOpenStep] = useState(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    setBusy(true);
    setErr(null);
    try {
      // `api` is an object of verbs ({ get, post, patch, del }), not a callable.
      // Calling it directly threw TypeError on every load, so this panel could
      // never show evidence at all — the fetch failed before the request left
      // the browser, and the catch below reported it as "evidence could not be
      // loaded", which reads exactly like a task that has none.
      setEv(await api.get(`/agent/plan/${encodeURIComponent(taskId)}/evidence`));
    } catch (e) {
      // A task that does not exist is a real answer, not an empty panel that
      // reads as "nothing happened".
      setErr(e.message || 'The evidence could not be loaded.');
      setEv(null);
    } finally {
      setBusy(false);
    }
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  if (!taskId) return null;

  return (
    <section className="evidence-panel" aria-label="Evidence">
      <div className="spread ev-head">
        <div className="row">
          <b>Evidence</b>
          {ev && (
            <span className={`badge ${FINAL_TONE[ev.final?.status] ?? ''}`} title={ev.final?.reason || ''}>
              {ev.final?.status ?? 'unknown'}
            </span>
          )}
          {ev && recoveryLabels(ev).map(([text, tone]) => (
            <span key={text} className={`badge ${tone}`}>{text}</span>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn ghost sm" onClick={load} disabled={busy}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
          {onClose && <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>}
        </div>
      </div>

      {err && <div className="ev-error">{err}</div>}
      {busy && !ev && <LoadingRegion label="Reading the durable record" />}

      {ev && (
        <>
          {/* ---- the request and the plan ---- */}
          <div className="ev-block">
            <Field label="Goal">{dash(ev.plan?.goal ?? ev.task?.goal)}</Field>
            <Field label="Asked for">{dash(ev.request?.text)}</Field>
            <Field label="Plan status">
              {dash(ev.plan?.state ?? ev.task?.state)}
              {ev.plan?.stepCount != null && <span className="muted"> · {ev.plan.stepCount} step(s)</span>}
            </Field>
            {ev.plan?.capabilities?.length > 0 && (
              <Field label="Capabilities">{ev.plan.capabilities.join(', ')}</Field>
            )}
            {ev.plan?.mechanisms?.length > 0 && (
              <Field label="Mechanisms">{ev.plan.mechanisms.join(', ')}</Field>
            )}
          </div>

          {/* ---- APPROVAL, on its own ---- */}
          <div className="ev-block">
            <div className="ev-section">APPROVAL</div>
            <Field label="State">
              <span className={`badge ${ev.approval?.valid === false ? 'red' : ''}`}>
                {dash(ev.approval?.status)}
              </span>
            </Field>
            <Field label="Binding">
              {ev.approval?.valid === true && 'the approved plan is the plan that ran'}
              {ev.approval?.valid === false && (
                <span className="ev-bad">the plan changed after it was approved — execution was refused</span>
              )}
              {ev.approval?.valid == null && <span className="muted">not applicable</span>}
            </Field>
            {ev.approval?.source && <Field label="Provenance">{ev.approval.source}</Field>}
            {ev.approval?.note && <Field label="Note">{ev.approval.note}</Field>}
          </div>

          {/* ---- the steps: EXECUTION and VERIFICATION side by side ---- */}
          <div className="ev-block">
            <div className="ev-section">EXECUTION &amp; VERIFICATION</div>
            {(ev.steps ?? []).length === 0 && <div className="muted">No steps were recorded.</div>}
            <ol className="ev-steps">
              {(ev.steps ?? []).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="ev-step-head"
                    onClick={() => setOpenStep(openStep === s.id ? null : s.id)}
                    aria-expanded={openStep === s.id}
                  >
                    <span className="ev-step-id mono">{s.id}</span>
                    <span className="ev-step-op">{s.operation || s.tool || s.kind}</span>
                    <span
                      className={`badge ${STEP_TONE[s.execution_status] ?? ''}`}
                      title="Whether the call happened and returned."
                    >
                      exec: {s.execution_status}
                    </span>
                    <span
                      className={`badge ${VERIFY_TONE[s.verification_status] ?? ''}`}
                      title="Whether the effect was proven. A step can be executed and unverified."
                    >
                      verify: {s.verification_status ?? 'none'}
                    </span>
                  </button>

                  {openStep === s.id && (
                    <div className="ev-step-body">
                      <Field label="Capability">{dash(s.capability)}</Field>
                      <Field label="Mechanism">{dash(s.mechanism)}</Field>
                      <Field label="Tool">{dash(s.tool)}</Field>
                      <Field label="Executed">{s.executed ? 'yes' : 'no'}</Field>
                      <Field label="Expected">
                        {(s.expectedEffects ?? []).length
                          ? <ul className="ev-list">{s.expectedEffects.map((e, i) => <li key={i}>{e}</li>)}</ul>
                          : <span className="muted">nothing was promised</span>}
                      </Field>
                      <Field label="Actual">
                        {s.result
                          ? <pre className="ev-pre">{typeof s.result === 'string' ? s.result : JSON.stringify(s.result, null, 2)}</pre>
                          : <span className="muted">no result recorded</span>}
                      </Field>
                      {s.verification && (
                        <Field label="Verification">
                          <div>
                            {s.verification.strategy && <span className="muted">{s.verification.strategy} · </span>}
                            {s.verification.note || s.verification.status}
                          </div>
                          {(s.verification.assertions ?? []).length > 0 && (
                            <ul className="ev-list">
                              {s.verification.assertions.map((a, i) => (
                                <li key={i} className={a.passed === false ? 'ev-bad' : undefined}>
                                  {a.claim ?? a.text ?? JSON.stringify(a)}
                                  {a.passed === false && ' — did not hold'}
                                </li>
                              ))}
                            </ul>
                          )}
                        </Field>
                      )}
                      {s.failureReason && <Field label="Failure"><span className="ev-bad">{s.failureReason}</span></Field>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>

          {/* ---- what actually changed on the instance ---- */}
          {(ev.changes ?? []).length > 0 && (
            <div className="ev-block">
              <div className="ev-section">CHANGES</div>
              <table className="ev-table">
                <thead>
                  <tr><th>table</th><th>record</th><th>fields</th><th>verification</th><th>proven?</th></tr>
                </thead>
                <tbody>
                  {ev.changes.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.table}</td>
                      <td className="mono" title={c.sys_id}>{c.number || String(c.sys_id ?? '').slice(0, 8)}</td>
                      <td>
                        {(c.changed_fields ?? []).join(', ') || <span className="muted">none</span>}
                        {(c.dropped_fields ?? []).length > 0 && (
                          <div className="ev-bad">dropped: {c.dropped_fields.join(', ')}</div>
                        )}
                        {(c.transformed_fields ?? []).length > 0 && (
                          <div className="ev-warn">stored differently: {c.transformed_fields.join(', ')}</div>
                        )}
                      </td>
                      <td><span className={`badge ${VERIFY_TONE[c.verification_status] ?? ''}`}>{c.verification_status}</span></td>
                      <td>
                        {/* PHASE 8 — exact means the ledger row names this task.
                            Correlated means it was matched by session and time,
                            and a concurrent plan could have produced it. */}
                        <span className={`badge ${c.exact ? 'green' : 'amber'}`} title={c.exact
                          ? 'This row names this task, so it cannot belong to another plan.'
                          : 'Matched by session and time window — a concurrent plan could have produced this.'}>
                          {c.exact ? 'exact' : 'correlated'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- RECOVERY LINEAGE ---- */}
          {ev.recovery?.attempted && (
            <div className="ev-block">
              <div className="ev-section">RECOVERY</div>
              {ev.recovery.steps.map((r) => (
                <div key={r.step} className="ev-recovery">
                  <div className="row">
                    <span className="mono">{r.step}</span>
                    <span className="muted">{r.operation}</span>
                    <span className={`badge ${r.recovered ? 'green' : 'red'}`}>
                      {r.recovered ? 'RECOVERED' : 'UNRECOVERED'}
                    </span>
                    <span className="badge">final: {r.finalState}</span>
                  </div>
                  {/* Attempt 1 -> classification -> decision -> Attempt 2 -> outcome */}
                  <ol className="ev-lineage">
                    <li>
                      <span className="ev-lineage-n">Attempt 1</span>
                      <span className="ev-bad">failed</span>
                    </li>
                    {r.attempts.map((a, i) => (
                      <li key={i}>
                        <span className="ev-lineage-n">classified</span>
                        <span className="badge">{a.failure ?? 'unclassified'}</span>
                        <span className="ev-lineage-n">decided</span>
                        <span className={`badge ${a.decision === 'RETRY' ? 'blue' : 'amber'}`}>{a.decision}</span>
                        {a.idempotency && <span className="badge" title="Only READ_ONLY and IDEMPOTENT may be repeated automatically.">{a.idempotency}</span>}
                        <div className="ev-lineage-why">{a.reason}</div>
                        {a.decision === 'RETRY' && (
                          <div className="ev-lineage-next">
                            <span className="ev-lineage-n">Attempt {(a.attempt ?? 1) + 1}</span>
                            <span className={`badge ${a.outcome === 'RECOVERED' ? 'green' : 'red'}`}>{a.outcome}</span>
                            {a.result && <span className="muted"> — {a.result}</span>}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              <div className="muted ev-note">{ev.recovery.note}</div>
            </div>
          )}

          {/* ---- UNCERTAINTIES ---- */}
          {(ev.uncertainties ?? []).length > 0 && (
            <div className="ev-block">
              <div className="ev-section">UNCERTAINTIES</div>
              <ul className="ev-list">
                {ev.uncertainties.map((u, i) => (
                  <li key={i}>
                    <span className="badge amber">{u.kind}</span> {u.note}
                    {u.step && <span className="muted"> ({u.step})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- how much of this is proven ---- */}
          <div className="ev-block">
            <div className="ev-section">EVIDENCE QUALITY</div>
            <Field label="Correlation">{ev.audit?.correlation}</Field>
            <Field label="Exact">
              <span className={`badge ${ev.audit?.exact ? 'green' : 'amber'}`}>
                {ev.audit?.exact ? 'every row names this task' : 'some rows matched by window'}
              </span>
            </Field>
            {ev.audit?.counts && (
              <Field label="Counts">
                <span className="mono">
                  changes {ev.audit.counts.changesExact}/{ev.audit.counts.changes} exact ·
                  {' '}tool events {ev.audit.counts.toolEventsExact}/{ev.audit.counts.toolEvents} exact
                </span>
              </Field>
            )}
            <Field label="Verification coverage">
              {ev.verification?.promised
                ? `${ev.verification.verified}/${ev.verification.promised} promised effect(s) verified`
                : <span className="muted">nothing was promised</span>}
            </Field>
            <div className="muted ev-note">{ev.audit?.note}</div>
          </div>
        </>
      )}
    </section>
  );
}
