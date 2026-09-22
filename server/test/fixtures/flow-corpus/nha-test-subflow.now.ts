// nowforge-spec: b338dc7ff68a333a
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn, StringColumn, BooleanColumn } from '@servicenow/sdk/core'

export const nhaTestSubflow = Subflow(
    {
        $id: Now.ID['nht_nha_test_subflow'],
        name: 'NHA Test Subflow',
        description: 'Updates an incident with a work note and returns success.',
        runAs: 'system',
        inputs: {
            targetIncident: ReferenceColumn({ label: 'Target Incident', referenceTable: 'incident', mandatory: true }),
            notePrefix: StringColumn({ label: 'Note Prefix', mandatory: false }),
        },
        outputs: {
            success: BooleanColumn({ label: 'Success' }),
        },
    },
    (params) => {
        // Read notePrefix (optional) via a log action
        wfa.action(action.core.log, { $id: Now.ID['nht_log_note_prefix'] }, {
            log_level: 'info',
            log_message: `${wfa.dataPill(params.inputs.notePrefix, 'string')}`,
        })

        // Append work note to the target incident
        wfa.action(action.core.updateRecord, { $id: Now.ID['nht_update_incident'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.inputs.targetIncident, 'reference'),
            values: TemplateValue({
                work_notes: 'NHA Test Subflow processed this record successfully.',
            }),
        })

        // Assign output
        wfa.flowLogic.assignSubflowOutputs(
            { $id: Now.ID['nht_assign_outputs'] },
            params.outputs,
            { success: true }
        )
    }
)