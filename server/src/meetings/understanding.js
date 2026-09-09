import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { log } from '../logging.js';
import { chatOnce } from '../agent/providers/index.js';
import { normalize, verifyFinding } from './evidence.js';
import { parseModelJson } from './model-json.js';

/**
 * WHAT THE MEETING MEANT — the rolling understanding pass.
 *
 * Runs DURING the meeting, not after it. Every ~90 seconds of newly
 * transcribed speech the model reads the new window and proposes findings, so
 * by the time someone hangs up the pipeline is one window behind rather than
 * one meeting behind. That is what makes "the requirements are ready when the
 * call ends" true rather than aspirational.
 *
 * TWO RULES THE PROMPT CANNOT BE TRUSTED TO KEEP, SO THE CODE KEEPS THEM:
 *
 *   1. Every finding must cite the transcript, and the citation is CHECKED
 *      (evidence.js). Asking a model to be truthful is not a mechanism.
 *   2. The model interprets the MEETING. It does not design ServiceNow. The
 *      prompt says so, and the artifact planner in phase 5 is a separate stage
 *      that never sees the audio — so a model that ignores the instruction can
 *      only produce a badly-worded requirement, never a bad implementation.
 */

export const KINDS = Object.freeze(['requirement', 'decision', 'question', 'assumption', 'criterion']);

/** How much NEW transcribed speech triggers a pass while the meeting runs. */
export const PASS_TRIGGER_MS = 90_000;

/**
 * Utterances carried over from the previous window.
 *
 * A requirement is routinely split across a question and its answer, and a
 * window that starts cleanly between them extracts neither. The overlap costs
 * a few hundred tokens; the fingerprint dedupe below stops it producing the
 * same finding twice.
 */
export const OVERLAP_SEGMENTS = 4;

const now = () => new Date().toISOString();

