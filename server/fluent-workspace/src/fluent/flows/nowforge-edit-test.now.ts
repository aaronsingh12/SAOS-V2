// nowforge-spec: 759d6a76ad3fbfd8
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['nfe_flow'],
        name: 'NowForge Edit Test',
        description: 'Logs creation of incident with a formatted message.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['nfe_trigger'] },
        {
            table: 'incident',
            run_flow_in: 'background',
        }
    ),
    () => {
        wfa.action(action.core.log, { $id: Now.ID['nfe_log'] }, {
            log_level: 'info',
            log_message: 'NowForge Edit Test ran for {{trigger.current.number}}',
        })
    }
)