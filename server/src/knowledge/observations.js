import { getDb } from '../memory/db.js';
import { currentInstance } from '../memory/facts.js';

/**
 * K5 — what SNADA has verified for itself.
 *
 * SEPARATE FROM TWO THINGS IT LOOKS LIKE, deliberately.
 *
 * Not the documentation corpus (kb_documents): that is what ServiceNow says.
 * This is what happened when we tried it. When they disagree the whole point of
 * knowledge/precedence.js is that these two rank differently, and they cannot
 * rank differently if they live in one table.
 *
 * Not the instance fact ledger (memory/facts.js): that is per-instance
 * knowledge injected into every system prompt — traps, field mappings, user
 * preferences, decisions — and it is deliberately small enough to send in full
 * on every turn. This store answers a different question ("has this SDK feature
 * ever worked?", "what broke last time we tried this?"), grows without bound,
 * is queried rather than broadcast, and carries an evidence artifact per row
 * that the ledger has no column for.
 *
 * THE ONE RULE. Only VERIFIED observations. Every row must name what made it
 * true and carry the artifact — the error text, the read-back, the compiler
 * output. `recordObservation` refuses a write without one, because an
 * observation with no evidence is an LLM output that has been given a database
 * row and, from that moment on, is indistinguishable from something measured.
 * That is the exact failure this store exists to prevent, so the refusal is
 * structural rather than advisory.
 */

/**
 * The kinds of thing worth remembering, closed so a typo becomes an error
 * rather than a category nobody ever queries again.
 */
export const OBSERVATION_CATEGORIES = Object.freeze([
  'sdk-limitation',         // the installed SDK cannot do a documented thing
  'implementation-success', // this approach worked, and here is the proof
  'implementation-failure', // this approach did not, and here is why
  'version-behaviour',      // behaviour specific to a platform release
  'tooling-defect',         // a defect in SNADA's own tools or a dependency
]);

/**
 * What counts as evidence.
 *
 * Every one of these is an ARTIFACT that existed independently of the model's
 * account of it. "The model concluded X" is not on the list and never will be:
 * that is the input this store filters, not a kind of proof.
 */
export const EVIDENCE_KINDS = Object.freeze([
  'read-back',      // the record as the instance returned it after a write
  'tool-result',    // a tool's own structured result
  'instance-query',  // a direct query against the instance
  'compile-output', // SDK/compiler stdout or stderr
  'http-error',     // an upstream status and body
  'test-run',       // a test in this repo that passes or fails on it
]);

/** Universal scope: a property of the SDK or the platform, not of one PDI. */
export const UNIVERSAL = '*';

const isBlank = (v) => typeof v !== 'string' || !v.trim();
const now = () => new Date().toISOString();

/**
 * Record a verified observation.
 *
 * Re-observing an identical observation CONFIRMS it — `confirmations` goes up
 * and `confirmed_at` moves — rather than creating a near-duplicate row. Two
 * independent confirmations of an SDK limitation is a materially stronger claim
 * than one, and it is the kind of thing that should be visible in the store
 * rather than inferable from counting rows.
 *
 * @param {{
 *   category: string, subject: string, observation: string,
 *   evidenceKind: string, evidence: string,
 *   instance?: string, platformVersion?: string, toolEvent?: number
 * }} input
 * @returns {{ ok: boolean, errors?: string[], id?: number, status?: string, confirmations?: number }}
 */
