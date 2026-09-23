import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import BorderGlow from './BorderGlow.jsx';
import { toast } from './toast.js';
import { ACCEPT, describeAttachment, formatBytes } from './attachments.js';

/*
 * The agent composer.
 *
 * PRESENTATION ONLY. Every handler here arrives as a prop and belongs to
 * AgentChat: `onSubmit` is its existing `send()`, `onStop` its existing
 * `stop()`, `onNewChat` its existing `newChat()`. Nothing in this file builds
 * a request, touches a session, or knows what an agent turn is — it decides
 * how the control LOOKS and what a keystroke means, then hands off.
 *
 * The two pieces of state it does own are its own: whether the "+" menu is
 * open, and whether the browser is currently listening. Neither outlives the
 * composer, and neither is anything the rest of the page can ask about.
 */

/* Stroke icons rather than a dependency. Four glyphs at one weight are not
   worth an icon package, and these inherit currentColor so they follow the
   same tokens every other control in the app already uses. */
const Icon = {
  plus: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  ),
  /* A waveform, not a microphone. Five bars read as speech rather than as
     hardware — and the shape can animate while listening, which a mic capsule
     cannot do legibly at 18px. */
  voice: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path className="wf wf-1" d="M4 10v4" />
      <path className="wf wf-2" d="M8 7v10" />
      <path className="wf wf-3" d="M12 4v16" />
      <path className="wf wf-4" d="M16 7v10" />
      <path className="wf wf-5" d="M20 10v4" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  ),
  /* A slash — the universal "type a command here" mark. */
  command: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 5L9 19" />
    </svg>
  ),
  /* A chip, for the model readout. */
  chip: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </svg>
  ),
};

/* Prefixed on Chrome and Edge, absent on Firefox. Read once — the constructor
   does not appear part-way through a session, so re-checking on every render
   would only ever produce the same answer. */
const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

const MAX_TEXTAREA_PX = 200;

