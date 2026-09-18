import { table } from './client.js';
import { readInstanceState, writeInstanceState, boundHost, registerPostInstallHook, resolveManagedArtifact, activateManagedFlow } from './fluent.js';
import { flows } from './flows.js';
import { log } from '../logging.js';

/**
 * State the SDK model cannot express, re-applied after every deploy.
 *
 * ── THE DRIFT THIS EXISTS TO CLOSE ───────────────────────────────────────────
 *
 * `x_2002152_nwforge_emp_assets` was asked to be created INACTIVE. Fluent's
 * `Table()` has no `active` option — measured against the installed sdk-core,
 * whose Table options are extensible/audit/readOnly/textIndex/
 * allowWebServiceAccess/allowNewFields/allowUiActions/liveFeed/accessibleFrom
 * and nothing else. A table's active flag lives on its `sys_dictionary`
 * COLLECTION record (`sys_db_object` has no `active` column at all — checked),
 * so it can only be set over the Table API, after the install.
 *
 * That leaves it outside the SDK's model, and `now-sdk install` re-applies the
 * whole application from source on every deploy. So the flag was one unrelated
 * install away from silently flipping back to active — a change nobody made,
 * that nothing would report, discovered eventually by someone wondering why a
 * table they had retired was accepting records again.
 *
 * ── WHY A RECONCILER AND NOT A ONE-OFF ───────────────────────────────────────
 *
 * The one-off is what created the drift. The durable answer is to record the
 * INTENT — "this table is meant to be inactive on this instance" — and re-apply
 * it after every deploy, reading it back each time. The intent outlives the
 * install that would undo it, which is the only property that makes it durable.
 *
 * Intents are filed PER INSTANCE, for the same reason install state is (B5): an
 * intent recorded against dev428633 must be inert when bound to another host,
 * never replayed there. And every re-apply is READ BACK, because a write that
 * reports success is a claim — the M-1 lesson, and the reason a `sys_id` is
 * never treated as proof.
 *
 * The shape is deliberately open (`kind` + a target + a value) so the next
 * out-of-model state — a dictionary attribute, a `read_only` flag, a table
 * option Fluent never grew — is a new `APPLIERS` entry rather than a new
 * mechanism.
 */

/** `kind` -> how to read the current value, write it, and read it back. */
const APPLIERS = {
  /**
   * A table's active flag, on its sys_dictionary collection record.
   *
   * NOT on sys_db_object: measured, that table has no `active` column, so a
   * reconciler aimed there would write nothing and report success.
   */
  table_active: {
    describe: (i) => `${i.target}.active = ${i.value}`,
    async read(intent) {
      const rows = await table.query('sys_dictionary', {
        query: `name=${intent.target}^elementISEMPTY^internal_type=collection`,
        fields: 'sys_id,name,active', limit: 1, display: 'false',
      });
      if (!rows.length) return { found: false };
      return { found: true, sysId: rows[0].sys_id, current: rows[0].active === 'true' };
    },
    async write(intent, sysId) {
      await table.update('sys_dictionary', sysId, { active: intent.value ? 'true' : 'false' }, 'false');
    },
    async readBack(intent, sysId) {
      const rows = await table.query('sys_dictionary', {
        query: `sys_id=${sysId}`, fields: 'sys_id,active', limit: 1, display: 'false',
      });
      return rows.length ? rows[0].active === 'true' : null;
    },
  },

  /**
   * A flow is meant to be PUBLISHED on this instance.
   *
   * ── THE DRIFT ────────────────────────────────────────────────────────────
   *
   * `now-sdk install` re-applies the whole application from source, and a flow
   * written from source arrives as a DRAFT: `active=false, status=draft,
   * latest_snapshot=''`. Publishing is not part of the source model — it is an
   * act performed against the instance afterwards, through the platform's
   * activation processor. So every install silently un-publishes every flow
   * that had been published, including ones nobody touched: deploy an
   * unrelated subflow, and the flow that was live this morning is a draft that
   * will never run again, with nothing anywhere saying so.
   *
   * That is the same shape as the table-active drift above — state the SDK
   * model cannot express, undone by the next install — so it gets the same
   * answer rather than a second mechanism: record the intent, re-apply it
   * after every deploy, and READ IT BACK.
   *
   * ── WHAT IS AND IS NOT CLAIMED ───────────────────────────────────────────
   *
   * `current` is the four-way published proof (`flows.publishedProof`), never
   * `active` alone — an active header with no snapshot is not published, and
   * this reconciler must not report it as if it were. When that proof cannot
   * be read the state is UNKNOWN: reported as such, never written over on the
   * assumption that unknown means unpublished.
   *
   * The re-apply is `activateManagedFlow`, which is the one proven publish
   * path: resolve by name inside the bound scope, ask the platform's own
   * processor, and verify with the same four-way read. Nothing here writes to
   * `sys_hub_flow` directly — that door is closed on purpose (flows.js).
   *
   * Only `value: true` is reconcilable. There is no un-publish call, so an
   * intent to leave something a draft is an intent nothing could keep, and
   * `validate` refuses to record it rather than accepting a promise it cannot
   * honour.
   */
  flow_published: {
    describe: (i) => `"${i.target}" published`,
    validate(intent) {
      if (intent.value !== true) {
        throw Object.assign(new Error(
          'A flow_published intent can only be `true`. The platform offers an activation call and no un-publish call, '
          + 'so "this flow should stay a draft" is a promise this reconciler could not keep — and recording an intent '
          + 'nothing re-applies is worse than not recording it.',
        ), { status: 400 });
      }
    },
    async read(intent) {
      const found = await resolveManagedArtifact(intent.target);
      /* The artifact is gone, or its name is now ambiguous: nothing to re-apply,
       * and choosing between candidates is exactly what the resolver refuses. */
      if (!found.ok) return { found: false, note: found.message };
      const proof = await flows.publishedProof(found.sysId).catch((err) => ({ published: null, note: err.message }));
      return {
        found: true,
        sysId: found.sysId,
        current: proof.published === true,
        /* UNKNOWN is its own answer: neither published nor a reason to publish. */
        unknown: proof.published === null,
        note: proof.note ?? null,
      };
    },
    async write(intent) {
      const res = await activateManagedFlow(intent.target);
      if (!res.ok) throw new Error(res.message || `"${intent.target}" was not published (${res.stage ?? 'activate'}).`);
    },
    async readBack(intent, sysId) {
      const proof = await flows.publishedProof(sysId).catch(() => ({ published: null }));
      return proof.published === true ? true : proof.published;
    },
  },
};