export function recordObservation(input = {}) {
  const errors = [];
  const {
    category, subject, observation, evidenceKind, evidence,
    instance, platformVersion, toolEvent,
  } = input;

  if (!OBSERVATION_CATEGORIES.includes(category)) {
    errors.push(`category must be one of: ${OBSERVATION_CATEGORIES.join(', ')}`);
  }
  if (isBlank(subject)) errors.push('subject is required — the tool, table, SDK feature or API this is about');
  if (isBlank(observation)) errors.push('observation is required — what was observed, in one sentence');

  // The verification gate. Both halves are required: naming a kind of evidence
  // without producing any is the shape an unverified claim takes when someone
  // knows a field is checked.
  if (!EVIDENCE_KINDS.includes(evidenceKind)) {
    errors.push(
      `evidence_kind must be one of: ${EVIDENCE_KINDS.join(', ')}. `
      + 'Only VERIFIED observations belong in this store — a conclusion with no artifact behind it is not one.'
    );
  }
  if (isBlank(evidence)) {
    errors.push(
      'evidence is required: the artifact itself — the error text, the read-back, the compiler output. '
      + 'An observation with no evidence is an LLM output with a database row.'
    );
  }

  if (errors.length) return { ok: false, errors };

  const db = getDb();
  const scope = isBlank(instance) ? currentInstance() : instance.trim();
  const ts = now();

  const existing = db
    .prepare(
      `SELECT id, confirmations FROM snada_observations
        WHERE category = ? AND subject = ? AND instance = ? AND observation = ?`
    )
    .get(category, subject.trim(), scope, observation.trim());

  if (existing) {
    db.prepare(
      `UPDATE snada_observations
          SET confirmations = confirmations + 1, confirmed_at = ?,
              evidence_kind = ?, evidence = ?,
              platform_version = COALESCE(?, platform_version),
              tool_event = COALESCE(?, tool_event)
        WHERE id = ?`
    ).run(ts, evidenceKind, evidence, platformVersion || null, toolEvent ?? null, existing.id);
    return { ok: true, id: existing.id, status: 'confirmed', confirmations: existing.confirmations + 1 };
  }

  const res = db
    .prepare(
      `INSERT INTO snada_observations
         (category, subject, observation, evidence_kind, evidence, instance,
          platform_version, tool_event, observed_at, confirmed_at, confirmations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      category, subject.trim(), observation.trim(), evidenceKind, evidence,
      scope, platformVersion || null, toolEvent ?? null, ts, ts,
    );

  return { ok: true, id: Number(res.lastInsertRowid), status: 'recorded', confirmations: 1 };
}

/**
 * Read observations.
 *
 * SCOPE IS THE LOAD-BEARING PART, and it is the same rule the fact ledger
 * learned the hard way: a universal observation applies everywhere, and one
 * measured on a specific PDI applies to THAT PDI. A limitation measured on one
 * instance, replayed confidently on another, is a confidently wrong answer —
 * and the second instance may well not have the problem.
 */
export function listObservations({ category, subject, instance, includeUniversal = true, limit = 50 } = {}) {
  const db = getDb();
  const where = [];
  const args = [];

  if (category) { where.push('category = ?'); args.push(category); }
  if (subject) { where.push('subject LIKE ?'); args.push(`%${subject}%`); }

  const scope = instance || currentInstance();
  if (includeUniversal) { where.push('(instance = ? OR instance = ?)'); args.push(scope, UNIVERSAL); }
  else { where.push('instance = ?'); args.push(scope); }

  const sql = `
    SELECT id, category, subject, observation, evidence_kind, evidence, instance,
           platform_version, tool_event, observed_at, confirmed_at, confirmations
      FROM snada_observations
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY confirmations DESC, confirmed_at DESC
     LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

/**
 * What SNADA knows about one subject, as a claim the precedence ladder can take.
 *
 * Deliberately tagged `tool_capability`: these are measurements of what the
 * tools and the SDK actually do, which is rung 2. That is what lets a recorded
 * SDK limitation OVERRULE a documentation page claiming the feature exists —
 * the spec's own conflict example, resolved by data rather than by a rule
 * written into a prompt.
 *
 * Only sdk-limitation and tooling-defect map to that rung. An
 * implementation-success is a record of one build working, not a general
 * capability claim, and promoting it would let "it worked once" outrank the
 * documentation for every future case.
 */
export function capabilityClaimsFor(subject, { instance } = {}) {
  const rows = listObservations({ subject, instance, limit: 20 });
  return rows
    .filter((r) => r.category === 'sdk-limitation' || r.category === 'tooling-defect')
    .map((r) => ({
      source: 'tool_capability',
      says: r.observation,
      evidence: r.evidence,
      ref: `observation #${r.id} (${r.evidence_kind}, confirmed ${r.confirmations}x)`,
    }));
}

export function deleteObservation(id) {
  return getDb().prepare('DELETE FROM snada_observations WHERE id = ?').run(id).changes;
}

export function observationStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS n FROM snada_observations').get().n;
  const byCategory = db
    .prepare('SELECT category, COUNT(*) AS n FROM snada_observations GROUP BY category ORDER BY n DESC')
    .all();
  return { total, byCategory };
}
