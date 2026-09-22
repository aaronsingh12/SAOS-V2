// nowforge-spec: e2e-matrix-03
/*
 * E2E 03 — a scheduled flow.
 *
 * Two things are under test that no record-triggered flow can show: that the
 * schedule itself (time + timezone) reaches the instance, and that a flow with
 * no `current` record is authored correctly — the body finds its own records
 * with lookUpRecords and the callback takes no `params` at all.
 *
 * `lookUpRecords` reads; it writes nothing. Publishing this flow is therefore
 * safe even though its schedule would fire.
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['e2e03_flow'],
        name: 'E2E 03 Scheduled Daily',
        description: 'E2E matrix: scheduled.daily with an explicit timezone, and a body with no trigger record.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.daily,
        { $id: Now.ID['e2e03_trigger'] },
        { time: Time({ hours: 3, minutes: 30, seconds: 0 }, 'Asia/Kolkata') }
    ),
    () => {
        const open = wfa.action(
            action.core.lookUpRecords,
            { $id: Now.ID['e2e03_lookup'] },
            {
                table: 'incident',
                conditions: 'active=true^priority=1',
                max_results: 5,
                sort_column: 'sys_created_on',
                sort_type: 'sort_desc',
            }
        )

        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e03_log'] },
            {
                log_level: 'info',
                log_message: `E2E 03 found ${wfa.dataPill(open.Count, 'integer')} open P1 incidents`,
            }
        )
    }
)
