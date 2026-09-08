/**
 * PHASE 18 — WHERE A "BEFORE" IS ALLOWED TO COME FROM.
 *
 * §3 needs two states with authoritative provenance and §63.1 makes inventing a
 * baseline a release blocker. Both come down to one property, and it is the
 * property this file exists to guarantee: EVERY BASELINE THIS BUILD WILL USE
 * CAN BE READ AGAIN. Not remembered, not described, not reconstructed — read,
 * from a place that has a name, by a caller who did not write it.
 *
 * That is why there is no `fromDescription`, no `fromModel` and no
 * `fromConversation` below, and why adding one would be a change to this
 * comment as much as to the code.
 *
 * ═══ WHAT THIS INSTANCE ACTUALLY OFFERS, MEASURED ═══
 *
 * `sys_hub_flow_snapshot` is the real find. Flow Designer writes a copy of a
 * flow when it is published, and that copy is not a summary — it has its OWN
 * action and trigger instances, which carry the snapshot's sys_id in their
 * `flow` column exactly as the live flow's components carry its. So the same
 * reader answers both, and the two are genuinely two states of one artifact.
 *
 * On dev424910: 331 snapshots across 324 flows, and comparing forty live/
 * snapshot pairs found forty identical ones — which is exactly what a
 * development instance nobody edits should look like, and makes them the
 * perfect control for §43's false-positive tests.
 *
 * What this instance does NOT offer, and it is recorded rather than worked
 * around: `sys_update_version` holds no rows for any flow artifact at all, so
 * ServiceNow's ordinary version history is not a source here. That was checked
 * three ways — by name prefix, by a LIKE over the whole column, and by type —
 * and is a fact about the instance rather than an assumption about the API.
 */
import { SOURCES, STOPS } from './schemas.js';
import { normalizeFlow, hashArtifact, versionIdOf } from './normalize.js';

/**
 * Read one state of a flow and normalise it, keeping where it came from.
 *
 * @param sysId     the row to read — a flow OR a snapshot
 * @param source    a member of SOURCES, stated by the caller that chose it
 * @param readArtifact  injected `readFlowArtifact`
 *
 * `provenance` travels with the state for the rest of the run and is what §56's
 * audit reconstructs from. It is never derived from the content: a caller that
 * read a snapshot says so, and nothing downstream second-guesses it.
 */
export async function readState({ sysId, source, readArtifact, version = null, at = null }) {
  if (!SOURCE_IS_REAL(source)) {
    throw new Error(`"${source}" is not a baseline source this build has. A state must come from somewhere it can be read again.`);
  }
  let artifact = null;
  let error = null;
  try {
    artifact = await readArtifact(sysId);
  } catch (err) {
    error = err.message;
  }
  if (!artifact) {
    return {
      ok: false, source, sys_id: sysId,
      note: error ?? `Nothing could be read at ${sysId}.`,
    };
  }

  const normalized = normalizeFlow(artifact, { source, sys_id: sysId, read_at: at });
  const hash = hashArtifact(normalized);
  return {
    ok: true,
    source,
    sys_id: sysId,
    normalized,
    hash,
    version: versionIdOf(normalized, { version }),
    complete: normalized.complete,
    gaps: normalized.gaps,
    raw: artifact,
  };
}

const SOURCE_IS_REAL = (s) => Object.values(SOURCES).includes(s);

/**
 * Find the baseline for a flow.
 *
 * Sources are tried in descending order of how well they answer "the previous
 * version of THIS artifact":
 *
 *   1. an explicit sys_id the caller gave      — they said which
 *   2. the flow's own published snapshot       — the platform's own answer
 *   3. a captured artifact stored earlier      — this build's own answer
 *
 * And then it STOPS. §4 is explicit that where no trustworthy baseline exists
 * the answer is NO_BASELINE, and §63.1 makes anything else a blocker. There is
 * deliberately no fourth branch that reconstructs one.
 *
 * @param findSnapshot  injected: (flowSysId) => [{ sys_id, version, created_on }]
 * @param captured      injected: (flowSysId) => a stored normalised state, or null
 */
