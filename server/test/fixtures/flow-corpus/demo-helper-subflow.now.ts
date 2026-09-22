// nowforge-spec: 6b0abbf00016810a
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn } from '@servicenow/sdk/core'

export const demoHelperSubflow = Subflow(
    {
        $id: Now.ID['dhs_subflow'],
        name: 'Demo Helper Subflow',
        description: 'A reusable subflow that receives an incident sys_id and short description, looks up the incident, adds a work note, and returns a status message containing the short description.',
        runAs: 'system',
        inputs: {
            incident_sys_id: StringColumn({ label: 'Incident Sys ID', mandatory: true }),
            short_description: StringColumn({ label: 'Short Description', mandatory: true }),
        },
        outputs: {
            status: StringColumn({ label: 'Status' }),
        },
    },
    (params) => {
        const incident = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['dhs_lookup_incident'] },
            {
                table: 'incident',
                conditions: `sys_id=${wfa.dataPill(params.inputs.incident_sys_id, 'string')}`,
            }
        )

        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['dhs_update_incident'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(incident.Record, 'reference'),
                values: TemplateValue({ work_notes: 'Processed by subflow' }),
            }
        )

        wfa.action(
            action.core.log,
            { $id: Now.ID['dh_log_short_desc'] },
            {
                log_level: 'info',
                log_message: `Short description: ${wfa.dataPill(params.inputs.short_description, 'string')}`,
            }
        )

        wfa.flowLogic.assignSubflowOutputs(
            { $id: Now.ID['dhs_assign_outputs'] },
            params.outputs,
            {
                status: 'Subflow completed for {{short_description}}',
            }
        )
    }
)