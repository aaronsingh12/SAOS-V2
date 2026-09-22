import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['smoke_test_flow'],
        name: 'NowForge Smoke Test',
        description: 'Minimal flow used to validate the Fluent build pipeline.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['smoke_test_trigger'] },
        {
            table: 'incident',
            condition: 'short_descriptionLIKEnowforge-smoke-test',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['smoke_test_log'] },
            {
                log_level: 'info',
                log_message: `Smoke test saw ${wfa.dataPill(params.trigger.current.number, 'string')}`,
            }
        )
    }
)
