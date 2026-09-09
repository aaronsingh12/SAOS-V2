/**
 * PHASE 20 — WHAT A PERSON READS BEFORE APPROVING (§41, §70).
 *
 * §41 lists what the review must show and §70 shows the shape. The ordering is
 * the design: architecture, then components, then dependencies, then
 * CAPABILITY, then lint, then change, then the test plan. Capability sits in
 * the middle deliberately — a reader who has understood what would be built
 * needs to learn immediately whether any of it can be, before they read a risk
 * assessment for work that will not happen.
 *
 * §28 IS THE HEADLINE. A build with one unsupported component says
 * ARCHITECTURE READY / BUILD BLOCKED at the top, names the components, and says
 * plainly that nothing was written. It never says APPLICATION CREATED, and the
 * closing line of every blocked report is the same sentence: no changes were
 * made.
 */
import { OUTCOME, STATUS, VERIFY } from './schemas.js';

export function renderBuild(result) {
  if (!result) return '## Application Architecture\n\nNothing was produced.';
  const L = [];

  L.push('## Application Architecture');
  L.push('');

  if (result.stopped) {
    L.push(`**${result.requirements?.name ?? 'Application'}**`);
    L.push('');
    L.push('### Not designed');
    L.push('');
    L.push(result.stopped.note ?? 'The request could not be turned into an architecture.');
    for (const p of result.stopped.problems ?? []) L.push(`- ${p.message}`);
    L.push('');
    L.push('No changes were made.');
    return L.join('\n');
  }

  const a = result.architecture;
  L.push(`**Application:** ${a?.application?.name ?? '(unnamed)'}`);
  if (a?.application?.purpose) L.push(`*${a.application.purpose}*`);
  if (a?.application?.scope) L.push(`Scope: \`${a.application.scope}\``);
  L.push('');

  /* ---- components ---- */
  L.push('### Components');
  L.push('');
  const counts = a?.counts ?? {};
  const lines = Object.entries(counts).map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`);
  L.push(lines.length ? lines.join(', ') : 'none');
  L.push('');
  for (const c of a?.components ?? []) {
    L.push(`- **${c.type}** \`${c.name}\`${c.purpose ? ` — ${c.purpose}` : ''}${c.collision ? '  **COLLISION**' : ''}`);
  }

  /* ---- §7 reuse ---- */
  if (a?.reused?.length) {
    L.push('');
    L.push('### Already present — not rebuilt');
    L.push('');
    for (const r of a.reused) L.push(`- \`${r.identity}\` — ${r.why}`);
  }
  if (a?.collisions?.length) {
    L.push('');
    L.push('### Needs a person');
    L.push('');
    for (const c of a.collisions) {
      L.push(`- \`${c.identity}\` — ${c.why}`);
      for (const d of c.differences ?? []) L.push(`  · ${d.what}: ${d.detail}`);
    }
  }

  /* ---- dependencies ---- */
  if (result.graph?.described?.length) {
    L.push('');
    L.push('### Dependencies');
    L.push('');
    for (const d of result.graph.described) {
      L.push(`- ${d.from_label} → ${d.to_label}${d.external ? ' *(already exists)*' : ''}`);
      L.push(`  · ${d.why}`);
    }
  }
  if (result.graph?.order?.length) {
    L.push('');
    L.push(`Build order: ${result.graph.order.join(' → ')}`);
  }

  /* ---- §12 capability, and the headline it produces ---- */
  L.push('');
  L.push('### Capability');
  L.push('');
  const cap = result.capability;
  if (!cap) {
    L.push('Not resolved.');
  } else if (cap.executable) {
    L.push('All requested components are supported on this instance.');
  } else {
    L.push(`**BUILD BLOCKED** — ${cap.blocked.length} of ${cap.summary.total} component(s) cannot be built here.`);
    L.push('');
    for (const b of cap.blocked) {
      L.push(`- \`${b.component}\` — **${b.status}**`);
      L.push(`  · ${b.why}`);
    }
    if (result.remediation?.length) {
      L.push('');
      for (const r of result.remediation) {
        L.push(`**${r.status}** (${r.components.join(', ')})`);
        L.push(`  ${r.what_would_unblock_it}`);
      }
    }
  }

  /* ---- §25 security ---- */
  if (a?.security?.length) {
    L.push('');
    L.push('### Security model');
    L.push('');
    L.push('| Table | Operation | Roles | Note |');
    L.push('|---|---|---|---|');
    for (const s of a.security) {
      L.push(`| ${s.table} | ${s.operation} | ${s.roles.join(', ') || '—'} | ${s.note ?? ''} |`);
    }
  }

  /* ---- §33 lint ---- */
  L.push('');
  L.push('### NowLint');
  L.push('');
  if (!result.lint) L.push('Not run — nothing in this architecture is a lintable live artifact yet.');
  else if (result.lint.error) L.push(`Could not run: ${result.lint.error}`);
  else {
    const f = result.lint.findings ?? [];
    L.push(f.length ? `${f.length} finding(s).` : 'No confirmed defects.');
    for (const x of f.slice(0, 5)) L.push(`- ${x.rule_id} — ${x.title} (${x.status}/${x.severity})`);
  }

  /* ---- §38 change ---- */
  L.push('');
  L.push('### Change');
  L.push('');
  if (result.change) {
    L.push(`${result.change.total} component(s) would be added.`);
    if (result.change.by_type) {
      for (const [type, n] of Object.entries(result.change.by_type)) L.push(`- ${n} × ${type}`);
    }
    L.push('');
    L.push(`Risk: **${result.change.risk}**`);
    if (result.change.why) L.push(result.change.why);
  } else {
    L.push('No change summary was produced.');
  }

  /* ---- §39 knowledge ---- */
  if (result.knowledge?.panel && !result.knowledge.panel.empty) {
    L.push('');
    L.push('### Relevant knowledge');
    L.push('');
    for (const e of result.knowledge.panel.entries.slice(0, 4)) {
      L.push(`- *${e.label}* — ${e.title}: ${String(e.content).slice(0, 160)}`);
    }
    L.push('');
    L.push(result.knowledge.panel.note);
  }

  /* ---- §35 the test plan ---- */
  if (result.testPlan?.length) {
    L.push('');
    L.push('### Test plan');
    L.push('');
    result.testPlan.forEach((t, i) => {
      L.push(`${i + 1}. ${t.criterion}`);
      L.push(`   · ${t.note}`);
    });
  }
  if (result.untestable?.length) {
    L.push('');
    L.push(`${result.untestable.length} stated criterion/criteria describe a quality rather than an observation, `
      + 'so nothing can establish them:');
    for (const c of result.untestable) L.push(`- ${c}`);
  }

  /* ---- the outcome ---- */
  L.push('');
  L.push('---');
  L.push('');
  L.push(...renderOutcome(result));
  return L.join('\n');
}

