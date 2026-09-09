/**
 * PHASE 18 — THE COMPARISON, WRITTEN FOR A PERSON.
 *
 * §39 asks for `- removed` / `+ added` on values and for structural changes to
 * keep their category rather than being flattened into text, and the two pull
 * apart: a `-`/`+` pair is the clearest thing in the world for a field value
 * and says nothing useful about a step that moved. So values get the diff
 * gutter and structure gets a named line, which is the whole of §39.
 *
 * §26 IS ENFORCED BY CONSTRUCTION. The counts a reader sees are the ones
 * `summarise` computed; this file formats them and cannot alter them, and there
 * is no path by which a sentence and a number here come from different places.
 *
 * §41 — a PARTIAL comparison says so in its heading, before anything else, and
 * lists what could not be read. A reader who stops at the first line must not
 * come away thinking they saw the whole picture.
 */
import { KINDS, ELEMENTS, RISK, STATUS } from './schemas.js';

const MINUS = '-';
const PLUS = '+';

export function renderComparison(c) {
  if (!c) return '## Change Intelligence\n\nNo comparison was produced.';
  const L = [];

  L.push('## Change Intelligence');
  L.push('');
  if (c.artifact?.name) {
    L.push(`**Flow:** ${c.artifact.name}`);
    L.push('');
  }

  /* A run that never compared anything says why and stops. */
  if (c.stopped) {
    L.push('### No comparison');
    L.push('');
    L.push(c.stopped.note ?? 'The comparison did not run.');
    if (c.stopped.candidates?.length) {
      L.push('');
      L.push('Candidates:');
      for (const x of c.stopped.candidates.slice(0, 10)) L.push(`- ${x.name} — \`${x.sys_id}\``);
    }
    L.push('');
    L.push('No changes have been deployed.');
    return L.join('\n');
  }

  /* ---- the two states ---- */
  L.push('### Compared');
  L.push('');
  L.push(`| | Source | Version | Read |`);
  L.push(`|---|---|---|---|`);
  L.push(`| Baseline | ${c.baseline?.source ?? '—'} | \`${c.baseline?.version?.id ?? '—'}\`${c.baseline?.version?.derived ? ' (derived)' : ''} | ${c.baseline?.sys_id ?? '—'} |`);
  L.push(`| Current | ${c.current?.source ?? '—'} | \`${c.current?.version?.id ?? '—'}\`${c.current?.version?.derived ? ' (derived)' : ''} | ${c.current?.sys_id ?? '—'} |`);

  if (!c.complete) {
    L.push('');
    L.push('### PARTIAL');
    L.push('');
    L.push('Part of this artifact could not be read, so what follows is not a complete comparison.');
    for (const u of c.unreadable ?? []) L.push(`- ${u}`);
  }

  /*
   * §35 — A CAPTURE IS NOT A COMPARISON, and it used to render as one.
   *
   * FOUND BY REVIEW. A capture-baseline run has no baseline and no summary, so
   * it fell into the `!s.total` branch and reported "The two states are
   * identical" — about a run that read one state and compared nothing.
   */
  if (c.captured_baseline) {
    L.push('');
    L.push('### Baseline captured');
    L.push('');
    L.push(`The current state of this flow was recorded as a baseline (\`${c.captured_baseline.hash?.slice(0, 12)}\`, `
      + `source ${c.captured_baseline.source}, at ${c.captured_baseline.captured_at}).`);
    L.push('');
    L.push('Nothing was compared. Ask for a comparison to see what has changed since.');
    L.push('');
    L.push('---');
    L.push('');
    L.push('No changes have been deployed.');
    return L.join('\n');
  }

  /* ---- the counts, verbatim (§26) ---- */
  const s = c.summary ?? {};
  L.push('');
  if (!s.total) {
    L.push(`### No semantic changes`);
    L.push('');
    L.push(c.complete
      ? `The two states are identical. ${s.unchanged ?? 0} element(s) were compared and every one matches.`
      : `Nothing differs in the sections that could be read.`);
    if (s.display_only) {
      L.push('');
      L.push(`${s.display_only} label(s) differ while the identity behind them does not. That is not a change to what the flow does.`);
    }
  } else {
    L.push(`### ${s.total} change${s.total === 1 ? '' : 's'}`);
    L.push('');
    L.push([
      s.added ? `${s.added} addition${s.added === 1 ? '' : 's'}` : null,
      s.removed ? `${s.removed} removal${s.removed === 1 ? '' : 's'}` : null,
      s.changed ? `${s.changed} modification${s.changed === 1 ? '' : 's'}` : null,
      s.moved ? `${s.moved} move${s.moved === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(', '));
  }

  /* ---- the changes, grouped by element (§39) ---- */
  const real = (c.changes ?? []).filter((x) => !x.display_only && x.kind !== KINDS.UNCHANGED);
  for (const [element, label] of GROUPS) {
    const group = real.filter((x) => x.element === element);
    if (!group.length) continue;
    L.push('');
    L.push(`### ${label}`);
    L.push('');
    for (const x of group) L.push(...renderChange(x));
  }

  /* ---- §19, shown but never counted as a change ---- */
  const labels = (c.changes ?? []).filter((x) => x.display_only);
  if (labels.length) {
    L.push('');
    L.push('### Labels only');
    L.push('');
    for (const x of labels) {
      L.push(`~ ${x.path}: "${x.before_display ?? ''}" → "${x.after_display ?? ''}"`);
      L.push(`  · the identity is unchanged (\`${x.after}\`), so nothing the flow does changed`);
    }
  }

  /* ---- impact ---- */
  if (c.impact?.length || c.dependencies?.added?.length || c.dependencies?.removed?.length) {
    L.push('');
    L.push('### Impact');
    L.push('');
    for (const f of c.impact ?? []) {
      L.push(`**${f.status}** ${f.statement}`);
      if (f.why_it_matters) L.push(`  · ${f.why_it_matters}`);
    }
  }

  /* ---- risk ---- */
  L.push('');
  L.push('### Risk');
  L.push('');
  L.push(`**${c.risk}**`);
  if (c.risk_reason) L.push('');
  if (c.risk_reason) L.push(c.risk_reason);
  if (c.risk_unknown_changes) {
    L.push('');
    L.push(`${c.risk_unknown_changes} difference(s) have an effect this build could not establish. They are `
      + 'listed above and are not counted in the assessment.');
  }

  /* ---- NowLint (§22) ---- */
  L.push('');
  L.push('### NowLint');
  L.push('');
  if (!c.lint) {
    L.push('Not run.');
  } else if (c.lint.error) {
    L.push(`Could not run: ${c.lint.error}`);
  } else {
    const findings = c.lint.findings ?? [];
    L.push(findings.length
      ? `${findings.length} finding${findings.length === 1 ? '' : 's'} on the current artifact.`
      : 'No findings on the current artifact from the rules that ran.');
    for (const f of findings.slice(0, 5)) L.push(`- ${f.rule_id} — ${f.title} (${f.status}/${f.severity})`);
    if (c.lint.scope?.relevant?.length) {
      L.push('');
      const evaluated = c.lint.scope.evaluated ?? [];
      L.push(`Rules relevant to what changed: ${c.lint.scope.relevant.join(', ')}.`);
      /*
       * §22 — "do not claim lint clean if an important rule was not evaluated".
       * Both halves are stated, because which one applies is the difference
       * between a complete answer and a scoped one, and a reader cannot infer
       * it from the findings.
       */
      if (c.lint.scope.not_evaluated?.length) {
        L.push(`Not evaluated: ${c.lint.scope.not_evaluated.join(', ')} — nothing above says those pass.`);
      } else if (evaluated.length) {
        L.push(`All ${evaluated.length} rules were evaluated against the current artifact, so the findings above are not scoped.`);
      }
    }
  }

  /* ---- NowTest (§23) ---- */
  L.push('');
  L.push('### NowTest');
  L.push('');
  if (c.test?.recommended) {
    L.push(`Available. ${c.test.reason}`);
    L.push('');
    L.push(`[Run NowTest] — ${c.test.request}`);
  } else {
    L.push(c.test?.reason ?? 'Not assessed.');
  }

  /* ---- §32 — the one thing this never did ---- */
  L.push('');
  L.push('---');
  L.push('');
  L.push('No changes have been deployed.');
  if (c.deployment?.available) {
    L.push('');
    L.push('[Prepare Change] — hands the goal below to the ordinary planner, which shows you what it will do '
      + 'and waits for your approval before anything runs.');
    L.push('');
    L.push(`> ${c.deployment.goal}`);
  } else if (c.deployment?.note) {
    L.push('');
    L.push(c.deployment.note);
  }

  return L.join('\n');
}

const GROUPS = Object.freeze([
  [ELEMENTS.TRIGGER, 'Trigger'],
  [ELEMENTS.CONDITION, 'Conditions'],
  [ELEMENTS.ACTION, 'Actions'],
  [ELEMENTS.BRANCH, 'Branches'],
  [ELEMENTS.REFERENCE, 'References'],
  [ELEMENTS.INPUT, 'Inputs'],
  [ELEMENTS.OUTPUT, 'Outputs'],
  [ELEMENTS.DEPENDENCY, 'Dependencies'],
  [ELEMENTS.HEADER, 'Flow properties'],
]);

/**
 * One change.
 *
 * §39's split: a value change gets the `-`/`+` gutter, and a structural change
 * gets a named line saying what happened to what. A step that moved is not
 * usefully rendered as two lines of text, and pretending otherwise is how a
 * diff makes a reorder look like a rewrite.
 */
function renderChange(x) {
  const out = [];
  const risk = x.risk && x.risk !== RISK.LOW ? ` **${x.risk}**` : '';
  const uncertain = x.status === STATUS.UNKNOWN ? ' *(effect not established)*' : '';

  if (x.kind === KINDS.MOVED) {
    out.push(`MOVED ${short(x.path)}${risk}${uncertain}`);
    if (x.note) out.push(`  · ${x.note}`);
    else out.push(`  · ${fmt(x.before)} → ${fmt(x.after)}`);
    return out;
  }
  if (x.element === ELEMENTS.ACTION && (x.kind === KINDS.ADDED || x.kind === KINDS.REMOVED)) {
    out.push(`${x.kind} ACTION ${fmt(x.after ?? x.before)}${risk}${uncertain}`);
    if (x.detail?.order !== undefined) out.push(`  · at position ${x.detail.order}`);
    return out;
  }

  out.push(`${short(x.path)}${risk}${uncertain}`);
  if (x.before !== null) out.push(`${MINUS} ${fmt(x.before)}${x.before_display && x.before_display !== x.before ? `  (${x.before_display})` : ''}`);
  if (x.after !== null) out.push(`${PLUS} ${fmt(x.after)}${x.after_display && x.after_display !== x.after ? `  (${x.after_display})` : ''}`);
  if (x.note) out.push(`  · ${x.note}`);
  if (x.why && x.risk && x.risk !== RISK.LOW) out.push(`  · ${x.why}`);
  return out;
}

const fmt = (v) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

/** `steps[<uuid>].inputs.values` reads badly; the uuid is not what a person
 *  is looking at. The step keeps a short identity so two steps stay
 *  distinguishable, and the rest of the path is left alone. */
const short = (path) => String(path).replace(/steps\[([0-9a-f-]{8})[0-9a-f-]*\]/i, 'step $1');

export const _internals = { renderChange, short, GROUPS };
