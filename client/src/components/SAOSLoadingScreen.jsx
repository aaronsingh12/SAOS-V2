import { useCallback, useEffect, useRef, useState } from 'react';
import { useHealth } from '../hooks/useHealth.js';
import { logToServer } from '../logging.js';
import { currentStage, describeStartup } from './startupProgress.js';
import './SAOSLoadingScreen.css';

/*
 * THE STARTUP SCREEN. Mounted once, in App, and never again.
 *
 * It is an OVERLAY, not a gate. The shell renders underneath it from the first
 * frame, so every load effect the app already runs at startup — the shared
 * health poller, the agent workspace's session list, the first route's data —
 * fires exactly as it did before this existed. The screen only watches those
 * things happen and reports them; it never delays them, and it never pretends
 * they happened when they did not. The stages, their weights and the estimate
 * between them live in startupProgress.js, where the offline suite can hold
 * them to that.
 *
 * Once the last stage lands the screen holds full for a beat, fades, and
 * unmounts itself for good. Navigation cannot bring it back: App never
 * remounts, and this component's own `gone` state is terminal.
 *
 * MOTION — everything decorative is CSS keyframes, so the global
 * `prefers-reduced-motion` rule in styles.css reaches all of it: particles
 * stop drifting, rings stop turning, the shimmer is removed and the bar just
 * sits at its current value. The fade-out is timed rather than waited for on
 * `transitionend`, because under that rule there is no transition to end.
 */

/** Signals the fonts CDN cannot hold the screen hostage past this. */
const ASSET_CAP_MS = 3000;
/** How long the bar sits at 100% before the screen starts to fade. */
const HOLD_MS = 420;
/** Must match the `.saos-splash.is-leaving` transition in the sheet. */
const FADE_MS = 520;
const TICK_MS = 100;

/*
 * The particles are a fixed table, never drawn at random: under StrictMode's
 * double render in dev a random field would visibly reshuffle on first paint,
 * and a background that twitches reads as something going wrong.
 */
const PARTICLES = [
  { x: 18, y: 22, s: 3, d: 0, t: 11 },
  { x: 31, y: 64, s: 2, d: 2.4, t: 13 },
  { x: 42, y: 15, s: 2, d: 5.1, t: 12 },
  { x: 58, y: 26, s: 4, d: 1.3, t: 10 },
  { x: 66, y: 71, s: 2, d: 3.9, t: 14 },
  { x: 74, y: 40, s: 3, d: 6.2, t: 12 },
  { x: 83, y: 18, s: 2, d: 0.8, t: 15 },
  { x: 88, y: 58, s: 2, d: 4.6, t: 11 },
  { x: 12, y: 48, s: 2, d: 7.3, t: 13 },
  { x: 25, y: 82, s: 3, d: 2.9, t: 12 },
  { x: 50, y: 88, s: 2, d: 5.7, t: 14 },
  { x: 92, y: 80, s: 2, d: 1.9, t: 12 },
];

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The SAOS mark: the favicon's own "S" path, unchanged, inside the framed
 * double-square emblem. Same glyph as the tab and the sidebar, so the screen
 * and the app are recognisably one thing.
 */
function Emblem() {
  return (
    <svg className="saos-splash-logo" viewBox="0 0 64 64" width="96" height="96" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="8" fill="none" stroke="currentColor" strokeWidth="3.5" />
      <rect x="11" y="11" width="42" height="42" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <path
        d="M43 21.5 C40.5 16.5 22 15 21 24.5 C20 34 44 30 44 40.5 C44 50 24 50 20.5 43"
        fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="1.4" fill="currentColor" opacity="0.8" />
      <circle cx="48" cy="16" r="1.4" fill="currentColor" opacity="0.8" />
      <circle cx="16" cy="48" r="1.4" fill="currentColor" opacity="0.8" />
      <circle cx="48" cy="48" r="1.4" fill="currentColor" opacity="0.8" />
    </svg>
  );
}

function Rings() {
  return (
    <>
      <svg className="saos-splash-rings" viewBox="0 0 300 300" aria-hidden="true">
        <g className="saos-splash-ring saos-splash-ring-a">
          <circle cx="150" cy="150" r="104" fill="none" stroke="currentColor" strokeWidth="1"
            strokeDasharray="420 240" strokeLinecap="round" />
        </g>
        <g className="saos-splash-ring saos-splash-ring-b">
          <circle cx="150" cy="150" r="126" fill="none" stroke="currentColor" strokeWidth="0.8"
            strokeDasharray="300 500" strokeLinecap="round" />
        </g>
        <circle cx="150" cy="150" r="142" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.35" />
      </svg>
      <span className="saos-splash-orbit saos-splash-orbit-a" aria-hidden="true"><i /></span>
      <span className="saos-splash-orbit saos-splash-orbit-b" aria-hidden="true"><i /></span>
    </>
  );
}

