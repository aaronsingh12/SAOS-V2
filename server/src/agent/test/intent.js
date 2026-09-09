/**
 * PHASE 17 — WHAT WAS ASKED, AND WHETHER THIS BUILD MAY DO IT.
 *
 * Two questions, and the second is the one with teeth.
 *
 * WHICH FLOW is answered by reusing Phase 16's resolver unchanged. §8 asks for
 * exact sys_id, exact name, or an unambiguous lookup, with an ambiguous result
 * BLOCKED and no model choosing between candidates — which is precisely what
 * `resolveFlowForRequest` already does, measured at 20/20 over ten request
 * shapes. Writing a second one would be writing a second thing to be wrong.
 *
 * WHICH MODE is answered here, and the answer is deliberately narrow. §3
 * describes a Mode B where a user names an existing record to test against, and
 * then says the mutation rules still apply and that Phase 17 may reject the
 * mode outright. It is rejected. The reason is not caution for its own sake:
 * "test this against INC0010038" is a sentence a person types when they want to
 * see what the flow WOULD do, and the only way to show them is to change that
 * incident — a real record, belonging to someone, that this run does not own
 * and cannot clean up. §18's ownership rule and Mode B are incompatible, and
 * the honest resolution is to say so and offer the disposable fixture instead.
 */
import { resolveFlowForRequest } from '../lint/intent.js';
import { BLOCKS, MODES } from './schemas.js';

/**
 * A record the user named, which would make this Mode B.
 *
 * Two shapes, both unambiguous: a ServiceNow record number (two to five capital
 * letters then seven or more digits — INC0010038, CHG0000014) and a bare
 * sys_id. A phrase like "the existing incident" is deliberately NOT matched:
 * it names no record, so it cannot be Mode B, and treating it as such would
 * refuse an ordinary request for a reason the user could not act on.
 */
const RECORD_NUMBER = /\b([A-Z]{2,5}\d{7,})\b/;
const BARE_SYS_ID = /\b([0-9a-f]{32})\b/i;

/** Wording that asks for the test to run against something that already exists. */
const AGAINST = /\b(against|on|using|with|for)\s+(the\s+)?(existing|production|real|live)?\s*(incident|record|change|request|ticket|task)\b/i;

export function detectUserFixture(request) {
  const text = String(request ?? '');
  const number = RECORD_NUMBER.exec(text);
  if (number) return { mode: MODES.USER_FIXTURE, record: number[1], by: 'record_number' };

  /*
   * A bare sys_id in a test request is ambiguous: it might name the FLOW. So it
   * only reads as a user fixture when the sentence also says the test should
   * run against a record.
   */
  const sysId = BARE_SYS_ID.exec(text);
  if (sysId && AGAINST.test(text)) {
    return { mode: MODES.USER_FIXTURE, record: sysId[1].toLowerCase(), by: 'sys_id_against' };
  }
  if (AGAINST.test(text) && /\b(existing|production|real|live)\b/i.test(text)) {
    return { mode: MODES.USER_FIXTURE, record: null, by: 'phrase' };
  }
  return { mode: MODES.DISPOSABLE, record: null, by: 'default' };
}

/**
 * The refusal Mode B gets, written to be actionable rather than merely negative.
 */
export function userFixtureRefusal(detected) {
  const named = detected.record ? ` ${detected.record}` : '';
  return {
    block: BLOCKS.USER_FIXTURE_MODE,
    note: `This build tests a flow by creating a disposable record it owns and deletes. It will not run a test `
      + `against${named || ' an existing record'}, because proving what the flow does means CHANGING that record — `
      + 'and a record this run did not create is one it must not modify and cannot clean up. '
      + 'Ask for the test without naming a record and a disposable fixture will be created instead.',
  };
}

/**
 * Read a test request.
 *
 * @returns {{ ok, mode, found, flow_name, by, detected, block, note }}
 *
 * `found` is `resolveFlowForRequest`'s own answer, unmodified, so an ambiguous
 * name arrives here carrying its candidate list and stops (§8).
 */
export async function readTestIntent({ request, find, chat = null, signal = null, sys_id: sysId = null } = {}) {
  const detected = detectUserFixture(request);
  if (detected.mode === MODES.USER_FIXTURE) {
    const refusal = userFixtureRefusal(detected);
    return {
      ok: false, mode: detected.mode, detected, found: null, flow_name: null, by: 'deterministic',
      block: refusal.block, note: refusal.note,
    };
  }

  if (sysId) {
    const found = await find({ sys_id: sysId });
    return {
      ok: found.ok, mode: MODES.DISPOSABLE, detected, found,
      flow_name: found.name ?? null, by: 'sys_id',
      block: found.ok ? null : blockFor(found.reason), note: found.ok ? null : found.note,
    };
  }

  const resolved = await resolveFlowForRequest({ request, find, chat, signal });
  return {
    ok: resolved.found.ok,
    mode: MODES.DISPOSABLE,
    detected,
    found: resolved.found,
    flow_name: resolved.flow_name,
    by: resolved.by,
    block: resolved.found.ok ? null : blockFor(resolved.found.reason),
    note: resolved.found.ok ? null : resolved.found.note,
  };
}

function blockFor(reason) {
  if (reason === 'ambiguous') return BLOCKS.FLOW_AMBIGUOUS;
  return BLOCKS.FLOW_NOT_IDENTIFIED;
}
