import { useEffect, useState } from 'react';

/*
 * THE APP THEME — Original (the dark control room), ServiceNow (a light theme
 * in the Now palette) or ROBOTIC (the UI2_p look).
 *
 * Original is the default and is expressed by the ABSENCE of a data-theme
 * attribute, so with it selected the document is byte-for-byte what it always
 * was: every rule for another theme lives in its own sheet under
 * :root[data-theme="<name>"] and cannot match otherwise. Its stored value is
 * still 'black', so a choice saved before there were three themes still reads.
 *
 * The choice is a per-browser preference (like desktop notifications), kept
 * in localStorage. Storage can be unavailable (private windows, blocked site
 * data), so every access is guarded and the app falls back to Original.
 */

const STORAGE_KEY = 'nha.theme';
export const THEMES = ['black', 'servicenow', 'robotic'];

/*
 * What the picker shows for each theme. `swatch` is [side column, ground,
 * accent] — the three colours that make each theme recognisable at a glance.
 */
export const THEME_INFO = {
  black: {
    label: 'Original',
    blurb: 'The dark control room: blue-black panels, verdigris accent, moving waves.',
    swatch: ['#151a21', '#0e1116', '#57b57c'],
  },
  servicenow: {
    label: 'ServiceNow',
    blurb: 'Light and airy, in the Now palette: navy column, signal green, soft motion.',
    swatch: ['#032d42', '#f2f5f7', '#62d84e'],
  },
  robotic: {
    label: 'ROBOTIC',
    blurb: 'The UI2_p look: ink borders, hard offset shadows, square corners.',
    swatch: ['#0c2633', '#f4f8f9', '#5edc56'],
  },
};
export const THEME_LABELS = Object.fromEntries(THEMES.map((t) => [t, THEME_INFO[t].label]));

// The browser-chrome colour for each theme (address bar on mobile).
const CHROME = { black: '#0e1116', servicenow: '#032d42', robotic: '#0c2633' };

/*
 * A theme's webfont is fetched the first time that theme is used, not on every
 * page load: Original and ROBOTIC never pay for a face they do not draw.
 */
const FONTS = {
  servicenow: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap',
};

const normalise = (theme) => (THEMES.includes(theme) ? theme : 'black');

export function readTheme() {
  try {
    return normalise(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'black';
  }
}

/** Fetch a theme's webfont ahead of time (the picker calls this on open). */
export function preloadTheme(theme) {
  const href = FONTS[theme];
  if (!href || document.querySelector(`link[data-theme-font="${theme}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.themeFont = theme;
  document.head.appendChild(link);
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'black') delete root.dataset.theme;
  else root.dataset.theme = theme;
  preloadTheme(theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME[theme] || CHROME.black);
}

let current = null;
const listeners = new Set();

export function currentTheme() {
  if (current === null) current = readTheme();
  return current;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/*
 * Switching animates as a circle of the new theme opening out from the point
 * that chose it (`origin`, viewport px), using the View Transitions API: the
 * browser snapshots the old page, the attribute flips, and the new page is
 * revealed through a growing clip. Where the API is missing, or the user has
 * asked for reduced motion, the switch is simply instant — same end state.
 */
export function setTheme(theme, origin) {
  const next = normalise(theme);
  const changed = next !== currentTheme();
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* preference only; the switch still applies */ }
  const commit = () => {
    applyTheme(next);
    listeners.forEach((fn) => fn(next));
  };
  if (!changed || !document.startViewTransition || reducedMotion()) {
    commit();
    return;
  }
  const root = document.documentElement;
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.classList.add('theme-reveal');
  const vt = document.startViewTransition(commit);
  vt.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }, () => { /* the transition was skipped; commit() has still run */ });
  const done = () => root.classList.remove('theme-reveal');
  vt.finished.then(done, done);
}

export function useTheme() {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    listeners.add(set);
    return () => listeners.delete(set);
  }, []);
  return [theme, setTheme];
}
