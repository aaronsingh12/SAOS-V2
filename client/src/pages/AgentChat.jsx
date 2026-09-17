import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, sse } from '../api.js';
import { logToServer } from '../logging.js';
import { useHealth } from '../hooks/useHealth.js';
import Markdown from '../components/Markdown.jsx';
import { confirmDestructive, promptFor, CONSEQUENCE } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import { notifyDesktop } from '../components/notify.js';
import { SkeletonLines, LoadingRegion, EmptyState, DisconnectedBanner } from '../components/states.jsx';
import ScopeBadge from '../components/ScopeBadge.jsx';
import ImpersonationChip from '../components/ImpersonationChip.jsx';
import DiagnosisPanel from '../components/DiagnosisPanel.jsx';
import LintPanel from '../components/LintPanel.jsx';
import TestPanel from '../components/TestPanel.jsx';
import ChangePanel from '../components/ChangePanel.jsx';
import KnowledgePanel, { KnowledgeAside } from '../components/KnowledgePanel.jsx';
import AppBuildPanel from '../components/AppBuildPanel.jsx';
import { writeOutcome, captureReason, approvalProvenance } from '../components/writeOutcome.js';
import { elevationOutcome } from '../components/elevationOutcome.js';
import { SourcesDrawer } from '../components/SourcesPanel.jsx';
import PlanPanel from '../components/PlanPanel.jsx';
import SkillsPanel from '../components/SkillsPanel.jsx';
import TaskHistory from '../components/TaskHistory.jsx';
import { rowFromFrame, mergeRows, deriveStatus } from '../components/activity.js';
import { useAgentSlots } from '../components/agentRail.js';
import Composer from '../components/Composer.jsx';
import { ActivityIndicator, ActivityDrawer } from '../components/ActivityDock.jsx';
import AgentWelcome from '../components/AgentWelcome.jsx';
import { AnimatedItem } from '../components/AnimatedList.jsx';

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
  /*
   * A `?session=` in the URL is how the Meetings page hands a build over. It
   * WINS over the remembered session — arriving from a meeting and landing in
   * yesterday's unrelated chat would be the worst possible outcome of pressing
   * "Build with the agent".
   */
  const [params, setParams] = useSearchParams();
  /*
   * Picking a chat IS opening the playground.
   *
   * The rail lives in the navigation now, so it can be clicked from any route —
   * and selecting a conversation while looking at Incidents used to change the
   * session behind a page you could not see. Navigation is the only thing added
   * here: the same setSessionId, the same newChat, the same persistence.
   */
  const navigate = useNavigate();
  const openAgent = () => { if (window.location.pathname !== '/agent') navigate('/agent'); };
  const [sessionId, setSessionId] = useState(
    () => params.get('session')
      || localStorage.getItem(SESSION_KEY)
      || localStorage.getItem(LEGACY_SESSION_KEY)
      || crypto.randomUUID()
  );
  // Set when this chat came from a meeting. Drives the banner and the rail mark.
  const [origin, setOrigin] = useState(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [digestCount, setDigestCount] = useState(0);
  // The three measured budget numbers for this session, streamed at meta time.
  const [budget, setBudget] = useState(null);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState(null);
  const [memory, setMemory] = useState(null);

  const { connected } = useHealth();
  const msgsRef = useRef(null);
  /*
   * Phase 0 — the running turn's controller, and nothing else.
   *
   * A ref rather than state: aborting must not re-render, and the handler that
   * reads it must see the CURRENT turn's controller rather than the one that
   * was current when the closure was made. Replaced on every send and cleared
   * when the turn settles, so Stop can never abort a turn that already ended.
   */
  const turnAbort = useRef(null);
  // Whether Stop has been pressed for the turn in flight. Drives the button's
  // own state, so a second click cannot fire a second abort.
  const [stopping, setStopping] = useState(false);
  /*
   * PHASE 8 — the durable evidence for the turn that just ran.
   *
   * `taskId` arrives on the `task_started` frame; the panel then reads the
   * EXISTING `GET /api/agent/plan/:taskId/evidence`. Nothing is accumulated
   * here — this is a pointer to the server's record, not a copy of it.
   */
  const [taskId, setTaskId] = useState(null);
  const [showEvidence, setShowEvidence] = useState(false);
  /* Whether the activity drawer is open. Purely presentational and local: it
     changes where existing activity state is DRAWN, never what it contains. */
  const [activityOpen, setActivityOpen] = useState(false);

  /*
   * EXPERIENCE §6 — THE ACTIVITY TIMELINE FOR THE TASK ON SCREEN.
   *
   * Rows, not frames. Every entry came from a frame the backend emitted or a
   * row it stored, mapped by `components/activity.js`; there is nothing here
   * this component advances on its own, which is what §66 asks for.
   *
   * ONE SOURCE AT A TIME. While a turn streams these are built from the stream;
   * on refresh or when a past task is opened they are REPLACED wholesale by the
   * server's durable projection. There is no merge of the two, so §11's
   * duplicate has nowhere to come from.
   */
  const [activity, setActivity] = useState([]);
  const [activeSkills, setActiveSkills] = useState([]);
  const [progress, setProgress] = useState(null);
  const [serverStatus, setServerStatus] = useState(null);
  /*
   * Where the rail below is DRAWN — the app's left column, not this page.
   *
   * Only the DOM position moves. The markup, the handlers and every piece of
   * state they close over stay exactly where they were, which is why nothing
   * under here had to be rewritten to relocate it.
   */
  /* Where each pane is DRAWN. Only the DOM position moves; the markup, the
     handlers and every piece of state they close over stay here. */
  const slots = useAgentSlots();
  /*
   * The task the frames arriving RIGHT NOW belong to, as a ref.
   *
   * A ref because `observe` runs inside an SSE callback that outlives the
   * render which created it: reading `taskId` from state there would see
   * whatever it was when the turn started, and every row would be keyed to a
   * stale task. `seq` is the same story — a monotone counter over this stream,
   * which is what orders rows that arrive in the same millisecond.
   */
  const liveTask = useRef(null);
  const seqRef = useRef(0);
  /*
   * The rows, readable from a callback that outlives the render which made it.
   * Used only by the §76 diagnostic below — reading `activity` there would
   * report whatever it held when the turn STARTED, which is always zero.
   */
  const activityRef = useRef([]);

  /**
   * One frame -> at most one timeline row (§7, §8).
   *
   * Called for EVERY frame of EVERY stream this page opens, which is why it is
   * wrapped around `sse` below rather than repeated in six handlers: a route
   * whose frames were not observed would show an empty timeline for work that
   * really happened, and that is exactly the class of bug §8 is about.
   */
  const observe = useCallback((evt) => {
    /*
     * Learned HERE rather than in each of the seven stream handlers.
     *
     * Every route emits `task_started`, and before this the knowledge route
     * dropped it on the floor — so a `/knowledge` turn produced real durable
     * evidence that the workspace had no id for and could not offer. Reading it
     * at the one point every frame passes through makes that impossible to
     * forget for the next route as well.
     */
    if (evt?.type === 'task_started') {
      liveTask.current = evt.taskId;
      setTaskId(evt.taskId);
    }
    if (evt?.type === 'skills_active') { setActiveSkills(evt.skills || []); return; }
    seqRef.current += 1;
    const row = rowFromFrame(evt, { taskId: liveTask.current, seq: seqRef.current });
    if (row) {
      setActivity((rows) => {
        const next = mergeRows(rows, row);
        activityRef.current = next;
        return next;
      });
    }
  }, []);

  /**
   * Wrap `sse` so the timeline sees every frame exactly once.
   *
   * `observe` runs BEFORE the caller's handler for the same reason the server's
   * `emit` projects before it writes: the record must not depend on what the
   * consumer does with the frame.
   */
  const streamed = useCallback(
    (path, body, onEvent, method = 'POST', opts = {}) => sse(path, body, (evt) => {
      observe(evt);
      onEvent(evt);
      /* Tell someone in another window. `notifyDesktop` does nothing unless
         they turned notifications on AND are away, so this costs nothing for
         a person watching the chat. */
      if (evt.type === 'approval_required') {
        notifyDesktop({
          title: 'The agent is waiting for your approval',
          body: evt.operation || (evt.name ? `Approve or reject: ${evt.name}` : 'Open the agent to approve or reject.'),
          tag: `nha-approval-${evt.approvalId ?? ''}`,
          path: '/agent',
        });
      } else if (evt.type === 'done') {
        notifyDesktop({ title: 'The agent finished', body: 'Its reply is ready.', tag: 'nha-agent', path: '/agent' });
      } else if (evt.type === 'error') {
        notifyDesktop({ title: 'The agent stopped with an error', body: evt.message || '', tag: 'nha-agent', path: '/agent' });
      }
    }, method, opts),
    [observe],
  );

  /**
   * EXPERIENCE §10/§51/§58 — load a task's DURABLE timeline and show that instead.
   *
   * The replacement is the point. `activityForTask` is projected from the
   * tables, so it is complete and its ids are the durable ones; appending it to
   * whatever the stream had produced would put two identities for one event in
   * one list. Replacing cannot.
   *
   * READ-ONLY on both sides: this is a GET, and the route it calls performs no
   * mutation — so §52's "do not re-execute anything" holds because there is
   * nothing here that could.
   */
  const openTask = useCallback(async (id) => {
    if (!id) return;
    const t0 = performance.now();
    try {
      const a = await api.get(`/agent/plan/${id}/activity`);
      /*
       * §76 — OBSERVABILITY, and what it is allowed to contain.
       *
       * Counts and durations. Not the goal, not a tool argument, not a row: the
       * numbers say whether the workspace is keeping up, and nothing in them
       * could be a credential. `logToServer` puts it in the server terminal
       * beside the request that produced it.
       */
      logToServer('debug',
        `activity: task ${id.slice(0, 8)} — ${a.events?.length ?? 0} event(s), `
        + `${a.progress?.total ?? 0} step(s), cursor ${a.cursor}, loaded in ${Math.round(performance.now() - t0)}ms`);
      setTaskId(id);
      setActivity(a.events || []);
      activityRef.current = a.events || [];
      setProgress(a.progress || null);
      setServerStatus(a.status || null);
      setActiveSkills(a.skills || []);
      seqRef.current = a.cursor || 0;
    } catch (err) {
      toast.error(err.message);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, sessionId);
    localStorage.removeItem(LEGACY_SESSION_KEY);
  }, [sessionId]);

  /*
   * `?session=` is a ONE-SHOT instruction from the Meetings page, and it is
   * consumed here rather than left in the URL.
   *
   * Leaving it there meant this effect fired again every time the rail changed
   * the session, snapping the user straight back to the meeting's chat — you
   * could not click another conversation at all. Clearing it also keeps the
   * address bar honest: it said "session=X" while you were reading Y.
   */
  useEffect(() => {
    const wanted = params.get('session');
    if (!wanted) return;
    if (wanted !== sessionId && !running) setSessionId(wanted);
    const next = new URLSearchParams(params);
    next.delete('session');
    setParams(next, { replace: true });
  }, [params, sessionId, running, setParams]);

  /*
   * WHERE THIS CHAT CAME FROM, and — when it came from a meeting and has not
   * been used yet — the brief, dropped into the composer.
   *
   * The brief is FETCHED rather than carried through navigation, so a refresh
   * does not lose it, and it is placed rather than sent: a transcript is a
   * lossy record of what people meant, and this is the last free moment to
   * correct one.
   */
  useEffect(() => {
    let cancelled = false;
    setOrigin(null);
    api.get(`/agent/sessions/${sessionId}`).then(async (row) => {
      if (cancelled || row?.source !== 'meeting') return;
      setOrigin({ kind: 'meeting', ref: row.source_ref, label: row.source_label });
      const untouched = !row.messageCount;
      if (!untouched) return;
      try {
        const brief = await api.get(`/meetings/${row.source_ref}/brief`);
        if (!cancelled) setInput((cur) => cur || brief.text);
      } catch { /* the meeting may have been discarded; the chat still stands */ }
    }).catch(() => { /* a brand-new session has no row yet */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  /*
   * A DRAFT HANDED OVER BY HEALTH ASSIST.
   *
   * `?health=<runId>:<fingerprint>` says which finding to work on. The prompt
   * itself is FETCHED rather than carried in the URL — for the same reason the
   * meeting brief is, plus one of its own: the draft names up to 25 sys_ids and
   * a URL is the wrong place for them.
   *
   * PLACED, NEVER SENT. Health Assist reads the instance and cannot write to
   * it; handing the agent a prompt must not become a way around that. The user
   * reads the draft, edits it, and sends it — and any mutation it leads to
   * still stops at the approval gate like every other one.
   *
   * The param is cleared once consumed, so a refresh does not re-place a draft
   * over something the user has since typed.
   */
  useEffect(() => {
    const ref = params.get('health');
    if (!ref) return undefined;
    const [runId, fingerprint] = ref.split(':');
    if (!runId || !fingerprint) return undefined;
    let cancelled = false;
    api.get(`/health/runs/${runId}/findings/${fingerprint}/prompt`)
      .then((draft) => {
        if (cancelled || !draft?.text) return;
        setInput((cur) => cur || draft.text);
        setOrigin({ kind: 'health', ref: fingerprint, label: draft.label });
      })
      .catch(() => { /* the run may have been deleted; the chat still stands */ })
      .finally(() => {
        if (cancelled) return;
        const next = new URLSearchParams(params);
        next.delete('health');
        setParams(next, { replace: true });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('health')]);

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
    /*
     * EXPERIENCE §58 — REFRESH MUST NOT LOSE THE TASK.
     *
     * The transcript already survives a reload (it is read from the database
     * above); the task did not, because its id only ever existed in this
     * component's state. So the newest task for this chat is looked up and its
     * durable timeline loaded — which makes a refresh mid-turn show what the
     * agent has done rather than an empty panel beside a full transcript.
     *
     * The timeline is cleared FIRST. Switching chats must not leave the
     * previous chat's activity on screen for the moment it takes to fetch, and
     * a chat with no tasks must show nothing rather than the last one's rows.
     */
    setActivity([]);
    activityRef.current = [];
    setProgress(null);
    setServerStatus(null);
    setActiveSkills([]);
    setTaskId(null);
    liveTask.current = null;
    seqRef.current = 0;
    api.get(`/agent/plan/history/${sessionId}`)
      .then((h) => {
        const newest = h.tasks?.[0];
        if (alive && newest) openTask(newest.task_id);
      })
      .catch(() => { /* no history is a fine answer; the panel simply stays empty */ });
    return () => { alive = false; };
  }, [sessionId, openTask]);

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
  /*
   * TWO DIFFERENT SCROLLS, and they used to be one.
   *
   * OPENING a conversation must land on the newest message: a chat that opens
   * at the top of a forty-message history shows you the oldest thing you have
   * already read. That jump is INSTANT and unconditional — it is a starting
   * position, not an animation, and smooth-scrolling a long transcript on open
   * makes the newest message arrive after a visible slide.
   *
   * FOLLOWING a live turn is different, and it must not fight the reader. The
   * old rule scrolled to the bottom on every change to `messages`, which meant
   * scrolling up to re-read something during a streaming answer yanked you back
   * down on the next frame. So the tail is followed only when you were already
   * near it; scroll up and it leaves you alone until you come back.
   */
  const nearBottomRef = useRef(true);
  const onMsgsScroll = () => {
    const el = msgsRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  /*
   * Hold the bottom while the transcript settles.
   *
   * A single scrollTop lands short: markdown, tool cards and their <pre>
   * blocks lay out after the commit that added them, so the container grows
   * underneath the scroll that just happened. Measured — 93px short on opening
   * a fourteen-row chat, 25px short at the end of a turn.
   *
   * Bounded at 30 frames, and every frame re-checks nearBottomRef, which
   * onMsgsScroll clears the instant anyone scrolls up. So this can never
   * become a loop that drags a reader back down.
   */
  const pinBottom = useCallback((smooth) => {
    const el = msgsRef.current;
    if (!el) return undefined;
    let frame = 0;
    let raf = 0;
    const step = () => {
      const node = msgsRef.current;
      if (!node || !nearBottomRef.current) return;
      if (smooth && frame === 0) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
      else node.scrollTop = node.scrollHeight;
      if (++frame < 30) raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, []);

  /*
   * Opening: land on the latest, instantly.
   *
   * Re-asserted across a few frames rather than set once, because the
   * transcript is still growing when the effect first runs — markdown, tool
   * cards and their <pre> blocks lay out after this commit, and a single
   * scrollTop landed 93px short of the end on a measured fourteen-row chat.
   *
   * Bounded, and it yields the moment the reader takes over: every pass checks
   * nearBottomRef, which onMsgsScroll clears as soon as anyone scrolls up. So
   * this cannot become a loop that fights you for the first half-second.
   */
  useEffect(() => {
    if (loadingSession) return undefined;
    nearBottomRef.current = true;
    return pinBottom(false);
  }, [sessionId, loadingSession, pinBottom]);

  // Live turns: follow the tail only if the reader is already there.
  useEffect(() => {
    if (!nearBottomRef.current) return undefined;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return pinBottom(smooth);
  }, [messages, pinBottom]);

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

  /*
   * Phase 0 — Stop.
   *
   * Aborting the fetch is the whole mechanism: it closes the SSE response, the
   * server sees the disconnect and stops its turn at the next safe boundary.
   * There is no cancel request to send, no polling, and no second execution
   * path — the stream that started the turn is the one that stops it.
   *
   * What this does NOT do is stop work already in flight on the instance. A
   * tool that has started finishes and is recorded, so the wording is "finishing
   * the current step" rather than a promise this cannot keep.
   */
  const stop = () => {
    if (!running || !turnAbort.current) return;
    setStopping(true);
    /*
     * EXPERIENCE §15 — cancellation REQUESTED, and what that does not mean.
     *
     * The wording is deliberate. A mutation already inside its boundary
     * completes; nothing is rolled back and nothing is undone. Saying "stopped"
     * would claim an outcome the backend has not reached yet, and implying a
     * rollback would claim one it never performs.
     */
    push({
      kind: 'system',
      text: 'Cancellation requested. The current operation completes safely and is recorded — '
        + 'nothing already written is rolled back.',
    });
    turnAbort.current.abort();
  };

  const send = async (text, { retry = false } = {}) => {
    const message = (text ?? input).trim();
    if (!message || running) return;
    if (!retry) setInput('');
    setRunning(true);
    setStopping(false);
    /*
     * EXPERIENCE §6 — a new turn is a new task, so it gets a new timeline.
     *
     * Cleared rather than appended to: the panel shows what THIS task is doing,
     * and carrying the previous task's rows forward would make the counts in
     * the header describe two runs at once. The previous task is not lost — it
     * is durable, and the Tasks rail reopens it (§51).
     */
    setActivity([]);
    activityRef.current = [];
    setProgress(null);
    setServerStatus(null);
    setActiveSkills([]);
    liveTask.current = null;
    seqRef.current = 0;
    const controller = new AbortController();
    turnAbort.current = controller;
    if (!retry) push({ kind: 'user', text: message });

    /*
     * PHASE 14 — `/diagnose <question>` runs the Doctor instead of an ordinary
     * turn.
     *
     * EXPLICIT RATHER THAN INFERRED. Sniffing "does this look like a
     * diagnostic question?" would sometimes route a request that wanted work
     * done into a read-only investigation, and sometimes the reverse — and the
     * second mistake is the one that matters, because the user would be told
     * something was investigated when they asked for it to be fixed. A command
     * cannot be misread.
     */
    /*
     * PHASE 16 — `/lint <flow>` runs NowLint, on the same explicit-command
     * principle as `/diagnose`. Sniffing "does this look like a lint request?"
     * would sometimes route a request that wanted work done into an analysis
     * pass, and the reverse; a command cannot be misread.
     */
    /*
     * PHASE 19 — `/knowledge <question>` asks everything this build knows, and
     * adjudicates where the sources disagree. Explicit, like every domain
     * command before it: retrieval already reaches every ordinary turn's
     * prompt, and what this adds is the ADJUDICATION, which a person should ask
     * for rather than have inferred from their phrasing.
     *
     * `knowledge_complete` is the terminal frame. There is no approval frame on
     * this route — the domain has no write path — so none is handled.
     */
    /*
     * PHASE 20 — `/build <request>` designs an application and, where this
     * environment can author every component, builds it through the ordinary
     * plan and the ordinary approval card.
     *
     * The approval frame IS handled here, unlike the read-only domain routes:
     * a build is a mutation, and it goes through the same gate every other
     * mutation does. `appbuild_complete` is the terminal frame.
     */
    if (/^\/build\s+/i.test(message)) {
      try {
        await streamed('/agent/plan/build',
          { sessionId, message: message.replace(/^\/build\s+/i, '') },
          (evt) => {
            switch (evt.type) {
              case 'task_started': setTaskId(evt.taskId); break;
              case 'appbuild_requirements':
                push({ kind: 'system', text: `Requirements read: ${evt.name}` });
                break;
              case 'appbuild_discovered':
                push({ kind: 'system', text: `Discovered ${JSON.stringify(evt.counts)}${evt.complete ? '' : ' (some surfaces unreadable)'}` });
                break;
              case 'appbuild_capability':
                push({ kind: 'system', text: evt.executable
                  ? 'Every component is supported here.'
                  : `${evt.blocked} component(s) cannot be built here — nothing will be written.` });
                break;
              case 'approval_required':
                setApproval({ approvalId: evt.approvalId, nonce: evt.nonce, name: evt.name, input: evt.input, plan: evt.plan, warning: evt.warning });
                break;
              case 'approval_resolved':
                setApproval(null);
                break;
              case 'appbuild_decided': break;
              case 'appbuild_complete':
                settled = true;
                if (evt.build) push({ kind: 'appbuild', build: evt.build });
                break;
              case 'plan_failed':
                settled = true;
                push({ kind: 'error', text: evt.note ?? 'The build could not be completed.' });
                break;
              default: break;
            }
          });
      } catch (e) {
        push({ kind: 'error', text: e.message || 'The build could not be completed.' });
      }
      return;
    }
    if (/^\/knowledge\s+/i.test(message) || /^\/know\s+/i.test(message)) {
      try {
        await streamed('/agent/plan/knowledge',
          { sessionId, message: message.replace(/^\/(knowledge|know)\s+/i, '') },
          (evt) => {
            if (evt.type === 'task_started') return;
            if (evt.type === 'knowledge_answered') return;
            if (evt.type === 'knowledge_complete') { push({ kind: 'knowledge', knowledge: evt.knowledge }); return; }
            if (evt.type === 'plan_failed') {
              push({ kind: 'error', text: evt.note ?? 'The question could not be answered.' });
            }
          });
      } catch (e) {
        push({ kind: 'error', text: e.message || 'The question could not be answered.' });
      }
      return;
    }

    if (/^\/lint\s+/i.test(message)) {
      try {
        await streamed('/agent/plan/lint',
          { sessionId, message: message.replace(/^\/lint\s+/i, '') },
          (evt) => {
            if (evt.type === 'task_started') { setTaskId(evt.taskId); return; }
            if (evt.type === 'lint_complete') { push({ kind: 'lint', lint: evt.lint, knowledge: evt.knowledge }); return; }
            if (evt.type === 'plan_failed') {
              push({ kind: 'error', text: evt.note ?? 'The lint could not be completed.' });
            }
          }, 'POST', { signal: controller.signal });
      } catch (e) {
        push({ kind: 'error', text: e.message || 'The lint could not be completed.' });
      } finally {
        setRunning(false);
        turnAbort.current = null;
      }
      return;
    }

    /*
     * PHASE 17 — `/test <flow>` runs NowTest, on the same explicit-command
     * principle as `/diagnose` and `/lint`, and for a sharper reason than
     * either: this is the only one of the three that WRITES. A sniffed
     * "does this look like a test request?" would occasionally create a real
     * record on a real instance because a sentence happened to contain the word
     * "test". A command cannot be misread.
     *
     * The approval that authorises that write goes through the EXISTING plan
     * approval card below — the same `approval_required` frame, the same nonce,
     * the same `decide()`, the same `POST /api/agent/approve` the server is
     * already waiting on. There is deliberately no second approval control: a
     * gate that exists twice is a gate that can be bypassed once.
     */
    if (/^\/test\s+/i.test(message)) {
      /*
       * `settled` exists because a domain-terminal frame and a STREAM-terminal
       * frame are not the same thing. `/plan/test` ends on `test_complete` or
       * `plan_failed` and then closes, without the `done` frame `sse()` looks
       * for, so a run that finished perfectly still surfaces as a truncated
       * stream in the catch below. Reporting "the connection ended before this
       * finished" underneath a completed verdict would be the renderer telling
       * a person the opposite of what happened. A genuinely truncated stream —
       * one that stops before either terminal frame — is still reported loudly.
       */
      let settled = false;
      try {
        await streamed('/agent/plan/test',
          { sessionId, message: message.replace(/^\/test\s+/i, '') },
          (evt) => {
            switch (evt.type) {
              case 'task_started': setTaskId(evt.taskId); break;
              // §8 — which flow this is about, named before anything is created.
              case 'test_flow_identified':
                push({ kind: 'system', text: `Testing "${evt.flow?.name ?? 'flow'}" — ${evt.flow?.sys_id ?? ''}` });
                break;
              // §13 — how much of what the flow promises this run will actually
              // check, said BEFORE the approval rather than discovered in the
              // verdict. A person approving a write deserves to know in advance
              // that the answer may be INCONCLUSIVE.
              case 'test_contract':
                if (evt.coverage?.note) push({ kind: 'system', text: evt.coverage.note });
                break;
              case 'test_plan_ready':
                push({
                  kind: 'system',
                  text: `Test plan ready — ${evt.review?.steps?.length ?? 0} step(s), `
                    + `${evt.review?.plannedChanges?.length ?? 0} change(s) on the instance.`,
                });
                break;
              // The existing approval card, unchanged. `warning` carries what
              // this particular approval authorises — a disposable record, or a
              // leftover one being cleaned up.
              case 'approval_required':
                push({
                  kind: 'approval', approvalId: evt.approvalId, name: evt.name, input: evt.input,
                  decided: null, warning: evt.warning || null, nonce: evt.nonce || null,
                });
                break;
              case 'approval_resolved':
                patchMsg((m) => m.kind === 'approval' && m.approvalId === evt.approvalId, {
                  decided: evt.approved, source: evt.source || null, at: evt.at || null,
                  sending: null, failed: null,
                });
                break;
              case 'test_started':
                push({
                  kind: 'system',
                  text: `Creating a disposable ${evt.fixture?.table ?? 'record'} and waiting for the flow to run.`,
                });
                break;
              // §36 — cleanup is never silent, including while it is happening.
              case 'test_cleanup_started':
                push({ kind: 'system', text: `Removing the test record ${evt.table} ${evt.sys_id}.` });
                break;
              /*
               * The verdict is decided, and the stream is not over: cleanup can
               * still be running. This is a progress line, and it is a DIFFERENT
               * frame from the terminal one below precisely so that exactly one
               * terminal frame ever arrives.
               */
              case 'test_decided':
                push({ kind: 'system', text: `Result: ${evt.status}. Finishing up.` });
                break;
              case 'test_complete':
                settled = true;
                if (evt.test) push({ kind: 'test', test: evt.test, knowledge: evt.knowledge });
                break;
              case 'plan_failed':
                settled = true;
                push({ kind: 'error', text: evt.note ?? 'The test could not be completed.' });
                break;
              default: break;
            }
          }, 'POST', { signal: controller.signal });
      } catch (e) {
        if (!settled) push({ kind: 'error', text: e.message || 'The test could not be completed.' });
      } finally {
        setRunning(false);
        turnAbort.current = null;
      }
      return;
    }

    /*
     * PHASE 18 — `/change <flow>` compares a flow with an earlier state of
     * itself, on the same explicit-command principle as the three above.
     *
     * It is the one of the four that CANNOT write. There is no approval frame
     * on this route and none is handled here, and that absence is deliberate
     * rather than an omission: `/api/agent/plan/change` has no executor, no
     * tool and no client in its path, so there is nothing for an approval to
     * authorise. Adding a card here would invent a gate in front of a door that
     * does not exist, and teach people that a comparison is a thing that
     * sometimes changes the instance.
     *
     * Deploying what the comparison found is a SEPARATE journey: the panel's
     * [Prepare Change] hands its goal to the ordinary `send()` below, which is
     * the ordinary planner with the ordinary review and the ordinary approval
     * card. One gate, in the place it already was.
     */
    if (/^\/change\s+/i.test(message)) {
      /*
       * `change_complete` is the terminal frame and the only one that
       * carries the comparison. The domain says `change_decided` when the
       * verdict is known; the route says `change_complete` when the stream
       * is over. One terminal frame, as everywhere else in this build.
       */
      let settled = false;
      try {
        await streamed('/agent/plan/change',
          { sessionId, message: message.replace(/^\/change\s+/i, '') },
          (evt) => {
            switch (evt.type) {
              case 'task_started': setTaskId(evt.taskId); break;
              // §8 — which flow this is about, named before either state is read.
              case 'change_artifact_identified':
                push({
                  kind: 'system',
                  text: `Comparing "${evt.flow?.name ?? 'flow'}" — ${evt.flow?.sys_id ?? ''}`,
                });
                break;
              // §4 — WHERE the two states came from, said while they are being
              // read rather than discovered in the result. A baseline whose
              // source a person only learns at the end is one they cannot
              // object to in time.
              case 'change_states_read':
                push({
                  kind: 'system',
                  text: `Read ${evt.baseline?.source ?? 'baseline'} and ${evt.current?.source ?? 'current'}.`,
                });
                break;
              // §35 — capturing a baseline happens INSTEAD of a comparison, so
              // it gets its own line rather than being folded into one.
              case 'change_baseline_captured':
                push({ kind: 'system', text: `Baseline captured — ${evt.hash ?? ''}` });
                break;
              /*
               * The comparison is decided and the stream is not over. A
               * DIFFERENT frame from the terminal one below, precisely so that
               * exactly one terminal frame ever arrives.
               */
              case 'change_decided':
                push({ kind: 'system', text: `${evt.changes ?? 0} change(s), risk ${evt.risk ?? 'UNKNOWN'}.` });
                break;
              case 'change_complete':
                settled = true;
                if (evt.change) push({ kind: 'change', change: evt.change, knowledge: evt.knowledge });
                break;
              case 'plan_failed':
                settled = true;
                push({ kind: 'error', text: evt.note ?? 'The comparison could not be completed.' });
                break;
              default: break;
            }
          }, 'POST', { signal: controller.signal });
      } catch (e) {
        if (!settled) push({ kind: 'error', text: e.message || 'The comparison could not be completed.' });
      } finally {
        setRunning(false);
        turnAbort.current = null;
      }
      return;
    }

    const diagnostic = /^\/diagnose\s+/i.test(message);
    if (diagnostic) {
      try {
        await streamed('/agent/plan/diagnose',
          { sessionId, message: message.replace(/^\/diagnose\s+/i, '') },
          (evt) => {
            if (evt.type === 'task_started') { setTaskId(evt.taskId); return; }
            if (evt.type === 'diagnosis_complete') {
              push({ kind: 'diagnosis', diagnosis: evt.diagnosis, knowledge: evt.knowledge });
              return;
            }
            if (evt.type === 'plan_failed') {
              push({ kind: 'error', text: evt.note ?? 'The diagnosis could not be completed.' });
            }
          }, 'POST', { signal: controller.signal });
      } catch (e) {
        push({ kind: 'error', text: e.message || 'The diagnosis could not be completed.' });
      } finally {
        setRunning(false);
        turnAbort.current = null;
      }
      return;
    }

    try {
      await streamed('/agent/chat', { sessionId, message, retry }, (evt) => {
        switch (evt.type) {
          case 'meta': setMeta(evt); break;
          // PHASE 8 — which durable task this turn is. Additive: a client that
          // ignored this frame would behave exactly as it did before.
          case 'task_started': setTaskId(evt.taskId); break;
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
              // WI-IMP-2 — whose authority this card hands over, resolved before
              // the card was shown rather than discovered after it was approved.
              impersonationApproval: evt.impersonationApproval || null,
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
          /*
           * WI-2 — the turn ended on a question only you can answer.
           *
           * DELIBERATELY RENDERS NOTHING. The frame is still handled here, and
           * the waiting state itself is untouched: rowFromFrame() above turns
           * this same frame into a BLOCKED activity row titled "Waiting for
           * you" before this switch ever runs, deriveStatus() reads that row,
           * and the composer's indicator shows it. What is gone is the chat
           * bubble that repeated it a third time — the question the agent asked
           * is already the message directly above it.
           */
          case 'awaiting_user':
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
          /*
           * Phase 0 — the third terminal state, and it is neither of the other
           * two. Rendered distinctly so a stopped turn is never read as a
           * failure (nothing went wrong) or as a completion (the work is not
           * finished). The server's own count of completed mutations rides
           * along, because "did anything land before it stopped" is the first
           * question anyone asks — and the mutation report above already says
           * exactly what did.
           */
          case 'cancelled':
            push({ kind: 'cancelled', phase: evt.phase, mutations: evt.mutations || 0, tool: evt.tool || null });
            break;
          // Calls the model proposed that never ran, because the turn stopped
          // first. Said out loud: silence would read as the model choosing not
          // to act.
          case 'calls_discarded':
            if (evt.reason === 'cancelled' && evt.discarded?.length) {
              push({
                kind: 'system',
                text: `Not started: ${evt.discarded.join(', ')} — the turn was stopped before ${evt.discarded.length === 1 ? 'it ran' : 'they ran'}.`,
              });
            }
            break;
          // An approval card that was still waiting when the turn stopped. It
          // was never decided, and must not be painted as approved or rejected.
          case 'approval_cancelled':
            patchMsg((m) => m.kind === 'approval' && m.approvalId === evt.approvalId, {
              decided: null, cancelled: true, sending: null, failed: null,
            });
            break;
          default: break;
        }
      }, 'POST', { signal: controller.signal });
    } catch (e) {
      /*
       * `e.cancelled` means WE aborted this fetch. The server is stopping its
       * own turn as we speak and will report what it did on the Audit page, so
       * this is a stopped turn rather than an error — and rendering it as one
       * would put a red box in front of a user who pressed Stop deliberately.
       *
       * The bubble is only pushed if the server's own `cancelled` frame did not
       * arrive first: aborting the fetch usually tears the stream down before
       * that frame can be read, but not always, and two stop bubbles for one
       * Stop is worse than none.
       */
      if (e.cancelled) {
        setMessages((ms) => (ms.some((m) => m.kind === 'cancelled')
          ? ms
          : [...ms, { id: uid(), kind: 'cancelled', phase: 'client-abort', mutations: null, tool: null }]));
      } else {
        push({ kind: 'error', text: e.message });
      }
    } finally {
      setRunning(false);
      setStopping(false);
      // The turn is over however it ended — a later Stop must not abort a
      // controller whose turn has already settled.
      if (turnAbort.current === controller) turnAbort.current = null;
      refreshSessions();
      /*
       * EXPERIENCE §8 — SETTLE THE TIMELINE FROM THE SERVER.
       *
       * The finished list is replaced by the durable projection, so what the
       * workspace shows after a turn is exactly what it shows after a refresh
       * and exactly what it shows when the task is reopened a week later. Three
       * routes to one answer rather than three answers.
       *
       * It also supplies the status and the step counts, which the frame stream
       * cannot give honestly: `progress` comes from the step rows, and a count
       * derived from frames would be the client's estimate of the backend's
       * state, which §26 rules out.
       *
       * Failure here is not the turn's failure. The live rows stay, and they
       * were real; a projection that could not be fetched is a missing refinement,
       * not a reason to blank what the user just watched.
       */
      /*
       * §76 — how much the live stream produced, before the durable projection
       * replaces it. A large gap between the two is the signal that a frame is
       * being mapped to nothing, which is the failure this layer would
       * otherwise hide from itself.
       */
      logToServer('debug', `activity: turn produced ${seqRef.current} frame(s) -> ${activityRef.current.length} row(s)`);
      if (liveTask.current) openTask(liveTask.current).catch(() => {});
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
    openAgent();
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

  /**
   * Bulk chat delete.
   *
   * Behind the same confirmation dialog every other destructive action uses, and
   * it names what SURVIVES as well as what goes — the audit trail is the thing
   * a person will worry about, and the answer is reassuring, so say it.
   *
   * The server reports before/after counts and an `auditPreserved` verdict. If
   * that ever comes back false the toast says so loudly rather than reporting a
   * clean success, because the one failure that matters here is silent.
   */
  const removeAll = async () => {
    const count = sessions?.length ?? 0;
    if (!count) { toast.success('There are no chats to delete.'); return; }
    const ok = await confirmDestructive({
      action: 'Delete all chats',
      subject: `${count} conversation${count === 1 ? '' : 's'}`,
      detail: CONSEQUENCE.allSessions,
      confirmLabel: 'Delete all chats',
    });
    if (!ok) return;
    try {
      const res = await api.del('/agent/sessions');
      setSessionId(crypto.randomUUID());
      refreshSessions();
      if (res.auditPreserved === false) {
        toast.error(`Deleted ${res.deleted} chat(s), but the audit trail changed — check the Audit page.`);
      } else {
        toast.success(`Deleted ${res.deleted} chat${res.deleted === 1 ? '' : 's'}. The audit trail is intact.`);
      }
    } catch (e) { toast.error(e.message); }
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
  const chatRail = searchHits ? searchHits.sessions : (sessions || []);

  /*
   * EXPERIENCE §12/§13 — the one word the header shows.
   *
   * Derived, with a deterministic precedence, from what the backend has said —
   * never from which frame happened to arrive last. While a turn streams that
   * is the live rows; once it settles it is the server's own derivation over
   * the durable rows, so the header and the timeline cannot disagree.
   */
  const status = deriveStatus({ running, stopping, rows: activity, serverStatus });
  /*
   * §16/§19 — the plan panel's inputs, split out of the one timeline.
   *
   * A CHAT TURN IS NOT A PLAN. Every task carries one durable step — Phase 1's
   * "one turn, one task, one step" — so filtering on type alone put a one-line
   * "Plan: 1 step · One agent turn" panel above every ordinary message. §68
   * says the panels are contextual and the conversation stays primary, and a
   * panel that appears every single time is neither.
   *
   * A durable row knows whether it belongs to a plan: `plan_step_id` is set by
   * the plan store and null for a turn step. A LIVE row has no metadata at all,
   * and only the plan executor emits step frames — so its mere existence is the
   * evidence.
   */
  const planSteps = activity.filter((r) => {
    if (r.type !== 'step' || r.id.includes(':dataflow:')) return false;
    return r.metadata ? Boolean(r.metadata.plan_step_id) : true;
  });
  const dataflow = activity.filter((r) => r.id.includes(':dataflow:'));

  /*
   * THE LATEST UPDATE-SET REPORT.
   *
   * Derived, not stored: the capture frames are already in `messages` exactly
   * as they always were, and this reads the last one. No second copy to keep in
   * sync, and no new event — only the newest is shown because a capture report
   * supersedes the one before it rather than adding to a list.
   */
  const latestCapture = useMemo(
    () => [...messages].reverse().find((m) => m.kind === 'capture') ?? null,
    [messages],
  );

  return (
    <div className="agent-layout">
      {/*
        * The Gradient Waves are no longer mounted here. They live once in the
        * app shell (App.jsx) so every route shares one instance and one WebGL
        * context; this page sits above that layer like every other page does.
        */}
      {/*
        * CAPTURE AND AUTO-APPROVE, AT THE FOOT OF THE NAVIGATION.
        *
        * Relocated, not reimplemented: the same two labels, bound to the same
        * `capture`/`autoApprove` state and the same toggleCapture/toggleAuto
        * handlers that talk to the same endpoints they always did. They are
        * agent settings that outlive the page you happen to be looking at,
        * which is why they read correctly from the column rather than from the
        * playground.
        */}
      {/* Delete Chats stays in the navigation, beside the chat list it clears. */}
      {slots.actions && createPortal(
        <div className="agent-actions">
          {/* The same removeAll the rail head called — relocated, not
              reimplemented. */}
          <button
            type="button"
            className="nav-item nav-danger"
            onClick={removeAll}
            disabled={running || !(sessions?.length)}
            title="Delete every conversation. The audit trail is not affected."
          >
            <svg className="nav-ic" data-ic="trash" viewBox="0 0 24 24" width="17" height="17" fill="none"
              stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" />
            </svg>
            <span className="nav-label">Delete Chats</span>
          </button>
        </div>,
        slots.actions,
      )}

      {/*
        * CAPTURE AND AUTO-APPROVE, ON THE PREFERENCES PAGE.
        *
        * The same two labels, bound to the same `capture`/`autoApprove` state
        * and the same toggleCapture/toggleAuto handlers hitting the same
        * endpoints they always did. Relocated, not reimplemented — there is one
        * implementation of each and it is this one.
        */}
      {slots.prefs && createPortal(
        <div className="agent-switches">
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
        </div>,
        slots.prefs,
      )}

      {/*
        * FOUR PORTALS, ONE OWNER.
        *
        * The navigation files these under different headings now, so each pane
        * goes to its own slot instead of one blob going to one place. The
        * markup inside each is exactly what the old rail rendered — same
        * components, same props, same handlers — and every piece of state they
        * read still lives on this page.
        */}
      {/* New chat, above the Chats group. Same newChat(), same disabled-while-
          running guard — only the slot it lands in changed. */}
      {slots.newChat && createPortal(
        <button className="nav-newchat-btn" onClick={newChat} disabled={running}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>New chat</span>
        </button>,
        slots.newChat,
      )}

      {slots.chats && createPortal(
        <div className="rail-pane">
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
          {!railLoading && chatRail.length === 0 && (
            <div className="rail-empty">
              {searchHits ? 'Nothing matched.' : 'No chats yet — say something below and this fills in.'}
            </div>
          )}
          {chatRail.map((s) => (
            <div
              key={s.id}
              className={`rail-item${s.id === sessionId ? ' active' : ''}${s.source === 'meeting' ? ' from-meeting-row' : ''}`}
              onClick={() => { if (!running) { setSessionId(s.id); openAgent(); } }}
              title={[
                s.title || 'Untitled chat',
                s.source === 'meeting' && `from the meeting "${s.source_label || ''}"`,
                new Date(s.updated).toLocaleDateString(),
                s.message_count > 0 && `${s.message_count} message${s.message_count === 1 ? '' : 's'}`,
                s.mutation_count > 0 && `${s.mutation_count} mutation${s.mutation_count === 1 ? '' : 's'}`,
                s.snippet,
              ].filter(Boolean).join(' · ')}
            >
              <div className="rail-title">{s.title || 'Untitled chat'}</div>
              {/* Two actions, no overflow menu. They are clipped rather than
                  display:none so they stay in the tab order on every row — a
                  button that is not in the DOM cannot be focused, and the
                  confirm dialog could not restore focus to it afterwards. */}
              <div className="rail-actions">
                <button
                  type="button" className="rail-btn"
                  onClick={(e) => { e.stopPropagation(); rename(s); }}
                  title="Rename" aria-label={`Rename "${s.title || 'Untitled chat'}"`}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                    strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                  </svg>
                </button>
                <button
                  type="button" className="rail-btn danger"
                  onClick={(e) => { e.stopPropagation(); remove(s); }}
                  title="Delete" aria-label={`Delete "${s.title || 'Untitled chat'}"`}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                    strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
                    <path d="M18.5 6v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6" />
                  </svg>
                </button>
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
        </div>,
        slots.chats,
      )}

      {slots.tasks && createPortal(
          <div className="rail-pane">
            {/*
              * Opening a past task REPLACES the timeline with that task's
              * durable projection. Doing that mid-turn would leave the live
              * stream appending this turn's rows onto another task's list —
              * two id spaces in one panel, which is exactly the mixing §11
              * exists to prevent. So the rows are inert while a turn runs, and
              * the reason is on screen rather than left to be discovered.
              */}
            <TaskHistory
              sessionId={sessionId}
              currentTaskId={taskId}
              onOpen={running ? null : openTask}
              onContinue={running ? null : (prompt) => setInput(prompt)}
            />
            {running && (
              <p className="rail-note">
                A turn is running. Past tasks open once it finishes — their timelines would otherwise
                mix with this one’s.
              </p>
            )}
          </div>
        ,
        slots.tasks,
      )}

      {slots.skills && createPortal(
          <div className="rail-pane">
            {/*
              * §45 — a skill toggled while a turn is running does NOT change
              * that turn. The task recorded its skill set when it opened; this
              * changes what the NEXT task sees. The control is disabled while a
              * turn runs so the UI cannot suggest otherwise.
              */}
            <SkillsPanel disabled={running} />
            {running && (
              <p className="rail-note">
                A turn is running. Skill changes apply to the next task — this one keeps the set it started with.
              </p>
            )}
          </div>
        ,
        slots.skills,
      )}


      <div className="chat-wrap">
        {/* A chat that came from a meeting is not one somebody typed, and the
            difference matters most at the moment you are about to approve a
            write. Persistent rather than a toast, for exactly that reason — it
            has to still be there ten minutes and forty tool calls later. */}
        {origin?.kind === 'meeting' && (
          <div className="from-meeting" style={{ marginBottom: 10 }}>
            <span className="mark">● from meeting</span>
            <span className="what">
              Building what was agreed in <b>{origin.label || 'a recorded meeting'}</b>.
              Requirements came from the transcript, not from me.
            </span>
            <Link className="btn ghost sm" to="/meetings">Open the meeting</Link>
          </div>
        )}

        {/* Same banner, same reason: at the moment you approve a write, it has
            to still say where this work came from. A health finding is a READ
            of the instance — it proposes, and nothing about arriving from it
            changes what the gate asks. */}
        {origin?.kind === 'health' && (
          <div className="from-meeting" style={{ marginBottom: 10 }}>
            <span className="mark">● from health assist</span>
            <span className="what">
              Working on <b>{origin.label || 'a health finding'}</b>.
              The finding came from a deterministic rule over a read of the instance — every write it leads to is still yours to approve.
            </span>
            <Link className="btn ghost sm" to="/health">Open Health Assist</Link>
          </div>
        )}

        {/* The agent itself runs disconnected — it just cannot do anything
            useful to an instance, so this is a banner rather than a gate. */}
        <DisconnectedBanner />

        {/*
          * ONE scroll container, still. TASK 5 puts React Bits' AnimatedItem
          * around each row inside it rather than wrapping the transcript in
          * <AnimatedList>, whose own .scroll-list would have been a second
          * scrollbar inside this one.
          */}
        {/*
          * The transcript and the activity drawer share one row. The drawer is
          * a SIBLING, so opening it narrows .msgs instead of covering it —
          * nothing is ever hidden behind the panel.
          */}
        <div className="playground-body">
        <div className="msgs" ref={msgsRef} onScroll={onMsgsScroll}>
          {loadingSession && (
            <div className="msg">
              <div className="bubble" style={{ minWidth: 320 }}><SkeletonLines lines={3} /></div>
              <LoadingRegion label="Loading transcript" />
            </div>
          )}

          {/* The new-chat state. Same prompts, same send() behind them — only
              the card around them is gone. */}
          {!loadingSession && messages.length === 0 && (
            <AgentWelcome />
          )}

          {messages.map((m) => {
            /*
              * The row is built exactly as it always was — every branch below
              * is untouched — and then handed to AnimatedItem. Wrapping the
              * RESULT rather than editing eleven return sites is what keeps
              * this a presentation change: the approval cards, tool cards and
              * their buttons are the same elements they were.
              */
            const row = (() => {
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
            /*
             * Phase 0 — a STOPPED turn, which is neither of its neighbours.
             *
             * Not an error bubble: nothing went wrong and there is nothing to
             * retry-because-it-failed. Not silence either: a turn that stopped
             * halfway must say so, or it reads exactly like one that finished.
             * The amber border is the same one the approval gate uses — this
             * is a turn awaiting a person, not a broken one.
             */
            if (m.kind === 'cancelled') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble" style={{ borderColor: 'var(--amber)' }}>
                    <strong>Stopped.</strong>{' '}
                    <span className="muted">
                      {m.tool
                        ? `${m.tool} was already running when you pressed Stop; it finished and was recorded. `
                        : ''}
                      {m.mutations === null
                        ? 'The agent was told to stop and is winding down. Anything it completed is on the Audit page.'
                        : m.mutations > 0
                          ? `${m.mutations} change${m.mutations === 1 ? '' : 's'} had already been made and ${m.mutations === 1 ? 'is' : 'are'} listed above. Nothing further was started.`
                          : 'Nothing was changed on the instance.'}
                    </span>
                  </div>
                </div>
              );
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
            /*
              * UPDATE SET CAPTURE IS NOT CONVERSATION.
              *
              * Whether a change landed in an update set is a property of the
              * run, not a thing the agent said, and as a bubble it interrupted
              * the conversation to report on plumbing. It moved to the Update
              * Set section at the foot of the Activity panel, which reads the
              * very same messages — the push above is unchanged, so nothing
              * stopped being recorded.
              */
            if (m.kind === 'capture') return null;
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
            if (m.kind === 'appbuild') {
              return (
                <div key={m.id} className="msg assistant">
                  <AppBuildPanel build={m.build} />
                </div>
              );
            }
            if (m.kind === 'knowledge') {
              return (
                <div key={m.id} className="msg assistant">
                  <KnowledgePanel knowledge={m.knowledge} />
                </div>
              );
            }
            if (m.kind === 'lint') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble">
                    <LintPanel lint={m.lint} />
                    <KnowledgeAside panel={m.knowledge?.panel} />
                  </div>
                </div>
              );
            }
            if (m.kind === 'test') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble">
                    {/* §40 — the Doctor handoff is a CONTINUATION, so it starts
                        an ordinary `/diagnose` turn rather than a private one.
                        The question it asks is visible in the transcript and
                        answerable by the same command anyone could have typed,
                        which is the difference between a handoff and a hidden
                        second engine. */}
                    <TestPanel test={m.test} onInvestigate={(request) => send(`/diagnose ${request}`)} />
                    <KnowledgeAside panel={m.knowledge?.panel} />
                  </div>
                </div>
              );
            }
            if (m.kind === 'change') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble">
                    {/* §32 — both handoffs are CONTINUATIONS, so each starts an
                        ordinary turn rather than a private one. [Prepare
                        Change] types the goal into the normal planner, which
                        reviews it and waits for an approval; [Run NowTest]
                        types the ordinary `/test` command. The panel itself
                        cannot deploy or write anything, and neither of these
                        gives it a way to. */}
                    <ChangePanel
                      change={m.change}
                      onPrepare={(goal) => send(goal)}
                      onRunTest={(request) => send(`/test ${request}`)}
                    />
                    <KnowledgeAside panel={m.knowledge?.panel} />
                  </div>
                </div>
              );
            }
            if (m.kind === 'diagnosis') {
              return (
                <div key={m.id} className="msg">
                  <div className="bubble">
                    <DiagnosisPanel diagnosis={m.diagnosis} />
                    <KnowledgeAside panel={m.knowledge?.panel} />
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
            /*
              * TOOL CALLS ARE NOT CONVERSATION.
              *
              * A tool card is execution: which tool ran, with what arguments,
              * and what came back. It belongs to the Activity panel, which is
              * fed by the very same frames (activity.js turns tool_use and
              * tool_result into rows) — so nothing stopped being recorded and
              * nothing stopped being visible. It stopped being a chat message.
              *
              * The message is still PUSHED and still patched by tool_result:
              * the approval flow matches on it, and dropping it from state
              * would break that. Only its rendering is gone.
              */
            if (m.kind === 'tool') return null;
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
                  {/* WI-IMP-2 — this card hands authority to a PERSON. The chip
                      above is null on a first start (mode is not active yet),
                      which is exactly the card where "whose authority?" is being
                      decided. An ADMINISTRATOR target gets the same red weight
                      as a destructive action: measured, the elevated flag used
                      to appear only as a boolean inside the JSON payload below,
                      indistinguishable from impersonating any ordinary user. */}
                  {m.impersonationApproval && (
                    <div style={{
                      border: `1px solid var(--${m.impersonationApproval.elevated ? 'red' : 'amber'})`,
                      borderRadius: 6, padding: '6px 8px', marginTop: 6, fontSize: 12,
                    }}>
                      <div style={{ color: `var(--${m.impersonationApproval.elevated ? 'red' : 'amber'})`, fontWeight: 600 }}>
                        {m.impersonationApproval.elevated
                          ? `⚠ ELEVATED — ${m.impersonationApproval.target.user_name} holds the ADMIN role`
                          : `Acts as ${m.impersonationApproval.target.user_name}`}
                      </div>
                      <div style={{ color: 'var(--muted)' }}>
                        {m.impersonationApproval.target.display} · {m.impersonationApproval.target.sys_id}
                      </div>
                      {m.impersonationApproval.task && (
                        <div style={{ color: 'var(--muted)' }}>for: {m.impersonationApproval.task}</div>
                      )}
                      <div style={{ color: 'var(--muted)', marginTop: 4 }}>{m.impersonationApproval.note}</div>
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
                  {/*
                    * Phase 0 — the card was still waiting when the turn stopped.
                    *
                    * Checked FIRST, and it is deliberately not one of the two
                    * verdicts: nobody approved and nobody rejected. Painting it
                    * red would put a decision on screen that no person made,
                    * which is the same dishonesty WI-4 removed from the green
                    * badge. The buttons go, because there is no longer a turn
                    * waiting for them.
                    */}
                  {m.cancelled ? (
                    <>
                      <span className="badge">not decided — the turn was stopped</span>
                      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
                        This was never authorised and never ran. Ask again if you still want it.
                      </div>
                    </>
                  ) : m.decided === null || m.decided === undefined ? (
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
            })();

            if (!row) return null;
            return (
              <AnimatedItem
                key={m.id}
                /*
                 * amount "some": any pixel counts. An agent answer taller than
                 * the scroller can never satisfy a 0.5 ratio, so a numeric
                 * threshold would leave long replies permanently hidden.
                 *
                 * once is deliberately NOT set. That is what makes the effect a
                 * SCROLL animation rather than an arrival animation: a row that
                 * leaves the scroller re-arms, so coming back to it — upward or
                 * downward — plays the entrance again. With "some", a row only
                 * re-arms once it is fully out of view, so nothing fades while
                 * any part of it is still on screen and being read.
                 *
                 * The style overrides drop the vendor's menu affordances: .msgs
                 * already owns the 12px gap, and a transcript is text you
                 * select, not a row you click.
                 */
                amount="some"
                className={`msg-row${m.kind === 'user' ? ' is-user' : ''}`}
                style={{ marginBottom: 0, cursor: 'auto' }}
              >
                {row}
              </AnimatedItem>
            );
          })}
        </div>

        {/* Sources sits in the same row as Activity and wears the same shell,
            so the two open, close and reflow identically. They are mutually
            exclusive: two panels both claiming the row would each take width
            from the transcript. */}
        <SourcesDrawer
          open={showEvidence}
          taskId={taskId}
          onClose={() => setShowEvidence(false)}
        />

        <ActivityDrawer
          open={activityOpen}
          rows={activity}
          taskId={taskId}
          running={running}
          progress={progress}
          skills={activeSkills}
          updateSet={latestCapture}
          onOpenEvidence={() => { setActivityOpen(false); setShowEvidence(true); }}
          onClose={() => setActivityOpen(false)}
        />
        </div>

        {/*
          * The composer is PRESENTATION, and lives in its own file for that
          * reason. Everything it does on submit is this page's own send() —
          * same handler, same payload, same turn. Phase 0's Send/Stop swap is
          * preserved inside it: the two are mutually exclusive actions on one
          * turn, and one live control beats a live one next to a dead one.
          */}
        <PlanPanel steps={planSteps} progress={progress} dataflow={dataflow} />

        {/*
          * The composer and the activity indicator sit on one row at the foot
          * of the playground. The indicator is the ONLY place the agent's
          * status is shown now — the composer's own status readout is gone, so
          * the same state is never printed twice.
          */}
        <div className="composer-line">
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={send}
          onStop={stop}
          onNewChat={newChat}
          running={running}
          stopping={stopping}
          model={meta}
          hasEvidence={Boolean(taskId)}
          sourcesOpen={showEvidence}
          onOpenEvidence={() => {
            setShowEvidence((v) => {
              if (!v) setActivityOpen(false);
              return !v;
            });
          }}
        />

        <ActivityIndicator
          rows={activity}
          running={running}
          status={status}
          open={activityOpen}
          onToggle={() => setActivityOpen((v) => {
            // Mutually exclusive with Sources: both claim the same row beside
            // the transcript, and two open panels would each take width from it.
            if (!v) setShowEvidence(false);
            return !v;
          })}
        />
        </div>
      </div>
    </div>
  );
}
