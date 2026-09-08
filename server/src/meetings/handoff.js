import { getDb } from '../memory/db.js';
import { log } from '../logging.js';
import { createSession, getSession } from '../memory/sessions.js';
import { approvedSet } from './findings.js';

/**
 * HANDING A MEETING TO THE AGENT.
 *
 * This replaces the build-plan stage that used to live on the Meetings page.
 * That stage was a second, weaker orchestrator sitting beside one that already
 * existed: the agent has the approval gate, the tool cards, the whole tool
 * registry, the iteration budget, the mutation ledger — and, unlike a plan
 * screen, it can be argued with. "Change the approval to the department head"
 * is a sentence there and a re-plan everywhere else.
 *
 * So nothing is planned here. What is produced is a BRIEF: the confirmed
 * requirements, the evidence behind them, and the things the meeting did not
 * settle. The agent decides what to build, and the human approves each write
 * at the gate that already exists.
 *
 * THE BRIEF IS NOT SENT AUTOMATICALLY. It lands in the composer, where it can
 * be read and edited before a single tool runs. A meeting transcript is a
 * lossy record of what people meant, and the last chance to correct it is
 * before the agent starts writing to a live instance — not after.
 */

/** Only what a human confirmed, and for model findings only what was evidenced. */
export function meetingBrief(meetingId) {
  const db = getDb();
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!meeting) throw Object.assign(new Error('No such meeting.'), { status: 404 });

  const set = approvedSet(meetingId);
  const when = new Date(meeting.started).toLocaleString();
  const title = meeting.title || 'Untitled meeting';

  const lines = [];
  lines.push(`These are the agreed outcomes of a meeting I recorded: "${title}" (${when}).`);
  lines.push('');
  lines.push('Every line below was confirmed by me, and each one is quoted from the transcript.');
  lines.push('');

  const section = (heading, items, { quotes = true } = {}) => {
    if (!items.length) return;
    lines.push(`## ${heading}`);
    for (const f of items) {
      lines.push(`- ${f.edited_text || f.text}`);
      if (quotes) {
        for (const e of (f.evidence || []).filter((x) => x.verified)) {
          // The quote travels with the requirement. When the agent has to make
          // a judgement call, the speaker's own words are better evidence than
          // a paraphrase that has already been through two models.
          lines.push(`    said: "${e.quote}"`);
        }
      }
    }
    lines.push('');
  };

  section('What was asked for', set.requirements);
  section('What was decided', set.decisions);
  section('How we will know it works', set.criteria);

  if (set.assumptions.length) {
    lines.push('## Assumptions the transcript did not state outright');
    for (const f of set.assumptions) lines.push(`- ${f.edited_text || f.text}`);
    lines.push('');
  }

  if (set.openQuestions.length) {
    lines.push('## NOT settled in the meeting — do not design around these');
    for (const f of set.openQuestions) lines.push(`- ${f.edited_text || f.text}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Please build this on the connected instance.');
  lines.push('');
  lines.push('- Work out which artifacts these need. Check the live schema before writing anything.');
  lines.push('- Where the meeting did not say something you need — a group, a user, a table, a field, '
    + 'a choice value — ASK me. Do not pick a plausible value: the transcript is all the authority '
    + 'there is here, and it is silent on anything not quoted above.');
  lines.push('- The open questions above are open. Do not answer them for me.');
  lines.push('- Tell me what you intend to build before you start, then build it one artifact at a time.');

  return {
    text: lines.join('\n'),
    meeting: { id: meeting.id, title, started: meeting.started, instance: meeting.instance },
    counts: set.counts,
    requirements: set.requirements.length,
    openQuestions: set.openQuestions.length,
  };
}

/**
 * Create (or return) the agent session this meeting hands off to.
 *
 * Idempotent per meeting: pressing the button twice returns the SAME chat
 * rather than starting a second one against the same requirements. Two chats
 * building the same meeting is how a catalog item gets created twice, and
 * nothing downstream would notice.
 */
export function handoffToAgent(meetingId) {
  const db = getDb();
  const brief = meetingBrief(meetingId);
  if (!brief.requirements && !brief.counts.confirmed) {
    throw Object.assign(new Error(
      'Nothing has been confirmed for this meeting yet. Confirm the requirements you want built, '
      + 'then hand it to the agent.'
    ), { status: 409 });
  }

  const existing = db.prepare(
    "SELECT id FROM sessions WHERE source = 'meeting' AND source_ref = ? ORDER BY created DESC LIMIT 1"
  ).get(meetingId);
  if (existing) {
    log.info('meetings', `meeting ${meetingId} already has agent chat ${existing.id} — reusing it`);
    return { session: getSession(existing.id), brief, reused: true };
  }

  const session = createSession({
    title: `Build: ${brief.meeting.title}`,
    source: 'meeting',
    sourceRef: meetingId,
    sourceLabel: brief.meeting.title,
  });
  log.info('meetings', `meeting ${meetingId} handed to agent chat ${session.id}`);
  return { session, brief, reused: false };
}
