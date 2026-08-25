/**
 * B4 / D3 — task-boundary continuity.
 *
 * THE FAILURE THIS PREVENTS. Impersonation is started for a reason — "check
 * what Aagamya can see on the Laptop Request item". Three turns later the user
 * types something else. Nothing on the instance objects, nothing in the
 * transcript changes colour, and the new request quietly executes carrying
 * someone else's authority. Phase 0 measured that every impersonated action is
 * attributed solely to the impersonated user and the instance keeps no record
 * of the real initiator, so this is not a cosmetic problem: it is how a person
 * ends up named in an audit trail for work they never asked for.
 *
 * THE ASYMMETRY THAT MAKES A DETERMINISTIC CLASSIFIER SUFFICIENT.
 * Only one verdict is dangerous to get wrong. `clearly_continuing` proceeds
 * silently; everything else stops and asks. So `clearly_continuing` REQUIRES
 * POSITIVE EVIDENCE, and every uncertain case falls to the safe side by
 * construction rather than by tuning. Confusing `clearly_new` with `ambiguous`
 * changes only the wording of the question.
 *
 * That is also why there is no model call here. The only available backend is
 * non-deterministic, ignores `seed`, has a weekly cap that has already
 * exhausted mid-run, and can return HTTP 200 with a repetition loop. A guard
 * whose safe default depended on it would be a guard that stops guarding on the
 * day the cap runs out. The same reasoning already governs `plan-check` and the
 * question guards in the orchestrator: derive it in code, or ask the human.
 */

export const BOUNDARY = {
  CONTINUING: 'clearly_continuing',
  NEW: 'clearly_new',
  AMBIGUOUS: 'ambiguous',
  IDENTITY_COMMAND: 'identity_command',
};

/**
 * Anything that names impersonation itself. The user is talking ABOUT the
 * identity, not acting under it, so the tools' own gates decide — asking "are
 * you sure you want to continue as X?" when they just said "stop impersonating"
 * would be the guard arguing with a plain instruction.
 */
const IDENTITY_COMMAND = /\b(impersonat\w*|stop pretending|as yourself|be yourself|back to (admin|yourself|your own)|drop the impersonation)\b/i;

/**
 * Explicit topic-change markers. A person announcing a new subject is the
 * clearest signal available, and it outranks any lexical overlap that follows.
 */
const NEW_TASK_MARKER = /\b(unrelated|different (thing|question|topic|task|matter)|new (task|topic|question|subject)|another (thing|task|question)|change of subject|by the way|on another note|separately|forget (that|it)|never mind that|switching topics?|moving on)\b/i;

/**
 * Destructive intent. A read-only task descriptor does not authorise a delete
 * just because the words overlap, so a destructive verb the task never
 * mentioned can never reach `clearly_continuing`.
 */
const DESTRUCTIVE = /\b(delete|remove|deactivate|disable|drop|purge|wipe|destroy|revoke|deprovision|terminate)\b/i;

const AFFIRMATIVE = /^\s*(y|yes|yep|yeah|yup|sure|ok|okay|please do|go ahead|proceed|continue|carry on|keep going|stay|do it|correct|confirmed?)\b/i;
const AFFIRMATIVE_PHRASE = /\b(continue as|stay as|keep (impersonating|going as)|yes,? continue|remain as)\b/i;
const NEGATIVE = /^\s*(n|no|nope|nah|stop|end|cancel|don'?t|do not)\b/i;
const NEGATIVE_PHRASE = /\b(end (the )?impersonation|stop impersonating|as (myself|yourself)|back to (admin|yourself))\b/i;

/**
 * Words carrying no topic information. Overlap on "the" is not evidence of
 * anything, and without this list a long enough sentence always "continues".
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'there',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
  'its', 'our', 'their', 'mine', 'yours', 'ours', 'theirs', 'who', 'whom', 'whose', 'what', 'which',
  'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'too', 'very', 'just', 'now', 'also', 'still',
  'for', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'from', 'up', 'down', 'out', 'off', 'over', 'under',
  'again', 'further', 'once', 'here', 'as', 'because', 'until', 'while', 'please', 'thanks', 'thank',
  'let', 'lets', 'get', 'got', 'see', 'show', 'tell', 'give', 'make', 'want', 'need', 'like', 'try',
]);

/** Significant tokens: lowercase words of 3+ characters that carry topic. */
export function significantTokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_.\s-]/g, ' ')
      .split(/[\s-]+/)
      .map((w) => w.replace(/^[._]+|[._]+$/g, ''))
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

const intersect = (a, b) => [...a].filter((x) => b.has(x));

/**
 * Every token that is just the target's name.
 *
 * Split on dots and underscores as well as spaces, because `aagamya.tanwar` and
 * `Aagamya Tanwar` have to reduce to the same parts — the descriptor writes it
 * one way and the account the other.
 */
function targetNameTokens(target) {
  const out = new Set();
  if (!target) return out;
  for (const raw of [target.user_name, target.display]) {
    if (!raw) continue;
    const s = String(raw).toLowerCase();
    out.add(s);
    for (const part of s.split(/[.\s_-]+/)) if (part.length >= 3) out.add(part);
  }
  return out;
}