function Wave() {
  return (
    <svg className="saos-splash-wave" viewBox="0 0 1600 360" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <pattern id="saos-splash-dots" width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="1.1" fill="currentColor" />
        </pattern>
        <linearGradient id="saos-splash-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id="saos-splash-wave-mask">
          <rect x="-200" y="0" width="2000" height="360" fill="url(#saos-splash-fade)" />
        </mask>
      </defs>
      <g mask="url(#saos-splash-wave-mask)">
        <path className="saos-splash-wave-back"
          d="M-200 230 C 100 150, 350 290, 620 220 S 1050 110, 1300 210 S 1650 250, 1800 190 L1800 360 L-200 360 Z"
          fill="url(#saos-splash-dots)" />
        <path className="saos-splash-wave-front"
          d="M-200 280 C 150 210, 420 330, 700 270 S 1150 170, 1400 270 S 1700 300, 1800 250 L1800 360 L-200 360 Z"
          fill="url(#saos-splash-dots)" />
      </g>
    </svg>
  );
}

export default function SAOSLoadingScreen() {
  const health = useHealth();
  /** loading → complete → leaving → gone. Terminal. */
  const [phase, setPhase] = useState('loading');
  const [done, setDone] = useState({});
  const [, setTick] = useState(0);
  const sinceRef = useRef({});
  const shownRef = useRef(0);
  const startedAt = useRef(clock());

  // Idempotent on purpose: StrictMode runs every effect twice in dev.
  const complete = useCallback((id) => {
    setDone((d) => (d[id] ? d : { ...d, [id]: true }));
  }, []);

  /* mount — this effect running IS the signal: React has committed the tree. */
  useEffect(() => { complete('mount'); }, [complete]);

  /* assets — the webfonts. `ready` also resolves on failure, and the cap
     covers a CDN that neither answers nor fails: fonts are not worth a screen
     that never leaves. */
  useEffect(() => {
    let live = true;
    const finish = () => { if (live) complete('assets'); };
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    if (!fonts?.ready) { finish(); return undefined; }
    const cap = setTimeout(finish, ASSET_CAP_MS);
    fonts.ready.then(finish, finish);
    return () => { live = false; clearTimeout(cap); };
  }, [complete]);

  /* health — the shared poller's first answer, whatever it was. Subscribing
     here shares the request the agent workspace and the routes already make;
     it does not add one. */
  useEffect(() => { if (!health.loading) complete('health'); }, [health.loading, complete]);

  /* workspace — the shell beneath has painted with the health answer. Two
     frames: the first is requested before React's commit of that answer has
     necessarily painted, the second cannot run until it has. Not an idle
     callback — under the WebGL background the main thread is never idle in
     the sense that API means, and the screen would sit on its timeout. */
  useEffect(() => {
    if (!done.health || !done.assets) return undefined;
    let live = true;
    let handle = requestAnimationFrame(() => {
      handle = requestAnimationFrame(() => { if (live) complete('workspace'); });
    });
    return () => { live = false; cancelAnimationFrame(handle); };
  }, [done.health, done.assets, complete]);

  /* The estimate between stages needs a clock. Stop ticking once the last
     stage lands — there is nothing left to estimate. */
  useEffect(() => {
    if (phase !== 'loading') return undefined;
    const id = setInterval(() => {
      const stage = currentStage(done);
      if (stage && !sinceRef.current[stage.id]) sinceRef.current[stage.id] = clock();
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [phase, done]);

  const view = describeStartup(done, clock(), sinceRef.current);
  // Monotonic. A stage landing out of order can only raise the base, but a
  // number that ever went backwards would be read as something failing.
  const percent = phase === 'loading' ? Math.max(shownRef.current, view.percent) : 100;
  shownRef.current = percent;
  const label = phase === 'loading' ? view.label : 'Ready';

  /* Completion: hold at full, fade, unmount. Timed, not transitionend — see
     the note on motion above. */
  useEffect(() => {
    if (phase === 'loading' && view.ready) {
      setPhase('complete');
      logToServer('info', `startup ready in ${Math.round(clock() - startedAt.current)}ms`);
    }
  }, [phase, view.ready]);
  useEffect(() => {
    if (phase === 'complete') {
      const t = setTimeout(() => setPhase('leaving'), HOLD_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'leaving') {
      const t = setTimeout(() => setPhase('gone'), FADE_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [phase]);

  if (phase === 'gone') return null;

  // `view.ready` rather than the phase, so the completion glow lands in the
  // same frame as the 100, not one effect later.
  const cls = ['saos-splash', view.ready || phase !== 'loading' ? 'is-complete' : '', phase === 'leaving' ? 'is-leaving' : '']
    .filter(Boolean).join(' ');

  return (
    <div className={cls} aria-label="SAOS is starting" aria-busy={phase === 'loading'}>
      <div className="saos-splash-particles" aria-hidden="true">
        {PARTICLES.map((p, i) => (
          <i
            key={i}
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.s,
              height: p.s,
              animationDelay: `-${p.d}s`,
              animationDuration: `${p.t}s`,
            }}
          />
        ))}
      </div>

      <div className="saos-splash-stage">
        <div className="saos-splash-emblem">
          <Rings />
          <Emblem />
        </div>
        <h1 className="saos-splash-title">SAOS</h1>
        <p className="saos-splash-tagline">Simpler service, stronger outcomes</p>

        <div className="saos-splash-progress">
          <div
            className="saos-splash-track"
            role="progressbar"
            aria-label="Startup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="saos-splash-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="saos-splash-pct">{percent}%</span>
        </div>
        {/* Keyed on the label so a stage change fades the new line in; the
            line itself only changes when a stage lands, never on a tick. */}
        <p className="saos-splash-status" aria-live="polite"><span key={label}>{label}</span></p>
      </div>

      <Wave />
    </div>
  );
}
