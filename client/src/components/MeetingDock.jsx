import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { toast } from './toast.js';

/**
 * M6 — the capture controls, on every page.
 *
 * Both Python processes used to be started by hand in two terminals, so meeting
 * capture worked only when someone remembered to start it and left the windows
 * open. This is the button, and it is deliberately app-wide rather than on the
 * Meetings page: you start recording BEFORE you go and look at meetings, and a
 * control that lives where you end up is a control you reach too late.
 *
 * WHAT IT MUST NEVER DO IS LOOK GREEN WHEN NOTHING IS LISTENING. The server
 * reports two separate facts per process — `managed` (we spawned it, its pid is
 * alive) and `live` (the agent is heartbeating / the sidecar answers /health) —
 * and this renders the SECOND one as the status, because a process that crashed
 * on an import error satisfies the first for a while. `managed` only decides
 * whether Stop is offered, since we can only stop what we started.
 *
 * RECORDING IS THE LOUD STATE. When a meeting is being captured the pill turns
 * red and says so on every page, because a tool that records meetings must
 * never be ambiguous about whether it is recording.
 */

const POLL_OPEN_MS = 4000;
const POLL_SHUT_MS = 15_000;

/** Collapsed-pill summary. The order is the priority: recording first. */
function summarise(s) {
  if (!s) return { tone: 'idle', dot: '', text: 'Capture' };
  if (s.activeMeeting) return { tone: 'rec', dot: 'bad', text: 'Recording' };
  if (s.live?.agent && s.live?.stt) return { tone: 'on', dot: 'on', text: 'Listening' };
  if (s.live?.agent) return { tone: 'warn', dot: 'warn', text: 'Listening · no STT' };
  // A managed process that is not live yet is starting; one that is not managed
  // either is simply off. These read very differently to someone waiting.
  const starting = s.processes?.some((p) => p.managed) && !s.live?.agent;
  if (starting) return { tone: 'busy', dot: 'busy', text: 'Starting…' };
  return { tone: 'idle', dot: '', text: 'Capture off' };
}

function ProcessRow({ proc, live, foreign, busy, onStart, onStop }) {
  /*
   * Four states, kept apart because conflating them is how a UI lies:
   *   live + managed   -> running, ours, stoppable
   *   live + foreign   -> running, someone else's terminal: no buttons, and say so
   *   managed, not live-> spawned but not answering yet, or crashed
   *   neither          -> off
   */
  const state = live
    ? (foreign ? 'external' : 'running')
    : (proc.managed ? (proc.stopping ? 'stopping' : 'starting') : 'off');

  const LABEL = {
    running: { text: 'running', dot: 'on' },
    external: { text: 'running (started elsewhere)', dot: 'warn' },
    starting: { text: 'starting…', dot: 'busy' },
    stopping: { text: 'stopping…', dot: 'busy' },
    off: { text: 'not running', dot: '' },
  }[state];

  const died = !proc.managed && proc.lastExit && !proc.lastExit.requested;

  return (
    <div className="dock-row">
      <div className="dock-row-head">
        <span className={`dot ${LABEL.dot}`} />
        <span className="dock-row-name">{proc.label}</span>
        <span className="dock-row-state">{LABEL.text}</span>
        {state === 'running' && proc.pid ? <span className="badge mono">pid {proc.pid}</span> : null}
        {state === 'off' || state === 'starting'
          ? (
            <button className="btn sm primary" disabled={busy || state === 'starting'} onClick={onStart}>
              Start
            </button>
          )
          : null}
        {state === 'running' || state === 'stopping'
          ? (
            <button className="btn sm danger" disabled={busy || state === 'stopping'} onClick={onStop}>
              Stop
            </button>
          )
          : null}
      </div>
      <div className="dock-row-what">{proc.what}</div>
      {state === 'external' && (
        // No Stop button: we did not spawn it and have no safe handle on it.
        // Saying that is more useful than a button that cannot work.
        <div className="dock-note warn">
          Started outside this app, so it cannot be stopped from here. Use Ctrl-C in that terminal.
        </div>
      )}
      {state === 'stopping' && proc.graceful && (
        <div className="dock-note">Finishing the current meeting before it exits — this can take a few seconds.</div>
      )}
      {died && (
        // The most important line in the whole panel: it started, and then it
        // stopped on its own. The reason is in the output.
        <div className="dock-note bad">
          Exited on its own (code {String(proc.lastExit.code)}). See the output below.
        </div>
      )}
    </div>
  );
}

