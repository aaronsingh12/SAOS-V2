import { useState } from 'react';
import { api } from '../api.js';
import { toast } from './toast.js';
import { EmptyState } from './states.jsx';

/**
 * The review screen: "here is what NowHelpAssist understood."
 *
 * The user's job is to VALIDATE the understanding, not to do the extraction —
 * so every control is confirm, correct, reject, or add-what-was-missed.
 *
 * The evidence chip is not decoration. A finding the model could not back up
 * with words that actually appear in the transcript renders as UNVERIFIED and
 * can never reach the build stage. The chip is the difference between "the AI
 * says this was asked for" and "someone said this, and here is where".
 */

const dimSmall = { color: 'var(--muted)', fontSize: 12 };

const KIND_LABEL = {
  requirement: 'Requirements',
  decision: 'Decisions',
  criterion: 'Acceptance criteria',
  question: 'Open questions',
  assumption: 'Assumptions',
};
const KIND_ORDER = ['requirement', 'decision', 'criterion', 'question', 'assumption'];

function Finding({ f, onUpdate, onDelete, onJump }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.edited_text || f.text);
  const shown = f.edited_text || f.text;
  const done = f.status === 'confirmed';
  const dropped = f.status === 'rejected';

  return (
    <div className="card" style={{ padding: 10, marginBottom: 8, opacity: dropped ? 0.55 : 1 }}>
      <div className="finding">
        <div className="finding-body">
          {editing ? (
            <textarea
              className="textarea"
              rows={2}
              style={{ width: '100%' }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <div className="utterance-text" style={{ textDecoration: dropped ? 'line-through' : 'none' }}>{shown}</div>
          )}

          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            {f.origin === 'human' ? (
              <span className="badge blue">added by you</span>
            ) : f.verified ? (
              <span className="badge green">evidence checked</span>
            ) : (
              <span className="badge red" title="The model could not quote anything in the transcript to support this. It will not be built.">
                UNVERIFIED
              </span>
            )}
            {done && <span className="badge green">confirmed</span>}
            {dropped && <span className="badge">rejected</span>}
            {f.confidence && <span className="badge">{f.confidence}</span>}
            {f.edited_text && <span className="badge amber">edited</span>}
          </div>

          {f.evidence.length > 0 && (
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              {f.evidence.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`quote-chip${e.verified ? '' : ' bad'}`}
                  title={e.verified ? `Utterance ${e.seg_idx} — click to jump to it` : e.reason || 'unverified'}
                  onClick={() => e.verified && onJump(e.seg_idx)}
                >
                  {/* The whole quote, wrapped. Truncating it defeated the point:
                      the quote IS the evidence, and a clipped one cannot be
                      checked against the transcript by eye. */}
                  {e.verified ? `“${e.quote}”` : `not in the transcript — ${e.reason || 'unverified'}`}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="finding-actions">
          {editing ? (
            <>
              <button
                className="btn primary sm"
                onClick={() => { onUpdate(f.id, { text: draft, status: 'confirmed' }); setEditing(false); }}
              >
                Save
              </button>
              <button className="btn ghost sm" onClick={() => { setDraft(shown); setEditing(false); }}>Cancel</button>
            </>
          ) : (
            <>
              {!done && <button className="btn primary sm" onClick={() => onUpdate(f.id, { status: 'confirmed' })}>Confirm</button>}
              <button className="btn ghost sm" onClick={() => setEditing(true)}>Edit</button>
              {!dropped ? (
                <button className="btn ghost sm" onClick={() => onUpdate(f.id, { status: 'rejected' })}>Reject</button>
              ) : (
                <button className="btn ghost sm" onClick={() => onUpdate(f.id, { status: 'proposed' })}>Restore</button>
              )}
              {f.origin === 'human' && <button className="btn danger sm" onClick={() => onDelete(f.id)}>Delete</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MeetingFindings({ meetingId, data, onReload, onJump }) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('requirement');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const findings = data?.findings || [];
  const u = data?.understanding || {};
  const counts = data?.approved?.counts || {};

  const update = async (id, patch) => {
    try { await api.patch(`/meetings/${meetingId}/findings/${id}`, patch); onReload(); }
    catch (err) { toast.error(err.message); }
  };
  const remove = async (id) => {
    try { await api.del(`/meetings/${meetingId}/findings/${id}`); onReload(); }
    catch (err) { toast.error(err.message); }
  };
  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.post(`/meetings/${meetingId}/findings`, { kind, text });
      setText(''); setAdding(false); onReload();
    } catch (err) { toast.error(err.message); }
  };
  const readNow = async () => {
    setBusy(true);
    try {
      const out = await api.post(`/meetings/${meetingId}/understand`, {});
      if (out.ok) {
        toast.success(
          `Read ${out.read} utterances — ${out.backed} evidence-backed`
          + (out.rejected ? `, ${out.rejected} discarded for citing nothing that was said` : '')
        );
      } else {
        toast.error(out.error || 'The understanding pass failed.');
      }
      onReload();
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ margin: 0 }}>What the meeting meant</div>
        <div className="row" style={{ gap: 8 }}>
          <span style={dimSmall}>
            {u.passes ? `${u.passes} pass${u.passes === 1 ? '' : 'es'}` : 'not read yet'}
            {u.pendingMs > 0 ? ` · ${Math.round(u.pendingMs / 1000)}s unread` : ''}
            {counts.unverified ? ` · ${counts.unverified} unverified` : ''}
          </span>
          <button className="btn ghost sm" disabled={busy || u.state === 'running'} onClick={readNow}>
            {busy || u.state === 'running' ? 'Reading…' : 'Read transcript now'}
          </button>
          <button className="btn ghost sm" onClick={() => setAdding((v) => !v)}>Add</button>
        </div>
      </div>

      {u.error && <p className="error-text">{u.error}</p>}

      {adding && (
        <div className="row" style={{ marginBottom: 10, gap: 6 }}>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KIND_ORDER.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Something the meeting covered that is missing above…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn primary sm" onClick={add}>Add</button>
        </div>
      )}

      {!findings.length ? (
        <EmptyState
          title="Nothing extracted yet."
          hint={u.pendingMs > 0
            ? `${Math.round(u.pendingMs / 1000)}s of transcript is waiting to be read. This runs on its own during a meeting — or press "Read transcript now".`
            : 'Findings appear here by themselves while a meeting is running. Small talk correctly produces none.'}
        />
      ) : (
        KIND_ORDER.map((k) => {
          const group = findings.filter((f) => f.kind === k);
          if (!group.length) return null;
          return (
            <div key={k} style={{ marginBottom: 14 }}>
              <div style={{ ...dimSmall, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                {KIND_LABEL[k]} ({group.length})
              </div>
              {group.map((f) => (
                <Finding key={f.id} f={f} onUpdate={update} onDelete={remove} onJump={onJump} />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
