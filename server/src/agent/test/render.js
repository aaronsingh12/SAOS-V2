/**
 * PHASE 17 — THE TEST RESULT, WRITTEN FOR A PERSON.
 *
 * §38 and §39 give the shape; the reason for it is that a test result is read
 * in about four seconds and the four seconds decide what someone does next. So
 * the order is: what was tested, what was set up, what ran, what was checked,
 * what was cleaned up, and only then the verdict — because the verdict is
 * meaningless without the line above it.
 *
 * THE INCONCLUSIVE WORDING IS THE POINT OF THE WHOLE FILE. §39 makes the
 * distinction mandatory, and the way it is kept here is that an INCONCLUSIVE
 * report never contains a sentence about what the flow does or does not do. It
 * says what was observed and then says, in as many words, that no claim
 * follows from it.
 */
import { RESULTS, ASSERTION_STATES, CLEANUP, FAILURES } from './schemas.js';
import { readable } from './result.js';

const TICK = '✓';
const CROSS = '✗';
const DASH = '–';

export function renderTest(result) {
  if (!result) return '## NowTest\n\nNo test result was produced.';
  const L = [];

  L.push('## NowTest');
  L.push('');
  if (result.flow?.name || result.artifact?.name) {
    L.push(`**Flow:** ${result.flow?.name ?? result.artifact?.name}`);
    L.push('');
  }

  /* A run that never started says so and stops. */
  if (result.status === RESULTS.BLOCKED && result.stopped) {
    L.push('### Not run');
    L.push('');
    L.push(result.stopped.note ?? result.statement ?? 'The test did not run.');
    if (result.stopped.candidates?.length) {
      L.push('');
      L.push('Candidates:');
      for (const c of result.stopped.candidates.slice(0, 10)) L.push(`- ${c.name} — \`${c.sys_id}\``);
    }
    if (result.stopped.unsupported?.length) {
      L.push('');
      for (const u of result.stopped.unsupported) L.push(`- \`${u.term}\` — ${u.reason}`);
    }
    L.push('');
    L.push('## BLOCKED');
    L.push('');
    L.push(cleanupLine(result.cleanup));
    return L.join('\n');
  }

  /* ---- setup ---- */
  L.push('### Test setup');
  L.push('');
  const f = result.fixture;
  if (f?.created) {
    L.push(`${TICK} Created a disposable ${f.table} \`${f.sys_id}\``);
    if (f.marker) L.push(`  · marked ${'`'}${f.marker}${'`'} in ${f.marker_field}`);
    const written = Object.entries(f.data ?? {}).filter(([k]) => k !== f.marker_field);
    if (written.length) L.push(`  · set ${written.map(([k, v]) => `${k}=${v}`).join(', ')} to satisfy the trigger`);
    for (const d of result.contract?.trigger?.derived ?? []) {
      L.push(`  · ${d.field} was driven from ${d.from.join(' + ')} rather than written — the platform computes it`);
    }
  } else {
    L.push(`${CROSS} No test record was created${f?.error ? `: ${f.error}` : ''}`);
  }

  if (result.trigger_check && !result.trigger_check.satisfied) {
    L.push('');
    for (const c of result.trigger_check.failed) {
      L.push(`${CROSS} ${c.field} read back as "${c.actual}", but the trigger needs "${c.expected}"`);
    }
  }

  /* ---- execution ---- */
  L.push('');
  L.push('### Execution');
  L.push('');
  const e = result.execution;
  if (!e) {
    L.push(`${DASH} The execution history was not read.`);
  } else if (!e.found) {
    L.push(`${CROSS} No execution of this flow was recorded within ${Math.round((e.waited_ms ?? 0) / 1000)}s`);
  } else {
    L.push(`${TICK} Flow triggered`);
    const head = e.executions?.[0] ?? null;
    const ok = e.settled && head?.state === 'EXECUTION_COMPLETE';
    L.push(`${ok ? TICK : CROSS} Execution ${readable(head?.state ?? e.state)}`
      + `${e.waited_ms ? ` after ${(e.waited_ms / 1000).toFixed(1)}s` : ''}`);
    if (head?.error) L.push(`  · ${head.error}`);
    if (head?.sys_id) L.push(`  · execution \`${head.sys_id}\``);
    if (e.other_executions > 0) {
      L.push(`  · ${e.other_executions} other execution(s) ran against this record and are not counted here`);
    }
  }

  /* ---- assertions ---- */
  L.push('');
  L.push('### Assertions');
  L.push('');
  if (!result.assertions?.length) {
    L.push(`${DASH} Nothing about this flow could be checked by reading the record it was triggered by.`);
  } else {
    for (const a of result.assertions) {
      const mark = a.status === ASSERTION_STATES.PASS ? TICK
        : a.status === ASSERTION_STATES.FAIL ? CROSS : DASH;
      L.push(`${mark} ${a.description}`);
      if (a.status === ASSERTION_STATES.FAIL) {
        L.push(`  · expected ${a.expected === null ? 'a change' : `\`${a.expected}\``}`);
        L.push(`  · observed ${a.actual === '' || a.actual === null ? '(empty)' : `\`${a.actual}\``}`
          + `${a.actual_display ? ` (${a.actual_display})` : ''}`);
      } else if (a.status === ASSERTION_STATES.UNAVAILABLE) {
        L.push(`  · ${a.note ?? 'no evidence was available to decide this'}`);
      } else if (a.note) {
        L.push(`  · ${a.note}`);
      }
      if (a.source) L.push(`  · read by ${a.source.step} (${a.source.tool})`);
    }
  }

  /* ---- cleanup ---- */
  L.push('');
  L.push('### Cleanup');
  L.push('');
  L.push(cleanupLine(result.cleanup));

  /* ---- verdict ---- */
  L.push('');
  L.push(`## ${result.status}`);
  L.push('');
  L.push(result.statement ?? '');

  if (result.status === RESULTS.INCONCLUSIVE) {
    L.push('');
    L.push('No claim is made about whether the expected effect would eventually occur.');
  }
  if (result.status === RESULTS.FAIL) {
    L.push('');
    L.push('This establishes that an expected effect is missing. It does not establish why.');
  }
  if (result.failures?.length) {
    L.push('');
    L.push(`Classified as: ${result.failures.join(', ')}`);
  }

  /*
   * §28 — reported beside the verdict, never folded into it. A flow that also
   * stamps a field nobody asked about is behaving in a way somebody should see,
   * and is not thereby failing its test.
   */
  if (result.unexpected_effects?.length) {
    L.push('');
    L.push('### Also changed (not part of what was tested)');
    L.push('');
    for (const u of result.unexpected_effects) {
      L.push(`- ${u.field}: "${u.from || '(empty)'}" → "${u.to || '(empty)'}"${u.display ? ` (${u.display})` : ''}`);
    }
    L.push('');
    L.push('These are reported as a risk. They did not decide the result.');
  }

  /* ---- what was not covered ---- */
  if (result.limitations?.length) {
    L.push('');
    L.push('### Not covered by this test');
    L.push('');
    for (const l of result.limitations) L.push(`- ${l}`);
  }

  /* §41 — lint findings, shown, never a gate. */
  const lintFindings = result.lint?.findings ?? [];
  if (lintFindings.length) {
    L.push('');
    L.push('### NowLint also found');
    L.push('');
    for (const finding of lintFindings.slice(0, 5)) {
      L.push(`- ${finding.rule_id} — ${finding.title} (${finding.status})`);
    }
    L.push('');
    L.push('Lint and runtime testing answer different questions; these did not gate the test.');
  }

  /*
   * §40/§62 — offered on a FAIL and nowhere else.
   *
   * `doctorHandoff` already returns null for every other status, so this is the
   * second of two checks rather than the only one. It is here because the
   * renderer is what a person reads: an "investigate this" button under a
   * passing test would suggest there is something to investigate.
   */
  if (result.doctor?.available && result.status === RESULTS.FAIL) {
    L.push('');
    L.push(`[Investigate with Doctor] — ${result.doctor.request}`);
  }

  return L.join('\n');
}

function cleanupLine(cleanup) {
  if (!cleanup) return `${DASH} Cleanup was not recorded.`;
  switch (cleanup.status) {
    case CLEANUP.NOT_NEEDED:
      return `${DASH} Nothing was created, so nothing needed removing.`;
    case CLEANUP.PASS:
      return `${TICK} ${cleanup.records_deleted} of ${cleanup.records_created} test record(s) deleted and verified gone.`;
    case CLEANUP.REFUSED:
      return `${CROSS} Cleanup was not authorised. ${cleanup.note}`;
    case CLEANUP.FAILED:
      return `${CROSS} Cleanup failed. ${cleanup.note}`;
    default:
      return `${CROSS} Cleanup outcome unknown. ${cleanup.note ?? ''}`;
  }
}

export const _internals = { cleanupLine, FAILURES };
