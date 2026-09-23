import { useEffect, useState } from 'react';

/*
 * THE APP THEME — Black (the original) or ROBOTIC (the UI2_p look).
 *
 * Black is the default and is expressed by the ABSENCE of a data-theme
 * attribute, so with ROBOTIC off the document is byte-for-byte what it always
 * was: every rule for ROBOTIC lives in theme-robotic.css under
 * :root[data-theme="robotic"] and cannot match otherwise.
 *
 * The choice is a per-browser preference (like desktop notifications), kept
 * in localStorage. Storage can be unavailable (private windows, blocked site
 * data), so every access is guarded and the app falls back to Black.
 */

const STORAGE_KEY = 'nha.theme';
export const THEMES = ['black', 'robotic'];
export const THEME_LABELS = { black: 'Black', robotic: 'ROBOTIC' };

// The browser-chrome colour for each theme (address bar on mobile).
const CHROME = { black: '#0e1116', robotic: '#0c2633' };

export function readTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'robotic' ? 'robotic' : 'black';
  } catch {
    return 'black';
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'robotic') root.dataset.theme = 'robotic';
  else delete root.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME[theme] || CHROME.black);
}

let current = null;
const listeners = new Set();

export function currentTheme() {
  if (current === null) current = readTheme();
  return current;
}

export function setTheme(theme) {
  const next = theme === 'robotic' ? 'robotic' : 'black';
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* preference only; the switch still applies */ }
  applyTheme(next);
  listeners.forEach((fn) => fn(next));
}

export function useTheme() {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    listeners.add(set);
    return () => listeners.delete(set);
  }, []);
  return [theme, setTheme];
}