const keyOf = (intent) => `${intent.kind}:${intent.target}`;

/** Every intent recorded for the currently bound instance. */
export function listIntendedStates(host = boundHost()) {
  const stored = readInstanceState(host)?.intendedState ?? {};
  return Object.values(stored);
}

/**
 * Record what a target is MEANT to be, so a later deploy cannot quietly undo it.
 *
 * Re-recording the same kind+target replaces it: the latest stated intent is
 * the intent, and keeping a history here would invite replaying a superseded one.
 */
export function recordIntendedState({ kind, target, value, why = null }, host = boundHost()) {
  if (!APPLIERS[kind]) {
    throw Object.assign(new Error(
      `"${kind}" is not a reconcilable state. Known: ${Object.keys(APPLIERS).join(', ')}. Add an APPLIERS entry `
      + 'naming how to read, write and read it back — an intent nothing can apply is a promise nothing keeps.'
    ), { status: 400 });
  }
  if (!host) throw Object.assign(new Error('No instance is bound, so an intent has nowhere to be filed.'), { status: 409 });
  if (!target) throw Object.assign(new Error(`A ${kind} intent needs a target.`), { status: 400 });
  /* A kind may refuse a value it could never re-apply. Refusing at RECORD time
   * is the point: an unkeepable intent discovered at reconcile time has already
   * been trusted for however many installs happened in between. */
  APPLIERS[kind].validate?.({ kind, target, value, why });

  const intent = { kind, target, value, why, recordedAt: new Date().toISOString(), instance: host };
  const stored = { ...(readInstanceState(host)?.intendedState ?? {}) };
  stored[keyOf(intent)] = intent;
  writeInstanceState(host, { intendedState: stored });
  log.info('reconcile', `intent recorded on ${host}: ${APPLIERS[kind].describe(intent)}${why ? ` — ${why}` : ''}`);
  return intent;
}

/** Drop an intent — the state is no longer wanted, so stop re-applying it. */
export function forgetIntendedState({ kind, target }, host = boundHost()) {
  const stored = { ...(readInstanceState(host)?.intendedState ?? {}) };
  const key = `${kind}:${target}`;
  if (!(key in stored)) return { forgotten: false, reason: 'no such intent' };
  delete stored[key];
  writeInstanceState(host, { intendedState: stored });
  return { forgotten: true, key };
}

/**
 * Re-apply every recorded intent, and read each one back.
 *
 * Never throws: this runs after a deploy that already succeeded, and turning a
 * good install into an exception because one flag could not be re-set would
 * lose the install's own result. Failures are REPORTED, loudly, and the caller
 * decides — the same reasoning that makes a red install a claim rather than a
 * verdict.
 */
