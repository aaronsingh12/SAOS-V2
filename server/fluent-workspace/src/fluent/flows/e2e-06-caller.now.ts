// nowforge-spec: e2e-matrix-06
/*
 * E2E 06 — a flow that CALLS the subflow, and then uses what it returned.
 *
 * Under test, and each one is a separate claim the read-back has to settle:
 *   - the call resolves to the subflow's record (a real reference, not a name)
 *   - every declared input is mapped, including the reference one and one fed
 *     from the trigger record
 *   - `waitForCompletion: true` sits in the INPUTS object, and the question is
 *     whether that reaches the `wait_for_completion` COLUMN on the call row
 *   - the subflow's outputs are readable afterwards and reach a later action
 *   - ordering: the call is step 1 and the consumer is step 2
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { e2eClassifyIncident } from './e2e-05-subflow.now'

Flow(
    {
        $id: Now.ID['e2e06_flow'],
        name: 'E2E 06 Subflow Caller',
        description: 'E2E matrix: calls a subflow with mapped inputs, waits, and consumes its outputs.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['e2e06_trigger'] },
        {
            table: 'incident',
            condition: 'number=E2E_NEVER_MATCHES',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const classified = wfa.subflow(
            e2eClassifyIncident,
            { $id: Now.ID['e2e06_call'], annotation: 'Classify the incident' },
            {
                incident: wfa.dataPill(params.trigger.current, 'reference'),
                threshold: 2,
                note: 'called from E2E 06',
                verbose: true,
                waitForCompletion: true,
            }
        )

        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e06_log_result'] },
            {
                log_level: 'info',
                log_message: `E2E 06 classification=${wfa.dataPill(classified.classification, 'string')} escalate=${wfa.dataPill(classified.escalate, 'boolean')}`,
            }
        )
    }
)