export default function MeetingDock() {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(null);
  const [showOut, setShowOut] = useState(null);
  const [lines, setLines] = useState([]);
  // A failed poll must not blank a panel the user is reading, so the last good
  // snapshot stays on screen and the failure is shown beside it.
  const [pollError, setPollError] = useState(null);
  const timer = useRef(null);

  const poll = useCallback(async () => {
    try {
      setSnap(await api.get('/meetings/processes'));
      setPollError(null);
    } catch (err) {
      setPollError(err.message);
    }
  }, []);

  useEffect(() => {
    poll();
    timer.current = setInterval(poll, open ? POLL_OPEN_MS : POLL_SHUT_MS);
    return () => clearInterval(timer.current);
  }, [poll, open]);

  // The output pane is only refreshed while it is open — it is the largest
  // response here and nobody is reading it the rest of the time.
  useEffect(() => {
    if (!showOut) { setLines([]); return undefined; }
    let alive = true;
    const load = () => api.get(`/meetings/processes/${showOut}/output`)
      .then((r) => { if (alive) setLines(r.lines || []); })
      .catch(() => { /* the panel below says the poll failed */ });
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [showOut]);

  const act = async (name, verb) => {
    setBusy(name);
    try {
      await api.post(`/meetings/processes/${name}/${verb}`, {});
      // Immediate, so the row moves the moment the button is pressed rather
      // than at the next poll tick.
      await poll();
      if (verb === 'stop') toast.info('Stopping — it will finish the current meeting first.');
    } catch (err) {
      // Refusals arrive here with their fix lines already in the message.
      toast.error(err.message);
      // A refusal usually means the world is not what the panel showed.
      await poll();
      setShowOut(name);
    } finally {
      setBusy(null);
    }
  };

  // Nothing to control: this build does not ship the agent. Rendering a dead
  // widget on every page would be worse than rendering nothing.
  if (snap && !snap.available) return null;

  const sum = summarise(snap);
  const pyBroken = snap && !snap.python?.ok;

  return (
    <div className={`dock${open ? ' open' : ''}`}>
      {open && snap && (
        <div className="dock-panel">
          <div className="dock-head">
            <span className="dock-title">Meeting capture</span>
            <a className="dock-link" href="/meetings">Meetings →</a>
            <button className="dock-x" onClick={() => setOpen(false)} aria-label="Collapse">×</button>
          </div>

          {snap.activeMeeting && (
            <div className="dock-note rec">Recording a meeting right now.</div>
          )}

          {pyBroken && (
            /* The setup step, stated as one — not as a runtime error after a
               button press. Whitespace is preserved so the commands stay on
               their own lines. */
            <div className="dock-note bad dock-pre">
              {snap.python.reason}
              {'\n'}
              {(snap.python.fixes || []).join('\n')}
            </div>
          )}

          {snap.processes.map((p) => (
            <ProcessRow
              key={p.name}
              proc={p}
              live={snap.live?.[p.name]}
              foreign={snap.foreign?.[p.name]}
              busy={busy === p.name || pyBroken}
              onStart={() => act(p.name, 'start')}
              onStop={() => act(p.name, 'stop')}
            />
          ))}

          <div className="dock-foot">
            <button
              className="btn sm ghost"
              onClick={() => setShowOut(showOut ? null : (snap.processes[0]?.name || 'agent'))}
            >
              {showOut ? 'Hide output' : 'Show output'}
            </button>
            {showOut && snap.processes.map((p) => (
              <button
                key={p.name}
                className={`btn sm ghost${showOut === p.name ? ' primary' : ''}`}
                onClick={() => setShowOut(p.name)}
              >
                {p.name}
              </button>
            ))}
          </div>

          {showOut && (
            <pre className="dock-out">
              {lines.length
                ? lines.map((l, i) => `${l.stream === 'err' ? '! ' : ''}${l.line}`).join('\n')
                : 'no output yet'}
            </pre>
          )}

          {pollError && <div className="dock-note warn">Status is stale — {pollError}</div>}
        </div>
      )}

      <button
        className={`dock-pill tone-${sum.tone}`}
        onClick={() => setOpen((v) => !v)}
        title="Meeting capture — start or stop the recorder"
      >
        <span className={`dot ${sum.dot}`} />
        {sum.text}
      </button>
    </div>
  );
}
