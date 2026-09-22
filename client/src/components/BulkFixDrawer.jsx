import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, sse } from '../api.js';
import RecordDrawer from './RecordDrawer.jsx';
import { ProposalChangeList, WriteGateCard, isExecutable, statusFor } from './RemediationParts.jsx';
import { toast } from './toast.js';
import { notifyDesktop } from './notify.js';

/**
 * BULK FIX — the remediation review, once per selected finding.
 *
 * ═══ WHAT THIS IS ═══
 *
 * The same four moments the single drawer has — propose, review, approve,
 * see what landed — laid out as a list. Each finding is its own proposal with
 * its own fingerprint, its own editable change list and its own result. The
 * server applies them ONE AFTER ANOTHER through the single flow's own
 * sequence, and every write still stops at the executor's card, rendered here
 * and answered through POST /api/agent/approve, the one resolver.
 *
 * There is deliberately no "approve everything" that skips reading. The
 * approve button sends, per proposal, the fingerprint of the version on
 * screen; an item the reviewer edited is saved first and its NEW fingerprint
 * is sent; an item they unticked is not sent at all.
 *
 * ═══ WHY THE STATUS IS PER FINDING, ALWAYS ═══
 *
 * A batch report that says "done" is a batch report that hides the one
 * finding that needed a value nobody supplied. Every row here carries one
 * status from the server's closed vocabulary and the note that goes with it,
 * before, during and after — and the summary is a count of those, never a
 * verdict on the batch.
 */

