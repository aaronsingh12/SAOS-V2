/*
 * HEALTH FINDING DIMENSIONS — the page's pure helpers.
 *
 * Plain .js on purpose, like the other helpers in this folder: the server's
 * offline suite imports them and asserts their decisions directly.
 *
 * Nothing here decides what a dimension CONTAINS — that is the server's
 * (/api/health/dimensions), resolved from rule mappings. These only shape what
 * the server returned: ordering, search, the matrix, percentages, chips, the
 * URL, and which icon and tint a dimension wears.
 *
 * Not to be confused with the CMDB Quality score's D1–D10 "dimensions": those
 * are a scoring concept; these are a classification of findings.
 */

export const UNCLASSIFIED_ID = 'unclassified';

/** The three grouping views of the findings page. Severity is the original. */
export const GROUP_MODES = Object.freeze([
  { key: 'severity', label: 'Severity' },
  { key: 'dimension', label: 'Dimension' },
  { key: 'both', label: 'Both' },
]);

export function groupModeOf(value) {
  return GROUP_MODES.some((m) => m.key === value) ? value : 'severity';
}

/*
 * The data model's types, in the page's words. `built_in` is the product
 * taxonomy ("System"); `system` is the one fallback, Unclassified, which holds
 * whatever no dimension claims ("Fallback").
 */
export const TYPE_LABEL = Object.freeze({ built_in: 'System', custom: 'Custom', system: 'Fallback' });

/* ── Visual identity per built-in dimension: an icon and a tint ─────────────
 * Tints name reserved series hues in styles.css (--hx-t-*), never severity
 * tones, so a dimension card can never be read as a severity. */
export const DIMENSION_VISUAL = Object.freeze({
  'ownership-accountability': { icon: 'users', tint: 'green' },
  'stale-not-refreshed': { icon: 'clock', tint: 'blue' },
  'missing-incomplete-data': { icon: 'file', tint: 'violet' },
  'service-model-csdm': { icon: 'layers', tint: 'pink' },
  'security-access': { icon: 'shield', tint: 'orange' },
  'relationships-impact': { icon: 'link', tint: 'cyan' },
  'discovery-itom-machinery': { icon: 'radar', tint: 'teal' },
  'lifecycle-retirement': { icon: 'cycle', tint: 'yellow' },
  'work-stuck-sla-backlog': { icon: 'hourglass', tint: 'indigo' },
  'duplicates-identity': { icon: 'copy', tint: 'rose' },
  'change-control-compliance': { icon: 'filecheck', tint: 'sky' },
  'wrong-invalid-data': { icon: 'alert', tint: 'red' },
  'work-not-linked-to-ci': { icon: 'share', tint: 'magenta' },
  'governance-attestation': { icon: 'award', tint: 'emerald' },
  'customization-platform-risk': { icon: 'wrench', tint: 'azure' },
  [UNCLASSIFIED_ID]: { icon: 'folder', tint: 'neutral' },
});

export function visualOf(dimension) {
  if (!dimension) return { icon: 'tag', tint: 'neutral' };
  return DIMENSION_VISUAL[dimension.id] || (dimension.type === 'custom' ? { icon: 'tag', tint: 'violet' } : { icon: 'tag', tint: 'neutral' });
}

/* ── Ordering and search ─────────────────────────────────────────────────── */

export const SORTS = Object.freeze([
  { key: 'findings-desc', label: 'Findings (high to low)' },
  { key: 'findings-asc', label: 'Findings (low to high)' },
  { key: 'name', label: 'Name (A–Z)' },
]);

