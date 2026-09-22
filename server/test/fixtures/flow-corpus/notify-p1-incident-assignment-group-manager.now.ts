// nowforge-spec: a7119d3f5c476c97
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['notif_p1_inc_mgr_flow'],
        name: 'Notify P1 Incident Assignment Group Manager',
        description: 'When a P1 incident is created, email the assignment group manager if present; otherwise add a work note.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['notif_p1_inc_mgr_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['notif_p1_inc_mgr_cond_manager'],
                condition: `${wfa.dataPill(params.trigger.current.assignment_group.manager.email, 'string')}ISNOTEMPTY`,
            },
            () => {
                wfa.action(action.core.sendEmail, { $id: Now.ID['notif_p1_inc_mgr_send_email'] }, {
                    ah_to: `${wfa.dataPill(params.trigger.current.assignment_group.manager.email, 'string')}`,
                    ah_subject: `P1 Incident ${wfa.dataPill(params.trigger.current.number, 'string')} - Manager Notification`,
                    ah_body: 'A Priority 1 incident has been assigned to your group. Please review the incident promptly.',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table_name: 'incident',
                })
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['notif_p1_inc_mgr_no_manager'] }, () => {
            wfa.action(action.core.updateRecord, { $id: Now.ID['notif_p1_inc_mgr_add_note'] }, {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    work_notes: 'No manager defined for the assignment group; please assign the incident manually.',
                }),
            })
        })
    }
)