// nowforge-spec: e2e-matrix-04
/*
 * E2E 04 — data pills, ordering, and every flow-logic construct.
 *
 * The chain under test is the one the question names: Trigger -> Action A ->
 * Action B where B consumes A's output. Here A is a lookUpRecord and B reads
 * `A.Record.manager.email`, a dot-walk two levels deep off an action output.
 *
 * Then: if / elseIf / else as sibling calls, a forEach over a record set, a
 * doInParallel with two branches, and a tryCatch — with actions placed INSIDE
 * each, so the read-back can show where each step was attached and in what
 * order.
 *
 * Every action is a read or a log. The condition is unsatisfiable. Nothing
 * this flow can do writes to the instance.
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['e2e04_flow'],
        name: 'E2E 04 Pills And Logic',
        description: 'E2E matrix: action output chaining, if/elseIf/else, forEach, doInParallel, tryCatch.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['e2e04_trigger'] },
        {
            table: 'incident',
            condition: 'number=E2E_NEVER_MATCHES',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        /* A — produces outputs that later steps consume. */
        const group = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['e2e04_lookup_group'] },
            {
                table: 'sys_user_group',
                conditions: 'name=Network',
            }
        )

        /* B — consumes A, dot-walking through a reference on A's output. */
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e04_log_manager'] },
            {
                log_level: 'info',
                log_message: `E2E 04 manager is ${wfa.dataPill(group.Record.manager.email, 'string')}`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['e2e04_if_p1'],
                label: 'Priority is 1',
                condition: `${wfa.dataPill(params.trigger.current.priority, 'string')}=1`,
            },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['e2e04_log_p1'] },
                    { log_level: 'info', log_message: 'E2E 04 branch: P1' }
                )
            }
        )
        wfa.flowLogic.elseIf(
            {
                $id: Now.ID['e2e04_elseif_p2'],
                condition: `${wfa.dataPill(params.trigger.current.priority, 'string')}=2`,
            },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['e2e04_log_p2'] },
                    { log_level: 'info', log_message: 'E2E 04 branch: P2' }
                )
            }
        )
        wfa.flowLogic.else({ $id: Now.ID['e2e04_else_other'] }, () => {
            wfa.action(
                action.core.log,
                { $id: Now.ID['e2e04_log_other'] },
                { log_level: 'info', log_message: 'E2E 04 branch: other' }
            )
        })

        const recent = wfa.action(
            action.core.lookUpRecords,
            { $id: Now.ID['e2e04_lookup_recent'] },
            {
                table: 'incident',
                conditions: 'active=true^priority=1',
                max_results: 3,
            }
        )

        wfa.flowLogic.forEach(
            wfa.dataPill(recent.Records, 'records'),
            { $id: Now.ID['e2e04_foreach'] },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['e2e04_log_each'] },
                    { log_level: 'info', log_message: 'E2E 04 iterating one record' }
                )
            }
        )

        wfa.flowLogic.doInParallel(
            { $id: Now.ID['e2e04_parallel'] },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['e2e04_par_a'] },
                    { log_level: 'info', log_message: 'E2E 04 parallel branch A' }
                )
            },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['e2e04_par_b'] },
                    { log_level: 'info', log_message: 'E2E 04 parallel branch B' }
                )
            }
        )

        wfa.flowLogic.tryCatch(
            { $id: Now.ID['e2e04_try'] },
            {
                try: () => {
                    wfa.action(
                        action.core.log,
                        { $id: Now.ID['e2e04_try_body'] },
                        { log_level: 'info', log_message: 'E2E 04 try body' }
                    )
                },
                catch: () => {
                    wfa.action(
                        action.core.log,
                        { $id: Now.ID['e2e04_catch_body'] },
                        { log_level: 'error', log_message: 'E2E 04 catch body' }
                    )
                },
            }
        )
    }
)