/** Case-insensitive search over name and description. */
export function searchDimensions(dimensions = [], query = '') {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return dimensions;
  return dimensions.filter((d) => {
    const text = `${d.name} ${d.description || ''}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
}

/**
 * Themed dimensions in the chosen order, and Unclassified apart — it is a
 * fallback, not a theme, so it never tops a list by accident and the page can
 * give it its own place.
 */
export function orderDimensions(dimensions = [], sort = 'findings-desc') {
  const themed = dimensions.filter((d) => d.id !== UNCLASSIFIED_ID);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const cmp = sort === 'name' ? byName
    : sort === 'findings-asc' ? (a, b) => (a.findings || 0) - (b.findings || 0) || byName(a, b)
      : (a, b) => (b.findings || 0) - (a.findings || 0) || byName(a, b);
  return { themed: [...themed].sort(cmp), unclassified: dimensions.find((d) => d.id === UNCLASSIFIED_ID) || null };
}

/**
 * Dimensions with findings in view, largest first, Unclassified last.
 * `hidden` is how many dimensions have nothing in view — named, not dropped.
 */
export function dimensionRows(dimensions = []) {
  const withFindings = dimensions.filter((c) => (c.findings || 0) > 0);
  const { themed, unclassified } = orderDimensions(withFindings);
  return { rows: unclassified ? [...themed, unclassified] : themed, hidden: dimensions.length - withFindings.length };
}

/** A share of the distinct findings in view, as a percentage — 0 when there are none. */
export function shareOf(n, total) {
  return total > 0 ? (n / total) * 100 : 0;
}

export function fmtPct(p) {
  if (!p) return '0%';
  if (p < 0.1) return '<0.1%';
  return `${p.toFixed(1)}%`;
}

/* ── The dimension × severity matrix ─────────────────────────────────────── */

/**
 * Every cell is a real count from the server's per-severity breakdown — a zero
 * is a zero, never a blank that reads as "not measured". `sortKey` is `total`
 * or a severity key; ties fall back to name so the order is stable.
 */
export function dimensionMatrix(dimensions = [], severityKeys = [], { sortKey = 'total', dir = 'desc' } = {}) {
  const { rows } = dimensionRows(dimensions);
  const matrix = rows.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    total: c.findings || 0,
    cells: severityKeys.map((k) => ({ severity: k, n: c.severity?.[k] || 0 })),
  }));
  const valueOf = (r) => (sortKey === 'total' ? r.total : (r.cells.find((c) => c.severity === sortKey)?.n || 0));
  const sign = dir === 'asc' ? 1 : -1;
  const themed = matrix.filter((r) => r.id !== UNCLASSIFIED_ID)
    .sort((a, b) => sign * (valueOf(a) - valueOf(b)) || a.name.localeCompare(b.name));
  const unc = matrix.find((r) => r.id === UNCLASSIFIED_ID);
  const sorted = unc ? [...themed, unc] : themed;
  const max = Math.max(0, ...sorted.flatMap((r) => r.cells.map((c) => c.n)));
  return { rows: sorted, max };
}

/**
 * The matrix as CSV. Every cell is escaped against spreadsheet formula
 * injection (a cell starting = + - @ is prefixed), the same rule the server's
 * finding export follows — a dimension name is user-authored text.
 */
export function matrixCsv(rows = [], severities = []) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Dimension', ...severities.map((s) => s.label), 'Total'];
  const lines = [head.map(cell).join(',')];
  for (const r of rows) lines.push([r.name, ...r.cells.map((c) => c.n), r.total].map(cell).join(','));
  return lines.join('\n');
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/**
 * A finding's dimensions as chips: the first `max`, and a count of the rest.
 * Unknown ids (a dimension deleted since the page loaded) are skipped rather
 * than rendered as raw ids.
 */
export function chipsFor(ids = [], byId = {}, max = 1) {
  const known = (ids || []).map((id) => byId[id]).filter(Boolean);
  return { shown: known.slice(0, max), more: Math.max(0, known.length - max), all: known };
}

/* ── URL ─────────────────────────────────────────────────────────────────── */

/**
 * The filter part of the page's URL. Severity and dimension live there so a
 * filtered view survives a refresh and can be shared; domain and rule stay
 * page state as before (an area belongs to one scope and is cleared on a scope
 * switch). `category` is the pre-rename name of `dimension`: read once on load,
 * and dropped whenever the URL is rewritten.
 */
export function withFilterParams(params, filter, group) {
  const qs = new URLSearchParams(params);
  qs.delete('category');
  for (const key of ['severity', 'dimension']) {
    if (filter?.[key]) qs.set(key, filter[key]); else qs.delete(key);
  }
  if (group && group !== 'severity') qs.set('group', group); else qs.delete('group');
  return qs;
}

export function dimensionFromParams(params) {
  return params.get('dimension') || params.get('category') || '';
}
