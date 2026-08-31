import { useEffect, useState } from 'react';
import { api, sse, val, disp } from '../api.js';
import { confirmDestructive, confirmAction, CONSEQUENCE } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import { SkeletonRows, SkeletonLines, LoadingRegion, EmptyState } from '../components/states.jsx';
import ScopeBadge from '../components/ScopeBadge.jsx';
import { useScopeLabels } from '../hooks/useScopeLabels.js';

/** Green when live authoring is ready; otherwise the exact commands to fix it. */
function CapabilityBanner({ cap }) {
  if (!cap) return null;
  if (cap.ok) {
    return (
      <div className="note" style={{ borderLeftColor: 'var(--verdigris)' }}>
        <b>Live flow authoring ready.</b>{' '}
        {/*
          The SDK no longer has a credential alias of its own — its binding is
          derived per invocation from the connection set in Settings, which is
          why there is one host here rather than a credential name and a host
          that could disagree. Rendering `cap.auth.alias` now would print an
          empty span forever.
        */}
        ServiceNow SDK {cap.cli?.version} · deploys to{' '}
        <span className="mono">{cap.auth?.host || '(no instance bound)'}</span>
        {' '}· scope <span className="mono">{cap.workspace?.scope}</span>
        {cap.auth?.matchesNowHelpAssistInstance === false && (
          <div style={{ marginTop: 6, color: 'var(--amber, #b8860b)' }}>
            Warning: the SDK credential points at a different instance than NowHelpAssist is connected to.
            Flows would deploy to <span className="mono">{cap.auth.host}</span>.
          </div>
        )}
        {cap.lastInstall && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
            Last install {cap.lastInstall.ok ? 'succeeded' : 'failed'}
            {cap.lastInstall.activation ? ` — flows activated ${cap.lastInstall.activation}` : ''}
            {cap.lastInstall.at ? ` (${new Date(cap.lastInstall.at).toLocaleString()})` : ''}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="note warn">
      <b>Live flow authoring unavailable.</b> NowHelpAssist falls back to blueprint + Business Rule until this is fixed.
      {cap.cli && !cap.cli.present && <div style={{ marginTop: 4 }}>ServiceNow SDK not found.</div>}
      {cap.auth?.error && <div style={{ marginTop: 4 }}>{cap.auth.error}</div>}
      {cap.workspace?.error && <div style={{ marginTop: 4 }}>{cap.workspace.error}</div>}
      {cap.fixes?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {cap.fixes.map((f, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12.5 }}>{f.problem}</div>
              <pre className="mono" style={{ margin: '2px 0 0', fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{f.command}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PROGRESS_LABEL = {
  generating: 'Reading the request…',
  intent: 'Intent extracted',
  resolved: 'Resolved references on the instance',
  attempt: 'Generating Fluent TypeScript',
  building: 'Compiling (offline — the instance is untouched)',
  built: 'Compiled cleanly',
  build_failed: 'Compile failed — feeding diagnostics back',
  deploying: 'Installing on the instance',
  verifying: 'Reading the result back',
  done: 'Done',
  // Model-proofing floor (A2–A5). Every one of these is a correction the
  // pipeline made to the model's output, so none of them is allowed to be
  // silent — a rewritten name in particular changes what the instance matches.
  identity_pinned: 'Flow identity pinned',
  identity_rewritten: 'Renamed flow corrected back to its pinned identity',
  promised_literals: 'Exact text the request demands',
  literals_rejected: 'Rejected — promised text missing from the source',
  trigger_strategy_rejected: 'Rejected — trigger strategy would misfire',
  identity_rejected: 'Rejected — duplicate element identity',
  verify_spec_attempt: 'Writing a verification spec',
  verify_spec_rejected: 'Verification spec rejected — adding measured evidence',
  verify_spec_stalled: 'Verification stopped — a retry would have repeated itself',
  verify_spec_ready: 'Verification spec ready',
  verify_spec_failed: 'No valid verification spec could be produced',
  // Subflows as first-class artifacts.
  artifact_type: 'Artifact type',
  artifact_type_rejected: 'Rejected — wrong artifact shape',
  subflow_catalog: 'Existing subflows offered for reuse',
  subflow_reuse_rejected: 'Rejected — would duplicate an existing subflow',
};

function progressLine(e) {
  const base = PROGRESS_LABEL[e.type] || e.type;
  if (e.type === 'attempt') return `${base} (attempt ${e.attempt}/${e.of})`;
  if (e.type === 'building') return `${base} — ${e.file}`;
  if (e.type === 'intent') return `${base}: ${e.intent?.kind} on ${e.intent?.trigger_table || 'n/a'}`;
  if (e.type === 'resolved') {
    return `${base}: ${e.resolved.map((r) => `${r.search}→${r.matches[0]?.sys_id?.slice(0, 8)}…`).join(', ')}`;
  }
  if (e.type === 'build_failed') return `${base} (attempt ${e.attempt})`;
  if (e.type === 'identity_pinned') return `${base}: ${e.pins.map((p) => `${p.kind} “${p.name}”`).join(', ')}`;
  if (e.type === 'identity_rewritten') {
    return `${base}: ${e.rewrites.map((r) => `“${r.from}” → “${r.to}”`).join(', ')}`;
  }
  if (e.type === 'promised_literals') return `${base}: ${e.literals.map((l) => JSON.stringify(l)).join(', ')}`;
  if (e.type === 'literals_rejected') return `${base} (attempt ${e.attempt}): ${e.missing.map((l) => JSON.stringify(l)).join(', ')}`;
  if (e.type === 'trigger_strategy_rejected') return `${base} (attempt ${e.attempt}): ${e.strategy ? `is '${e.strategy}'` : 'not set'}`;
  if (e.type === 'identity_rejected') return `${base} (attempt ${e.attempt})`;
  if (e.type === 'verify_spec_attempt') return `${base} (attempt ${e.attempt}/${e.of})`;
  if (e.type === 'verify_spec_rejected') {
    return `${base} (attempt ${e.attempt})${e.evidenceAdded ? ` — ${e.evidenceAdded} new field inventory` : ''}`;
  }
  if (e.type === 'verify_spec_ready') return `${base}: ${e.assertions} assertion(s) in ${e.attempts} attempt(s)`;
  if (e.type === 'artifact_type') return `${base}: ${e.artifactType} (decided by ${e.decidedBy})${e.note ? ` — ${e.note}` : ''}`;
  if (e.type === 'artifact_type_rejected') return `${base} (attempt ${e.attempt}): expected a ${e.artifactType}`;
  if (e.type === 'subflow_catalog') return `${base}: ${e.subflows.map((c) => `“${c.name}” (${c.inputs.join(', ') || 'no inputs'})`).join(', ')}`;
  if (e.type === 'subflow_reuse_rejected') return `${base} (attempt ${e.attempt})`;
  return base;
}

/** An input/output contract, rendered the same way wherever it appears. */
function Contract({ contract, deployed }) {
  if (!contract) return null;
  const line = (f) => `${f.name}: ${f.type}${f.reference ? ` → ${f.reference}` : ''}${f.mandatory ? ' (required)' : ''}`;
  const side = (label, list) => (
    <div style={{ marginTop: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>{' '}
      {list?.length
        ? list.map((f) => <span key={f.name} className="badge mono" style={{ marginRight: 4 }}>{line(f)}</span>)
        : <span style={{ fontSize: 12, color: 'var(--muted)' }}>none</span>}
    </div>
  );
  // The instance read-back is shown only when it DISAGREES with the source.
  // Two identical lists side by side is noise; a difference is the whole point.
  const names = (l) => (l || []).map((f) => f.name).join(',');
  const drift = deployed && (names(deployed.inputs) !== names(contract.inputs) || names(deployed.outputs) !== names(contract.outputs));
  return (
    <div style={{ marginTop: 6 }}>
      {side('inputs', contract.inputs)}
      {side('outputs', contract.outputs)}
      {drift && (
        <div className="note warn" style={{ marginTop: 6 }}>
          The contract on the instance differs from the source: inputs <span className="mono">{names(deployed.inputs) || '(none)'}</span>,
          outputs <span className="mono">{names(deployed.outputs) || '(none)'}</span>.
        </div>
      )}
    </div>
  );
}

/** Spec in → streamed build log → result card. */
function LiveBuild({ capOk, seedSpec, managed = [], onDeployed }) {
  const [spec, setSpec] = useState('');
  const [updates, setUpdates] = useState('');
  const [artifactType, setArtifactType] = useState('flow');
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => { if (seedSpec) setSpec(seedSpec); }, [seedSpec]);

  const run = async () => {
    setRunning(true); setEvents([]); setResult(null); setFailure(null);
    try {
      await sse('/flows/live', { spec, updates: updates || undefined, artifact_type: artifactType }, (e) => {
        if (e.type === 'done' && e.result) { setResult(e.result); onDeployed?.(); }
        else if (e.type === 'error') setFailure(e);
        else setEvents((prev) => [...prev, e]);
      });
    } catch (e) {
      setFailure({ message: e.message });
    } finally { setRunning(false); }
  };

  return (
    <div className="card">
      <div className="card-title">Live build — deploy a real flow or subflow</div>
      <textarea
        className="textarea"
        placeholder={artifactType === 'subflow'
          ? "e.g. Create a subflow named 'Escalate To Duty Manager' with inputs task (reference to task) and message (string): look up the task's assignment group manager, notify them, and add a work note…"
          : 'e.g. When a P1 incident is created for the Network group, notify the group manager and add a work note…'}
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn amber" onClick={run} aria-busy={running} disabled={running || !spec.trim() || !capOk}>
          {running ? 'Building…' : updates ? 'Regenerate & deploy' : `Generate & deploy ${artifactType}`}
        </button>
        <select
          className="input" style={{ maxWidth: 190 }} value={artifactType} disabled={running || Boolean(updates)}
          onChange={(e) => setArtifactType(e.target.value)} aria-label="Artifact type"
        >
          <option value="flow">Flow (has a trigger)</option>
          <option value="subflow">Subflow (called, no trigger)</option>
        </select>
        {managed.length > 0 && (
          <select className="input" style={{ maxWidth: 260 }} value={updates} onChange={(e) => setUpdates(e.target.value)} disabled={running}>
            <option value="">Create something new</option>
            {managed.map((m) => (
              <option key={m.name} value={m.name}>Update {m.kind} “{m.name}” in place</option>
            ))}
          </select>
        )}
        {!capOk && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Unavailable — see the banner above.</span>}
      </div>
      {updates && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
          Editing “{updates}”: it keeps its sys_id and history rather than becoming a second artifact. An artifact cannot
          change kind, so the type selector does not apply.
        </p>
      )}
      {!updates && artifactType === 'subflow' && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
          Name the inputs and outputs in the description — they become the subflow’s contract, and other flows are
          generated against it.
        </p>
      )}

      {events.length > 0 && (
        <div className="card" style={{ marginTop: 12, background: 'transparent' }}>
          {events.map((e, i) => (
            <div key={i} style={{ fontSize: 12.5, padding: '2px 0' }}>
              <span className="mono" style={{ color: 'var(--muted)' }}>›</span> {progressLine(e)}
              {e.type === 'build_failed' && (
                <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--muted)', margin: '4px 0 0' }}>
                  {String(e.diagnostics || '').slice(0, 900)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="note" style={{ marginTop: 12, borderLeftColor: 'var(--verdigris)' }}>
          <div className="row">
            <b>{result.name}</b>
            <span className={`badge ${result.verified?.type === 'subflow' ? 'blue' : ''}`}>{result.verified?.type || result.artifactType || 'flow'}</span>
            {result.verified?.active && <span className="badge green">active</span>}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>
            Compiled on attempt {result.attempts} · flows activated {result.activation} ·
            {' '}{result.verified?.triggers ?? 0} trigger, {result.verified?.actions ?? 0} actions, {result.verified?.logic ?? 0} logic
          </div>
          {result.contract && <Contract contract={result.contract} deployed={result.verified?.contract} />}
          {result.verification?.available && (
            <div style={{ fontSize: 12.5, marginTop: 6 }}>
              Verification spec ready: {result.verification.assertions} check
              {result.verification.assertions === 1 ? '' : 's'}
              {result.verification.kind === 'subflow' ? ' — run it to call the subflow with test inputs.' : ''}
            </div>
          )}
          {result.verification && !result.verification.available && result.verification.reason && (
            <div className="note warn" style={{ marginTop: 6, fontSize: 12.5 }}>{result.verification.reason}</div>
          )}
          <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>sys_id {result.verified?.sys_id}</div>
          {result.verified?.link && (
            <a className="btn sm" style={{ marginTop: 8, display: 'inline-block' }} href={result.verified.link} target="_blank" rel="noreferrer">
              Open in ServiceNow
            </a>
          )}
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, marginBottom: 0 }}>{result.shippedNote}</p>
          {result.rollbackUrl && (
            <a className="mono" style={{ fontSize: 11 }} href={result.rollbackUrl} target="_blank" rel="noreferrer">rollback this install</a>
          )}
        </div>
      )}

      {failure && (
        <div className="note warn" style={{ marginTop: 12 }}>
          <b>{failure.stage === 'capability' ? 'Live authoring unavailable' : 'Build failed'}</b>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>{failure.message}</div>
          {failure.attempts && <div style={{ fontSize: 12.5 }}>Attempts: {failure.attempts}</div>}
          {failure.diagnostics && (
            <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 6 }}>
              {String(failure.diagnostics).slice(0, 1500)}
            </pre>
          )}
          {failure.cleanedUp && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              The candidate source was removed; nothing was deployed to the instance.
            </div>
          )}
          {failure.hint && <p className="note" style={{ marginTop: 8 }}>{failure.hint}</p>}
        </div>
      )}
    </div>
  );
}

const VERIFY_LABEL = {
  verify_setup: 'Creating a record for the test…',
  verify_setup_done: 'Test record created',
  verify_waiting: 'Waiting for the flow to run…',
  verify_execution: 'Execution state',
  verify_assert: 'Assertion',
  verify_cleanup: 'Deleting test data…',
  // A subflow has no trigger, so it is CALLED through the execution harness:
  // a one-shot scheduled job, deleted again with its result row.
  verify_invoking: 'Calling the subflow…',
  harness_job_creating: 'Creating a one-shot scheduled job',
  harness_job_created: 'Scheduled job created',
  harness_waiting: 'Waiting for the job to report…',
  harness_invoking: 'Invoking through sn_fd.FlowAPI',
  harness_execution: 'Subflow execution state',
  harness_cleanup: 'Job and result row removed',
};

function verifyLine(e) {
  const base = VERIFY_LABEL[e.type] || e.type;
  if (e.type === 'verify_setup') return `${base} (${e.table})`;
  if (e.type === 'verify_setup_done') return `${base}: ${e.record}`;
  if (e.type === 'verify_waiting') return `${base} (up to ${e.timeoutSec}s)`;
  if (e.type === 'verify_execution') return `${base}: ${e.state}`;
  if (e.type === 'verify_invoking') return `${base} ${e.qualified} with ${JSON.stringify(e.inputs)}`;
  if (e.type === 'harness_execution') return `${base}: ${e.state}`;
  if (e.type === 'harness_cleanup') {
    return e.leftovers?.length ? `Cleanup INCOMPLETE — left behind: ${e.leftovers.join(', ')}` : base;
  }
  if (e.type === 'verify_assert') {
    return `${e.pass ? '✓' : '✗'} ${e.field}: expected "${e.expected}"${e.pass ? '' : `, got "${e.actual ?? ''}"`}`;
  }
  return base;
}

/** Streams a verification run for one managed artifact. */
function VerifyPanel({ name, onClose }) {
  const [events, setEvents] = useState([]);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await sse('/flows/live/verify', { name }, (e) => {
          if (!live) return;
          if (e.type === 'done') setResult(e.result);
          else if (e.type === 'error') setError(e.message);
          else setEvents((prev) => [...prev, e]);
        });
      } catch (e) { if (live) setError(e.message); }
      finally { if (live) setRunning(false); }
    })();
    return () => { live = false; };
  }, [name]);

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="spread">
        <div className="card-title" style={{ marginBottom: 0 }}>Verifying “{name}”</div>
        <button className="btn sm" onClick={onClose} disabled={running}>Close</button>
      </div>
      {events.map((e, i) => (
        <div key={i} style={{ fontSize: 12.5, padding: '2px 0' }}>
          <span className="mono" style={{ color: 'var(--muted)' }}>›</span> {verifyLine(e)}
        </div>
      ))}
      {running && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>running…</div>}

      {result && (
        <div className={`note ${result.ok ? '' : 'warn'}`} style={{ marginTop: 10, borderLeftColor: result.ok ? 'var(--verdigris)' : undefined }}>
          <b>{result.ok ? 'Verified' : 'Verification failed'}</b>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>{result.message}</div>
          {result.execution && (
            <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
              execution {result.execution.name} — {result.execution.state}
              {result.execution.error_message ? ` — ${result.execution.error_message}` : ''}
            </div>
          )}
          {result.kind === 'subflow' && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
              Called as <span className="mono">{result.subflow?.qualified}</span> via {result.mechanism}.
              {result.harness && (result.harness.leftovers?.length
                ? <span> Cleanup INCOMPLETE: {result.harness.leftovers.join(', ')}.</span>
                : <span> The scheduled job and its result row were deleted and read back.</span>)}
            </div>
          )}
          {result.outputs && Object.keys(result.outputs).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>outputs returned</span>{' '}
              {Object.entries(result.outputs).map(([k, v]) => (
                <span key={k} className="badge mono" style={{ marginRight: 4 }}>{k} = {JSON.stringify(v.value)}</span>
              ))}
            </div>
          )}
          {result.assertions?.length > 0 && (
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th /><th>Field</th><th>Expected</th><th>Actual</th><th>Proves</th></tr></thead>
              <tbody>
                {result.assertions.map((a, i) => (
                  <tr key={i}>
                    <td><span className={`badge ${a.pass ? 'green' : 'red'}`}>{a.pass ? 'pass' : 'fail'}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{a.type === 'output' ? `output: ${a.field}` : `${a.table}.${a.field}`}</td>
                    <td style={{ fontSize: 11.5 }}>{String(a.expected ?? '')}</td>
                    <td style={{ fontSize: 11.5 }}>{a.reason || String(a.actual ?? '')}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{a.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, marginBottom: 0 }}>
            Test data was deleted. Verification proves the asserted effects on a real execution; it cannot prove
            effects nobody asserted.
          </p>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** NowHelpAssist-managed Fluent sources and their live state. */
function ManagedArtifacts({ reloadKey, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState('');

  const load = () => api.get('/flows/live').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [reloadKey]);

  const remove = async (m) => {
    const name = m.name;
    const ok = await confirmDestructive({
      action: 'Delete flow',
      subject: name,
      sysId: m.live?.sys_id,
      detail: CONSEQUENCE.flow,
    });
    if (!ok) return;
    setBusy(name); setError('');
    try {
      await api.del(`/flows/live/${encodeURIComponent(name)}`);
      await load();
      onChanged?.();
      toast.success(`Deleted "${name}" and reinstalled the application.`);
    } catch (e) {
      // A refused delete is the dependency guard, not a failure: the message
      // already names the callers, so it is shown as-is rather than summarised.
      setError(e.message); toast.error(e.message);
    }
    finally { setBusy(''); }
  };

  // Used to render nothing at all while loading, so the page shuffled itself
  // downwards a second after it appeared.
  if (!data) {
    return (
      <div className="card">
        <div className="card-title">NowHelpAssist-managed artifacts</div>
        <SkeletonLines lines={3} />
        <LoadingRegion label="Loading managed artifacts" />
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-title">NowHelpAssist-managed artifacts</div>
      {data.managed.length === 0 && (
        <EmptyState
          title="Nothing is managed yet."
          hint="Describe an automation in the box above and NowHelpAssist will generate Fluent source, compile it offline, install it, and read it back. Only what it authored appears here."
        />
      )}
      {data.managed.length > 0 && (
        <table className="table">
          <thead><tr><th>Name</th><th>Kind</th><th>Contract / dependencies</th><th>On instance</th><th>Verification</th><th /></tr></thead>
          <tbody>
            {data.managed.map((m) => (
              <tr key={m.file + m.name}>
                <td>{m.name}<div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{m.file}</div></td>
                <td><span className={`badge ${m.kind === 'subflow' ? 'blue' : ''}`}>{m.kind}</span></td>
                <td>
                  {m.contract && <Contract contract={m.contract} />}
                  {m.calls?.length > 0 && (
                    <div style={{ fontSize: 11.5, marginTop: 4 }}>
                      <span style={{ color: 'var(--muted)' }}>Calls:</span> {m.calls.join(', ')}
                    </div>
                  )}
                  {m.calledBy?.length > 0 && (
                    <div style={{ fontSize: 11.5, marginTop: 4 }}>
                      <span style={{ color: 'var(--muted)' }}>Called by:</span> {m.calledBy.join(', ')}
                    </div>
                  )}
                  {m.unresolvedCalls?.length > 0 && (
                    <div style={{ fontSize: 11.5, marginTop: 4, color: 'var(--muted)' }}>
                      Calls a subflow this project does not manage:{' '}
                      {m.unresolvedCalls.map((u) => u.sysId || u.binding).join(', ')}
                    </div>
                  )}
                  {!m.contract && !m.calls?.length && !m.calledBy?.length && !m.unresolvedCalls?.length && (
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td>
                  {m.live
                    ? <span className={`badge ${m.live.active ? 'green' : ''}`}>{m.live.active ? 'active' : 'inactive'}</span>
                    : <span className="badge red">not found</span>}
                </td>
                <td>
                  {m.verification?.available
                    ? <span className="badge">{m.verification.assertions} assertion{m.verification.assertions === 1 ? '' : 's'}</span>
                    : <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>—</span>}
                </td>
                <td>
                  <div className="row">
                    {m.verification?.available && (
                      <button className="btn amber sm" onClick={() => setVerifying(m.name)} aria-busy={verifying === m.name} disabled={Boolean(verifying)}>
                        Verify
                      </button>
                    )}
                    <button
                      className="btn sm" onClick={() => remove(m)} aria-busy={busy === m.name}
                      disabled={busy === m.name || m.calledBy?.length > 0}
                      title={m.calledBy?.length ? `Called by ${m.calledBy.join(', ')} — delete or edit the caller first.` : undefined}
                    >
                      {busy === m.name ? 'Removing…' : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {verifying && <VerifyPanel name={verifying} onClose={() => setVerifying('')} />}
      {data.staged?.length > 0 && (
        <p className="note" style={{ marginTop: 10 }}>
          Staged (build-verified, deliberately not deployed): <span className="mono">{data.staged.join(', ')}</span>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function KV({ record, keys }) {
  const rows = keys.filter((k) => disp(record, k));
  if (!rows.length) return null;
  return (
    <dl className="kv">
      {rows.map((k) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd className={k.includes('sys_') || k === 'condition' ? 'mono' : ''}>{disp(record, k)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Blueprint({ bp, capOk, onDeploy }) {
  const [ruleResult, setRuleResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = () => {
    const blob = new Blob([JSON.stringify(bp, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(bp.name || 'flow-blueprint').replace(/\W+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const createRule = async () => {
    const ok = await confirmAction({
      action: 'Create an equivalent Business Rule for',
      subject: bp.name,
      detail: 'It is created INACTIVE on the instance for your review. This is the Tier 3 fallback — '
        + 'it is not a flow, and nothing activates it for you.',
      confirmLabel: 'Create rule',
    });
    if (!ok) return;
    setBusy(true); setError('');
    try { setRuleResult(await api.post('/flows/blueprint-to-rule', { blueprint: bp })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const recordTriggered = String(bp.trigger?.type || '').startsWith('record');

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="spread">
        <h3 style={{ fontSize: 15 }}>{bp.name}</h3>
        <div className="row">
          <button className="btn sm" onClick={download}>Download JSON</button>
          {capOk && (
            <button className="btn primary sm" onClick={() => onDeploy?.(bp)}>
              Deploy as real flow
            </button>
          )}
          {recordTriggered && (
            <button className="btn amber sm" onClick={createRule} aria-busy={busy} disabled={busy}>
              {busy ? 'Creating…' : 'Business Rule fallback'}
            </button>
          )}
        </div>
      </div>
      <p style={{ color: 'var(--muted)' }}>{bp.description}</p>

      <div className="card-title">Trigger</div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="badge green">{bp.trigger?.type}</span>
        {bp.trigger?.table && <span className="badge mono">{bp.trigger.table}</span>}
      </div>
      {bp.trigger?.condition_plain && <p style={{ fontSize: 13, margin: '4px 0' }}>{bp.trigger.condition_plain}</p>}
      {bp.trigger?.condition_encoded_query && <p className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{bp.trigger.condition_encoded_query}</p>}

      <div className="card-title" style={{ marginTop: 12 }}>Steps</div>
      {(bp.steps || []).map((s, i) => (
        <div className="step-row" key={i}>
          <div className="step-num">{s.order ?? i + 1}</div>
          <div>
            <div className="row">
              <span className="badge">{s.kind}</span>
              {s.flow_designer_action && <span className="badge blue">{s.flow_designer_action}</span>}
            </div>
            <p style={{ margin: '4px 0', fontSize: 13 }}>{s.summary}</p>
            {s.config && Object.keys(s.config).length > 0 && (
              <pre className="mono" style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'pre-wrap', margin: 0 }}>
                {Object.entries(s.config).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}
              </pre>
            )}
          </div>
        </div>
      ))}

      {bp.reference_fields_used?.length > 0 && (
        <>
          <div className="card-title" style={{ marginTop: 12 }}>Reference fields involved</div>
          <table className="table">
            <thead><tr><th>Field</th><th>On table</th><th>References</th></tr></thead>
            <tbody>
              {bp.reference_fields_used.map((r, i) => (
                <tr key={i}><td className="mono">{r.field}</td><td className="mono">{r.table}</td><td className="mono">{r.referenced_table}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {bp.test_plan?.length > 0 && (
        <>
          <div className="card-title" style={{ marginTop: 12 }}>Test plan</div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--muted)' }}>
            {bp.test_plan.map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </>
      )}
      {bp.notes && <p className="note" style={{ marginTop: 12 }}>{bp.notes}</p>}

      {ruleResult?.rule && (
        <div className="note" style={{ marginTop: 12, borderLeftColor: 'var(--verdigris)' }}>
          Created Business Rule <b>{disp(ruleResult.rule, 'name')}</b> on <span className="mono">{disp(ruleResult.rule, 'collection')}</span> —
          created <b>inactive</b>. Review the script on your instance, then activate.
          <span className="mono" style={{ display: 'block', fontSize: 11 }}>sys_id {val(ruleResult.rule, 'sys_id')}</span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export default function Flows() {
  const [rows, setRows] = useState([]);
  // One batched resolve for the whole list, not one per row.
  const scopeLabels = useScopeLabels(rows.map((r) => val(r, 'sys_scope')));
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [detail, setDetail] = useState(null);
  const [execs, setExecs] = useState([]);
  const [designOpen, setDesignOpen] = useState(false);
  const [designText, setDesignText] = useState('');
  const [bp, setBp] = useState(null);
  const [bpError, setBpError] = useState('');
  const [designing, setDesigning] = useState(false);
  const [error, setError] = useState('');
  const [cap, setCap] = useState(null);
  const [seedSpec, setSeedSpec] = useState('');
  const [managedKey, setManagedKey] = useState(0);
  const [managed, setManaged] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/flows/live/capability').then(setCap).catch(() => setCap({ ok: false, fixes: [] }));
  }, []);
  useEffect(() => {
    api.get('/flows/live').then((d) => setManaged(d.managed || [])).catch(() => setManaged([]));
  }, [managedKey]);

  /** Blueprint → live build: flatten the design into a spec and scroll it into view. */
  const deployBlueprint = (b) => {
    const t = b.trigger || {};
    const lines = [
      `Create an automation named "${b.name}".`,
      b.description ? `Purpose: ${b.description}` : null,
      t.type ? `Trigger: ${t.type}${t.table ? ` on the ${t.table} table` : ''}${t.condition_plain ? ` when ${t.condition_plain}` : ''}.` : null,
      t.condition_encoded_query ? `Trigger condition (encoded query): ${t.condition_encoded_query}` : null,
      t.schedule ? `Schedule: ${t.schedule}` : null,
      'Steps:',
      ...(b.steps || []).map((s, i) => `  ${s.order ?? i + 1}. [${s.kind}] ${s.summary}${s.flow_designer_action ? ` (action: ${s.flow_designer_action})` : ''}`),
    ].filter(Boolean);
    setSeedSpec(lines.join('\n'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const load = () => {
    setLoading(true);
    return api.get(`/flows?search=${encodeURIComponent(search)}&type=${typeFilter}`)
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [typeFilter]);

  const open = async (r) => {
    setError('');
    try {
      const d = await api.get(`/flows/${val(r, 'sys_id')}`);
      setDetail(d);
      setExecs(await api.get(`/flows/executions?flow=${val(r, 'sys_id')}`));
    } catch (e) { setError(e.message); }
  };

  const toggleActive = async () => {
    const id = val(detail.flow, 'sys_id');
    const next = val(detail.flow, 'active') !== 'true';
    try {
      await api.post(`/flows/${id}/active`, { active: next });
      const d = await api.get(`/flows/${id}`);
      setDetail(d);
      load();
    } catch (e) { setError(e.message); }
  };

  const design = async () => {
    setDesigning(true); setBp(null); setBpError('');
    try {
      const r = await api.post('/flows/design', { description: designText });
      if (r.blueprint) setBp(r.blueprint);
      else setBpError(r.error + (r.raw ? ` — ${r.raw.slice(0, 400)}` : ''));
    } catch (e) { setBpError(e.message); }
    finally { setDesigning(false); }
  };

  return (
    <div className="stack">
      <div className="note">
        Flows are authored through ServiceNow's own SDK (Fluent): NowHelpAssist generates TypeScript, compiles it
        offline — so nothing reaches the instance unless it compiles — then installs it and reads the result back.
        There is still no REST API for writing <span className="mono">sys_hub_*</span> directly, and NowHelpAssist never
        attempts it. Blueprint and the inactive Business Rule remain the fallback tier for environments where the
        SDK cannot run.
      </div>

      <CapabilityBanner cap={cap} />

      <LiveBuild
        capOk={Boolean(cap?.ok)}
        seedSpec={seedSpec}
        managed={managed}
        onDeployed={() => { setManagedKey((k) => k + 1); load(); }}
      />

      <ManagedArtifacts reloadKey={managedKey} onChanged={() => load()} />

      <div className="card">
        <div className="spread">
          <div className="card-title" style={{ marginBottom: 0 }}>Design a new automation with AI</div>
          <button className="btn primary sm" onClick={() => setDesignOpen(!designOpen)}>{designOpen ? 'Hide designer' : 'Open designer'}</button>
        </div>
        {designOpen && (
          <div style={{ marginTop: 12 }}>
            <textarea className="textarea" placeholder="e.g. When a P1 incident is created for the Network group, notify the group manager and create a problem task…"
              value={designText} onChange={(e) => setDesignText(e.target.value)} />
            <button className="btn primary" style={{ marginTop: 8 }} onClick={design} aria-busy={designing} disabled={designing || !designText.trim()}>
              {designing ? 'Designing…' : 'Generate blueprint'}
            </button>
            {bpError && <p className="error-text">{bpError}</p>}
            {bp && <Blueprint bp={bp} capOk={Boolean(cap?.ok)} onDeploy={deployBlueprint} />}
          </div>
        )}
      </div>

      <div className="split">
        <div className="card">
          <div className="card-title">Flows &amp; subflows on instance</div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="input" placeholder="Search…" value={search}
              onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
            <select className="input" style={{ maxWidth: 130 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All types</option>
              <option value="flow">Flows</option>
              <option value="subflow">Subflows</option>
            </select>
          </div>
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Scope</th><th>Status</th><th>Active</th></tr></thead>
            {loading && <SkeletonRows rows={6} cols={5} />}
            {!loading && <tbody>
              {rows.map((r) => (
                <tr key={val(r, 'sys_id')} className={`click ${detail && val(detail.flow, 'sys_id') === val(r, 'sys_id') ? 'selected' : ''}`} onClick={() => open(r)}>
                  <td>{disp(r, 'name')}</td>
                  <td><span className={`badge ${val(r, 'type') === 'subflow' ? 'blue' : ''}`}>{val(r, 'type') || 'flow'}</span></td>
                  <td><ScopeBadge scope={scopeLabels[val(r, 'sys_scope')] || val(r, 'sys_scope')} name={disp(r, 'sys_scope')} /></td>
                  <td><span className="badge">{disp(r, 'status') || '—'}</span></td>
                  <td><span className={`badge ${val(r, 'active') === 'true' ? 'green' : ''}`}>{val(r, 'active') === 'true' ? 'on' : 'off'}</span></td>
                </tr>
              ))}
            </tbody>}
          </table>
          {loading && <LoadingRegion label="Loading flows" />}
          {/* "or not connected" is gone: the binding is answered before the
              page renders, so an empty list is now only an empty list. */}
          {!loading && rows.length === 0 && (
            <EmptyState
              title="No flows or subflows match."
              hint="Clear the search and type filter, or build one — NowHelpAssist authors real Flow Designer flows through the SDK."
            />
          )}
          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="card">
          {!detail ? (
            <EmptyState
              title="Nothing selected."
              hint="Pick a flow on the left to read it top-to-bottom: trigger, actions, logic and recent executions."
            />
          ) : (
            <>
              <div className="spread">
                <div className="row">
                  <h3 style={{ fontSize: 16, margin: 0 }}>{disp(detail.flow, 'name')}</h3>
                  <span className={`badge ${val(detail.flow, 'type') === 'subflow' ? 'blue' : ''}`}>
                    {val(detail.flow, 'type') || 'flow'}
                  </span>
                </div>
                <button className="btn sm" onClick={toggleActive}>
                  {val(detail.flow, 'active') === 'true' ? 'Deactivate' : 'Activate'}
                </button>
              </div>
              <p style={{ color: 'var(--muted)' }}>{disp(detail.flow, 'description') || 'No description.'}</p>
              <KV record={detail.flow} keys={['status', 'sys_scope', 'sys_created_by', 'sys_updated_on']} />

              {detail.notes?.length > 0 && detail.notes.map((n, i) => (
                <p className="note" key={i} style={{ marginTop: 8 }}>{n}</p>
              ))}

              <div className="card-title" style={{ marginTop: 14 }}>Trigger{detail.triggers.length !== 1 ? 's' : ''}</div>
              {detail.triggers.length === 0 && <div className="empty">No trigger instances.</div>}
              {detail.triggers.map((t) => (
                <div key={val(t, 'sys_id')} style={{ marginBottom: 8 }}>
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span className="badge green">{disp(t, 'trigger_type') || 'trigger'}</span>
                    {disp(t, 'name') && <span className="badge">{disp(t, 'name')}</span>}
                  </div>
                  {disp(t, 'comment') && <p style={{ margin: '2px 0 6px', fontSize: 12.5, color: 'var(--muted)' }}>{disp(t, 'comment')}</p>}
                  {t.config && Object.keys(t.config).length > 0 && (
                    <dl className="kv">
                      {Object.entries(t.config).map(([k, v]) => (
                        <div key={k} style={{ display: 'contents' }}>
                          <dt>{k}</dt>
                          <dd className={k === 'condition' || k === 'table' ? 'mono' : ''}>{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ))}

              <div className="card-title" style={{ marginTop: 14 }}>Actions ({detail.actions.length})</div>
              {detail.actions.length === 0 && <div className="empty">No action instances.</div>}
              {detail.actions.map((a) => (
                <div className="step-row" key={val(a, 'sys_id')}>
                  <div className="step-num">{disp(a, 'order') || '·'}</div>
                  <div>
                    <div className="row">
                      <span className="badge blue">{disp(a, 'action_type') || 'action'}</span>
                      {val(a, 'active') === 'false' && <span className="badge red">inactive</span>}
                    </div>
                    {disp(a, 'comment') && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>{disp(a, 'comment')}</p>}
                  </div>
                </div>
              ))}

              {detail.callers?.length > 0 && (
                <>
                  <div className="card-title" style={{ marginTop: 14 }}>Called by ({detail.callers.length})</div>
                  {detail.callers.map((c) => (
                    <div className="step-row" key={c.sys_id}>
                      <div className="step-num">·</div>
                      <div className="row">
                        <span className={`badge ${c.type === 'subflow' ? 'blue' : ''}`}>{c.type}</span>
                        <b style={{ fontSize: 13 }}>{c.name}</b>
                        {!c.active && <span className="badge red">inactive</span>}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {detail.subflowCalls?.length > 0 && (
                <>
                  <div className="card-title" style={{ marginTop: 14 }}>Calls ({detail.subflowCalls.length})</div>
                  {detail.subflowCalls.map((c) => (
                    <div className="step-row" key={val(c, 'sys_id')}>
                      <div className="step-num">{disp(c, 'order') || '·'}</div>
                      <div>
                        <div className="row">
                          <span className="badge blue">subflow</span>
                          <b style={{ fontSize: 13 }}>{disp(c, 'subflow') || disp(c, 'comment')}</b>
                          {val(c, 'wait_for_completion') === 'true' && <span className="badge">waits for completion</span>}
                        </div>
                        {c.inputs && Object.keys(c.inputs).length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            {Object.entries(c.inputs).map(([k, v]) => (
                              <span key={k} className="badge mono" style={{ marginRight: 4 }}>{k} = {String(v)}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {detail.logic.length > 0 && (
                <>
                  <div className="card-title" style={{ marginTop: 14 }}>Flow logic</div>
                  {detail.logic.map((l) => (
                    <div className="step-row" key={val(l, 'sys_id')}>
                      <div className="step-num">{disp(l, 'order') || '·'}</div>
                      <div>
                        <span className="badge amber">{disp(l, 'logic_definition') || 'logic'}</span>
                        {disp(l, 'comment') && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>{disp(l, 'comment')}</p>}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {detail.sourceTables && (
                <p className="mono" style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)' }}>
                  read from {detail.sourceTables.family} tables · {detail.sourceTables.triggers} · {detail.sourceTables.actions} · {detail.sourceTables.logic}
                  {detail.sourceTables.subflows ? ` · ${detail.sourceTables.subflows}` : ''}
                </p>
              )}

              <div className="card-title" style={{ marginTop: 14 }}>Recent executions</div>
              {execs.length === 0 && <div className="empty">No execution contexts found.</div>}
              {execs.length > 0 && (
                <table className="table">
                  <thead><tr><th>State</th><th>Started</th><th>Context</th></tr></thead>
                  <tbody>
                    {execs.map((e) => (
                      <tr key={val(e, 'sys_id')}>
                        <td><span className={`badge ${disp(e, 'state')?.toLowerCase().includes('complete') ? 'green' : ''}`}>{disp(e, 'state') || '—'}</span></td>
                        <td className="mono" style={{ fontSize: 11.5 }}>{disp(e, 'sys_created_on')}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{val(e, 'sys_id').slice(0, 12)}…</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
