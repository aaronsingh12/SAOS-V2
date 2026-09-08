/**
 * PHASE 19 — THE ANSWER, WRITTEN FOR A PERSON.
 *
 * §41 asks the UI to label authority clearly and §82 shows exactly what a good
 * answer looks like: live evidence, instance knowledge and documentation as
 * three separately-headed sections, with a closing line saying which of them is
 * authoritative.
 *
 * THE HEADINGS ARE THE SAFETY FEATURE. §80.4 makes presenting retrieved text as
 * live fact a release blocker, and the failure mode is not a lie — it is a
 * paragraph of documentation under a heading that does not say it is
 * documentation. So every section here is named for its AUTHORITY rather than
 * for its content, and an item cannot reach a section its authority does not
 * belong to: the sections are built by filtering on `provenance.authority`, not
 * by anything a caller passes in.
 *
 * §43 — nothing found is said plainly. An empty knowledge section is never
 * rendered as silence, because silence reads as "there is nothing to know",
 * which is a much stronger claim than "nothing was retrieved".
 */
import { AUTHORITY, AUTHORITY_LABEL, VERDICTS, FRESHNESS, QUESTION } from './schemas.js';

/* The order sections appear in: strongest authority first, always. */
const SECTIONS = Object.freeze([
  { authority: AUTHORITY.LIVE, heading: 'Live evidence', note: 'Read from the instance for this question.' },
  { authority: AUTHORITY.MANAGED_SOURCE, heading: 'Managed source', note: 'From the source this project builds from.' },
  { authority: AUTHORITY.LEDGER, heading: 'Verified instance knowledge', note: 'Measured on an instance and recorded with its evidence.' },
  { authority: AUTHORITY.DOCUMENTATION, heading: 'Documentation', note: 'Describes a release on an instance configured the way it assumes.' },
  { authority: AUTHORITY.HISTORICAL, heading: 'Historical notes', note: 'What happened before. Not a rule.' },
  { authority: AUTHORITY.MODEL, heading: 'Model knowledge', note: 'A prior, with no artifact behind it.' },
]);

export function renderAnswer(result) {
  if (!result) return '## Instance knowledge\n\nNo answer was produced.';
  const L = [];

  L.push('## Instance knowledge');
  L.push('');
  if (result.question) {
    L.push(`> ${result.question}`);
    L.push('');
  }

  if (result.verdict === VERDICTS.CANCELLED) {
    L.push('### Cancelled');
    L.push('');
    L.push(result.stopped?.note ?? 'The question was cancelled.');
    return L.join('\n');
  }

  /* §80.8 — a store that failed is never rendered as a store that found nothing. */
  if (result.verdict === VERDICTS.RETRIEVAL_UNAVAILABLE) {
    L.push('### Knowledge unavailable');
    L.push('');
    L.push('Retrieval could not run, so nothing is known either way about this question. This is NOT the '
      + 'same as finding nothing.');
    for (const u of result.retrieval?.unavailable ?? []) L.push(`- ${u.store}: ${u.reason}`);
    return L.join('\n');
  }

  /* §18/§68 — a live question with no live reading. */
  if (result.verdict === VERDICTS.INSUFFICIENT_EVIDENCE) {
    L.push('### Insufficient evidence');
    L.push('');
    L.push(result.answer ?? 'This question needs a live reading that was not available.');
    L.push('');
  }

  /* ---- §24 — the conflict, before anything it affects ---- */
  for (const c of result.conflicts ?? []) {
    L.push(`### Conflict — ${c.subject}`);
    L.push('');
    L.push('The current instance differs from the retrieved knowledge.');
    L.push('');
    if (c.higher_authority) {
      L.push(`**${AUTHORITY_LABEL[AUTHORITY.LIVE] ?? c.authority_winner}:** ${c.higher_authority.says}`);
    }
    for (const lower of c.lower_authority ?? []) {
      L.push(`**Overruled (${lower.source}):** ${lower.says}`);
    }
    L.push('');
    L.push(c.explanation ?? 'The higher authority wins.');
    if (c.ask) {
      L.push('');
      L.push(`**This needs a person:** ${c.ask}`);
    }
    L.push('');
  }

  /* ---- the evidence, by authority ---- */
  const byAuthority = (list, authority) => list.filter((x) => x?.provenance?.authority === authority);
  const all = [...(result.live_facts ?? []), ...(result.knowledge ?? [])];
  let shown = 0;

  for (const section of SECTIONS) {
    const items = byAuthority(all, section.authority);
    if (!items.length) continue;
    shown += items.length;
    L.push(`### ${section.heading}`);
    L.push('');
    L.push(`*${section.note}*`);
    L.push('');
    for (const item of items) L.push(...renderItem(item));
  }

  if (!shown) {
    /* §43, verbatim in spirit: say it, do not imply it by absence. */
    L.push('### Nothing found');
    L.push('');
    L.push('No relevant instance-specific knowledge was found.');
    L.push('');
  }

  /* ---- what is not known ---- */
  if (result.unknowns?.length) {
    L.push('### Not established');
    L.push('');
    for (const u of result.unknowns) L.push(`- ${u.statement}`);
    L.push('');
  }

  /* ---- §42 — where the answer came from ---- */
  L.push(...renderProvenanceSummary(result));

  /* ---- the closing line §82 asks for ---- */
  L.push('');
  if (result.live_facts?.length) {
    L.push('The live instance is the authoritative source for the current behaviour.');
  } else if (result.classification?.classification === QUESTION.LIVE_TRUTH_REQUIRED) {
    L.push('Nothing above establishes the current behaviour. Read the instance before acting on any of it.');
  } else {
    L.push('None of the above was confirmed against the instance as it is right now.');
  }

  return L.join('\n');
}

