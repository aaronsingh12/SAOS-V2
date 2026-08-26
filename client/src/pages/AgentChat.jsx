import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, sse } from '../api.js';
import { useHealth } from '../hooks/useHealth.js';
import Markdown from '../components/Markdown.jsx';
import { confirmDestructive, promptFor, CONSEQUENCE } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import { SkeletonLines, LoadingRegion, EmptyState, DisconnectedBanner } from '../components/states.jsx';
import ScopeBadge from '../components/ScopeBadge.jsx';
import ImpersonationChip from '../components/ImpersonationChip.jsx';
import { writeOutcome, captureReason, approvalProvenance } from '../components/writeOutcome.js';
import { elevationOutcome } from '../components/elevationOutcome.js';

const SAMPLES = [
  'Create a "Laptop Request" catalog item with 6 sensible variables including a reference to sys_user and a model select box',
  'Show me all critical incidents that are assigned to no one',
  'Design a flow: when a P1 incident is created, notify the assignment group manager',
];

const SESSION_KEY = 'nowhelpassist.sessionId';
// Read once, for anyone who had a chat open across the rename. Cleared on the
// first write, so this is not a key the app keeps two of.
const LEGACY_SESSION_KEY = 'nowforge.sessionId';

let nextId = 1;
const uid = () => `m${nextId++}`;

/**
 * Rebuild the visible transcript from persisted messages (A-2).
 *
 * The server stores the NEUTRAL history — the same shape the provider adapters
 * consume — so rehydration reads that rather than a second, UI-shaped copy that
 * could drift out of step with what the model actually saw.
 *
 * Approval cards are deliberately NOT reconstructed: an approval is a live
 * decision on an in-flight turn, and a resolved one is history. What it did is
 * visible in the tool card it gated.
 */
function hydrate(messages) {
  const out = [];
  for (const m of messages) {
    const e = m.entry;
    if (e.role === 'user') {
      out.push({ id: uid(), kind: 'user', text: e.text });
    } else if (e.role === 'assistant') {
      // Whitespace is not text. D-7 stops blank turns being written at all, but
      // sessions recorded before it still hold them, and `if (e.text)` is
      // truthiness — a stored newline rendered as an empty bubble on replay.
      if (e.text?.trim()) out.push({ id: uid(), kind: 'assistant', text: e.text });
      for (const tc of e.toolCalls || []) {
        out.push({ id: uid(), kind: 'tool', toolId: tc.id, name: tc.name, input: tc.input, status: 'done' });
      }
    } else if (e.role === 'tool') {
      for (const r of e.results || []) {
        // Attach the result to the call card already emitted above.
        const card = [...out].reverse().find((x) => x.kind === 'tool' && x.toolId === r.id);
        if (card) {
          card.output = r.output;
          card.status = r.isError ? 'error' : 'done';
        }
      }
    }
  }
  return out;
}