function renderOutcome(result) {
  const L = [];
  switch (result.outcome) {
    case OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED:
      L.push('## ARCHITECTURE READY — BUILD BLOCKED');
      L.push('');
      L.push('The architecture is valid. This environment cannot author every component it needs, so nothing '
        + 'was built — building the supported half would leave a partial application nobody designed.');
      L.push('');
      L.push('**No changes were made.**');
      break;
    case OUTCOME.APPLICATION_VERIFIED:
      L.push('## APPLICATION VERIFIED');
      L.push('');
      L.push('Every component was created and read back, and every stated behaviour was exercised and passed.');
      break;
    case OUTCOME.APPLICATION_PARTIALLY_VERIFIED:
      L.push('## APPLICATION BUILT — PARTIALLY VERIFIED');
      L.push('');
      L.push('Every component exists and was read back. Not every behaviour could be exercised, so this does '
        + 'not claim the application works.');
      if (result.verification?.behaviour?.note) L.push('');
      if (result.verification?.behaviour?.note) L.push(result.verification.behaviour.note);
      break;
    case OUTCOME.PARTIAL_BUILD:
      L.push('## PARTIAL BUILD');
      L.push('');
      L.push('Some components exist and some do not. Nothing was rolled back.');
      if (result.build?.partial) {
        L.push('');
        L.push(`Created: ${result.build.partial.created.map((c) => c.component).join(', ') || 'none'}`);
        L.push(`Not created: ${result.build.partial.not_created.join(', ') || 'none'}`);
        L.push('');
        L.push(result.build.partial.note);
      }
      break;
    case OUTCOME.BUILD_FAILED:
      L.push('## BUILD FAILED');
      L.push('');
      L.push(result.failures?.[0]?.message ?? 'The build did not run to completion.');
      L.push('');
      L.push('This is a build failure, not a statement about whether the application would work.');
      break;
    case OUTCOME.CANCELLED:
      L.push('## CANCELLED');
      L.push('');
      L.push(result.stopped?.note ?? 'The build was cancelled.');
      break;
    default:
      L.push('## BLOCKED');
      L.push('');
      L.push(result.failures?.[0]?.message ?? 'The build was refused before anything ran.');
      L.push('');
      L.push('**No changes were made.**');
  }

  if (result.limitations?.length) {
    L.push('');
    L.push('### Known limitations');
    L.push('');
    for (const l of result.limitations) L.push(`- ${l}`);
  }
  return L;
}

/** The §69 tally, computed once so a report and a metric cannot disagree. */
export function summarise(result) {
  const cap = result?.capability?.summary ?? {};
  const created = result?.created ?? [];
  const byType = {};
  for (const c of created) byType[c.type] = (byType[c.type] ?? 0) + 1;
  return {
    components_planned: result?.architecture?.components?.length ?? 0,
    components_executable: cap.executable ?? 0,
    components_blocked: cap.blocked ?? 0,
    supported: cap[STATUS.SUPPORTED] ?? 0,
    requires_sdk: cap[STATUS.REQUIRES_SDK] ?? 0,
    requires_source_control: cap[STATUS.REQUIRES_SOURCE_CONTROL] ?? 0,
    requires_manual: cap[STATUS.REQUIRES_MANUAL_ACTION] ?? 0,
    requires_elevation: cap[STATUS.REQUIRES_ELEVATION] ?? 0,
    unsupported: cap[STATUS.UNSUPPORTED] ?? 0,
    created: created.length,
    created_by_type: byType,
    verification: result?.verification?.components?.state ?? VERIFY.NOT_ATTEMPTED,
  };
}
