// nowforge-spec: ab5df625bc76dbd4
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { processIncidentAssignment } from './process-incident-assignment.now'

Flow(
    {
        $id: Now.ID['hpia_flow'],
        name: 'High Priority Incident Assignment',
        description: 'Assigns high‑priority incidents to the Network group and logs the result.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['hpia_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1^assignment_groupISEMPTY',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        const grp = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['hpia_lookup_group'] },
            {
                table: 'sys_user_group',
                conditions: `name=Network`,
            }
        )

        const proc = wfa.subflow(
            processIncidentAssignment,
            { $id: Now.ID['hpia_call_process'] },
            {
                incident: wfa.dataPill(params.trigger.current, 'reference'),
                sendNotification: true,
                assignmentOverrideGroup: wfa.dataPill(grp.Record, 'reference'),
                waitForCompletion: true,
            }
        )

        wfa.action(action.core.log, { $id: Now.ID['hpia_log'] }, {
            log_level: 'info',
            log_message: `Processed incident ${wfa.dataPill(params.trigger.current.number, 'string')} with success ${wfa.dataPill(proc.success, 'boolean')}`,
        })
    }
)