// nowforge-spec: b3da48f5455627bd
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn, BooleanColumn } from '@servicenow/sdk/core'

export const highPriorityIncidentEscalationLogic = Subflow(
    {
        $id: Now.ID['hpie_subflow'],
        name: 'High-Priority Incident Escalation Logic',
        description: 'Ensures a Problem exists for a high‑priority Incident and returns its identifiers.',
        runAs: 'system',
        inputs: {
            incident_sys_id: StringColumn({ label: 'Incident Sys ID', mandatory: true }),
        },
        outputs: {
            problem_number: StringColumn({ label: 'Problem Number' }),
            problem_sys_id: StringColumn({ label: 'Problem Sys ID' }),
            was_created: BooleanColumn({ label: 'Was Problem Created' }),
        },
    },
    (params) => {
        const incident = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['hpie_lookup_incident'] },
            {
                table: 'incident',
                conditions: `sys_id=${wfa.dataPill(params.inputs.incident_sys_id, 'string')}`,
            }
        )

        wfa.flowLogic.tryCatch(
            { $id: Now.ID['hpie_try_problem_lookup'] },
            {
                try: () => {
                    const existingProblem = wfa.action(
                        action.core.lookUpRecord,
                        { $id: Now.ID['hpie_lookup_problem'] },
                        {
                            table: 'problem',
                            conditions: `first_reported_by_task=${wfa.dataPill(params.inputs.incident_sys_id, 'string')}`,
                        }
                    )

                    wfa.flowLogic.assignSubflowOutputs(
                        { $id: Now.ID['hpie_out_existing'] },
                        params.outputs,
                        {
                            problem_number: wfa.dataPill(existingProblem.Record.number, 'string'),
                            problem_sys_id: wfa.dataPill(existingProblem.Record.sys_id, 'string'),
                            was_created: false,
                        }
                    )

                    wfa.action(
                        action.core.updateRecord,
                        { $id: Now.ID['hpie_incident_note_existing'] },
                        {
                            table_name: 'incident',
                            record: wfa.dataPill(incident.Record, 'reference'),
                            values: TemplateValue({
                                work_notes: 'Escalation flow: linked to Problem {{existingProblem.number}} (created/reused).',
                            }),
                        }
                    )
                },
                catch: () => {
                    const newProblem = wfa.action(
                        action.core.createRecord,
                        { $id: Now.ID['hpie_create_problem'] },
                        {
                            table_name: 'problem',
                            values: TemplateValue({
                                assignment_group: wfa.dataPill(incident.Record.assignment_group, 'reference'),
                                description: wfa.dataPill(incident.Record.description, 'string'),
                                first_reported_by_task: wfa.dataPill(params.inputs.incident_sys_id, 'string'),
                                priority: wfa.dataPill(incident.Record.priority, 'string'),
                                short_description: wfa.dataPill(incident.Record.short_description, 'string'),
                            }),
                        }
                    )

                    wfa.flowLogic.assignSubflowOutputs(
                        { $id: Now.ID['hpie_out_new'] },
                        params.outputs,
                        {
                            problem_number: wfa.dataPill(newProblem.record.number, 'string'),
                            problem_sys_id: wfa.dataPill(newProblem.record.sys_id, 'string'),
                            was_created: true,
                        }
                    )

                    wfa.action(
                        action.core.updateRecord,
                        { $id: Now.ID['hpie_incident_note_new'] },
                        {
                            table_name: 'incident',
                            record: wfa.dataPill(incident.Record, 'reference'),
                            values: TemplateValue({
                                work_notes: 'Escalation flow: linked to Problem {{newProblem.number}} (created/reused).',
                            }),
                        }
                    )

                    wfa.action(
                        action.core.updateRecord,
                        { $id: Now.ID['hpie_problem_note_new'] },
                        {
                            table_name: 'problem',
                            record: wfa.dataPill(newProblem.record, 'reference'),
                            values: TemplateValue({
                                work_notes: 'Created by high‑priority incident {{incidentRecord.number}}.',
                            }),
                        }
                    )
                },
            }
        )
    }
)