export async function findBaseline({
  flowSysId, explicitSysId = null, findSnapshot = null, captured = null, readArtifact,
}) {
  if (explicitSysId) {
    /*
     * A sys_id the caller named is READ OFF THE INSTANCE, so it is LIVE — the
     * row happens to be a snapshot or a flow, and either way this build did not
     * capture it. Labelling it CAPTURED_ARTIFACT was a provenance lie found by
     * review: §36 exists so a reader can tell where a state came from, and a
     * source that names the wrong origin defeats it.
     */
    const state = await readState({ sysId: explicitSysId, source: SOURCES.LIVE, readArtifact });
    if (!state.ok) {
      return { ok: false, reason: STOPS.BASELINE_UNREADABLE, note: `The baseline named as ${explicitSysId} could not be read: ${state.note}` };
    }
    return { ok: true, state, chosen: 'explicit' };
  }

  if (typeof findSnapshot === 'function') {
    let snapshots = [];
    try {
      snapshots = await findSnapshot(flowSysId);
    } catch (err) {
      return { ok: false, reason: STOPS.BASELINE_UNREADABLE, note: `The published versions of this flow could not be listed: ${err.message}` };
    }
    if (snapshots.length) {
      /* The most recent published copy is "the previous version". Ordering is
       * the caller's — it read the rows — and the newest is taken from the
       * front, so a caller that ordered them differently gets what it asked
       * for rather than a silent re-sort. */
      const pick = snapshots[0];
      const state = await readState({
        sysId: pick.sys_id, source: SOURCES.PUBLISHED_SNAPSHOT, readArtifact,
        version: pick.version, at: pick.created_on,
      });
      if (state.ok) {
        return {
          ok: true, state, chosen: 'published_snapshot',
          alternatives: snapshots.slice(1).map((s) => ({ sys_id: s.sys_id, version: s.version, created_on: s.created_on })),
        };
      }
      return { ok: false, reason: STOPS.BASELINE_UNREADABLE, note: `The published version ${pick.sys_id} could not be read: ${state.note}` };
    }
  }

  if (typeof captured === 'function') {
    const stored = await captured(flowSysId);
    if (stored) return { ok: true, state: stored, chosen: 'captured' };
  }

  return {
    ok: false,
    reason: STOPS.NO_BASELINE,
    note: 'There is no earlier state of this flow to compare against. ServiceNow has no published '
      + 'snapshot of it and this build has captured none, so there is nothing that could serve as a '
      + '"before" — and one will not be reconstructed from anything else.',
  };
}

/* ------------------------------------------------------------------ *
 * §35 / §36 — capturing a baseline is a deliberate act
 * ------------------------------------------------------------------ */

/**
 * Turn a state into a baseline record worth storing.
 *
 * §36 lists what it must identify — source, artifact, hash, captured_at,
 * provenance — and all five are here. §35 says a baseline is never replaced
 * automatically, which is a property of the CALLER rather than of this
 * function: nothing here writes anything, and the only way one is stored is a
 * caller deciding to.
 *
 * `by` records who asked. It is not decoration: a baseline is a claim about
 * what the world looked like, and a claim needs someone standing behind it.
 */
export function captureBaseline(state, { at, by = null, note = null }) {
  if (!state?.ok) throw new Error('A baseline can only be captured from a state that was read.');
  if (!at) throw new Error('A baseline must record when it was captured.');
  return {
    artifact: {
      type: state.normalized.artifact.type,
      sys_id: state.normalized.artifact.sys_id,
      name: state.normalized.artifact.name,
    },
    source: state.source,
    read_from_sys_id: state.sys_id,
    hash: state.hash,
    version: state.version,
    captured_at: at,
    captured_by: by,
    complete: state.complete,
    gaps: state.gaps,
    note,
    /* The normalised content itself, so the baseline can be compared later
     * without the artifact still existing. This is what makes a captured
     * baseline a real source rather than a pointer to one. */
    normalized: state.normalized,
  };
}

/** A stored baseline, back in the shape `readState` returns. */
export function restoreBaseline(record) {
  if (!record?.normalized) return null;
  return {
    ok: true,
    source: record.source ?? SOURCES.CAPTURED_ARTIFACT,
    sys_id: record.read_from_sys_id ?? record.artifact?.sys_id ?? null,
    normalized: record.normalized,
    /* Recomputed rather than trusted. A stored hash that disagrees with the
     * stored content is a corrupted record, and recomputing is how it surfaces
     * instead of being believed. */
    hash: hashArtifact(record.normalized),
    stored_hash: record.hash ?? null,
    version: record.version ?? null,
    complete: record.complete !== false,
    gaps: record.gaps ?? [],
    captured_at: record.captured_at ?? null,
  };
}

/**
 * Does a restored baseline still say what it said when it was stored?
 *
 * A stored hash and a recomputed one that disagree mean the record was edited
 * after capture — by a migration, by a hand, by anything. §36 forbids the model
 * rewriting baseline state, and this is how a rewrite is DETECTED rather than
 * merely prohibited.
 */
export function baselineIsIntact(restored) {
  if (!restored?.stored_hash) return { ok: true, note: 'This baseline was stored without a hash, so nothing can be re-checked.' };
  const ok = restored.stored_hash === restored.hash;
  return {
    ok,
    note: ok ? null
      : `This baseline no longer hashes to what it did when it was captured (${restored.stored_hash.slice(0, 12)} → ${restored.hash.slice(0, 12)}). `
        + 'Its content changed after capture, so it is not evidence about the past.',
  };
}
