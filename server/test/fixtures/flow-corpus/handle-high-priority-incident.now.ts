// nowforge-spec: 89dfac2e67ac67a9
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['handle_high_priority_incident'],
        name: 'Handle High Priority Incident',
        description: 'Processes high‑priority incidents on create or update.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.createdOrUpdated,
        { $id: Now.ID['hpi_trigger'] },
        {
            table: 'incident',
            condition: '',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        const grp = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['hpi_lookup_group'] },
            {
                table: 'sys_user_group',
                conditions: `sys_id=${wfa.dataPill(params.trigger.current.assignment_group, 'string')}`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['hpi_if_high_priority'],
                condition: `${wfa.dataPill(params.trigger.current.priority, 'integer')}IN1,2`,
            },
            () => {
                wfa.action(action.core.sendEmail, { $id: Now.ID['hpi_send_email'] }, {
                    ah_to: `${wfa.dataPill(grp.Record.manager.email, 'string')}`,
                    ah_subject: `High Priority Incident ${wfa.dataPill(params.trigger.current.number, 'string')}`,
                    ah_body: 'A high‑priority incident requires immediate attention. Please review the record.',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table_name: 'incident',
                })

                wfa.action(action.core.updateRecord, { $id: Now.ID['hpi_update_work_note'] }, {
                    table_name: 'incident',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({
                        work_notes: 'High priority incident processed automatically.',
                    }),
                })

                wfa.flowLogic.if(
                    {
                        $id: Now.ID['hpi_if_unassigned'],
                        condition: `${wfa.dataPill(params.trigger.current.assigned_to, 'string')}ISEMPTY`,
                    },
                    () => {
                        wfa.action(action.core.updateRecord, { $id: Now.ID['hpi_assign_manager'] }, {
                            table_name: 'incident',
                            record: wfa.dataPill(params.trigger.current, 'reference'),
                            values: TemplateValue({
                                assigned_to: wfa.dataPill(grp.Record.manager, 'reference'),
                            }),
                        })
                    }
                )
            }
        )
    }
)