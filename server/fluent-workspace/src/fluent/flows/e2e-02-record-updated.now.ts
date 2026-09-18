// nowforge-spec: e2e-matrix-02
/*
 * E2E 02 — every KIND of trigger condition the question asks about, in one
 * encoded query, on an `updated` trigger with an explicit strategy.
 *
 *   priority=1            choice field, compared by stored VALUE
 *   ^OR priority=2        an OR join
 *   ^ stateCHANGES        a change operator (no right-hand side)
 *   ^ active=true         a boolean
 *   ^ assigned_toISNOTEMPTY   a reference field
 *   ^ opened_atISNOTEMPTY     a date/time field
 *   ^ number=E2E_NEVER_MATCHES  makes the whole thing unsatisfiable, on purpose
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['e2e02_flow'],
        name: 'E2E 02 Record Updated',
        description: 'E2E matrix: record.updated, OR + CHANGES + choice + boolean + reference + date condition, trigger_strategy, run_on_extended.',
        runAs: 'system',
        flowPriority: 'HIGH',
    },
    wfa.trigger(
        trigger.record.updated,
        { $id: Now.ID['e2e02_trigger'] },
        {
            table: 'incident',
            condition:
                'priority=1^ORpriority=2^stateCHANGES^active=true^assigned_toISNOTEMPTY^opened_atISNOTEMPTY^number=E2E_NEVER_MATCHES',
            run_flow_in: 'background',
            run_on_extended: 'true',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e02_log'] },
            {
                log_level: 'info',
                log_message: `E2E 02 saw ${wfa.dataPill(params.trigger.current.number, 'string')}`,
            }
        )
    }
)
