import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, sse } from '../api.js';
import RecordDrawer from './RecordDrawer.jsx';
import ReferenceField from './ReferenceField.jsx';
import { SkeletonLines } from './states.jsx';
import { toast } from './toast.js';

/**
 * THE REMEDIATION REVIEW WINDOW.
 *
 * Built on `RecordDrawer` — the same editing surface Incidents, Catalog, Flows,
 * SLA, Tables and Transport already open. It is a shell that holds no record
 * logic, which is exactly why a seventh caller is the right move rather than a
 * seventh editor.
 *
 * ═══ THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE ═══
 *
 * Nothing here has happened yet. Everything above the action bar is a PROPOSAL,
 * and it says so in those words, at the top, until the moment a human clicks
 * Approve and apply. The vocabulary is deliberately flat — "Proposed changes —
 * not yet applied", then "Executing", then "Changes applied" or "Partially
 * applied" — because a reviewer skimming this needs to know which of those
 * three worlds they are in before they read anything else.
 *
 * ═══ WHY EDITING IS THE POINT, NOT A CONVENIENCE ═══
 *
 * The AI proposes a value for findings whose fix is a judgement call — who owns
 * a CI, what lifecycle stage a service is in. It says what it inferred and from
 * which field, and it is often right. It is also the kind of thing that is
 * wrong in a way only the person who runs the estate can see. So the value is
 * editable, individual changes are removable, and the edited version — not the
 * draft — is what gets approved and executed.
 *
 * Editing invalidates the approval by design: the server returns a new
 * fingerprint on every save, and approving sends the fingerprint the user was
 * actually looking at. If those disagree, nothing runs.
 */

const STATE_LABEL = {
  draft: 'Proposed changes — not yet applied',
  edited: 'Proposed changes (edited) — not yet applied',
  approved: 'Approved — starting',
  executing: 'Execution in progress',
  applied: 'Changes applied',
  partial: 'Partially completed',
  failed: 'Execution failed',
  rejected: 'Rejected — nothing was changed',
};

const STATE_TONE = {
  draft: 'warn', edited: 'warn', approved: 'ok', executing: 'ok',
  applied: 'ok', partial: 'warn', failed: 'bad', rejected: 'idle',
};

const isSettled = (s) => ['applied', 'partial', 'failed', 'rejected'].includes(s);

