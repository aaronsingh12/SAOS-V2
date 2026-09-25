// nowforge-spec: 769322c1d4a6366b
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['spc_flow'],
        name: 'Set In Progress and Create Follow‑up Task for High Priority Incidents',
        description: 'When an Incident priority becomes High, set state to In Progress, add a work note, and create a follow‑up Task if none exists.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.createdOrUpdated,
        { $id: Now.ID['spc_trigger'] },
        {
            table: 'incident',
            condition: 'priority=2^incident_state!=7^assignment_groupISNOTEMPTY',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        // Set incident state to In Progress
        wfa.action(action.core.updateRecord, { $id: Now.ID['spc_update_state'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({ incident_state: 2 }),
        })

        // Add first work note
        wfa.action(action.core.updateRecord, { $id: Now.ID['spc_add_note1'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({ work_notes: 'State set to In Progress by automated flow.' }),
        })

        // Look for existing follow‑up task linked via parent field
        const taskLookup = wfa.action(action.core.lookUpRecords, { $id: Now.ID['spc_task_lookup'] }, {
            table: 'task',
            conditions: `parent=${wfa.dataPill(params.trigger.current.sys_id, 'string')}`,
            max_results: 1,
        })

        wfa.flowLogic.if(
            {
                $id: Now.ID['spc_if_no_task'],
                condition: `${wfa.dataPill(taskLookup.Count, 'integer')}=0`,
            },
            () => {
                // Create follow‑up task
                wfa.action(action.core.createRecord, { $id: Now.ID['spc_create_task'] }, {
                    table_name: 'task',
                    values: TemplateValue({
                        short_description: 'Follow‑up task',
                        description: 'Follow‑up task for incident.',
                        parent: wfa.dataPill(params.trigger.current, 'reference'),
                        state: 1, // Open
                    }),
                })

                // Add second work note referencing the new task
                wfa.action(action.core.updateRecord, { $id: Now.ID['spc_add_note2'] }, {
                    table_name: 'incident',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({ work_notes: 'Follow‑up task created.' }),
                })
            }
        )
    }
)