export default function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  onNewChat,
  running,
  stopping,
  /* Provider and model for the CURRENT turn, as the server reported them. */
  model = null,
  onOpenEvidence = null,
  hasEvidence = false,
  sourcesOpen = false,
  /* Files for the next message: [{ key, name, size, status: uploading|ready|error, meta?, error? }] */
  attachments = [],
  onAttachFiles = null,
  onRemoveAttachment = null,
}) {
  const taRef = useRef(null);
  const menuRef = useRef(null);
  const plusRef = useRef(null);
  const recognitionRef = useRef(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [listening, setListening] = useState(false);

  const [dragging, setDragging] = useState(false);

  const hasText = Boolean(value.trim());
  const uploading = attachments.some((a) => a.status === 'uploading');
  const hasReadyFile = attachments.some((a) => a.status === 'ready');
  // A message can be files alone; it cannot leave while a file is still being read.
  const canSend = (hasText || hasReadyFile) && !uploading;

  /*
   * Auto-grow. Height is reset to `auto` before scrollHeight is read, because
   * the scrollHeight of an element already sized to its content reports the
   * height it currently HAS, not the one it wants — without the reset the box
   * can only ever grow, and deleting three lines leaves the hole behind.
   *
   * IT REFUSES TO MEASURE AN ELEMENT THAT HAS NO LAYOUT BOX. The Agent route
   * is mounted for the whole session and only its VISIBILITY is routed, so
   * this component's first render usually happens inside a display:none
   * subtree — where scrollHeight is 0. Writing that answer down left an inline
   * `height: 0px` on the textarea that nothing recomputed when the route was
   * finally opened: the control came up one line short, the placeholder sat
   * clipped, and only a reload (which mounts the composer visible) fixed it.
   * Skipping the write leaves the textarea at its own CSS height, which is the
   * correct height for one row.
   */
  const autosize = useCallback(() => {
    const ta = taRef.current;
    // offsetParent is null for a display:none subtree — and for position:fixed,
    // hence the second half: a real box has a height.
    if (!ta || (!ta.offsetParent && ta.offsetHeight === 0)) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_PX)}px`;
    // Past the ceiling it scrolls internally instead of growing further.
    ta.style.overflowY = ta.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
  }, []);

  useEffect(() => { autosize(); }, [value, autosize]);

  /*
   * ONE observer, on the row rather than on the textarea, so re-sizing the
   * textarea cannot feed itself. It answers three width changes with the same
   * measurement the keystroke path uses:
   *
   *   · the route becoming visible — the box goes from none to laid out, which
   *     is a resize, so a draft restored while hidden is sized on arrival;
   *   · the sidebar collapsing or expanding — the playground gets wider, and
   *     text that needed two lines may now need one;
   *   · the window resizing, for the same reason.
   *
   * Without it the height is only ever right for the width it was typed at.
   */
  useEffect(() => {
    const row = taRef.current?.parentElement;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => autosize());
    ro.observe(row);
    return () => ro.disconnect();
  }, [autosize]);

  // Dismissing the menu: outside click and Escape, the two a popover owes.
  useEffect(() => {
    if (!cmdOpen) return undefined;
    const onDown = (e) => {
      if (e.target.closest?.('.composer-menu, .composer-btn, .composer-chip')) return;
      setCmdOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setCmdOpen(false);
      plusRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [cmdOpen]);

  // A recogniser left running when the page navigates keeps the microphone
  // indicator lit in the browser chrome long after the UI that started it has
  // gone.
  useEffect(() => () => {
    try { recognitionRef.current?.abort(); } catch { /* already finished */ }
  }, []);

  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());

  /*
   * ATTACH — the picker is created on click and never rendered, so there is no
   * "Choose Files / No file chosen" control anywhere on the page. Paste (e.g. a
   * screenshot) and drag-and-drop feed the same handler.
   */
  const pickFiles = () => {
    if (!onAttachFiles) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT;
    input.onchange = () => { if (input.files?.length) onAttachFiles([...input.files]); };
    input.click();
  };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && onAttachFiles) { e.preventDefault(); onAttachFiles(files); }
  };
  const onDragOver = (e) => {
    if (!onAttachFiles || ![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e) => {
    setDragging(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length && onAttachFiles) { e.preventDefault(); onAttachFiles(files); }
  };

  const submit = () => {
    if (!canSend || running) return;
    // No arguments, deliberately: AgentChat's send() reads the live input when
    // it is called bare. Handing it the submit event would make `text` an
    // object and blow up on .trim().
    onSubmit();
  };

  const onKeyDown = (e) => {
    // Unchanged from the textarea this replaces: Enter sends, Shift+Enter makes
    // a line. IME composition is excluded — mid dead-key or CJK candidate
    // window, Enter means "accept that", not "send this".
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  /*
   * Voice, entirely in the browser. No audio leaves the page: the Web Speech
   * API hands back text, and that text goes into the box for the person to read
   * and edit. It is another way of TYPING, not a second way of submitting —
   * which is why nothing in here calls onSubmit.
   */
  const toggleVoice = () => {
    if (listening) {
      try { recognitionRef.current?.stop(); } catch { /* already stopping */ }
      return;
    }
    if (!SpeechRecognition) {
      toast.info(
        'This browser has no built-in speech recognition. Chrome, Edge and Safari do; Firefox '
        + 'does not. Typing works everywhere.',
      );
      return;
    }

    let recog;
    try {
      recog = new SpeechRecognition();
    } catch {
      toast.error('Speech recognition could not start in this browser.');
      return;
    }
    recog.lang = navigator.language || 'en-US';
    recog.interimResults = true;
    recog.continuous = false;

    // What the box held when the microphone opened. Dictation is APPENDED to
    // it, so speaking after typing half a sentence extends that sentence
    // instead of wiping it.
    const base = value;
    let settled = '';

    recog.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) settled += chunk;
        else interim += chunk;
      }
      const spoken = `${settled}${interim}`.trim();
      onChange(base ? `${base.replace(/\s+$/, '')} ${spoken}` : spoken);
    };
    recog.onerror = (event) => {
      setListening(false);
      // Neither is a fault: "aborted" is the person clicking stop, "no-speech"
      // is a quiet room. Saying so in a red toast would be noise.
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      toast.error(
        event.error === 'not-allowed'
          ? 'Microphone permission was refused, so dictation is off. The browser remembers that — '
            + 'clear it in the site settings to be asked again.'
          : `Dictation stopped: ${event.error}.`,
      );
    };
    recog.onend = () => {
      setListening(false);
      focusInput();
    };

    recognitionRef.current = recog;
    try {
      recog.start();
      setListening(true);
    } catch {
      // start() throws if one is already running; the existing session stands.
      setListening(false);
    }
  };

  return (
    <div className="composer-dock">
      {cmdOpen && (
        <div className="composer-menu composer-cmd" role="menu" ref={menuRef} aria-label="Commands">
          {/*
            * COMMANDS — every one of these is an action this frontend already
            * has. Nothing here reaches an endpoint that did not exist before.
            */}
          <button type="button" role="menuitem" className="composer-menu-item" disabled={running}
            onClick={() => { setCmdOpen(false); onNewChat(); focusInput(); }}>
            <b>New chat</b>
            <em>Start a fresh conversation.</em>
          </button>
          <button type="button" role="menuitem" className="composer-menu-item" disabled={running}
            onClick={() => { setCmdOpen(false); onChange('remember: '); focusInput(); }}>
            <b>Remember a preference</b>
            <em>Opens the message with <code>remember:</code>, which stores it.</em>
          </button>
          {hasEvidence && (
            <button type="button" role="menuitem" className="composer-menu-item"
              onClick={() => { setCmdOpen(false); onOpenEvidence(); }}>
              <b>Sources</b>
              <em>What this turn read: chat memory, online docs and files.</em>
            </button>
          )}
          {running && (
            <button type="button" role="menuitem" className="composer-menu-item" disabled={stopping}
              onClick={() => { setCmdOpen(false); onStop(); }}>
              <b>{stopping ? 'Stopping…' : 'Stop this turn'}</b>
              <em>Stops at the next safe point. Nothing already written is rolled back.</em>
            </button>
          )}
        </div>
      )}

      {/*
        * BORDER GLOW — React Bits, wrapping the composer rather than replacing
        * it. The form below is byte-for-byte the control it was; this adds a
        * halo that tracks the cursor's angle and edge-proximity on hover.
        *
        * The component is hover-gated in its own stylesheet
        * (`:not(:hover)` -> opacity 0), so "on hover" needed no new logic here.
        *
        * Its own card chrome — border, background, drop shadow — is switched
        * off in experience.css, because the composer already IS the surface and
        * a second one would be the outer container this must not add. What is
        * kept is the glow itself, in the component's own palette: recolouring
        * it to the app's green was explicitly not wanted.
        *
        * PERIMETER ONLY. BorderGlow draws three layers: ::before is the
        * gradient border ring, .edge-light is the halo around the outside, and
        * ::after is a mesh gradient washed across the card's INTERIOR on
        * soft-light. That third layer is what made the composer look lit from
        * within and tinted the area behind the textarea, so it is turned off —
        * fillOpacity 0 zeroes it through the component's own prop, and the
        * stylesheet also takes it out of the paint entirely. The two layers
        * that trace the perimeter are untouched.
        *
        * glowRadius is 20 to match .chat-wrap's 20px bottom padding exactly —
        * .agent-layout clips its overflow to contain the waves, and a wider
        * halo would be cut off along the bottom edge.
        */}
      <BorderGlow
        className="composer-glow"
        borderRadius={26}
        glowRadius={20}
        backgroundColor="transparent"
        fillOpacity={0}
      >
      <form
        className={`composer${listening ? ' is-listening' : ''}${dragging ? ' is-dragging' : ''}`}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <ul className="composer-files" aria-label="Attached files">
            {attachments.map((a) => (
              <li key={a.key} className={`composer-file is-${a.status}`}
                title={a.status === 'error' ? a.error : (a.meta?.warnings || []).join(' ') || a.name}>
                <span className="composer-file-icon" aria-hidden="true">{Icon.file}</span>
                <span className="composer-file-text">
                  <span className="composer-file-name">{a.name}</span>
                  <span className="composer-file-meta">
                    {a.status === 'uploading' && `Reading… ${formatBytes(a.size)}`}
                    {a.status === 'ready' && describeAttachment(a.meta)}
                    {a.status === 'error' && a.error}
                  </span>
                </span>
                {a.status === 'uploading' && <span className="composer-file-spin" aria-label="Reading the file" />}
                <button type="button" className="composer-file-x" onClick={() => onRemoveAttachment?.(a.key)}
                  aria-label={`Remove ${a.name}`} title="Remove">×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
        {/*
          * ATTACHMENTS — the entry point only.
          *
          * There is no upload pipeline yet, and deliberately no input[type=file]
          * behind this either: a native picker is the one element that can put
          * "Choose Files" and "No file chosen" on screen, and no amount of CSS
          * hiding is as reliable as not rendering it. When the real attachment
          * flow arrives, it hooks onto this handler.
          */}
        <button
          type="button"
          ref={plusRef}
          className="composer-btn"
          onClick={pickFiles}
          disabled={!onAttachFiles}
          aria-label="Attach files"
          title="Attach files — PDF, Word, Excel, CSV, PowerPoint, images (OCR), text. You can also paste or drop them here."
        >
          {Icon.plus}
        </button>

        <textarea
          ref={taRef}
          rows={1}
          className="composer-input"
          placeholder="Ask anything"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <button
          type="button"
          className={`composer-btn voice${listening ? ' on' : ''}`}
          onClick={toggleVoice}
          aria-pressed={listening}
          aria-label={listening ? 'Stop dictation' : 'Dictate'}
          title={
            SpeechRecognition
              ? (listening ? 'Listening — click to stop' : 'Dictate with your voice')
              : 'Speech recognition is not available in this browser'
          }
        >
          {Icon.voice}
        </button>

        {/*
          * One circular control, two states — the same swap the two buttons
          * this replaces already made. While a turn runs it IS the loading
          * indicator (the ring turns) and it is also how you stop, because a
          * spinner sitting beside a dead Send is a live control next to a
          * useless one.
          */}
        {running ? (
          <button
            type="button"
            className="composer-send is-running"
            onClick={onStop}
            disabled={stopping}
            title="Stop at the next safe point. A step already running will finish and be recorded."
            aria-label={stopping ? 'Stopping' : 'Stop'}
          >
            {Icon.stop}
          </button>
        ) : (
          <button
            type="submit"
            className="composer-send"
            disabled={!canSend}
            title={uploading ? 'Still reading an attached file…' : (canSend ? 'Send' : 'Type a message first')}
            aria-label="Send"
          >
            {Icon.send}
          </button>
        )}
        </div>

        {/*
          * THE LOWER BAR. Inside the same form and the same rounded shell, so
          * the composer stays ONE control rather than two boxes that happen to
          * be adjacent — a divider, not a gap.
          *
          * Everything on it is read from state that already exists. Nothing
          * here sends, configures or switches anything on the server.
          */}
        <div className="composer-bar">
          <button
            type="button"
            className="composer-chip"
            onClick={() => setCmdOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={cmdOpen}
            title="Commands"
          >
            {Icon.command}
            <span>Commands</span>
          </button>

          {/* No status here. The activity indicator beside this composer is
              the single place the agent's state is shown; printing it twice
              was two things to keep in sync and one of them redundant. */}

          <span className="composer-bar-spacer" />

          {hasEvidence && (
            <button type="button" className="composer-chip" onClick={onOpenEvidence}
              aria-pressed={sourcesOpen}
              title="What this turn read: chat memory, online documentation and files.">
              Sources
            </button>
          )}

          {/*
            * MODEL — a readout, not a switch. Which provider and model answer
            * a turn is decided on the Settings page and sent by the server with
            * the turn's meta; there is no frontend-only way to change it, and
            * inventing one would mean inventing the endpoint behind it. So this
            * states what is in use and links to the page that does change it.
            */}
          <Link
            className="composer-model"
            to="/settings"
            title={model
              ? `${model.provider} · ${model.model} — change it in Settings`
              : 'No provider is configured yet. Set one in Settings.'}
          >
            {Icon.chip}
            <span className="composer-model-name">{model ? model.model : 'set in Settings'}</span>
          </Link>
        </div>
      </form>
      </BorderGlow>
    </div>
  );
}