/** Stable identity for a finding, so overlapping windows do not duplicate it. */
export function fingerprint(kind, text) {
  // The separator is an explicit NUL rather than a space, and it is written as
  // an escape so it is visible in the source. A raw 0x00 byte got in here by
  // accident; it is kept deliberately because it is the right separator for a
  // hash input — it cannot occur in a kind or in normalised text, so
  // ('decision', 'x y') can never collide with ('decision x', 'y') — and because
  // changing it now would re-propose every finding already stored under the old
  // fingerprint as if it were new.
  return crypto.createHash('sha256').update(`${kind}\u0000${normalize(text)}`).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

const SYSTEM = `You extract structured facts from a meeting transcript. You are not a designer and not a consultant.

You will be given numbered utterances from a meeting. Each is labelled with WHO said it: "you" is the person running this tool, "them" is everyone else on the call.

Return ONLY a JSON object, with no prose and no markdown fences:

{"findings":[{"kind":"requirement","text":"...","evidence":[{"segment":12,"quote":"exact words from utterance 12"}],"confidence":"high"}]}

kind is one of: requirement, decision, question, assumption, criterion.
  requirement — something someone asked for or said the system must do
  decision    — something explicitly agreed
  question    — something raised and NOT resolved
  assumption  — something you inferred that nobody actually said outright
  criterion   — a stated way of telling whether the result is correct

THE RULES, IN ORDER OF IMPORTANCE:

1. EVERY finding must carry at least one evidence entry, and every quote must be
   copied VERBATIM from the utterance you cite. Utterances marked [UNCLEAR] were
   recorded over background noise and may be wrong — read them for context, but
   NEVER quote them; a finding whose only evidence is an unclear line is discarded. Do not paraphrase a quote. Do not
   quote an utterance number you were not given. The quotes are checked against
   the transcript and any finding whose quote cannot be found is discarded.

2. Extract only what was actually said. If the meeting did not settle something,
   that is a "question", not a requirement you invent an answer for. An empty
   findings list is a correct answer for small talk.

3. Do NOT design a solution. Do not name ServiceNow tables, catalog items, flows,
   fields or any implementation at all unless a speaker said those words. Write
   what was asked for in the speakers' own terms.

4. Ignore greetings, audio checks ("can you hear me"), scheduling chatter and
   jokes. They are not findings.

5. Prefer few, well-evidenced findings over many weak ones.`;

function buildUserPrompt(segments, existing) {
  const lines = segments.map((s) => {
    const who = s.track === 'mic' ? 'you' : 'them';
    // An unclear line is context, not a source. Saying so in the prompt saves
    // the model from proposing a finding the guard would then reject.
    const flag = s.stt_state === 'low' ? ' [UNCLEAR - context only, do not quote]' : '';
    return `[${s.idx}] (${who})${flag} ${s.text}`;
  });
  const already = existing.length
    ? `\n\nAlready recorded from earlier in this meeting — do NOT repeat these:\n`
      + existing.slice(-25).map((f) => `- (${f.kind}) ${f.edited_text || f.text}`).join('\n')
    : '';
  return `Transcript excerpt:\n\n${lines.join('\n')}${already}\n\nReturn the JSON object now.`;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Pull a JSON object out of whatever the model actually returned.
 *
 * gpt-oss:120b-cloud is non-reproducible and does not reliably honour "no
 * markdown fences" — measured across this project, the same prompt returns
 * bare JSON, fenced JSON, and JSON with a sentence in front of it. Failing the
 * whole pass on a code fence would make the feature look broken when the
 * content was fine, so the wrapper is stripped and the SHAPE is validated
 * instead. Anything that is not a well-formed findings array is an error the
 * caller reports, never a silent empty result.
 */
export function parseFindings(raw) {
  const parsed = parseModelJson(raw, { what: 'findings' });
  const findings = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(findings)) throw new Error('the model returned no "findings" array');

  const out = [];
  for (const f of findings) {
    const kind = String(f?.kind || '').toLowerCase().trim();
    const body2 = String(f?.text || '').trim();
    if (!KINDS.includes(kind) || !body2) continue;
    const evidence = Array.isArray(f?.evidence) ? f.evidence : [];
    out.push({
      kind,
      text: body2,
      confidence: ['high', 'medium', 'low'].includes(String(f?.confidence || '').toLowerCase())
        ? String(f.confidence).toLowerCase() : null,
      evidence: evidence.map((e) => ({ segment: Number(e?.segment), quote: String(e?.quote || '') })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

/** Transcribed, non-empty utterances — the only thing worth reading. */
export function transcribedSegments(meetingId) {
  /*
   * `low` is included on purpose, and marked in the prompt.
   *
   * A sentence spoken over wind or a third person talking fails Whisper's
   * confidence checks, and dropping it from the window would hide the middle of
   * a conversation from the model — the requirement either side of it then
   * makes no sense. So it is shown as context and the model is told it may not
   * cite it; the evidence guard enforces that independently, because
   * verifyCitation only accepts `done`.
   */
  return getDb().prepare(
    `SELECT idx, track, start_ms, end_ms, text, stt_state
       FROM meeting_segments
      WHERE meeting = ? AND stt_state IN ('done', 'low') AND text IS NOT NULL AND text <> ''
      ORDER BY start_ms ASC, idx ASC`
  ).all(meetingId);
}

export function existingFindings(meetingId) {
  return getDb().prepare(
    'SELECT id, kind, text, edited_text, status, fingerprint FROM meeting_findings WHERE meeting = ? ORDER BY id'
  ).all(meetingId);
}

/** How much new transcribed speech is waiting to be read. */
export function pendingSpeechMs(meetingId) {
  const m = getDb().prepare('SELECT understood_through_ms FROM meetings WHERE id = ?').get(meetingId);
  if (!m) return 0;
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(end_ms - start_ms), 0) AS ms
       FROM meeting_segments
      WHERE meeting = ? AND stt_state = 'done' AND text IS NOT NULL AND text <> ''
        AND start_ms >= ?`
  ).get(meetingId, m.understood_through_ms || 0);
  return row?.ms || 0;
}

function persist(meetingId, pass, findings) {
  const db = getDb();
  const insertFinding = db.prepare(
    `INSERT INTO meeting_findings (meeting, kind, text, status, origin, confidence, pass, fingerprint, created)
     VALUES (?, ?, ?, 'proposed', 'model', ?, ?, ?, ?)
     ON CONFLICT (meeting, fingerprint) DO NOTHING`
  );
  const insertEvidence = db.prepare(
    `INSERT INTO meeting_evidence (finding, seg_idx, quote, verified, reason, start_ms, end_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const added = [];
  for (const f of findings) {
    const fp = fingerprint(f.kind, f.text);
    const res = insertFinding.run(meetingId, f.kind, f.text, f.confidence, pass, fp, now());
    if (!res.changes) continue; // an overlapping window proposed it already
    const id = db.prepare('SELECT id FROM meeting_findings WHERE meeting = ? AND fingerprint = ?')
      .get(meetingId, fp)?.id;
    for (const c of f.evidence) {
      insertEvidence.run(id, c.seg_idx ?? null, c.quote, c.verified ? 1 : 0, c.reason, c.start_ms ?? null, c.end_ms ?? null);
    }
    added.push({ id, ...f });
  }
  return added;
}

/**
 * Run one understanding pass over the un-read part of the transcript.
 *
 * `force` runs it even when little new speech has arrived — which is what the
 * end of a meeting does, so the last thirty seconds are never left unread.
 */
export async function runPass(meetingId, { force = false } = {}) {
  const db = getDb();
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!meeting) throw Object.assign(new Error('No such meeting.'), { status: 404 });

  const all = transcribedSegments(meetingId);
  const watermark = meeting.understood_through_ms || 0;
  const fresh = all.filter((s) => s.start_ms >= watermark);
  if (!fresh.length) return { ok: true, skipped: 'nothing new has been transcribed', added: [], findings: 0 };

  const freshMs = fresh.reduce((a, s) => a + (s.end_ms - s.start_ms), 0);
  if (!force && freshMs < PASS_TRIGGER_MS) {
    return { ok: true, skipped: `only ${Math.round(freshMs / 1000)}s of new speech`, added: [], findings: 0 };
  }

  // Carry a little context back, or a requirement split across a question and
  // its answer is lost at the seam.
  const firstFreshIdx = all.indexOf(fresh[0]);
  const window = all.slice(Math.max(0, firstFreshIdx - OVERLAP_SEGMENTS));
  const pass = (meeting.passes || 0) + 1;

  db.prepare("UPDATE meetings SET understanding_state = 'running', understanding_error = NULL WHERE id = ?").run(meetingId);

  let proposed;
  try {
    const raw = await chatOnce({
      system: SYSTEM,
      user: buildUserPrompt(window, existingFindings(meetingId)),
      maxTokens: 2000,
    });
    proposed = parseFindings(raw);
  } catch (err) {
    db.prepare("UPDATE meetings SET understanding_state = 'error', understanding_error = ? WHERE id = ?")
      .run(err.message, meetingId);
    log.error('meetings', `understanding pass ${pass} failed for ${meetingId}: ${err.message}`);
    return { ok: false, error: err.message, added: [], findings: 0 };
  }

  // THE GUARD. Nothing reaches the user un-checked.
  const segments = db.prepare(
    'SELECT idx, text, stt_state, start_ms, end_ms FROM meeting_segments WHERE meeting = ?'
  ).all(meetingId);
  const checked = proposed.map((f) => {
    const v = verifyFinding(meetingId, f, { segments });
    return { ...f, evidence: v.evidence, verified: v.verified };
  });

  const backed = checked.filter((f) => f.verified);
  const unbacked = checked.filter((f) => !f.verified);
  if (unbacked.length) {
    // The number worth watching: how often the model claims something it
    // cannot back up. Quiet suppression would hide exactly that.
    log.warn('meetings',
      `understanding pass ${pass}: ${unbacked.length} of ${checked.length} finding(s) cited nothing that `
      + `appears in the transcript and were NOT accepted — ${unbacked.map((f) => JSON.stringify(f.text.slice(0, 60))).join('; ')}`);
  }

  const added = persist(meetingId, pass, backed);
  const through = Math.max(watermark, ...all.map((s) => s.end_ms));
  db.prepare(
    "UPDATE meetings SET understood_through_ms = ?, passes = ?, understanding_state = 'idle' WHERE id = ?"
  ).run(through, pass, meetingId);

  log.info('meetings',
    `understanding pass ${pass} on ${meetingId}: ${window.length} utterances read, `
    + `${checked.length} proposed, ${backed.length} evidence-backed, ${added.length} new`);

  return {
    ok: true,
    pass,
    read: window.length,
    proposed: checked.length,
    backed: backed.length,
    rejected: unbacked.length,
    rejectedFindings: unbacked.map((f) => ({ kind: f.kind, text: f.text, evidence: f.evidence })),
    added,
    findings: added.length,
  };
}
