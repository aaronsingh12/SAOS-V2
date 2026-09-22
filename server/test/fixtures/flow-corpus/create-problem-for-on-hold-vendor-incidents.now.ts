// nowforge-spec: 0a8c04f64afd4b31
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['vpo_create_problem_flow'],
        name: 'Create Problem for On Hold Vendor Incidents',
        description: 'When an incident is put On Hold with hold reason Awaiting Vendor, create a related problem and link it.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.updated,
        { $id: Now.ID['vpo_trigger_updated'] },
        {
            table: 'incident',
            condition: 'state=3^hold_reason=4',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const hwGroup = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['vpo_lookup_hw_group'] },
            {
                table: 'sys_user_group',
                conditions: `sys_id=8a5055c9c61122780043563ef53438e3`,
            }
        )

        const prob = wfa.action(
            action.core.createRecord,
            { $id: Now.ID['vpo_create_problem'] },
            {
                table_name: 'problem',
                values: TemplateValue({
                    short_description: `Vendor issue: ${wfa.dataPill(params.trigger.current.short_description, 'string')}`,
                    assignment_group: wfa.dataPill(hwGroup.Record.sys_id, 'reference'),
                }),
            }
        )

        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['vpo_update_incident_problem'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    problem: wfa.dataPill(prob.record, 'reference'),
                }),
            }
        )

        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['vpo_add_work_note'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    work_notes: `Linked Problem ${wfa.dataPill(prob.record.number, 'string')}`,
                }),
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['vpo_if_critical'],
                condition: `${wfa.dataPill(params.trigger.current.priority, 'integer')}=1`,
            },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['vpo_assign_problem_manager'] },
                    {
                        table_name: 'problem',
                        record: wfa.dataPill(prob.record, 'reference'),
                        values: TemplateValue({
                            assigned_to: wfa.dataPill(hwGroup.Record.manager, 'reference'),
                        }),
                    }
                )
            }
        )
    }
)