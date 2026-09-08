import { useCallback, useEffect, useRef, useState } from 'react';
import { api, sse } from '../api.js';
import { toast } from '../components/toast.js';
import { confirmDestructive } from '../components/confirm.js';
import { SkeletonRows, LoadingRegion, EmptyState } from '../components/states.jsx';
import MeetingFindings from '../components/MeetingFindings.jsx';
import MeetingHandoff from '../components/MeetingHandoff.jsx';
import { useHealth } from '../hooks/useHealth.js';

const dim = { color: 'var(--muted)' };
const dimSmall = { color: 'var(--muted)', fontSize: 12 };

/** ms → m:ss, the only duration format on this page. */
function clock(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function bytesLabel(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * The capture agent's status.
 *
 * An absent agent is the normal state before setup, not an error, so it renders
 * as the commands that fix it — the same shape the Flows page uses for an
 * absent SDK. Nothing is listening, and the page says exactly that.
 */
function AgentBanner({ cap, onRefresh }) {
  if (!cap) return null;
  const a = cap.agent || {};
  return (
    <div className={`note${cap.ok ? '' : ' warn'}`}>
      <div className="spread">
        <div>
          {cap.ok ? (
            <>
              <b>Capture agent connected</b> — v{a.version || '?'} · VAD {a.vad || '?'} ·{' '}
              {a.detecting ? 'listening for meetings' : 'detection paused'}
              {a.activeMeeting ? ' · recording now' : ''}
              {a.devices ? (
                <div className="mono" style={dimSmall}>
                  mic: {a.devices.mic || '—'} · system: {a.devices.system || '—'}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <b>No capture agent is running — nothing is listening for meetings.</b>
              <pre className="mono" style={{ ...dimSmall, whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
                {(cap.fixes || []).join('\n')}
              </pre>
              {cap.lastSeenMs != null ? (
                <div style={dimSmall}>Last seen {clock(cap.lastSeenMs)} ago.</div>
              ) : null}
            </>
          )}
        </div>
        <button className="btn ghost sm" onClick={onRefresh}>Refresh</button>
      </div>
    </div>
  );
}

/**
 * The transcription meter.
 *
 * `measuredRtf` is what this machine has ACTUALLY achieved, not what a model is
 * rated at. Below 1.0 means transcription is slower than speech is arriving and
 * the transcript will keep falling further behind - which is the one number
 * that decides whether live transcription works on a given laptop, so it is on
 * the page rather than in a log nobody reads.
 */
function SttMeter({ stt }) {
  if (!stt) return null;
  const q = stt.queue || {};
  if (!stt.ok) {
    return (
      <div className="note warn">
        <b>Transcription sidecar is not running.</b> Utterances are still being captured
        and nothing is lost - they will transcribe when it starts.
        <div className="mono" style={dimSmall}>{stt.reason}</div>
      </div>
    );
  }
  const behind = q.backlogMs > 0;
  return (
    <div className={`note${q.downgraded ? ' warn' : ''}`}>
      <div className="row">
        <span>
          <b>Transcribing</b> with <span className="mono">{q.model}</span>
          {q.downgraded && (
            <> - <b>downgraded</b> from <span className="mono">{q.liveModel}</span> to catch up.
            {' '}Accuracy on domain words is lower until the backlog clears.</>
          )}
        </span>
        <span className="mono" style={dimSmall}>
          {q.measuredRtf != null ? `${q.measuredRtf}x realtime` : 'no timing yet'}
          {' · '}{q.completed} done
          {q.failed ? ` · ${q.failed} FAILED` : ''}
          {behind ? ` · ${Math.round(q.backlogMs / 1000)}s behind` : ' · up to date'}
        </span>
      </div>
      {q.measuredRtf != null && q.measuredRtf < 1 && (
        <div style={dimSmall}>
          Below 1x means transcription is slower than speech arrives. The transcript will
          keep falling behind on this machine.
        </div>
      )}
      {q.lastError && <div className="mono" style={dimSmall}>last error: {q.lastError}</div>}
    </div>
  );
}

/**
 * The honest consequence of user-confirmed deletion: a meeting nobody opens
 * keeps its audio forever. The number is permanent on the page rather than
 * quietly growing on disk.
 */
function PendingAudio({ pending }) {
  if (!pending || !pending.count) return null;
  return (
    <div className="note">
      <b>{pending.count} meeting{pending.count === 1 ? '' : 's'} holding {bytesLabel(pending.bytes)} of audio.</b>{' '}
      Recordings are deleted when you confirm the transcript, so a meeting you never open keeps its audio.
    </div>
  );
}

function transcriptCell(s) {
  if (s.stt_state === 'failed') {
    return <span className="error-text" title={s.stt_error || ''}>transcription failed - {s.stt_error || 'unknown error'}</span>;
  }
  if (s.stt_state === 'low') {
    // Shown, not hidden. A real sentence spoken over noise fails Whisper's
    // confidence checks, and a blank row would read as "nobody spoke".
    return (
      <span title={s.stt_error || ''}>
        <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{s.text}</span>
        <span className="badge amber" style={{ marginLeft: 6 }}>unclear</span>
      </span>
    );
  }
  if (s.text) return s.text;
  if (s.stt_state === 'empty') {
    // A transcript Whisper produced but that failed its own confidence checks
    // is NOT silence, and saying "no speech found" for it would hide that the
    // model wrote a sentence nobody said.
    return <span style={dimSmall}>{s.stt_error ? s.stt_error : '(no speech found)'}</span>;
  }
  return <span style={dimSmall}>transcribing...</span>;
}

function MeetingDetail({ id, onBack, onChanged }) {
  // Building needs a bound instance; capture and review do not. The shared
  // poller is the single answer to "is an instance bound" across the whole app.
  const { connected } = useHealth();
  const [meeting, setMeeting] = useState(null);
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
  const [stt, setStt] = useState(null);
  const [findings, setFindings] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const audioRef = useRef(null);
  const rowRefs = useRef({});

  const loadFindings = useCallback(async () => {
    try { setFindings(await api.get(`/meetings/${id}/findings`)); }
    catch { /* the findings panel is never load-bearing for the transcript */ }
  }, [id]);

  const load = useCallback(async () => {
    try {
      const m = await api.get(`/meetings/${id}`);
      setMeeting(m);
      setSegments(m.segments || []);
      loadFindings();
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, loadFindings]);

  useEffect(() => { load(); }, [load]);

  /*
   * The queue meter. Polled rather than pushed for the un-streamed case: a
   * meeting that has already ENDED still has utterances transcribing, and it
   * has no SSE stream open, so without this the transcript would silently stop
   * filling in and look finished when it was not.
   */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const out = await api.get('/meetings/stt/status');
        if (alive) setStt({ ...out.sidecar, queue: out.queue });
      } catch { /* the meter is never load-bearing */ }
    };
    tick();
    const t = setInterval(() => {
      tick();
      // Cheap and self-limiting: only re-read the rows while some are pending.
      if (segments.some((x) => x.stt_state === 'pending')) load();
    }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [segments, load]);

  /*
   * Live updates while a meeting is still recording.
   *
   * Uses the shared `sse` reader, so a stream that dies mid-meeting throws in
   * the same place every other stream in this app does — rather than the page
   * quietly ceasing to update, which is indistinguishable from a meeting where
   * nobody spoke.
   */
  useEffect(() => {
    if (!meeting || meeting.status !== 'recording') return undefined;
    let cancelled = false;
    sse(`/meetings/${id}/stream`, null, (evt) => {
      if (cancelled) return;
      if (evt.type === 'hello') { setSegments(evt.segments || []); return; }
      if (evt.type === 'segment') {
        setSegments((prev) => {
          const next = prev.filter((s) => s.idx !== evt.segment.idx).concat(evt.segment);
          // Time order, never arrival order — two tracks close out of sequence.
          next.sort((a, b) => a.start_ms - b.start_ms || a.idx - b.idx);
          return next;
        });
      }
      if (evt.type === 'segment_text') {
        setSegments((prev) => prev.map((x) => (x.idx === evt.segment.idx ? evt.segment : x)));
        if (evt.stt) setStt((cur) => ({ ...(cur || {}), ok: true, queue: evt.stt }));
      }
      if (evt.type === 'findings' || evt.type === 'understanding_error') loadFindings();
      if (evt.type === 'done') load();
    }, 'GET').catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [id, meeting, load]);

  // A playing <audio> holds the file open, which is exactly what makes a later
  // delete fail on Windows. Stop it when this view goes away.
  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, []);

  /**
   * Clicking a quote jumps to the utterance it came from.
   *
   * This is what makes the evidence auditable rather than decorative: the whole
   * claim of this module is that a requirement can be traced to words somebody
   * actually said, and that is only true if you can get to them in one click.
   */
  const jumpTo = (segIdx) => {
    setHighlight(segIdx);
    rowRefs.current[segIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => setHighlight((cur) => (cur === segIdx ? null : cur)), 2500);
  };

  const play = (seg) => {
    audioRef.current?.pause();
    const a = new Audio(`/api/meetings/${id}/segment/${seg.idx}/audio`);
    audioRef.current = a;
    setPlaying(seg.idx);
    a.onended = () => setPlaying(null);
    a.onerror = () => {
      setPlaying(null);
      toast.error('That utterance could not be played — the file may already be deleted.');
    };
    a.play().catch((err) => { setPlaying(null); toast.error(err.message); });
  };

  const confirm = async () => {
    audioRef.current?.pause();
    audioRef.current = null;
    const ok = await confirmDestructive({
      action: 'Confirm transcript and delete audio',
      subject: meeting.title || 'Untitled meeting',
      sysId: meeting.id,
      detail:
        `This freezes the meeting and permanently deletes its ${segments.length} audio file`
        + `${segments.length === 1 ? '' : 's'} (${bytesLabel(meeting.audio_bytes)}). `
        + 'The transcript becomes the only record of what was said, which is what makes a later '
        + 'evidence citation point at something that can no longer change.',
      confirmLabel: 'Confirm and delete audio',
    });
    if (!ok) return;
    try {
      const out = await api.post(`/meetings/${id}/confirm`, {});
      if (out.deletion?.ok) {
        toast.success(`Transcript confirmed. ${bytesLabel(out.deletion.bytesFreed)} of audio deleted.`);
      } else {
        // A partial delete must never read as success — the files it left
        // behind are voice recordings the user believes are gone.
        toast.error(
          `Transcript confirmed, but ${out.deletion.remaining.length} audio file(s) could NOT be deleted `
          + `(${out.deletion.reason}). They are still on disk. Close anything playing them, then confirm again.`
        );
      }
      await load();
      onChanged?.();
    } catch (err) { toast.error(err.message); }
  };

  const discard = async () => {
    audioRef.current?.pause();
    audioRef.current = null;
    const ok = await confirmDestructive({
      action: 'Discard meeting',
      subject: meeting.title || 'Untitled meeting',
      sysId: meeting.id,
      detail: 'Deletes the recording and everything captured from it. This cannot be undone.',
      confirmLabel: 'Discard meeting',
    });
    if (!ok) return;
    try {
      await api.del(`/meetings/${id}`);
      toast.success('Meeting discarded.');
      onChanged?.();
      onBack();
    } catch (err) { toast.error(err.message); }
  };

  if (loading) return <div className="card"><LoadingRegion label="Loading meeting" /><SkeletonRows rows={4} cols={8} /></div>;
  if (!meeting) return <div className="card"><EmptyState title="No such meeting." hint={error} /></div>;

  const speech = segments.reduce((a, s) => a + (s.end_ms - s.start_ms), 0);
  const mic = segments.filter((s) => s.track === 'mic').length;

  return (
    <div className="stack">
      <SttMeter stt={stt} />
      <div className="card">
        <div className="spread" style={{ marginBottom: 12 }}>
          <div className="row">
            <button className="btn ghost sm" onClick={onBack}>← All meetings</button>
            <b style={{ fontSize: 15 }}>{meeting.title || 'Untitled meeting'}</b>
            <span className={`badge ${meeting.status === 'recording' ? 'blue' : ''}`}>{meeting.status}</span>
          </div>
          <div className="row">
            {meeting.status === 'captured' && (
              <button className="btn primary sm" onClick={confirm}>Confirm transcript &amp; delete audio</button>
            )}
            {meeting.status !== 'discarded' && (
              <button className="btn danger sm" onClick={discard}>Discard</button>
            )}
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <dl className="kv">
          <dt>Source</dt><dd className="mono">{meeting.source_app || '—'}{meeting.source_pid ? ` (pid ${meeting.source_pid})` : ''}</dd>
          <dt>Started</dt><dd className="mono">{new Date(meeting.started).toLocaleString()}</dd>
          <dt>Duration</dt><dd className="mono">{clock(meeting.duration_ms)}</dd>
          <dt>Speech captured</dt><dd className="mono">{clock(speech)} across {segments.length} utterances ({mic} yours, {segments.length - mic} theirs)</dd>
          <dt>Audio on disk</dt><dd className="mono utterance-text">{meeting.audio_dir ? `${bytesLabel(meeting.audio_bytes)} — ${meeting.audio_dir}` : 'deleted'}</dd>
          <dt>Detected by</dt><dd className="mono">{meeting.detected_by}</dd>
          <dt>Instance at capture</dt><dd className="mono">{meeting.instance || '—'}</dd>
        </dl>

        {meeting.confirmed && !meeting.audio_deleted ? (
          <div className="note warn" style={{ marginTop: 12 }}>
            <b>Audio was NOT fully deleted.</b> Files remain in <span className="mono">{meeting.audio_dir}</span>.
            Close anything playing them, then confirm again.
          </div>
        ) : null}
      </div>

      <MeetingFindings
        meetingId={id}
        data={findings}
        onReload={loadFindings}
        onJump={jumpTo}
      />

      {/* Below the findings on purpose: confirm what was said, THEN hand it
          over. The building itself happens in the agent, which already has the
          approval gate and can be argued with mid-build. */}
      <MeetingHandoff meetingId={id} connected={connected} />

      <div className="card">
        <div className="card-title">Utterances</div>
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="tight">#</th><th className="tight">Track</th><th className="tight">At</th>
              <th className="tight">Length</th><th className="tight">RMS</th><th className="tight">Size</th>
              <th className="tight">Audio</th><th>Transcript</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr
                key={s.idx}
                ref={(el) => { rowRefs.current[s.idx] = el; }}
                className={playing === s.idx || highlight === s.idx ? 'selected' : ''}
              >
                <td className="mono tight">{s.idx}</td>
                <td className="tight"><span className={`badge ${s.track === 'mic' ? 'blue' : ''}`}>{s.track === 'mic' ? 'you' : 'them'}</span></td>
                <td className="mono tight">{clock(s.start_ms)}</td>
                <td className="mono tight">{((s.end_ms - s.start_ms) / 1000).toFixed(1)}s</td>
                <td className="mono tight">{s.rms == null ? '—' : s.rms.toFixed(3)}</td>
                <td className="mono tight">{bytesLabel(s.bytes)}</td>
                <td className="tight">
                  {s.audio_path
                    ? <button className="btn ghost sm" onClick={() => play(s)}>{playing === s.idx ? 'Playing…' : 'Play'}</button>
                    : <span style={dimSmall}>deleted</span>}
                </td>
                {/* Three different things look like an empty transcript and
                    they must not read the same: still queued, genuinely
                    silent, and FAILED. A failure rendered as a blank line is a
                    hole in the transcript that a requirement may have been in. */}
                <td className="grow utterance-text">{transcriptCell(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {segments.length === 0 && (
          <EmptyState
            title="Nothing was captured."
            hint="If the meeting was silent, that is the correct result. If it was not, run `python -m meeting_agent.diagnose` to check which devices the agent picked."
          />
        )}
      </div>
    </div>
  );
}

export default function Meetings() {
  const [cap, setCap] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const loadCap = useCallback(async () => {
    try { setCap(await api.get('/meetings/capability')); } catch (err) { setError(err.message); }
  }, []);

  const loadList = useCallback(async () => {
    try { setData(await api.get('/meetings')); setError(''); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCap(); loadList(); }, [loadCap, loadList]);

  /*
   * The agent's presence changes with no user action, so it is polled. The
   * meeting list is not: it changes only when a meeting starts or ends, and a
   * recording meeting has its own live stream in the detail view.
   */
  useEffect(() => {
    const t = setInterval(() => { loadCap(); loadList(); }, 10_000);
    return () => clearInterval(t);
  }, [loadCap, loadList]);

  if (selected) {
    return (
      <MeetingDetail
        id={selected}
        onBack={() => setSelected(null)}
        onChanged={() => { loadList(); loadCap(); }}
      />
    );
  }

  return (
    <div className="stack">
      <AgentBanner cap={cap} onRefresh={() => { loadCap(); loadList(); }} />
      <SttMeter stt={cap?.stt} />
      <PendingAudio pending={data?.pendingAudio} />

      <div className="card">
        <div className="card-title">Meetings</div>
        {error && <p className="error-text">{error}</p>}
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Meeting</th><th className="tight">Source</th><th className="tight">Started</th>
              <th className="tight">Duration</th><th className="tight">Speech</th>
              <th className="tight">Utterances</th><th className="tight">Audio</th><th className="tight">Status</th>
            </tr>
          </thead>
          {loading && <SkeletonRows rows={5} cols={8} />}
          {!loading && (
            <tbody>
              {(data?.meetings || []).map((m) => (
                <tr key={m.id} className="click" onClick={() => setSelected(m.id)}>
                  <td className="grow">{m.title || <span style={dim}>Untitled meeting</span>}</td>
                  <td className="mono tight">{m.source_app || '—'}</td>
                  <td className="mono tight">{new Date(m.started).toLocaleString()}</td>
                  <td className="mono tight">{clock(m.duration_ms)}</td>
                  <td className="mono tight">{clock(m.speech_ms)}</td>
                  <td className="mono tight">{m.segments}</td>
                  <td className="mono tight">{m.audio_dir ? bytesLabel(m.audio_bytes) : 'deleted'}</td>
                  <td className="tight"><span className={`badge ${m.status === 'recording' ? 'blue' : ''}`}>{m.status}</span></td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        </div>
        {loading && <LoadingRegion label="Loading meetings" />}
        {!loading && !data?.meetings?.length && !error && (
          <EmptyState
            title="No meetings captured yet."
            hint="Start the capture agent, then join a call. A meeting appears here on its own — you do not have to press anything."
          />
        )}
      </div>
    </div>
  );
}