function renderItem(item) {
  const out = [];
  const fresh = item.freshness?.state;
  const badge = fresh === FRESHNESS.STALE
    ? ' — **stale**'
    : (fresh === FRESHNESS.FRESH && item.freshness?.verified_at
      ? ` — verified ${String(item.freshness.verified_at).slice(0, 10)}`
      : '');

  out.push(`**${item.title ?? item.id}**${badge}`);
  out.push('');
  out.push(item.content);
  const bits = [`source: ${item.provenance?.source ?? 'unknown'}`];
  if (item.provenance?.ref) bits.push(`ref: ${item.provenance.ref}`);
  if (item.scope?.instance) bits.push(`scope: ${item.scope.instance}`);
  else if (item.scope?.level) bits.push(`scope: ${String(item.scope.level).toLowerCase()}`);
  if (item.duplicates) bits.push(`${item.duplicates + 1} sources agreed`);
  if (item.clipped) bits.push(`clipped from ${item.full_length} chars`);
  out.push(`· ${bits.join(' | ')}`);
  if (item.freshness?.stale_because) out.push(`· stale: ${item.freshness.stale_because}`);
  out.push('');
  return out;
}

/**
 * §42 — a collapsible account of what was used.
 *
 * Counted by authority rather than listed, because the list is already above.
 * What this adds is the two numbers a reader cannot get from the list: what was
 * excluded, and whether the search was degraded.
 */
export function renderProvenanceSummary(result) {
  const L = [];
  const counts = new Map();
  for (const item of [...(result.live_facts ?? []), ...(result.knowledge ?? [])]) {
    const a = item?.provenance?.authority ?? 'unknown';
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  if (!counts.size && !result.retrieval) return L;

  L.push('<details><summary>Sources used</summary>');
  L.push('');
  for (const s of SECTIONS) {
    const n = counts.get(s.authority);
    if (n) L.push(`- ${n} × ${s.heading.toLowerCase()}`);
  }
  const r = result.retrieval;
  if (r) {
    if (r.considered) L.push(`- ${r.considered} item(s) considered, ${r.admitted} admitted after instance isolation`);
    if (r.isolated_out?.length) {
      L.push(`- ${r.isolated_out.length} excluded as belonging to another instance:`);
      for (const d of r.isolated_out.slice(0, 5)) L.push(`  - ${d.title ?? d.id}: ${d.reason}`);
    }
    if (r.degraded) L.push('- retrieval was DEGRADED: keyword matching only, no embeddings');
    for (const u of r.unavailable ?? []) L.push(`- the ${u.store} store was unavailable: ${u.reason}`);
  }
  L.push('');
  L.push('</details>');
  return L;
}

/**
 * The compact panel another domain embeds (§38, §39, §40, §41).
 *
 * Deliberately smaller than the full answer and deliberately still labelled: a
 * lint finding that quotes instance knowledge without saying it is knowledge
 * has done the exact thing §38 forbids.
 */
export function knowledgePanel(result) {
  const items = result?.knowledge ?? [];
  if (!items.length) {
    return {
      heading: 'Relevant knowledge',
      empty: true,
      text: 'No relevant instance-specific knowledge was found.',
      entries: [],
    };
  }
  return {
    heading: 'Relevant knowledge',
    empty: false,
    text: null,
    entries: items.map((item) => ({
      label: AUTHORITY_LABEL[item.provenance?.authority] ?? 'unknown source',
      authority: item.provenance?.authority ?? null,
      kind: item.kind,
      title: item.title,
      content: item.content,
      source: item.provenance?.source ?? null,
      ref: item.provenance?.ref ?? null,
      scope: item.scope?.instance ?? item.scope?.level ?? null,
      freshness: item.freshness?.state ?? null,
      verified_at: item.freshness?.verified_at ?? null,
      /* Never true for a retrieved item, and stated per entry so a renderer
       * cannot lose it (§35). */
      authorises: false,
    })),
    note: 'Context only. It does not establish what the instance does now.',
  };
}

export const _internals = { SECTIONS, renderItem };