export default function RemediationDrawer({ open, runId, finding, onClose }) {
  const [row, setRow] = useState(null);          // the stored proposal record
  const [fingerprint, setFingerprint] = useState(null);
  const [changes, setChanges] = useState([]);    // the editable working copy
  const [userNote, setUserNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const proposal = row?.proposal ?? null;
  const status = row?.status ?? 'draft';
  const settled = isSettled(status);

  /** Generate a fresh proposal when the drawer opens on a finding. */
  const generate = useCallback(async () => {
    setBusy('generate'); setError(''); setProgress(null);
    try {
      const res = await api.post(`/health/runs/${runId}/findings/${finding.fingerprint}/proposal`);
      setRow(res.proposal);
      setFingerprint(res.fingerprint);
      setChanges(res.proposal.proposal.changes);
      setUserNote(res.proposal.proposal.userNote || '');
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }, [runId, finding]);

  useEffect(() => {
    if (!open || !finding) return;
    setRow(null); setChanges([]); setError(''); setProgress(null);
    setRejecting(false); setRejectReason('');
    generate();
  }, [open, finding, generate]);

  /* A change is "dirty" when the working copy differs from what is stored. The
     approval always sends the fingerprint the user saw, so an unsaved edit
     cannot be approved by accident — it is saved first. */
  const dirty = useMemo(() => {
    const stored = proposal?.changes ?? [];
    return changes.some((c, i) => c.proposedValue !== stored[i]?.proposedValue || c.status !== stored[i]?.status)
      || userNote !== (proposal?.userNote ?? '');
  }, [changes, userNote, proposal]);

  const executable = changes.filter(
    (c) => c.status !== 'removed' && (c.fieldKind === 'delete' || String(c.proposedValue ?? '').trim()),
  );

  const setValue = (id, value, display) => {
    setChanges((cur) => cur.map((c) => (c.id === id
      ? {
        ...c,
        proposedValue: value,
        proposedDisplay: display ?? value,
        status: c.fieldKind === 'delete' || String(value).trim() ? 'ready' : 'needs_value',
      }
      : c)));
  };

  const toggleRemoved = (id) => {
    setChanges((cur) => cur.map((c) => (c.id === id
      ? {
        ...c,
        status: c.status === 'removed'
          ? (c.fieldKind === 'delete' || String(c.proposedValue ?? '').trim() ? 'ready' : 'needs_value')
          : 'removed',
      }
      : c)));
  };

  /** Save edits and take the new fingerprint. */
  const save = async () => {
    setBusy('save'); setError('');
    try {
      const res = await api.patch(`/health/proposals/${row.id}`, {
        proposal: { changes, userNote },
      });
      setRow(res.proposal);
      setFingerprint(res.fingerprint);
      setChanges(res.proposal.proposal.changes);
      toast.success('Plan updated. Nothing has been applied.');
      return res.fingerprint;
    } catch (e) { setError(e.message); return null; }
    finally { setBusy(''); }
  };

  /**
   * Approve and apply.
   *
   * Any unsaved edit is saved FIRST, and the fingerprint that comes back is the
   * one sent. That is what makes "the agent executes what you approved" true
   * rather than hoped for: the server compares it with what it holds and
   * refuses on a mismatch.
   */
  const approve = async () => {
    const fp = dirty ? await save() : fingerprint;
    if (!fp) return;
    setBusy('approve'); setError(''); setProgress({ stage: 'starting' });
    try {
      await sse(`/health/proposals/${row.id}/approve`, { fingerprint: fp }, (evt) => {
        if (evt.type === 'plan_created') setProgress({ stage: 'plan built', steps: evt.review?.stepCount });
        else if (evt.type === 'execution_started') setProgress({ stage: 'executing', steps: evt.steps });
        else if (evt.type === 'step_started') setProgress({ stage: `applying ${evt.step ?? ''}` });
        else if (evt.type === 'execution_complete') setProgress({ stage: 'validating' });
        else if (evt.type === 'done') { setRow(evt.proposal); setProgress(null); }
        else if (evt.type === 'error') { setRow(evt.proposal ?? row); throw new Error(evt.message); }
      });
      toast.success('Execution finished — check the result below.');
    } catch (e) {
      setError(e.message);
      toast.error('The remediation did not complete.');
      try { setRow((await api.get(`/health/proposals/${row.id}`)).proposal); } catch { /* keep what we have */ }
    } finally { setBusy(''); setProgress(null); }
  };

  const reject = async () => {
    setBusy('reject'); setError('');
    try {
      const res = await api.post(`/health/proposals/${row.id}/reject`, { reason: rejectReason });
      setRow(res.proposal);
      setRejecting(false);
      toast.success('Rejected. Nothing was changed.');
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const title = finding ? `Remediation · ${finding.rule_id}` : 'Remediation';

  return (
    <RecordDrawer open={open} title={title} onClose={onClose} width={620}>
      {busy === 'generate' && <SkeletonLines lines={10} />}

      {error && <p className="error-text">{error}</p>}

      {proposal && (
        <>
          {/* THE STATE BANNER. Always first, always in these words. */}
          <div className={`rm-state tone-${STATE_TONE[status] || 'idle'}`}>
            <b>{STATE_LABEL[status] || status}</b>
            {!settled && <span>Nothing has been sent to {finding?.table ? 'your instance' : 'the instance'} yet.</span>}
          </div>

          {progress && (
            <p className="note">Execution in progress — {progress.stage}
              {progress.steps ? ` · ${progress.steps} step(s)` : ''}. Do not close this window.</p>
          )}

          {/* ── SUMMARY ─────────────────────────────────────────────── */}
          <div className="rm-sec">What the AI recommends</div>
          <p className="rm-lead">{proposal.summary}</p>

          {proposal.needsJudgement && !settled && (
            <div className="rm-judge">
              <b>This needs your judgement.</b>
              <span>{proposal.judgementNote}</span>
            </div>
          )}

          {proposal.llm?.status && proposal.llm.status !== 'complete' && (
            <p className="note">{proposal.llm.note}</p>
          )}

          {/* ── PROPOSED CHANGES — the editable part ─────────────────── */}
          <div className="rm-sec">
            Proposed changes · {executable.length} of {changes.length}
            {settled ? '' : ' (editable)'}
          </div>

          {changes.length === 0 && (
            <p className="note">
              This rule has no single-field fix, so there is nothing to apply automatically. The manual steps on the
              finding are the remedy.
            </p>
          )}

          <ul className="rm-changes">
            {changes.map((c) => {
              const removed = c.status === 'removed';
              const result = row.execution?.results?.find((r) => r.sys_id === c.sys_id);
              return (
                <li key={c.id} className={`rm-change${removed ? ' is-removed' : ''}`}>
                  <div className="rm-change-head">
                    <span className="mono rm-target">{c.table} / {c.label}</span>
                    {!settled && (
                      <button type="button" className="btn ghost sm" onClick={() => toggleRemoved(c.id)}>
                        {removed ? 'Put back' : 'Remove'}
                      </button>
                    )}
                  </div>

                  {c.field && (
                    <div className="rm-field">
                      <span className="rm-field-name mono">{c.field}</span>
                      <div className="rm-vals">
                        <div>
                          <span className="rm-val-cap">Current</span>
                          <span className="rm-val mono">
                            {c.currentDisplay || c.currentValue || <em>(empty)</em>}
                          </span>
                        </div>
                        <span className="rm-arrow" aria-hidden="true">→</span>
                        <div>
                          <span className="rm-val-cap">Proposed</span>
                          {settled || removed ? (
                            <span className="rm-val mono">
                              {c.proposedDisplay || c.proposedValue || <em>(none)</em>}
                            </span>
                          ) : c.fieldKind === 'reference' && c.references ? (
                            /* The app's own reference picker — a sys_id is
                               never typed by hand here, for the same reason
                               the agent is told to resolve rather than invent. */
                            <ReferenceField
                              table={c.references}
                              value={c.proposedValue ? { id: c.proposedValue, label: c.proposedDisplay || c.proposedValue } : null}
                              onChange={(v) => setValue(c.id, v?.id || '', v?.label || '')}
                              placeholder={`Search ${c.references}…`}
                            />
                          ) : (
                            <input
                              className="input"
                              value={c.proposedValue}
                              onChange={(e) => setValue(c.id, e.target.value)}
                              placeholder="Value to set"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {c.fieldKind === 'delete' && (
                    <p className="rm-note"><b>This record would be deleted.</b> Deletion cannot be undone.</p>
                  )}

                  {c.assumption && (
                    <p className="rm-assume">
                      <b>Assumed:</b> {c.assumption}
                      {c.confidence != null && <span className="rm-conf"> · confidence {c.confidence}</span>}
                      {c.resolvedFrom && <span className="rm-conf"> · matched “{c.resolvedFrom}”</span>}
                    </p>
                  )}
                  {c.resolutionNote && <p className="rm-note">{c.resolutionNote}</p>}
                  {c.status === 'needs_value' && !removed && !settled && (
                    <p className="rm-note">No value proposed — supply one, or remove this change.</p>
                  )}

                  {/* After execution: what actually happened to THIS record. */}
                  {result && (
                    <p className={`rm-result tone-${result.ok ? 'ok' : 'bad'}`}>
                      {result.ok ? '✓ applied' : '✗ not applied'}
                      {result.verdict ? ` · read-back ${result.verdict}` : ''}
                      {result.note ? ` · ${result.note}` : ''}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {/* ── REASONING / IMPACT / VALIDATION ──────────────────────── */}
          <div className="rm-sec">Why</div>
          <p className="rm-lead">{proposal.reasoning}</p>

          <div className="rm-sec">Impact</div>
          <div className="rm-impact">
            <div><b>{executable.length}</b><span>records</span></div>
            <div><b>{proposal.table}</b><span>table</span></div>
            <div><b>{proposal.field || '—'}</b><span>field</span></div>
            <div>
              <b className={proposal.reversible ? '' : 'rm-bad'}>{proposal.reversible ? 'Yes' : 'No'}</b>
              <span>reversible</span>
            </div>
          </div>
          {proposal.risks?.length > 0 && (
            <ul className="rm-risks">{proposal.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
          {proposal.unreadable?.length > 0 && (
            <p className="note">
              {proposal.unreadable.length} record(s) could not be read and are not included:{' '}
              {proposal.unreadable.map((u) => u.reason).join('; ')}.
            </p>
          )}
          {proposal.truncated > 0 && (
            <p className="note">
              {proposal.truncated} further affected record(s) are not in this plan. Apply this batch, then generate again.
            </p>
          )}

          <div className="rm-sec">How it will be checked</div>
          <p className="rm-lead">{proposal.validation}</p>

          {/* ── NOTES TO THE AGENT ───────────────────────────────────── */}
          {!settled && (
            <>
              <div className="rm-sec">Notes or corrections (optional)</div>
              <textarea
                className="input rm-note-input"
                rows={2}
                value={userNote}
                onChange={(e) => setUserNote(e.target.value)}
                placeholder="Anything the agent should know when it applies this…"
              />
            </>
          )}

          {/* ── WHAT HAPPENED ───────────────────────────────────────── */}
          {row.validation && (
            <>
              <div className="rm-sec">Validation</div>
              <p className={`rm-verdict tone-${row.validation.ok ? 'ok' : 'bad'}`}>
                {row.validation.ok ? 'Validation successful' : 'Validation failed'} —{' '}
                {row.validation.cleared} of {row.validation.total} record(s) hold the approved value.
              </p>
              <p className="rm-note">{row.validation.note}</p>
            </>
          )}

          {status === 'rejected' && row.rejectReason && (
            <p className="rm-note"><b>Reason given:</b> {row.rejectReason}</p>
          )}

          {row.taskId && (
            <p className="rm-note">
              Executed as task <code className="mono">{row.taskId.slice(0, 8)}</code> — it appears in NHA Logs with every
              step, its approval and its read-back.
            </p>
          )}

          {/* ── ACTIONS ─────────────────────────────────────────────── */}
          {!settled && (
            <div className="rm-actions">
              {rejecting ? (
                <>
                  <input
                    className="input"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Why are you rejecting it? (optional)"
                  />
                  <button type="button" className="btn danger" onClick={reject} aria-busy={busy === 'reject'}>
                    Confirm reject
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>Cancel</button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={approve}
                    aria-busy={busy === 'approve'}
                    disabled={Boolean(busy) || executable.length === 0}
                    title={executable.length === 0 ? 'Nothing to apply — every change is removed or has no value.' : undefined}
                  >
                    Approve and apply {executable.length > 0 ? `(${executable.length})` : ''}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={save}
                    aria-busy={busy === 'save'}
                    disabled={!dirty || Boolean(busy)}
                  >
                    Save edits
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setRejecting(true)} disabled={Boolean(busy)}>
                    Reject
                  </button>
                </>
              )}
            </div>
          )}

          {!settled && (
            <p className="rm-fine">
              Approve and apply sends <b>this exact list</b> to the agent, which writes it through the same gate,
              read-back and audit trail as every other change in this app. If you edit after approving, the approval
              stops applying and nothing runs.
            </p>
          )}

          {settled && (
            <div className="rm-actions">
              <button type="button" className="btn" onClick={generate} aria-busy={busy === 'generate'}>
                Generate a new plan
              </button>
              <button type="button" className="btn ghost" onClick={onClose}>Close</button>
            </div>
          )}
        </>
      )}
    </RecordDrawer>
  );
}
