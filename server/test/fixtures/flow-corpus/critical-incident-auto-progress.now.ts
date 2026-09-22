// nowforge-spec: b10fdd83cc604aeb
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['cia_flow'],
        name: 'Critical Incident Auto-Progress',
        description: 'When an Incident is created or updated and is Critical (priority = 1) while not Closed, the flow moves the incident to In Progress, logs a work note, checks for an assigned user, and either emails the assignee or logs a work note indicating no assignee.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.createdOrUpdated,
        { $id: Now.ID['cia_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1^state!=7',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        // Set incident state to In Progress (2)
        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['cia_update_state'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({ state: 2 }),
            }
        )

        // Add work note about state change
        wfa.action(
            action.core.addWorknoteLinkToContext,
            { $id: Now.ID['cia_add_note1'] },
            {
                journal_field: 'work_notes',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                table: 'incident',
                additional_comments: 'Critical incident detected and moved to In Progress.',
            }
        )

        // Look up the assigned user (if any)
        const userLookup = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['cia_lookup_user'] },
            {
                table: 'sys_user',
                conditions: `sys_id=${wfa.dataPill(params.trigger.current.assigned_to, 'string')}`,
            }
        )

        // If an assigned user exists, send email
        wfa.flowLogic.if(
            {
                $id: Now.ID['cia_if_user_found'],
                condition: `${wfa.dataPill(userLookup.Record.sys_id, 'string')}ISNOTEMPTY`,
            },
            () => {
                wfa.action(
                    action.core.sendEmail,
                    { $id: Now.ID['cia_send_email'] },
                    {
                        ah_to: `${wfa.dataPill(userLookup.Record.email, 'string')}`,
                        ah_subject: `Critical Incident ${wfa.dataPill(params.trigger.current.number, 'string')}`,
                        ah_body: 'The incident has been moved to In Progress.',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table_name: 'incident',
                    }
                )
            }
        )

        // Else, add work note indicating no assignee
        wfa.flowLogic.else(
            { $id: Now.ID['cia_add_note_no_user'] },
            () => {
                wfa.action(
                    action.core.addWorknoteLinkToContext,
                    { $id: Now.ID['cia_add_note2'] },
                    {
                        journal_field: 'work_notes',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table: 'incident',
                        additional_comments: 'Critical incident has no assigned user.',
                    }
                )
            }
        )
    }
)