/** Does the text name the person being impersonated? */
function mentionsTarget(text, target) {
  if (!target) return false;
  const hay = String(text ?? '').toLowerCase();
  const names = [target.user_name, target.display].filter(Boolean).map((s) => String(s).toLowerCase());
  for (const n of names) {
    if (!n) continue;
    if (hay.includes(n)) return true;
    // "aagamya.tanwar" should also match "Aagamya" on its own.
    for (const part of n.split(/[.\s_]+/)) if (part.length >= 3 && hay.includes(part)) return true;
  }
  return false;
}

/**
 * Classify a new user turn against the task impersonation was started for.
 *
 * Returns the verdict plus the evidence behind it, because a guard that stops a
 * turn has to be able to say why — and because "which words made this look like
 * a continuation" is the first question anyone debugging it will ask.
 */
export function classifyTaskBoundary({ task, userText, target = null } = {}) {
  const text = String(userText ?? '').trim();
  const evidence = { overlap: [], novel: [], mentionsTarget: false, destructive: false };

  if (!text) return { verdict: BOUNDARY.AMBIGUOUS, reason: 'empty-request', evidence };

  // 1. Talking about the identity itself — the tools decide, not this.
  if (IDENTITY_COMMAND.test(text)) {
    return { verdict: BOUNDARY.IDENTITY_COMMAND, reason: 'names-impersonation-explicitly', evidence };
  }

  // No task descriptor means nothing to compare against. Ask rather than guess.
  if (!String(task ?? '').trim()) {
    return { verdict: BOUNDARY.AMBIGUOUS, reason: 'no-task-descriptor', evidence };
  }

  const taskTokens = significantTokens(task);
  const userTokens = significantTokens(text);
  const overlap = intersect(userTokens, taskTokens);
  const novel = [...userTokens].filter((t) => !taskTokens.has(t));
  const onTarget = mentionsTarget(text, target);
  const destructive = DESTRUCTIVE.test(text) && !DESTRUCTIVE.test(String(task));

  Object.assign(evidence, { overlap, novel, mentionsTarget: onTarget, destructive });

  // 2. An announced topic change outranks everything below it.
  if (NEW_TASK_MARKER.test(text)) {
    return { verdict: BOUNDARY.NEW, reason: 'explicit-topic-change', evidence };
  }

  // 3. THE FENCE. A destructive verb the task never mentioned can never be a
  //    silent continuation, however much the vocabulary overlaps. "Delete
  //    Aagamya's account" shares every content word with a task about Aagamya.
  if (destructive) {
    return { verdict: BOUNDARY.AMBIGUOUS, reason: 'destructive-verb-outside-task', evidence };
  }

  // 4. Introduces nothing the task did not already contain — it cannot be about
  //    something else, because it named nothing else. ("What about the others?")
  if (novel.length === 0) {
    return { verdict: BOUNDARY.CONTINUING, reason: 'introduces-nothing-new', evidence };
  }

  // 5. Positive evidence: two INDEPENDENT points of contact with the task.
  //
  //    The target's name is discounted from the overlap before scoring. A task
  //    descriptor almost always names the person being impersonated, so without
  //    this the name counts twice — once as shared vocabulary and once as the
  //    target mention — and "what is Aagamya's home phone number" scores 2
  //    against a task about Aagamya's catalog visibility. Measured while
  //    building this: it read as `clearly_continuing`, which is exactly the
  //    verdict that proceeds without asking.
  const targetTokens = targetNameTokens(target);
  const independentOverlap = overlap.filter((t) => !targetTokens.has(t));
  evidence.independentOverlap = independentOverlap;

  const score = independentOverlap.length + (onTarget ? 1 : 0);
  if (score >= 2) {
    return { verdict: BOUNDARY.CONTINUING, reason: 'shares-task-vocabulary', evidence };
  }

  // 6. Nothing in common, and it brought its own subject.
  if (independentOverlap.length === 0 && !onTarget && novel.length >= 2) {
    return { verdict: BOUNDARY.NEW, reason: 'no-contact-with-task', evidence };
  }

  return { verdict: BOUNDARY.AMBIGUOUS, reason: 'insufficient-evidence-to-continue', evidence };
}

/** Did the user just say yes to a pending boundary question? */
export function isAffirmative(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (NEGATIVE.test(t) || NEGATIVE_PHRASE.test(t)) return false;
  return AFFIRMATIVE.test(t) || AFFIRMATIVE_PHRASE.test(t);
}

/** Did they say no — or ask to stop? */
export function isNegative(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return NEGATIVE.test(t) || NEGATIVE_PHRASE.test(t);
}

const clip = (s, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The question itself.
 *
 * Names the target, the task it was started for, and what the new request looks
 * like — the three facts a person needs to answer without scrolling back. It
 * offers exactly two ways forward and does not pick one.
 */
export function boundaryQuestion({ target, task, userText, verdict }) {
  const who = target?.user_name ?? 'another user';
  const looks = verdict === BOUNDARY.NEW
    ? 'That looks like a different task.'
    : 'I cannot tell whether that is part of the same task.';
  return [
    `You are impersonating \`${who}\` for: **${clip(task)}**.`,
    '',
    `${looks} You asked: "${clip(userText)}"`,
    '',
    `Do you want me to continue as \`${who}\`, or end impersonation first and run this as NowHelpAssist?`,
    '',
    `Anything I do while impersonating is recorded on the instance as \`${who}\`'s work — the instance keeps no `
    + 'record of who really asked — so I would rather check than assume.',
  ].join('\n');
}