const STATUS = {
  pending: { label: 'Waiting', tone: 'idle' },
  proposed: { label: 'Ready to apply', tone: 'ok' },
  needs_value: { label: 'Needs a value', tone: 'warn' },
  no_field_fix: { label: 'Manual fix only', tone: 'idle' },
  stale: { label: 'No longer on the instance', tone: 'bad' },
  proposal_failed: { label: 'Could not propose', tone: 'bad' },
  excluded: { label: 'Left out', tone: 'idle' },
  already_decided: { label: 'Already decided', tone: 'idle' },
  applied: { label: 'Applied', tone: 'ok' },
  partial: { label: 'Partially applied', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Stopped', tone: 'bad' },
  not_started: { label: 'Not started', tone: 'idle' },
};
const statusOf = (s) => STATUS[s] || { label: s, tone: 'idle' };

const PHASE_LABEL = {
  generating: 'Proposing — nothing has been applied',
  review: 'Proposed changes — not yet applied',
  applying: 'Applying — one finding at a time',
  results: 'Finished — see each finding below',
};
const PHASE_TONE = { generating: 'warn', review: 'warn', applying: 'ok', results: 'idle' };

/** Executable changes in a working copy. */
const readyCount = (changes) => (changes || []).filter(isExecutable).length;

export default function BulkFixDrawer({ open, items, onClose, onSettled }) {
  const [phase, setPhase] = useState('generating');
  const [rows, setRows] = useState([]);
  const [progress, setProgress] = useState(null);   // { done, total, current }
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const [gate, setGate] = useState(null);           // the executor's card, plus which item it belongs to
  const [current, setCurrent] = useState(null);     // { key, stage } while applying
  const stopRef = useRef(null);

  /* Closing mid-stream aborts it: a pending card is cancelled at once, and
     any proposal not yet reached is never started. */
  useEffect(() => () => stopRef.current?.abort(), []);
  useEffect(() => { if (!open) stopRef.current?.abort(); }, [open]);

  const patchRow = useCallback((key, patch) => {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)));
  }, []);

  /* ── PHASE 1: propose, one finding after another ─────────────────────── */
  const generate = useCallback(async () => {
    const seed = items.map((it) => ({
      key: `${it.runId}:${it.fingerprint}`,
      runId: it.runId,
      fingerprint: it.fingerprint,
      title: it.title,
      ruleId: it.rule_id,
      severity: it.severity,
      status: 'pending',
      note: null,
      proposalId: null,
      proposal: null,          // the stored row
      proposalFingerprint: null,
      changes: [],             // the editable working copy
      included: false,
      expanded: false,
      priorProposal: null,
      result: null,
    }));
    setRows(seed);
    setPhase('generating');
    setError(''); setSummary(null); setGate(null); setCurrent(null);
    setProgress({ done: 0, total: seed.length, current: null });
    setBusy('generate');
    const controller = new AbortController();
    stopRef.current = controller;
    let terminal = null;
    try {
      await sse('/health/bulk/proposals', {
        items: items.map((it) => ({ runId: it.runId, fingerprint: it.fingerprint })),
      }, (evt) => {
        if (evt.type === 'item_started') {
          setProgress((p) => ({ ...p, current: evt.key }));
        } else if (evt.type === 'item_proposed') {
          const it = evt.item;
          const changes = it.proposal?.proposal?.changes ?? [];
          patchRow(evt.key, {
            status: it.status,
            note: it.note,
            proposalId: it.proposalId,
            proposal: it.proposal,
            proposalFingerprint: it.proposalFingerprint,
            changes,
            priorProposal: it.priorProposal ?? null,
            title: it.title ?? undefined,
            ruleId: it.ruleId ?? undefined,
            /* Included by default only when it is ready AND this finding has
               not already had a fix applied in this run. A finding that was
               fixed and re-proposed is a decision, not a default. */
            included: it.status === 'proposed' && !it.priorProposal,
          });
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        } else if (evt.type === 'item_skipped') {
          patchRow(evt.key, { status: evt.status, note: evt.note, included: false });
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        } else if (evt.type === 'done' || evt.type === 'error') terminal = evt;
      }, 'POST', { signal: controller.signal });

      if (!terminal || terminal.type === 'error') {
        setError(terminal?.message || 'The proposals did not finish generating.');
      }
      /* Anything the stream never settled is reported as such, not left "waiting". */
      setRows((cur) => cur.map((r) => (r.status === 'pending'
        ? { ...r, status: 'not_started', note: 'The proposal was never generated.' }
        : r)));
    } catch (e) {
      setError(e.cancelled ? 'Stopped. Nothing has been applied.' : e.message);
      setRows((cur) => cur.map((r) => (r.status === 'pending'
        ? { ...r, status: 'not_started', note: 'Stopped before a proposal was generated.' }
        : r)));
    } finally {
      stopRef.current = null;
      setBusy(''); setProgress(null);
      setPhase('review');
    }
  }, [items, patchRow]);

  useEffect(() => {
    if (!open || !items?.length) return;
    generate();
  }, [open, items, generate]);

  /* ── REVIEW: edit values, include / exclude ──────────────────────────── */
  const setValue = (key, id, value, display) => {
    patchRow(key, (r) => {
      const before = readyCount(r.changes);
      const changes = r.changes.map((c) => (c.id === id
        ? { ...c, proposedValue: value, proposedDisplay: display ?? value, status: statusFor(c, value) }
        : c));
      const after = readyCount(changes);
      /* Supplying the first value is the reviewer saying "this one too". */
      return { changes, included: before === 0 && after > 0 ? true : (after === 0 ? false : r.included) };
    });
  };
  const toggleRemoved = (key, id) => {
    patchRow(key, (r) => {
      const changes = r.changes.map((c) => (c.id === id
        ? { ...c, status: c.status === 'removed' ? statusFor(c, c.proposedValue) : 'removed' }
        : c));
      return { changes, included: readyCount(changes) === 0 ? false : r.included };
    });
  };
  const toggleIncluded = (key) => patchRow(key, (r) => ({ included: !r.included }));
  const toggleExpanded = (key) => patchRow(key, (r) => ({ expanded: !r.expanded }));

  const dirty = (r) => {
    const stored = r.proposal?.proposal?.changes ?? [];
    return r.changes.some((c, i) => c.proposedValue !== stored[i]?.proposedValue || c.status !== stored[i]?.status);
  };
  const includable = (r) => Boolean(r.proposalId) && readyCount(r.changes) > 0 && !r.result;
  const included = useMemo(() => rows.filter((r) => r.included && includable(r)), [rows]);
  const includedRecords = included.reduce((n, r) => n + readyCount(r.changes), 0);
  const setAll = (on) => setRows((cur) => cur.map((r) => ({ ...r, included: on && includable(r) })));

  /* ── PHASE 2: approve and apply, one proposal after another ─────────── */
  const approve = async () => {
    if (!included.length) return;
    setBusy('approve'); setError(''); setGate(null);
    setPhase('applying');

    /* Save every edited proposal FIRST and take its new fingerprint — the
       server compares what is sent with what it holds, so an unsaved edit
       cannot be approved by accident. A save that fails leaves that finding
       out and says why; the rest go on. */
    const toSend = [];
    for (const r of included) {
      let fp = r.proposalFingerprint;
      if (dirty(r)) {
        try {
          const res = await api.patch(`/health/proposals/${r.proposalId}`, { proposal: { changes: r.changes } });
          fp = res.fingerprint;
          patchRow(r.key, { proposal: res.proposal, proposalFingerprint: fp, changes: res.proposal.proposal.changes });
        } catch (e) {
          patchRow(r.key, { status: 'failed', note: `The edits could not be saved, so this finding was not sent: ${e.message}`, included: false });
          continue;
        }
      }
      toSend.push({ key: r.key, proposalId: r.proposalId, fingerprint: fp });
    }
    /* Whatever is not being sent is reported as left out, now, not after. */
    setRows((cur) => cur.map((r) => (toSend.some((s) => s.key === r.key) || r.result || ['failed'].includes(r.status)
      ? r
      : { ...r, status: r.status === 'proposed' ? 'excluded' : r.status, note: r.status === 'proposed' ? 'Not included in this batch. Nothing was sent for it.' : r.note })));
    if (!toSend.length) { setPhase('results'); setBusy(''); return; }

    const byProposal = new Map(toSend.map((s) => [s.proposalId, s.key]));
    const sessions = new Map();     // proposalId → sessionId, from execution_started
    const controller = new AbortController();
    stopRef.current = controller;
    let terminal = null;
    try {
      await sse('/health/bulk/approve', {
        items: toSend.map(({ proposalId, fingerprint }) => ({ proposalId, fingerprint })),
      }, (evt) => {
        const key = evt.item ? byProposal.get(evt.item) : null;
        if (evt.type === 'item_started') {
          setCurrent({ key, stage: 'starting' });
        } else if (evt.type === 'targets_observing') setCurrent({ key, stage: 're-reading the records from the instance' });
        else if (evt.type === 'plan_created') setCurrent({ key, stage: 'plan built' });
        else if (evt.type === 'execution_started') {
          sessions.set(evt.item, evt.sessionId ?? null);
          setCurrent({ key, stage: 'executing' });
        } else if (evt.type === 'approval_required') {
          setGate({ ...evt, key, sessionId: sessions.get(evt.item) ?? null });
          notifyDesktop({
            title: 'A bulk fix is waiting for you to confirm a write',
            body: evt.operation || 'Open Health Assist to apply or skip it.',
            tag: `nha-bulk-${evt.approvalId ?? ''}`,
            path: '/health',
          });
          setCurrent({ key, stage: 'waiting for you to confirm the write above' });
        } else if (evt.type === 'approval_resolved') setGate(null);
        else if (evt.type === 'step_started') setCurrent({ key, stage: `applying ${evt.step ?? ''}` });
        else if (evt.type === 'step_failed') setCurrent({ key, stage: `${evt.step ?? 'a step'} did not apply` });
        else if (evt.type === 'execution_complete') setCurrent({ key, stage: 'validating' });
        else if (evt.type === 'item_done') {
          patchRow(key ?? byProposal.get(evt.proposalId), {
            status: evt.status, note: evt.note, result: evt.result ?? null,
            proposal: evt.proposal ?? undefined, expanded: evt.status !== 'applied',
          });
        } else if (evt.type === 'done' || evt.type === 'error') terminal = evt;
      }, 'POST', { signal: controller.signal });

      if (terminal?.summary) setSummary(terminal.summary);
      if (!terminal || terminal.type === 'error') {
        setError(terminal?.message || 'The bulk fix did not complete.');
        toast.error('The bulk fix did not complete — each finding below says what happened to it.');
      } else if (terminal.summary?.ok) {
        toast.success(`Applied and read back — ${terminal.summary.note}`);
        notifyDesktop({ title: 'Bulk fix applied', body: terminal.summary.note, tag: 'nha-bulk', path: '/health' });
      } else {
        toast.info(`Finished — ${terminal.summary?.note ?? 'not everything applied'} Check each finding.`);
        notifyDesktop({ title: 'Bulk fix finished — not everything applied', body: terminal.summary?.note ?? '', tag: 'nha-bulk', path: '/health' });
      }
    } catch (e) {
      setError(e.cancelled
        ? 'Stopped. Anything not yet confirmed was not sent; anything already applied is shown on its finding.'
        : e.message);
      if (!e.cancelled) toast.error('The bulk fix did not complete.');
    } finally {
      stopRef.current = null;
      /* Anything the stream never closed is said so, not left "executing". */
      setRows((cur) => cur.map((r) => (toSend.some((s) => s.key === r.key) && !r.result
        ? { ...r, status: r.status === 'proposed' ? 'not_started' : r.status, note: r.note ?? 'The batch stopped before this finding was reported. Check NHA Logs for its task.' }
        : r)));
      setBusy(''); setGate(null); setCurrent(null);
      setPhase('results');
    }
  };

  /* The page learns what settled, so it can drop applied findings from the selection. */
  useEffect(() => {
    if (phase === 'results' && onSettled) onSettled(rows.map((r) => ({ key: r.key, status: r.status })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /** Answer the executor's card for ONE record. The stream clears it. */
  const decide = async (approved) => {
    if (!gate) return;
    if (!gate.sessionId) {
      setError('This confirmation arrived without a session, so it cannot be answered. Nothing was sent — press Stop.');
      return;
    }
    setGate((g) => (g ? { ...g, sending: approved } : g));
    try {
      const r = await api.post('/agent/approve', {
        sessionId: gate.sessionId, approvalId: gate.approvalId, approved, nonce: gate.nonce,
      });
      if (!r?.ok) setError('The write was no longer waiting for this answer — it was already answered, or it timed out.');
    } catch (e) {
      setError(e.message);
      setGate((g) => (g ? { ...g, sending: undefined } : g));
    }
  };

  const gateRow = gate ? rows.find((r) => r.key === gate.key) : null;
  const gateChange = gateRow ? gateRow.changes.find((c) => c.sys_id === gate.input?.sys_id) ?? null : null;

  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);
  const settled = phase === 'results';
  const reviewing = phase === 'review';

  return (
    <RecordDrawer open={open} title={`Bulk fix · ${items?.length ?? 0} finding${items?.length === 1 ? '' : 's'}`} onClose={onClose} width={720}>
      <div className={`rm-state tone-${PHASE_TONE[phase]}`}>
        <b>{PHASE_LABEL[phase]}</b>
        {!settled && <span>Nothing reaches your instance until you approve, and each write still asks you first.</span>}
        {settled && summary && <span>{summary.note}</span>}
      </div>

      {error && <p className="error-text">{error}</p>}

      {progress && (
        <p className="note" aria-live="polite">
          Proposing {Math.min(progress.done + 1, progress.total)} of {progress.total}
          {progress.current ? ` — ${rows.find((r) => r.key === progress.current)?.ruleId ?? ''}` : ''}… Closing this window stops it.
        </p>
      )}
      {current && (
        <p className="note" aria-live="polite">
          <b>{rows.find((r) => r.key === current.key)?.ruleId ?? 'Applying'}</b> — {current.stage}. Closing this window stops the batch.
        </p>
      )}

      <WriteGateCard gate={gate} change={gateChange} onDecide={decide} onStop={() => stopRef.current?.abort()} />

      {/* ── THE BATCH, one finding per row ───────────────────────────── */}
      <div className="rm-sec bf-sec">
        <span>Findings · {rows.length}</span>
        {reviewing && (
          <span className="bf-sec-actions">
            <button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Include all ready</button>
            <button type="button" className="btn ghost sm" onClick={() => setAll(false)}>Include none</button>
          </span>
        )}
      </div>

      <ul className="bf-list">
        {rows.map((r) => {
          const st = statusOf(r.status);
          const ready = readyCount(r.changes);
          const canInclude = reviewing && includable(r);
          const isCurrent = current?.key === r.key;
          return (
            <li key={r.key} className={`bf-item${isCurrent ? ' is-current' : ''}${r.expanded ? ' is-open' : ''}`}>
              <div className="bf-head">
                <label className="bf-check" title={canInclude ? 'Include in this batch' : (r.status === 'proposed' ? '' : st.label)}>
                  <input
                    type="checkbox"
                    checked={Boolean(r.included && includable(r))}
                    disabled={!canInclude}
                    onChange={() => toggleIncluded(r.key)}
                    aria-label={`Include ${r.ruleId}`}
                  />
                </label>
                <button type="button" className="bf-title" onClick={() => toggleExpanded(r.key)} aria-expanded={r.expanded}>
                  <span className="bf-title-text">{r.title}</span>
                  <span className="hd-row-meta"><code>{r.ruleId}</code>{r.proposalId && <> · {ready} of {r.changes.length} record{r.changes.length === 1 ? '' : 's'} ready</>}</span>
                </button>
                <span className={`hs-lc bf-status tone-${st.tone}`}>{st.label}</span>
              </div>

              {r.note && <p className="bf-note">{r.note}</p>}
              {r.priorProposal && !r.result && (
                <p className="bf-note">
                  <b>Already fixed once in this run</b> — a proposal for this finding was {r.priorProposal.status}
                  {r.priorProposal.decidedAt ? ` on ${new Date(r.priorProposal.decidedAt).toLocaleString()}` : ''}. Re-scan to confirm before fixing again; it is left out unless you include it.
                </p>
              )}

              {r.expanded && r.proposal && (
                <div className="bf-body">
                  <p className="rm-lead">{r.proposal.proposal.summary}</p>
                  {r.proposal.proposal.needsJudgement && !r.result && (
                    <div className="rm-judge"><b>This needs your judgement.</b><span>{r.proposal.proposal.judgementNote}</span></div>
                  )}
                  {r.proposal.proposal.llm?.status && !['complete', 'preset'].includes(r.proposal.proposal.llm.status) && (
                    <p className="note">{r.proposal.proposal.llm.note}</p>
                  )}
                  <ProposalChangeList
                    changes={r.changes}
                    settled={!reviewing}
                    results={r.result?.results ?? r.proposal.execution?.results ?? null}
                    onSetValue={(id, v, d) => setValue(r.key, id, v, d)}
                    onToggleRemoved={(id) => toggleRemoved(r.key, id)}
                  />
                  {r.proposal.proposal.unreadable?.length > 0 && (
                    <p className="note">{r.proposal.proposal.unreadable.length} record(s) could not be read and are not included.</p>
                  )}
                  {r.proposal.proposal.truncated > 0 && (
                    <p className="note">{r.proposal.proposal.truncated} further affected record(s) are not in this plan. Apply, re-scan, then fix again.</p>
                  )}
                  {r.result?.validation && (
                    r.result.validation.skipped
                      ? <p className="rm-verdict tone-idle">Not validated — nothing was applied.</p>
                      : (
                        <p className={`rm-verdict tone-${r.result.validation.ok ? 'ok' : 'bad'}`}>
                          {r.result.validation.ok ? 'Validation successful' : 'Validation failed'} —{' '}
                          {r.result.validation.cleared} of {r.result.validation.total} applied record(s) hold the approved value.
                        </p>
                      )
                  )}
                  {r.result?.taskId && (
                    <p className="rm-note">Executed as task <code className="mono">{r.result.taskId.slice(0, 8)}</code> — in NHA Logs with every step, its approval and its read-back.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* ── ACTIONS ──────────────────────────────────────────────────── */}
      {reviewing && (
        <>
          <div className="rm-actions">
            <button
              type="button"
              className="btn primary"
              onClick={approve}
              disabled={Boolean(busy) || included.length === 0}
              title={included.length === 0 ? 'Nothing is included — tick a ready finding, or supply a value.' : undefined}
            >
              Approve and apply {included.length} finding{included.length === 1 ? '' : 's'}
              {includedRecords ? ` (${includedRecords} record${includedRecords === 1 ? '' : 's'})` : ''}
            </button>
            <button type="button" className="btn ghost" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
            <span className="hs-muted bf-counts">
              {Object.entries(counts).filter(([s]) => s !== 'proposed').map(([s, n]) => `${n} ${statusOf(s).label.toLowerCase()}`).join(' · ')}
            </span>
          </div>
          <p className="rm-fine">
            Approve and apply sends <b>each included list</b> to the agent, one finding at a time, through the same gate,
            read-back and audit trail as a single fix. Every write still asks you first. A finding you edit is saved and
            re-fingerprinted before it is sent; one you untick is not sent at all.
          </p>
        </>
      )}

      {settled && (
        <div className="rm-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <span className="hs-muted">Re-run the scan to confirm which findings cleared.</span>
        </div>
      )}
    </RecordDrawer>
  );
}
