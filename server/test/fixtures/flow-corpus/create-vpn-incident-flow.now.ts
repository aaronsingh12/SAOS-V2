// nowforge-spec: ba271390339134c3
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { incidentApprovalAndAssignmentAction } from './incident-approval-and-assignment-action.now'

Flow(
    {
        $id: Now.ID['cvi_flow'],
        name: 'Create VPN Incident Flow',
        description: 'On creation of a VPN incident, assign to Network group and invoke approval/assignment subflow.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['cvi_trigger'] },
        {
            table: 'incident',
            condition: 'category=Network^subcategory=VPN^impact=1^urgency=1',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['cvi_update_assign_group'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({
                assignment_group: '287ebd7da9fe198100f92cc8d1d2154e',
            }),
        })

        wfa.subflow(
            incidentApprovalAndAssignmentAction,
            { $id: Now.ID['cvi_call_approval'] },
            {
                incidentRecordSysId: wfa.dataPill(params.trigger.current.sys_id, 'string'),
                waitForCompletion: true,
            }
        )
    }
)