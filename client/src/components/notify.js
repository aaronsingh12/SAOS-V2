/**
 * DESKTOP NOTIFICATIONS — "tell me when it is done, I am in another window".
 *
 * Long work in this app — a health check, an agent turn, a flow build, a
 * remediation — takes minutes, and the person who started it goes and does
 * something else. A toast is no use to someone who is not looking at the tab.
 *
 * The browser's own Notification API, nothing more: no service worker, no push
 * server, nothing leaves the machine. `localhost` is a secure context, so it is
 * available to this app as it runs.
 *
 * ═══ THREE RULES ═══
 *
 *   1. OFF until the person turns it on in Preferences. Asking for permission
 *      the moment the app opens is how a browser learns to block a site.
 *   2. Only when they are AWAY — the tab hidden or the window not focused. If
 *      they are looking at the app, the in-app toast already told them, and a
 *      second, system-level interruption for the same fact is noise.
 *   3. Never load-bearing. A notification that fails to show changes nothing
 *      about the work; every call is wrapped and simply returns false.
 *
 * The preference is per browser, in localStorage, because permission is per
 * browser too — a server-side switch could say "on" to a browser that had
 * never granted it.
 */

const KEY = 'nha.desktopNotifications';
const listeners = new Set();

export function notificationSupport() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;   // 'default' | 'granted' | 'denied'
}

export function desktopNotificationsEnabled() {
  try { return window.localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

function store(on) {
  try { window.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode: stays off */ }
  for (const fn of listeners) { try { fn(on); } catch { /* a listener's problem */ } }
}

export function subscribeNotificationPref(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Turn notifications on or off. Turning on asks the browser for permission
 * when it has not been asked yet; a refusal leaves the switch OFF and says why,
 * rather than showing "on" for something that can never fire.
 */
export async function setDesktopNotifications(on) {
  if (!on) { store(false); return { ok: true, enabled: false }; }
  const support = notificationSupport();
  if (support === 'unsupported') {
    store(false);
    return { ok: false, enabled: false, reason: 'This browser does not support desktop notifications.' };
  }
  let permission = support;
  if (permission === 'default') {
    try { permission = await window.Notification.requestPermission(); } catch { permission = 'default'; }
  }
  if (permission !== 'granted') {
    store(false);
    return {
      ok: false,
      enabled: false,
      reason: permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser\'s site settings (the icon left of the address bar), then turn this on again.'
        : 'The browser did not grant permission, so notifications stay off.',
    };
  }
  store(true);
  return { ok: true, enabled: true };
}

/** Is the person looking at the app right now? */
export function userIsAway() {
  if (typeof document === 'undefined') return false;
  return document.visibilityState !== 'visible' || !document.hasFocus();
}

/**
 * Show a notification if the person turned them on and is away.
 *
 * `path` is where a click takes them, inside the app, without a reload. `tag`
 * collapses repeats of the same event into one notification. `force` skips the
 * away check — used only by the "send a test" button.
 */
export function notifyDesktop({ title, body = '', tag, path, force = false } = {}) {
  try {
    if (!title || !desktopNotificationsEnabled() || notificationSupport() !== 'granted') return false;
    if (!force && !userIsAway()) return false;
    const n = new window.Notification(title, { body, tag, icon: '/favicon.svg' });
    n.onclick = () => {
      try { window.focus(); } catch { /* not allowed everywhere */ }
      if (path) window.dispatchEvent(new CustomEvent('nha:navigate', { detail: path }));
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
