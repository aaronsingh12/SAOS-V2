import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { toast } from './toast.js';

/**
 * "Build this with the agent."
 *
 * This replaced a build-plan stage that lived here and did its own
 * orchestration. That was the wrong shape: the agent already has the approval
 * gate, the whole tool registry, the mutation ledger and the iteration budget —
 * and, unlike a plan screen, it can be argued with. "Actually make that the
 * department head" is a sentence in a chat and a re-plan anywhere else.
 *
 * So this screen hands over and gets out of the way. It shows exactly what will
 * be sent, opens the chat, and puts the brief in the composer rather than
 * sending it — a transcript is a lossy record of what people meant, and the
 * cheapest moment to fix one is before a tool has run.
 */

const dimSmall = { color: 'var(--muted)', fontSize: 12 };

export default function MeetingHandoff({ meetingId, connected }) {
  const navigate = useNavigate();
  const [brief, setBrief] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setBrief(await api.get(`/meetings/${meetingId}/brief`)); }
    catch { /* the brief is a preview; the page works without it */ }
  }, [meetingId]);

  useEffect(() => { load(); }, [load]);

  const confirmed = brief?.counts?.confirmed || 0;
  const requirements = brief?.requirements || 0;
  const openQuestions = brief?.openQuestions || 0;

  const hand = async () => {
    setBusy(true);
    try {
      const out = await api.post(`/meetings/${meetingId}/handoff`, {});
      toast.success(out.reused
        ? 'Reopened the agent chat for this meeting.'
        : 'Opened an agent chat with these requirements.');
      // The brief is fetched again by the chat itself, so a refresh there does
      // not lose it. Only the session id travels.
      navigate(`/agent?session=${encodeURIComponent(out.session.id)}`);
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="card handoff-card">
      <div className="spread" style={{ marginBottom: 8 }}>
        <div className="card-title" style={{ margin: 0 }}>Build this</div>
        <div className="row" style={{ gap: 8 }}>
          <span style={dimSmall}>
            {confirmed
              ? `${requirements} requirement${requirements === 1 ? '' : 's'} confirmed`
              : 'nothing confirmed yet'}
            {openQuestions ? ` · ${openQuestions} open question${openQuestions === 1 ? '' : 's'}` : ''}
          </span>
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)} disabled={!confirmed}>
            {open ? 'Hide brief' : 'Preview brief'}
          </button>
          <button className="btn primary sm" onClick={hand} disabled={!confirmed || busy}>
            {busy ? 'Opening…' : 'Build with the agent →'}
          </button>
        </div>
      </div>

      {!confirmed ? (
        <div style={dimSmall}>
          Confirm the requirements above first. Only confirmed findings are handed over — and for
          anything the model proposed, only the ones whose quote was found in the transcript.
        </div>
      ) : (
        <div style={dimSmall}>
          Opens an agent chat with these requirements in the composer. Nothing is sent and nothing is
          written until you read it and press send — and every write still stops at the approval card.
          {!connected && ' No instance is bound yet, so the agent will not be able to build until you connect one.'}
        </div>
      )}

      {open && brief && (
        <pre className="handoff-brief mono">{brief.text}</pre>
      )}
    </div>
  );
}
