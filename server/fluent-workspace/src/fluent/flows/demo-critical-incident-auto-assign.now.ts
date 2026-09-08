// nowforge-spec: 362a47ee2f21f47e
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['dcia_flow'],
        name: 'Demo Critical Incident Auto-Assign',
        description:
            'When a critical (priority 1) incident is created, adds an auto-assignment work note and sets the assignment group to Service Desk.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['dcia_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        // Step 1: add the auto-assignment work note
        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['dcia_add_work_note'], annotation: 'Add auto-assignment work note' },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    work_notes: 'Critical incident auto-assigned to Service Desk by demo flow',
                }),
            }
        )

        // Step 2: set assignment_group to the Service Desk group
        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['dcia_set_assignment_group'], annotation: 'Set assignment group to Service Desk' },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    assignment_group: 'd625dccec0a8016700a222a0f7900d06',
                }),
            }
        )
    }
)