export default function AgentChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [meta, setMeta] = useState(null);
  const [autoApprove, setAutoApprove] = useState(false);
  // ON by default, matching the server; re-read on every session switch.
  const [capture, setCapture] = useState(true);

  const [sessions, setSessions] = useState(null);   // null = not loaded yet
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || crypto.randomUUID()
  );
  const [loadingSession, setLoadingSession] = useState(false);
  const [digestCount, setDigestCount] = useState(0);
  // The three measured budget numbers for this session, streamed at meta time.
  const [budget, setBudget] = useState(null);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState(null);
  const [memory, setMemory] = useState(null);

  const { connected } = useHealth();
  const msgsRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, sessionId);
    localStorage.removeItem(LEGACY_SESSION_KEY);
  }, [sessionId]);

  const refreshSessions = useCallback(async () => {
    try { setSessions(await api.get('/agent/sessions')); }
    catch { setSessions([]); /* the rail is not load-bearing, but it must settle */ }
  }, []);

  useEffect(() => {
    api.get('/system/settings').then((s) => setAutoApprove(s.agent.autoApprove)).catch(() => {});
    api.get('/agent/memory/status').then(setMemory).catch(() => {});
    refreshSessions();
  }, [refreshSessions]);

  // Rehydrate on mount and on every session switch. This is the whole point of
  // A-2: Agent -> Settings -> Agent must lose NOTHING.
  useEffect(() => {
    let alive = true;
    setLoadingSession(true);
    api
      .get(`/agent/sessions/${sessionId}/messages`)
      .then((data) => {
        if (!alive) return;
        setMessages(hydrate(data.messages || []));
        setDigestCount((data.digests || []).length);
      })
      .catch(() => { if (alive) { setMessages([]); setDigestCount(0); } })
      .finally(() => { if (alive) setLoadingSession(false); });
    api.get(`/transport/capture/${sessionId}`)
      .then((c) => { if (alive) setCapture(c.enabled); })
      .catch(() => { /* the server's default is ON, and so is ours */ });
    return () => { alive = false; };
  }, [sessionId]);

  /**
   * Keep the transcript pinned to the newest turn — by scrolling the message
   * COLUMN, never by asking an element to scroll itself into view.
   *
   * `scrollIntoView` walks every scrollable ancestor, so the moment anything
   * above the chat became scrollable it scrolled that too: the page slid down
   * on load and again on every click that touched `messages`, taking the
   * topbar with it. Setting scrollTop on the one container that should move
   * cannot do that, whatever the layout above it is doing.
   */
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [messages]);

  const push = (m) => setMessages((ms) => [...ms, { id: uid(), ...m }]);
  const patchMsg = (match, patch) =>
    setMessages((ms) => ms.map((m) => (match(m) ? { ...m, ...patch } : m)));

  const toggleAuto = async (v) => {
    setAutoApprove(v);
    try { await api.post('/system/settings', { agent: { autoApprove: v } }); } catch { /* noop */ }
  };

  /*
   * `retry` re-issues a turn that died before it wrote anything — an empty
   * completion, or the upstream falling over mid-turn. The message is NOT
   * echoed again as a user bubble and the server does not append it again:
   * the same history is sent a second time. Anything else would quietly change
   * the conversation the model sees while claiming to repeat it.
   */
  // Capture is ON by default; the server owns the default so the toggle cannot
  // disagree with what the sweep actually does.
  const toggleCapture = async (on) => {
    setCapture(on);
    try { await api.post(`/transport/capture/${sessionId}`, { enabled: on }); }
    catch (e) { setCapture(!on); toast.error(e.message); }
  };

  const send = async (text, { retry = false } = {}) => {
    const message = (text ?? input).trim();
    if (!message || running) return;
    if (!retry) setInput('');
    setRunning(true);
    if (!retry) push({ kind: 'user', text: message });
    try {
      await sse('/agent/chat', { sessionId, message, retry }, (evt) => {
        switch (evt.type) {
          case 'meta': setMeta(evt); break;
          // The three measured numbers, for the digest badge's tooltip.
          case 'budget': setBudget(evt); break;
          // Same rule as hydrate(): only real content becomes a bubble.
          case 'assistant_text': if (evt.text?.trim()) push({ kind: 'assistant', text: evt.text }); break;
          case 'remembered': push({ kind: 'system', text: `Remembered — ${evt.fact.value}` }); break;
          case 'compacted':
            setDigestCount((n) => n + 1);
            // One line, and it stays one line. The detail lives on the badge's
            // tooltip, where it is available without costing every reader the
            // vertical space.
            push({
              kind: 'system',
              text: `Compacted ${evt.entries} earlier messages into a digest (${evt.tokensBefore} → ${evt.tokensAfter} tokens, budget ${evt.budget}). Artifacts and sys_ids were carried across.`,
            });
            break;
          case 'tool_use':
            push({ kind: 'tool', toolId: evt.id, name: evt.name, input: evt.input, mutating: evt.mutating, status: 'running' });
            break;
          case 'approval_required':
            // WI-5 — `warning` is the plan-time trap check: what the ledger
            // already knows about the fields this payload is about to set.
            push({
              kind: 'approval', approvalId: evt.approvalId, name: evt.name, input: evt.input,
              decided: null, warning: evt.warning || null,
              // B6 — whose authority this card carries. Null unless impersonation
              // mode is active.
              impersonation: evt.impersonation || null,
              // WI-3 — the token this card must present to approve. It arrives
              // once, with the card, and is never re-requested.
              nonce: evt.nonce || null,
              // WI-4 — the elevation context: this card authorises elevating a
              // role, and the human must see that before approving.
              elevation: evt.elevation || null,
            });
            break;
          case 'approval_resolved':
            // WI-4 — provenance rides along, so the card can say who decided
            // and when instead of leaving it to be inferred.
            patchMsg((m) => m.kind === 'approval' && m.approvalId === evt.approvalId, {
              decided: evt.approved, source: evt.source || null, at: evt.at || null,
              sending: null, failed: null,
            });
            break;
          case 'tool_result':
            // WI-4 — a gated ELEVATION result is its own bubble, rendered SOLELY
            // from the honest tier (no prior tool_use exists to patch). Its
            // green is structurally reachable only from tier === EXECUTED.
            if (evt.elevation) {
              push({ kind: 'elevation', name: evt.name, elevation: evt.elevation, output: evt.output });
              break;
            }
            // `verification` rides along so the card's glyph and words come
            // from the same object (WI-6).
            patchMsg((m) => m.kind === 'tool' && m.toolId === evt.id, {
              status: evt.isError ? 'error' : 'done', output: evt.output, verification: evt.verification || null,
              impersonation: evt.impersonation || null,
            });
            break;
          // WI-3 — the completion asked the user something AND called a
          // mutating tool. The write never reached the gate and was discarded;
          // silence here would read as the model simply choosing not to act.
          case 'mutations_held':
            push({
              kind: 'system',
              text: `${evt.text} The agent asked a question ("${String(evt.asked || '').trim()}") in the same breath as `
                + `${evt.held.join(', ')} — so the write was withheld and discarded. Answer above and it will re-plan.`,
            });
            break;
          // WI-2 — the turn ended on a question only you can answer.
          case 'awaiting_user':
            push({ kind: 'system', text: 'Waiting for your answer — nothing was changed on the instance.' });
            break;
          // WI-3 — a write the harness proved is a no-op never reached the gate.
          case 'tool_blocked':
            // WI-4 — a pre-write elevation refusal (REFUSED / FAIL_CLOSED) is an
            // elevation bubble, rendered distinctly and never as generic error.
            if (evt.elevation) {
              push({ kind: 'elevation', name: evt.name, elevation: evt.elevation, output: null });
              break;
            }
            push({ kind: 'blocked', name: evt.name, input: evt.input, reason: evt.reason, text: evt.message });
            break;
          // WI-2 — the harness's own account of what changed, which the model
          // did not write and cannot omit.
          case 'mutation_report':
            push({ kind: 'mutation_report', markdown: evt.markdown, mutations: evt.mutations });
            break;
          // Capture is reported whether or not anything was captured. A change
          // that is DATA says so — silence would read as a capture failure.
          case 'capture': push({ kind: 'capture', ...evt }); break;
          case 'error': push({ kind: 'error', text: evt.message, retryable: evt.retryable, retryOf: message }); break;
          default: break;
        }
      });
    } catch (e) {
      push({ kind: 'error', text: e.message });
    } finally {
      setRunning(false);
      refreshSessions();
    }
  };

  /*
   * WI-4 — the card's verdict comes from the SERVER, never from the click.
   *
   * This used to patch `decided` optimistically and swallow the error, so a
   * post that failed — or one that arrived after the gate had already timed out
   * — still painted a green "approved" badge over a mutation the server had
   * rejected. That is the renderer-dishonesty class (WI-7) in the one place it
   * matters most: the badge that says a human authorised a write.
   *
   * The click now only says "sending". `approval_resolved` decides.
   */
  const decide = async (m, approved) => {
    patchMsg((x) => x.id === m.id, { sending: approved, failed: null });
    try {
      const r = await api.post('/agent/approve', {
        sessionId, approvalId: m.approvalId, approved, nonce: m.nonce,
      });
      if (!r?.ok) {
        // WI-3 — the two refusals mean different things and the buttons come
        // back for only one of them: a token mismatch leaves the approval
        // PENDING, so this card is still live and can still be answered.
        patchMsg((x) => x.id === m.id, {
          sending: null,
          failed: r?.reason === 'token-mismatch'
            ? 'This card could not prove it came from this session, so the decision was refused. '
              + 'The approval is still pending — try again.'
            : 'The gate was no longer waiting for this — it was already answered, or it timed out.',
        });
      }
    } catch (e) {
      patchMsg((x) => x.id === m.id, { sending: null, failed: e.message });
    }
  };

  const newChat = async () => {
    if (running) return;
    const id = crypto.randomUUID();
    try { await api.post('/agent/sessions', { id }); } catch { /* created on first message anyway */ }
    setSessionId(id);
    setSearchHits(null);
    setQuery('');
    refreshSessions();
  };

  const rename = async (s) => {
    const title = await promptFor({
      action: 'Rename this chat',
      label: 'Title',
      value: s.title || '',
    });
    if (title === null) return;
    try { await api.patch(`/agent/sessions/${s.id}`, { title }); refreshSessions(); toast.success('Chat renamed.'); }
    catch (e) { toast.error(e.message); }
  };

  const remove = async (s) => {
    const ok = await confirmDestructive({
      action: 'Delete chat',
      subject: s.title || 'this chat',
      sysId: s.id,
      detail: CONSEQUENCE.session,
      confirmLabel: 'Delete chat',
    });
    if (!ok) return;
    try {
      await api.del(`/agent/sessions/${s.id}`);
      if (s.id === sessionId) {
        const id = crypto.randomUUID();
        setSessionId(id);
      }
      refreshSessions();
      toast.success('Chat deleted.');
    } catch (e) { toast.error(e.message); }
  };

  const runSearch = async (e) => {
    e?.preventDefault?.();
    const q = query.trim();
    if (!q) { setSearchHits(null); return; }
    try {
      const res = await api.get(`/agent/memory/search?sessions=true&q=${encodeURIComponent(q)}`);
      setSearchHits(res);
      if (res.degraded) setMemory({ mode: 'keyword', degraded: true, command: res.command, reason: res.reason });
    } catch (err) { toast.error(err.message); }
  };

  const railLoading = !searchHits && sessions === null;
  const rail = searchHits ? searchHits.sessions : (sessions || []);

  return (
    <div className="agent-layout">
      <aside className="session-rail">
        <div className="rail-head">
          <button className="btn primary sm" onClick={newChat} disabled={running}>New chat</button>
        </div>

        <form className="rail-search" onSubmit={runSearch}>
          <input
            className="input"
            placeholder="Search all chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={runSearch}
          />
          {searchHits && (
            <button type="button" className="btn ghost sm" onClick={() => { setQuery(''); setSearchHits(null); }}>
              Clear
            </button>
          )}
        </form>

        {searchHits && (
          <div className="rail-note">
            {searchHits.sessions.length} match{searchHits.sessions.length === 1 ? '' : 'es'}
            {' · '}
            <span className={searchHits.degraded ? 'rail-mode-warn' : 'rail-mode-ok'}>
              {searchHits.mode}
            </span>
          </div>
        )}

        <div className="rail-list">
          {railLoading && (
            <div style={{ padding: '6px 2px' }}>
              <SkeletonLines lines={4} />
              <LoadingRegion label="Loading chats" />
            </div>
          )}
          {!railLoading && rail.length === 0 && (
            <div className="rail-empty">
              {searchHits ? 'Nothing matched.' : 'No chats yet — say something below and this fills in.'}
            </div>
          )}
          {rail.map((s) => (
            <div
              key={s.id}
              className={`rail-item${s.id === sessionId ? ' active' : ''}`}
              onClick={() => { if (!running) setSessionId(s.id); }}
              title={s.title || 'Untitled chat'}
            >
              <div className="rail-title">{s.title || 'Untitled chat'}</div>
              <div className="rail-meta">
                <span className="mono">{new Date(s.updated).toLocaleDateString()}</span>
                {s.message_count > 0 && <span>{s.message_count} msg</span>}
                {s.mutation_count > 0 && <span className="badge amber">{s.mutation_count}</span>}
              </div>
              {s.snippet && <div className="rail-snippet">{s.snippet}</div>}
              <div className="rail-actions">
                <button className="rail-btn" onClick={(e) => { e.stopPropagation(); rename(s); }} title="Rename">rename</button>
                <button className="rail-btn danger" onClick={(e) => { e.stopPropagation(); remove(s); }} title="Delete">delete</button>
              </div>
            </div>
          ))}
        </div>

        {/* One quiet banner, with the exact command. Never a silent downgrade. */}
        {memory?.degraded && (
          <div className="rail-foot">
            <div className="label">Recall: keyword only</div>
            <div className="rail-foot-body">
              The embedding model isn’t pulled, so search matches words rather than meaning.
              <pre className="mono">{memory.command}</pre>
            </div>
          </div>
        )}
      </aside>

      <div className="chat-wrap">
        <div className="spread" style={{ marginBottom: 10 }}>
          <div className="row">
            {meta && <span className="badge blue">{meta.provider} · <span className="mono">{meta.model}</span></span>}
            {!meta && <span className="badge">provider set in Settings</span>}
            {digestCount > 0 && (
              <span className="badge" title="Older turns were summarised into a digest to stay inside the context budget. Artifacts and sys_ids were carried across.">
                {digestCount} digest{digestCount === 1 ? '' : 's'}
              </span>
            )}
            {/* The budget used to be a constant nobody could see was wrong — it
                was 4% of this model's context window for a while, and the only
                symptom was the transcript quietly compacting three times in one
                turn. On hover, so it informs without taking up room. */}
            {budget && (
              <span
                className="badge"
                title={
                  `Model context: ${budget.modelCtx.toLocaleString()} tokens (${budget.modelCtxSource})
` +
                  `Self-imposed cap: ${budget.ceiling.toLocaleString()}
` +
                  `Fixed overhead: ${budget.fixed.toLocaleString()} (system prompt + tool schemas)
` +
                  `Output headroom: ${budget.headroom.toLocaleString()}
` +
                  `History budget: ${budget.budget.toLocaleString()}`
                }
              >
                {(budget.budget / 1000).toFixed(1)}k history budget
              </span>
            )}
            {meta?.decoding?.reality && !/honoured\./.test(meta.decoding.reality) && (
              <span className="badge amber" title={meta.decoding.reality}>non-reproducible</span>
            )}
          </div>
          <div className="row">
            <label
              className="check"
              title="Configuration this session changes is moved into an update set named after it, one per scope. Task data — incidents, requests — is never captured, because update sets do not carry data."
            >
              <input type="checkbox" checked={capture} onChange={(e) => toggleCapture(e.target.checked)} />
              Capture changes
            </label>
            <label className="check" title="When off, every create/update/delete pauses for your approval — like Claude Code permissions.">
              <input type="checkbox" checked={autoApprove} onChange={(e) => toggleAuto(e.target.checked)} />
              Auto-approve mutations
            </label>
          </div>
        </div>

        {/* The agent itself runs disconnected — it just cannot do anything
            useful to an instance, so this is a banner rather than a gate. */}
        <DisconnectedBanner />

        <div className="msgs" ref={msgsRef}>
          {loadingSession && (
            <div className="msg">
              <div className="bubble" style={{ minWidth: 320 }}><SkeletonLines lines={3} /></div>
              <LoadingRegion label="Loading transcript" />
            </div>
          )}

          {!loadingSession && messages.length === 0 && (
            <div className="card" style={{ maxWidth: 780 }}>
              <div className="card-title">NowHelpAssist Agent</div>
              <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--muted)' }}>
                Talks to your bound instance with schema inspection, reference resolution, record CRUD,
                catalog composites, flow reading, blueprint design and live authoring. Every mutation stops
                at the amber gate until you approve it. Conversations are saved — this chat will still be
                here after a restart, and <span className="mono">recall_memory</span> searches all of them.
              </p>
              <div className="chips">
                {SAMPLES.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
              </div>
              {!connected && (
                <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
                  No instance is bound yet, so every one of those needs a PDI first.{' '}
                  <Link to="/">Connect one on the Dashboard</Link>.
                </p>
              )}
            </div>
          )}

          {messages.map((m) => {
            if (m.kind === 'user') {
              // User bubbles stay literal on purpose: what you typed is what you
              // see, and nobody wants their asterisks eaten.
              return <div key={m.id} className="msg user"><div className="bubble">{m.text}</div></div>;
            }
            if (m.kind === 'assistant') {
              return (
                <div key={m.id} className="msg assistant">
                  <div className="bubble md-bubble"><Markdown text={m.text} /></div>
                </div>
              );
            }
            if (m.kind === 'system') {
              return <div key={m.id} className="msg"><div className="system-note">{m.text}</div></div>;
            }
            if (m.kind === 'error') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble" style={{ borderColor: 'var(--red)' }}>
                    <span className="error-text">{m.text}</span>
                    {m.retryable && (
                      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <button className="btn" disabled={running} onClick={() => send(m.retryOf, { retry: true })}>
                          Retry
                        </button>
                        {/* F8 — what happened and what to check, not a guess at
                            a cause. This card used to blame "a transient load
                            on Ollama's side" for every failure, including ones
                            where the request was built wrong, and to promise
                            nothing had been written — which is true of the
                            failed CALL and not of the turn, whose earlier tool
                            actions may already have applied. */}
                        <span className="muted" style={{ fontSize: 12 }}>
                          The request and the provider&apos;s reply were captured to this session&apos;s log.
                          Earlier tool actions in this turn may already have applied — check the mutation report
                          above. Retry re-runs the turn from the session&apos;s current state.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            if (m.kind === 'capture') {
              // Deliberately quiet: one line, the same shape whether something
              // was captured or not, because "nothing to capture" is an answer
              // and not an absence.
              const bad = m.failures?.length > 0;
              return (
                <div key={m.id} className="msg">
                  <div className="tool-card">
                    <div className="tool-head">
                      <span className={`badge ${bad ? 'red' : m.captured ? 'green' : ''}`}>
                        {bad ? 'capture failed' : m.captured ? 'captured' : 'not captured'}
                      </span>
                      {/* E6 — the badge and the message both began "not
                          captured", so the line read "not captured / not
                          captured — data, not configuration". One source: the
                          badge states the verdict, the message states only the
                          REASON. */}
                      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{captureReason(m)}</span>
                    </div>
                    {(m.updates?.length > 0 || bad) && (
                      <div className="tool-body" style={{ fontSize: 12.5 }}>
                        {m.updates?.map((u) => (
                          <div key={u.name} className="row" style={{ gap: 6 }}>
                            <span className="badge">{u.type}</span>
                            <span>{u.target}</span>
                            <ScopeBadge scope={u.scope} />
                          </div>
                        ))}
                        {m.failures?.map((f, i) => (
                          <div key={i} className="error-text">{f.name || f.scope || f.stage}: {f.message}</div>
                        ))}
                        {m.sets?.length > 0 && (
                          <div className="mono" style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
                            {m.sets.map((x) => x.setName).join(' · ')} — <Link to="/transport">Transport</Link>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            if (m.kind === 'blocked') {
              return (
                <div key={m.id} className="msg">
                  <div className="tool-card">
                    <div className="tool-head">
                      <span className="dot" style={{ background: 'var(--amber)' }} />
                      <span className="name">{m.name}</span>
                      <span className="badge amber" style={{ marginLeft: 'auto' }}>blocked before approval</span>
                    </div>
                    <div className="tool-body">
                      <div style={{ fontSize: 12.5, color: 'var(--amber)', whiteSpace: 'pre-wrap' }}>{m.text}</div>
                    </div>
                  </div>
                </div>
              );
            }
            if (m.kind === 'mutation_report') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble">
                    <Markdown text={m.markdown} />
                  </div>
                </div>
              );
            }
            if (m.kind === 'elevation') {
              // WI-4 — the elevation bubble. Its ENTIRE visual state comes from
              // elevationOutcome(m.elevation), which derives green solely from
              // tier === EXECUTED. isError, a sys_id, or "approved" never reach
              // this render — the M3 class cannot recur here.
              const o = elevationOutcome(m.elevation);
              return (
                <div key={m.id} className="msg">
                  <div className="tool-card">
                    <div className="tool-head">
                      <span
                        className={`dot ${o.green ? 'on' : ''}`}
                        style={o.tone === 'bad' ? { background: 'var(--red)' } : o.tone === 'warn' ? { background: 'var(--amber)' } : {}}
                      />
                      <span className="name">{m.name || 'role elevation'}</span>
                      {o.role && <span className="badge amber" title="required role">{o.role}</span>}
                      <span className={`badge ${o.badgeClass}`} style={{ marginLeft: 'auto' }}>{o.label}</span>
                    </div>
                    <div className="tool-body">
                      <div style={{ fontSize: 12.5, color: o.tone === 'bad' ? 'var(--red)' : o.tone === 'warn' ? 'var(--amber)' : 'inherit' }}>
                        {o.headline}
                      </div>
                      {o.target?.table && (
                        <div className="label" style={{ marginTop: 6 }}>
                          target: {o.target.table}{o.target.sys_id ? ` · ${o.target.sys_id}` : ''}
                        </div>
                      )}
                      {o.green && o.confirmedFields.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          <div className="label">verified fields</div>
                          {o.confirmedFields.map((f) => (
                            <div key={f.field} style={{ fontSize: 12 }}>✓ {f.field} = {f.actual}</div>
                          ))}
                        </div>
                      )}
                      {o.showDiff && o.diffs.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          <div className="label" style={{ color: 'var(--amber)' }}>requested vs actual</div>
                          {o.diffs.map((d) => (
                            <div key={d.field} style={{ fontSize: 12, color: 'var(--amber)' }}>
                              {d.field}: requested "{d.requested}" → actual "{d.actual}"
                            </div>
                          ))}
                        </div>
                      )}
                      {o.reason && !o.green && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{o.reason}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            }
            if (m.kind === 'tool') {
              // WI-6 — the glyph and the words come from ONE object.
              //
              // The transcript rendered "✅ Update set … was not updated": a
              // success mark hardcoded onto a failure sentence. It cannot
              // happen here any more, because both halves are derived from the
              // same verification status rather than from "no exception was
              // thrown".
              const v = writeOutcome(m);
              return (
                <div key={m.id} className="tool-card">
                  <div className="tool-head">
                    <span className={`dot ${v.tone === 'ok' ? 'on' : ''}`} style={v.dotStyle} />
                    <span className="name">{m.name}</span>
                    {m.mutating && <span className="badge amber">mutation</span>}
                    {m.impersonation && <ImpersonationChip chip={m.impersonation} />}
                    <span className={`badge ${v.badgeClass}`} style={{ marginLeft: 'auto' }} title={v.title}>{v.label}</span>
                  </div>
                  {v.detail && (
                    <div className="tool-body" style={{ paddingBottom: 0 }}>
                      <div className={v.tone === 'bad' ? 'error-text' : ''} style={v.tone === 'warn' ? { color: 'var(--amber)', fontSize: 12.5 } : { fontSize: 12.5 }}>
                        {v.detail}
                      </div>
                    </div>
                  )}
                  <div className="tool-body">
                    <pre>{JSON.stringify(m.input, null, 1)}</pre>
                    {m.output && (
                      <>
                        <div className="label" style={{ margin: '8px 0 4px' }}>result</div>
                        <pre style={m.status === 'error' ? { color: 'var(--red)' } : {}}>{m.output}</pre>
                      </>
                    )}
                  </div>
                </div>
              );
            }
            if (m.kind === 'approval') {
              return (
                <div key={m.id} className="approval-card">
                  <div className="title">Approval required — {m.name}</div>
                  {/* B6 — identity first: whose authority is being asked for is
                      part of the decision, not a detail of the payload. */}
                  {m.impersonation && (
                    <div style={{ marginTop: 6 }}>
                      <ImpersonationChip chip={m.impersonation} />
                    </div>
                  )}
                  {/* WI-5 — above the payload, because it is about the decision. */}
                  {m.warning && (
                    <div style={{ color: 'var(--amber)', fontSize: 12, marginTop: 6 }}>
                      Heads up — {m.warning}
                    </div>
                  )}
                  {/* WI-4 — this card authorises ELEVATING a role. The human must
                      see that, and the eligibility verdict behind it, before approving. */}
                  {m.elevation?.will_elevate && (
                    <div style={{ border: '1px solid var(--amber)', borderRadius: 6, padding: '6px 8px', marginTop: 6, fontSize: 12 }}>
                      <div style={{ color: 'var(--amber)', fontWeight: 600 }}>
                        Elevates {m.elevation.required_role} — high-risk
                      </div>
                      {m.elevation.op && (
                        <div style={{ color: 'var(--muted)' }}>
                          {m.elevation.op.operation} on {m.elevation.op.table}
                        </div>
                      )}
                      {m.elevation.eligibility && (
                        <div style={{ color: 'var(--muted)' }}>
                          eligibility: {m.elevation.eligibility.eligible ? 'eligible' : 'not eligible'}
                          {m.elevation.eligibility.branch ? ` (${m.elevation.eligibility.branch})` : ''}
                        </div>
                      )}
                    </div>
                  )}
                  <pre>{JSON.stringify(m.input, null, 1)}</pre>
                  {m.decided === null || m.decided === undefined ? (
                    m.sending === true || m.sending === false ? (
                      <span className="badge">sending your {m.sending ? 'approval' : 'rejection'}…</span>
                    ) : (
                      <div className="row">
                        <button className="btn amber sm" onClick={() => decide(m, true)}>Approve &amp; run</button>
                        <button className="btn danger sm" onClick={() => decide(m, false)}>Reject</button>
                      </div>
                    )
                  ) : (
                    <>
                      <span className={`badge ${m.decided ? 'green' : 'red'}`}>{m.decided ? 'approved' : 'rejected'}</span>
                      {/* WI-4 — who decided, and when. Never inferred from the fact that it ran. */}
                      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>{approvalProvenance(m)}</div>
                    </>
                  )}
                  {m.failed && (
                    <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 6 }}>{m.failed}</div>
                  )}
                </div>
              );
            }
            return null;
          })}
        </div>

        <div className="chat-input">
          <textarea
            className="textarea"
            placeholder="Tell the agent what to build or find on your instance…  (start with “remember:” to store a preference)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="btn primary" onClick={() => send()} aria-busy={running} disabled={running || !input.trim()}>
            {running ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
