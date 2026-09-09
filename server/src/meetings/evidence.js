/**
 * THE EVIDENCE GUARD.
 *
 * This is the safety mechanism the whole module rests on, and it is about
 * forty lines of string comparison.
 *
 * THE THREAT. The only model available on this machine is gpt-oss:120b-cloud,
 * which provably ignores `seed` — every generation is non-reproducible. The
 * failure mode of a model like that, on a task like "read this transcript and
 * tell me what was asked for", is NOT a crash and NOT obvious nonsense. It is
 * a fluent, confident, entirely invented requirement that reads exactly like
 * the real ones sitting next to it. Nothing about the text distinguishes them,
 * and a human reviewing twenty findings will not catch the fabricated one.
 *
 * THE DEFENCE. A fabricated requirement cannot quote words that exist in a
 * transcript it never read. So every finding must cite an utterance and quote
 * it, and the server checks that quote against the stored text before the
 * finding is ever shown. This is the same rule the rest of NowHelpAssist runs
 * on — `fluent.js` does not trust that a flow installed, it reads it back;
 * `write-verify.js` does not trust that a field was written, it checks. Here
 * the transcript is the instance and the quote is the read-back.
 *
 * WHY NOT FUZZY MATCHING. Because the strictness IS the value. A similarity
 * threshold lets a model that half-remembers the conversation produce a
 * citation that "nearly" matches, which is precisely the case this exists to
 * catch. Normalisation is limited to things that carry no meaning — case,
 * whitespace, and the punctuation Whisper adds or drops at random.
 */
import { getDb } from '../memory/db.js';

/**
 * Case, whitespace and punctuation carry no meaning here and vary run to run:
 * Whisper writes "cost centre," in one pass and "cost centre" in another, and
 * the model retyping a quote will not reproduce its commas. Everything else —
 * the words and their order — must match exactly.
 *
 * Curly quotes and dashes are folded because the model emits typographic
 * characters for the ASCII ones Whisper produces, which would otherwise fail a
 * citation that is word-for-word correct.
 */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    // Dashes become WHITESPACE, not hyphens. Folding an em-dash to "-" and
    // stopping there left "approval - before" unmatchable against "approval,
    // before" — a citation that was word-for-word correct. Whisper is also
    // inconsistent about hyphenating compounds ("sign-off" / "sign off"), and
    // treating both as a word break makes the two spellings agree.
    .replace(/[‐-―–—-]/g, ' ')
    .replace(/[.,!?;:"'`()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote has to be long enough to actually prove anything. */
export const MIN_QUOTE_WORDS = 3;

/**
 * Check one citation against the transcript.
 *
 * Returns a verdict rather than throwing: a failed citation is data the user
 * should see ("the model quoted something nobody said"), not an exception.
 */
export function verifyCitation(meetingId, citation, { segments } = {}) {
  const idx = Number(citation?.segment);
  const quote = String(citation?.quote || '');

  if (!Number.isInteger(idx)) {
    return { verified: false, reason: 'no utterance number was cited', seg_idx: idx, quote };
  }
  const nq = normalize(quote);
  if (!nq) {
    return { verified: false, reason: 'the citation carried no quote', seg_idx: idx, quote };
  }
  if (nq.split(' ').length < MIN_QUOTE_WORDS) {
    return {
      verified: false,
      reason: `the quote is shorter than ${MIN_QUOTE_WORDS} words, which proves nothing`,
      seg_idx: idx, quote,
    };
  }

  const rows = segments || getDb()
    .prepare('SELECT idx, text, stt_state, start_ms, end_ms FROM meeting_segments WHERE meeting = ?')
    .all(meetingId);
  const seg = rows.find((r) => r.idx === idx);

  if (!seg) {
    return { verified: false, reason: `utterance ${idx} does not exist in this meeting`, seg_idx: idx, quote };
  }
  /*
   * A discarded transcript may NOT be cited.
   *
   * This is the load-bearing half of the rule and it is easy to miss. Phase 2
   * keeps Whisper's own hallucinations out of the transcript by marking them
   * `empty` with a reason — but their audio and their index still exist. If a
   * citation could point at one, a fabricated requirement could be "supported"
   * by a sentence the model itself invented one stage earlier, and the whole
   * chain would look verified.
   */
  if (seg.stt_state !== 'done' || !seg.text) {
    return {
      verified: false,
      reason: seg.stt_state === 'failed'
        ? `utterance ${idx} failed transcription, so nothing in it can be quoted`
        : `utterance ${idx} has no confirmed transcript to quote`,
      seg_idx: idx, quote,
    };
  }

  if (!normalize(seg.text).includes(nq)) {
    return {
      verified: false,
      reason: `that quote does not appear in utterance ${idx}`,
      seg_idx: idx, quote,
    };
  }
  return {
    verified: true, reason: null, seg_idx: idx, quote,
    start_ms: seg.start_ms, end_ms: seg.end_ms,
  };
}

/**
 * Verify every citation on a finding.
 *
 * A finding with no VERIFIED citation is not evidence-backed, and the caller
 * must not present it as a requirement. It is still recorded, with its failed
 * citations and their reasons, because "the model claimed this and could not
 * back it up" is a fact worth being able to see — silently dropping it would
 * hide how often the model invents things, which is exactly the number a
 * person deciding whether to trust this feature needs.
 */
export function verifyFinding(meetingId, finding, opts = {}) {
  const citations = Array.isArray(finding?.evidence) ? finding.evidence : [];
  const checked = citations.map((c) => verifyCitation(meetingId, c, opts));
  return {
    evidence: checked,
    verified: checked.some((c) => c.verified),
    verifiedCount: checked.filter((c) => c.verified).length,
  };
}