export async function reconcilePostInstall({ emit = () => {}, host = boundHost() } = {}) {
  return reconcileIntents(listIntendedStates(host), { appliers: APPLIERS, emit, host });
}

/**
 * The reconciliation itself, with the appliers injected.
 *
 * Split from `reconcilePostInstall` so the outcome classification — the part
 * carrying the rules — is testable without an instance or a six-minute install.
 * The distinctions it draws are the whole value: `already-correct` is not
 * `re-applied`, `target-absent` is not a failure, and a write whose read-back
 * disagrees is `write-did-not-land` rather than a success.
 */
export async function reconcileIntents(intents, { appliers = APPLIERS, emit = () => {}, host = null } = {}) {
  if (!intents.length) return { ran: true, instance: host, applied: [], count: 0, reApplied: 0, failed: 0 };

  const applied = [];
  for (const intent of intents) {
    const applier = appliers[intent.kind];
    if (!applier) {
      applied.push({ ...intent, outcome: 'unknown-kind', ok: false });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const found = await applier.read(intent);
      if (!found.found) {
        // The target is gone. Not an error — a dropped table is a legitimate
        // reason for an intent to have nothing to act on — but it is reported
        // rather than silently skipped, so a stale intent is visible.
        applied.push({ kind: intent.kind, target: intent.target, outcome: 'target-absent', ok: true, note: 'nothing to re-apply' });
        continue;
      }
      if (found.unknown) {
        /*
         * The state could not be determined. Writing anyway would act on a
         * guess, and reporting ok would certify a state nobody read — so this
         * is a loud, named failure with the reason attached, and the caller
         * decides. (Same rule as publishedVerdict's `published: null`.)
         */
        applied.push({
          kind: intent.kind, target: intent.target, outcome: 'state-unknown', ok: false,
          note: found.note ?? 'the current state could not be read, so nothing was re-applied',
        });
        log.error('reconcile',
          `could not tell whether ${applier.describe(intent)} still holds: ${found.note ?? 'unreadable'}. `
          + 'Nothing was re-applied, and this is NOT a report that the state is correct.');
        continue;
      }
      if (found.current === intent.value) {
        applied.push({ kind: intent.kind, target: intent.target, outcome: 'already-correct', ok: true, value: intent.value });
        continue;
      }

      emit({ type: 'reconcile_applying', kind: intent.kind, target: intent.target, from: found.current, to: intent.value });
      // eslint-disable-next-line no-await-in-loop
      await applier.write(intent, found.sysId);
      // eslint-disable-next-line no-await-in-loop
      const after = await applier.readBack(intent, found.sysId);
      const ok = after === intent.value;
      applied.push({
        kind: intent.kind, target: intent.target, outcome: ok ? 're-applied' : 'write-did-not-land',
        ok, from: found.current, to: intent.value, readBack: after,
      });
      if (ok) {
        log.info('reconcile', `re-applied after install: ${applier.describe(intent)} (was ${found.current})`);
      } else {
        log.error('reconcile',
          `FAILED to re-apply ${applier.describe(intent)} — the write returned but the read-back says ${after}. `
          + 'The install has reverted this state and it is NOT what was asked for.');
      }
    } catch (err) {
      applied.push({ kind: intent.kind, target: intent.target, outcome: 'error', ok: false, error: err.message });
      log.error('reconcile', `could not re-apply ${intent.kind} on ${intent.target}: ${err.message}`);
    }
  }

  const failed = applied.filter((a) => !a.ok);
  const changed = applied.filter((a) => a.outcome === 're-applied');
  if (changed.length) {
    log.warn('reconcile',
      `the install reverted ${changed.length} out-of-model state(s); they were re-applied and read back: `
      + changed.map((c) => `${c.kind} ${c.target}`).join(', '));
  }
  emit({ type: 'reconcile_done', applied: applied.length, reApplied: changed.length, failed: failed.length });
  return {
    ran: true,
    instance: host,
    count: applied.length,
    reApplied: changed.length,
    failed: failed.length,
    applied,
    ...(failed.length ? { warning: 'Some intended states could not be restored after the install. They are NOT as asked.' } : {}),
  };
}

/*
 * Registered rather than called from fluent.js, so the dependency points one
 * way: this module knows about the installer, the installer does not know about
 * this module. Same shape as registerInstanceScopedCache.
 */
registerPostInstallHook(reconcilePostInstall);

export const POST_INSTALL_KINDS = Object.keys(APPLIERS);
