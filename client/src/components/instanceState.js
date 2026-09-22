/**
 * D-3 — what a page should show instead of its data, decided in plain JS.
 *
 * Split out of states.jsx for the same reason markdownConfig.js is split out
 * of Markdown.jsx: this is the part carrying a rule, and a rule that cannot be
 * rendered in the offline suite is a rule nobody is checking. Node cannot
 * import `.jsx`, and adding a transform to the repo to test a component tree
 * would buy less than moving the decision somewhere it can be asserted.
 *
 * The rule itself is an honesty rule, not a cosmetic one. Incidents, SLA and
 * Flows each used to render one sentence — "No X match. Connect your PDI on
 * the Dashboard first." — for two opposite facts. That is the same failure the
 * ACL analyzer needed a `visibility` field to avoid: an empty result and an
 * unreadable one look identical unless something states which it is.
 */

/**
 * @param {object} h  the shape `useHealth()` returns
 * @param {string} [what]  the page's own name, used in the copy
 * @returns {{kind: 'children'|'waiting'|'unbound'|'server', title?: string,
 *            hint?: string, to?: string, actionLabel?: string, icon?: string}}
 */
export function describeInstanceState(h, what = 'This page') {
  // Unknown is its own answer, and it took a measurement to get this right.
  //
  // The first version rendered the children while health was still loading, on
  // the reasoning that a flash of "disconnected" is worse than a flash of the
  // page. That was true and beside the point: mounting the children mounts
  // their load effects, so the disconnected sweep produced 18 console errors —
  // every page firing a request that 400'd before the gate replaced it.
  //
  // So unknown now renders a loading state, and the reason that is affordable
  // is the other half of the same fix: /api/system/health stopped waiting on
  // the SDK capability probe, so it answers in about 2ms instead of 5.5s.
  if (h.loading) return { kind: 'waiting' };

  if (h.serverDown) {
    return {
      kind: 'server',
      icon: '!',
      title: 'The SAOS server is not responding.',
      hint: `${h.error} — start it with \`npm run dev\` in server/, then reload. This is the local API on :4000, not your instance.`,
    };
  }
  if (!h.connected) {
    return {
      kind: 'unbound',
      icon: '○',
      title: 'No ServiceNow instance is bound.',
      hint: `${what} reads and writes against your PDI, so there is nothing to show until one is connected.`,
      to: '/',
      actionLabel: 'Connect an instance',
    };
  }
  return { kind: 'children' };
}

/**
 * Skeleton widths, derived from position rather than drawn at random.
 *
 * A skeleton that reshuffles between renders reads as content still arriving,
 * and under React's StrictMode double-render in dev it would visibly twitch on
 * the first paint. Same cell, same width, every time.
 */
const WIDTHS = [68, 44, 82, 55, 36];
export const skeletonWidth = (row, col) => WIDTHS[(row + col) % WIDTHS.length];

const LINE_WIDTHS = [86, 62, 74, 48, 92];
export const skeletonLineWidth = (i) => LINE_WIDTHS[i % LINE_WIDTHS.length];
