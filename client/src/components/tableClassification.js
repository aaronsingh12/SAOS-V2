/**
 * How a table's classification is shown — decided in plain JS.
 *
 * Split out of the page for the same reason instanceState.js and
 * headerStatus.js are: this carries a rule, and Node cannot import `.jsx`, so a
 * rule left inside the component is a rule nobody is checking.
 *
 * The rule is the honesty one again. The LIST classifies from the
 * `sys_db_object` row alone (name prefix + scope) because the full check costs
 * two extra queries per table and a list is hundreds of tables. That is enough
 * to be certain a table is custom — but NOT enough to say a platform table is
 * pristine, because "has it been customized" is exactly the part that was not
 * asked. So the list badge says `ootb`, never `core-ootb`, and the detail view
 * — which does run the check — is the only place `core-ootb` can appear.
 *
 * Collapsing those two would let a list badge assert a check it never ran.
 */

const BADGES = {
  'custom-in-scope': { label: 'custom · in scope', tone: 'green', title: 'Named with a custom prefix and owned by an application scope. Yours to change.' },
  'custom-global': { label: 'custom · global', tone: 'amber', title: 'Custom-named but living in the global scope, so it is not owned by an application.' },
  'core-ootb': { label: 'core OOTB', tone: '', title: 'A platform table with no customization records found. Never edit it directly — augment it.' },
  'ootb-customized': { label: 'OOTB · customized', tone: 'amber', title: 'A platform table that has already been customized. Changes here compound someone else\'s.' },
  ootb: { label: 'OOTB', tone: '', title: 'Platform-named. Whether it has been customized was NOT checked in this list — open the table for the full classification.' },
};

/**
 * @param {{category?: string, customizationChecked?: boolean}|null} c
 * @returns {{label: string, tone: string, title: string, checked: boolean}}
 */
export function classificationBadge(c) {
  if (!c || !c.category) {
    return { label: 'unclassified', tone: 'amber', checked: false, title: 'No classification was returned for this table.' };
  }
  const b = BADGES[c.category] ?? { label: c.category, tone: 'amber', title: `Unrecognised classification "${c.category}".` };
  return { ...b, checked: c.customizationChecked === true };
}

/**
 * What the index panel should render.
 *
 * `sys_index` is 403 over REST on this instance and is read through a
 * server-side script, so "unavailable" is a routine outcome, not an error — and
 * it must never be drawn as an empty list. Every table has at least a primary
 * key, so a zero would be a false answer rather than a small one.
 */
export function describeIndexes(idx) {
  if (!idx) return { kind: 'loading' };
  if (idx.available === false) {
    return {
      kind: 'unavailable',
      tone: 'amber',
      title: 'Indexes could not be read',
      reason: idx.reason || 'The index read did not complete.',
      note: idx.zeroMeans || idx.note || null,
      isHarness: idx.failure === 'harness-unavailable',
    };
  }
  const count = idx.definitionRecordCount ?? (Array.isArray(idx.indexes) ? idx.indexes.length : null);
  if (count === 0) {
    // Read successfully, and genuinely zero DEFINITION RECORDS — which is still
    // not "no indexes". The wording carries that distinction.
    return {
      kind: 'zero',
      tone: 'amber',
      title: 'No index definition records',
      reason: idx.zeroMeans || 'No sys_index definition record exists for this table.',
      note: idx.completeness || null,
    };
  }
  return { kind: 'list', count, indexes: idx.indexes || [], note: idx.completeness || null, tone: '' };
}

/** Client-side filter, so typing does not round-trip for a list already held. */
export function filterTables(tables, { q = '', scope = '', kind = 'all' } = {}) {
  const needle = q.trim().toLowerCase();
  return (tables || []).filter((t) => {
    if (scope && t.scope !== scope) return false;
    if (kind === 'custom' && !t.classification?.customPrefix) return false;
    if (kind === 'ootb' && t.classification?.customPrefix) return false;
    if (!needle) return true;
    return t.name.toLowerCase().includes(needle) || String(t.label || '').toLowerCase().includes(needle);
  });
}
