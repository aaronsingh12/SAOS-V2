// nowforge-spec: a1732eeb506b4b36
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['scip_flow'],
        name: 'Set Critical Incident to In Progress',
        description: "Automatically runs when a new Incident is created with Priority 1 (Critical). The flow updates the Incident state to 'In Progress' and appends a Work Note indicating that a critical incident was detected.",
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['scip_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['scip_update'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    state: '2',
                    work_notes: 'Critical incident detected.',
                }),
            }
        )
    }
)