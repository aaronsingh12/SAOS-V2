// nowforge-spec: e2e-matrix-01
/*
 * E2E 01 — a record-triggered flow with a multi-clause AND condition.
 *
 * The condition is deliberately unsatisfiable (`number=E2E_NEVER_MATCHES`) so
 * that publishing this flow cannot make it act on a real incident. What is
 * under test is what the INSTALL creates, not what the flow does.
 *
 * ── REVISION 2 — the edit path ───────────────────────────────────────────────
 *
 * This file was changed after it had already been installed, to settle a
 * question the SDK's API cannot answer on its own: whether re-installing an
 * EDITED source updates the live flow in place or creates a second one.
 *
 * Three things changed, and each is a separate claim for the read-back:
 *   - the trigger condition gained a clause, on a trigger whose $id is unchanged
 *   - a second action was appended, with a freshly minted $id
 *   - the first action's message was rewritten, with its $id unchanged
 *
 * Every pre-existing `$id` is kept EXACTLY as it was. That is the whole
 * mechanism: `keys.ts` maps each key to one live record, so an unchanged key
 * updates that record and a new key creates one.
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['e2e01_flow'],
        name: 'E2E 01 Record Created',
        description: 'E2E matrix: record.created, multi-clause AND condition, one action. Revision 2 adds a step.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['e2e01_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1^assignment_groupISNOTEMPTY^number=E2E_NEVER_MATCHES^active=true',
            run_flow_in: 'background',
            run_on_extended: 'false',
        }
    ),
    () => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e01_log'] },
            {
                log_level: 'info',
                log_message: 'E2E 01 executed, revision 2.',
            }
        )

        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e01_log_second'] },
            {
                log_level: 'warn',
                log_message: 'E2E 01 second step, added by revision 2.',
            }
        )
    }
)
