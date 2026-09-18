// nowforge-spec: 5b8850ba35b90c31
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['abp_flow'],
        name: 'Approved Blueprint',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.runOnce,
        { $id: Now.ID['abp_trigger'] },
        { run_in: '2099-01-01 00:00:00' }
    ),
    () => {
        const incidents = wfa.action(
            action.core.lookUpRecords,
            { $id: Now.ID['abp_lookup'] },
            {
                table: 'incident',
                conditions: 'active=true',
                max_results: 1,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['abp_if'],
                condition: `${wfa.dataPill(incidents.Count, 'integer')}>0`,
            },
            () => {
                wfa.flowLogic.endFlow({ $id: Now.ID['abp_end_if'] })
            }
        )

        wfa.flowLogic.else(
            { $id: Now.ID['abp_else'] },
            () => {
                wfa.flowLogic.endFlow({ $id: Now.ID['abp_end_else'] })
            }
        )
    }
)