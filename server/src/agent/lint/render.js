/**
 * PHASE 16 — THE LINT REPORT A PERSON READS.
 *
 * §38, §40, §41 and §67. Assembled from the structure, like the Doctor's
 * narrative and for the same reason: a second model call to "write this up
 * nicely" would be one more chance to assert something the evidence does not
 * support, in the one place the user actually reads.
 *
 * THE GROUPING IS BY CERTAINTY, NOT SEVERITY, and that is the whole design of
 * this page. A reader needs to know what is definitely wrong before what might
 * be catastrophic, because the first list is work and the second is
 * investigation. Sorting a POSSIBLE CRITICAL above a CONFIRMED HIGH would put
 * speculation at the top of every report and teach people to skim.
 *
 * WHAT IT REFUSES TO SAY. There is no sentence here that means "this flow is
 * safe". §41 allows only "no issues detected by the available rules", and only
 * when every rule ran — a linter that says "looks good" after half its checks
 * failed is worse than one that says nothing.
 */
import { STATUS, KIND } from './schemas.js';

const GROUPS = [
  { status: STATUS.CONFIRMED, heading: 'Confirmed problems' },
  { status: STATUS.LIKELY, heading: 'Likely problems' },
  { status: STATUS.POSSIBLE, heading: 'Possible risks' },
];

/** One finding, as the §38 four-part explanation. */
function renderFinding(f) {
  const out = [];
  const kindTag = f.kind === KIND.RISK ? ' · RISK'
    : f.kind === KIND.PLATFORM_LIMITATION ? ' · PLATFORM LIMITATION'
      : f.kind === KIND.BEST_PRACTICE ? ' · BEST PRACTICE' : '';
  out.push(`**${f.severity}${kindTag} — ${f.rule_id}** ${f.title}`);
  out.push('');
  out.push(f.description);
  if (f.why_it_matters) {
    out.push('');
    out.push(`*Why it matters:* ${f.why_it_matters}`);
  }
  if (f.evidence?.length) {
    out.push('');
    out.push('*Evidence:*');
    for (const e of f.evidence) {
      const where = [e.table, e.field].filter(Boolean).join('.');
      const bits = [e.step, where, e.input, e.detail].filter(Boolean);
      out.push(`- \`${e.source}\` — ${bits.join(' · ')}`);
    }
  }
  if (f.recommendation?.statement) {
    out.push('');
    out.push(`*Recommended fix:* ${f.recommendation.statement}`);
  }
  if (f.merged?.length) {
    out.push('');
    out.push(`*Also matched:* ${f.merged.map((m) => m.rule_id).join(', ')}`);
  }
  return out.join('\n');
}

/** Render a lint result as Markdown. */
export function renderLint(result) {
  if (!result) return '_No lint result._';
  const out = ['## NowLint', ''];
  out.push(`Flow: **${result.flow?.name ?? 'unknown'}**`
    + `${result.flow?.active === false ? ' *(inactive)*' : ''}`);

  if (result.stopped) {
    out.push('');
    out.push('### The lint did not run');
    out.push('');
    out.push(result.stopped.note);
    if (result.stopped.candidates?.length) {
      out.push('');
      for (const c of result.stopped.candidates) out.push(`- ${c.name} — \`${c.sys_id}\``);
    }
    return out.join('\n');
  }

  const s = result.summary ?? {};
  out.push('');
  const counts = [
    s.confirmed ? `${s.confirmed} confirmed problem${s.confirmed === 1 ? '' : 's'}` : null,
    s.likely ? `${s.likely} likely problem${s.likely === 1 ? '' : 's'}` : null,
    s.possible ? `${s.possible} possible risk${s.possible === 1 ? '' : 's'}` : null,
    s.unknown ? `${s.unknown} check${s.unknown === 1 ? '' : 's'} unavailable` : null,
  ].filter(Boolean);
  out.push(counts.length ? counts.join(', ') : 'No findings.');

  for (const group of GROUPS) {
    const findings = (result.findings ?? []).filter((f) => f.status === group.status);
    if (!findings.length) continue;
    out.push('');
    out.push(`### ${group.heading}`);
    for (const f of findings) {
      out.push('');
      out.push(renderFinding(f));
    }
  }

  /*
   * §39 — the checks that could not run get their own section, never a
   * footnote. A reader deciding whether to deploy needs to know which
   * questions were not answered as much as which ones were.
   */
  if (result.unknown_checks?.length) {
    out.push('');
    out.push('### What I could not check');
    out.push('');
    for (const u of result.unknown_checks) {
      out.push(`- **${u.rule_id}** — ${u.reason}`);
    }
  }

  out.push('');
  if (s.clean) {
    /* §41 — the strongest sentence permitted, and it is deliberately modest. */
    out.push(`No issues detected by the ${s.rules_run} rules that ran.`);
  } else if (s.total === 0 && s.unknown) {
    out.push(`No issues were found by the rules that ran, but ${s.unknown} check(s) could not be `
      + 'performed — this is not a clean result.');
  }

  out.push('');
  out.push('*No changes have been made.*');
  return out.join('\n');
}
