/**
 * What the startup screen says and how far along it claims to be, decided in
 * plain JS.
 *
 * Split out of SAOSLoadingScreen.jsx for the same reason instanceState.js is
 * split out of states.jsx: this is the part carrying a rule, and a rule that
 * cannot be run in the offline suite is a rule nobody is checking. Node cannot
 * import `.jsx`.
 *
 * The rule is an honesty rule. The bar is NOT a timer dressed up as progress:
 * every stage below is a thing the application really waits on at startup,
 * and the screen only reaches 100% when the last of them has actually
 * happened. Between stages the number creeps toward the current stage's
 * ceiling and slows as it gets there, so a slow server reads as "still
 * connecting" rather than as a bar that finished and a screen that did not.
 */

/**
 * The startup stages, in the order they are reported, with the share of the
 * bar each one is worth. Weights sum to 100.
 *
 * - mount      React has committed the shell. Trivially true once anything
 *              renders, which is why it is worth little — but it is the
 *              moment the screen itself appears, so it is the floor.
 * - assets     The webfonts the app is set in have arrived (document.fonts).
 *              Until then the title would paint in a fallback face and re-flow.
 * - health     The first answer from /api/system/health — the gate every
 *              ServiceNow route waits on (D-3). Server down is still an
 *              answer: the app then shows its own banner, and the screen
 *              must not stand in front of it forever.
 * - workspace  The browser has gone idle after the shell painted with that
 *              answer, so the first route's mount work is behind us.
 */
export const STARTUP_STAGES = Object.freeze([
  Object.freeze({ id: 'mount', weight: 12, label: 'Initializing SAOS…' }),
  Object.freeze({ id: 'assets', weight: 18, label: 'Loading assets…' }),
  Object.freeze({ id: 'health', weight: 40, label: 'Connecting to services…' }),
  Object.freeze({ id: 'workspace', weight: 30, label: 'Preparing workspace…' }),
]);

export const READY_LABEL = 'Ready';

/** How quickly the estimate approaches a waiting stage's ceiling. */
const CREEP_TAU_MS = 1600;
/** How much of a waiting stage the estimate may claim before it really ends. */
const CREEP_CAP = 0.9;

/** The first stage not yet done, in reporting order — or null when all are. */
export function currentStage(done) {
  return STARTUP_STAGES.find((s) => !done[s.id]) || null;
}

/**
 * @param {Record<string, boolean>} done   which stage ids have completed
 * @param {number} now                     a monotonic clock, ms
 * @param {Record<string, number>} since   when each stage became current, ms
 * @returns {{percent:number, label:string, stage:string|null, ready:boolean}}
 */
export function describeStartup(done, now, since = {}) {
  let base = 0;
  for (const s of STARTUP_STAGES) if (done[s.id]) base += s.weight;

  const current = currentStage(done);
  if (!current) return { percent: 100, label: READY_LABEL, stage: null, ready: true };

  const started = Number.isFinite(since[current.id]) ? since[current.id] : now;
  const elapsed = Math.max(0, now - started);
  const creep = current.weight * CREEP_CAP * (1 - Math.exp(-elapsed / CREEP_TAU_MS));

  // Never 100 while something is still outstanding — that is the whole point.
  const percent = Math.min(99, Math.floor(base + creep));
  return { percent, label: current.label, stage: current.id, ready: false };
}
