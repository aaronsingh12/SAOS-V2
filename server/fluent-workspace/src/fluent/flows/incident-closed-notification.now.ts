// nowforge-spec: aa102857f470c865
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['icn_flow'],
        name: 'Incident Closed Notification',
        description: 'When an incident record is updated to a Closed state (state=7), this flow sends the "Incident closed" notification to the Assigned To user, if a user is assigned.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.updated,
        { $id: Now.ID['icn_trigger'] },
        {
            table: 'incident',
            condition: 'state=7',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['icn_if_assigned'],
                condition: `${wfa.dataPill(params.trigger.current.assigned_to, 'string')}ISNOTEMPTY`,
            },
            () => {
                wfa.action(
                    action.core.sendNotification,
                    { $id: Now.ID['icn_send_notification'] },
                    {
                        notification: 'b72922d27fb9121073b72458bc8665d3',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table_name: 'incident',
                    }
                )
            }
        )
    }
)