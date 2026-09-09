// nowforge-spec: efe64dbbb63deb11
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['aan_flow'],
        name: 'Auto-Assign Network Incidents',
        description: 'When a new Incident is created, this flow checks if the Category is \'Network\'. If true, it assigns the Incident to the Network team group, sets the Priority to 2 (High), and appends a work note indicating automatic assignment.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['aan_trigger'] },
        {
            table: 'incident',
            condition: '',
            run_flow_in: 'background',
            trigger_strategy: 'once',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['aan_if_category'],
                condition: `${wfa.dataPill(params.trigger.current.category, 'string')}=network`,
            },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['aan_update_incident'] },
                    {
                        table_name: 'incident',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            assignment_group: '287ebd7da9fe198100f92cc8d1d2154e',
                            impact: '1',
                            urgency: '2',
                            work_notes: 'Incident automatically assigned to Network team.',
                        }),
                    }
                )
            }
        )
    }
)