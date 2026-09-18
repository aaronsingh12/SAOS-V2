// nowforge-spec: 5169fcb87226447d
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['ipt_flow'],
        name: 'Incident Priority Test Flow',
        description: 'Automatically processes newly created incidents: if priority is 1, sets state to In Progress and routes to a specific assignment group while adding a work note. If impact and urgency are both 1, adds a work note and, when an assignee exists, sends an "Incident Assigned" notification to that user.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['ipt_trigger'] },
        {
            table: 'incident',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['ipt_if_priority'],
                condition: `${wfa.dataPill(params.trigger.current.priority, 'integer')}=1`,
            },
            () => {
                wfa.action(action.core.updateRecord, { $id: Now.ID['ipt_update_state'] }, {
                    table_name: 'incident',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({ state: 2 }),
                })

                wfa.action(action.core.updateRecord, { $id: Now.ID['ipt_update_group'] }, {
                    table_name: 'incident',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({ assignment_group: '5f721d93c0a8010e015533746de18bf9' }),
                })

                wfa.action(action.core.addWorknoteLinkToContext, { $id: Now.ID['ipt_add_work_note'] }, {
                    journal_field: 'work_notes',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table: 'incident',
                    additional_comments: 'Critical incident automatically routed by Flow Designer.',
                })
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['ipt_if_impact_urgency'],
                condition: `${wfa.dataPill(params.trigger.current.impact, 'integer')}=1^${wfa.dataPill(params.trigger.current.urgency, 'integer')}=1`,
            },
            () => {
                wfa.action(action.core.addWorknoteLinkToContext, { $id: Now.ID['ipt_add_work_note_impact'] }, {
                    journal_field: 'work_notes',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table: 'incident',
                    additional_comments: 'High impact and urgency detected.',
                })

                wfa.flowLogic.if(
                    {
                        $id: Now.ID['ipt_if_assigned'],
                        condition: `${wfa.dataPill(params.trigger.current.assigned_to, 'reference')}ISNOTEMPTY`,
                    },
                    () => {
                        wfa.action(action.core.sendNotification, { $id: Now.ID['ipt_send_notification'] }, {
                            notification: 'Incident Assigned',
                            record: wfa.dataPill(params.trigger.current, 'reference'),
                            table_name: 'incident',
                        })
                    }
                )
            }
        )
    }
)