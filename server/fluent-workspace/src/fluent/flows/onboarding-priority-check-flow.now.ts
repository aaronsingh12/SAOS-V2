// nowforge-spec: d98f82422350c49d
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation';
import { addPriorityCheckWorkNote } from './add-priority-check-work-note.now';

Flow(
    {
        $id: Now.ID['opc_flow'],
        name: 'Onboarding Priority Check Flow',
        description: 'On incident creation, call the Add Priority Check Work Note subflow, then record completion.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['opc_trigger'] },
        {
            table: 'incident',
            condition: '',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.subflow(
            addPriorityCheckWorkNote,
            { $id: Now.ID['opc_call_subflow'] },
            {
                incident: wfa.dataPill(params.trigger.current, 'reference'),
                waitForCompletion: true,
            }
        );

        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['opc_update_note'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({ work_notes: 'Flow completed successfully.' }),
            }
        );
    }
)