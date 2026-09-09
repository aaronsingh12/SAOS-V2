// nowforge-spec: a04d2876a74035af
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn } from '@servicenow/sdk/core'

export const addPriorityCheckWorkNote = Subflow(
    {
        $id: Now.ID['apcwn_subflow'],
        name: 'Add Priority Check Work Note',
        description: 'Checks an incident\'s priority and adds a work note indicating the check.',
        runAs: 'system',
        inputs: {
            incident: ReferenceColumn({ label: 'Incident', referenceTable: 'incident', mandatory: true })
        }
    },
    (params) => {
        // Log the priority being checked
        wfa.action(action.core.log, { $id: Now.ID['apcwn_log_priority'] }, {
            log_level: 'info',
            log_message: `Checked priority ${wfa.dataPill(params.inputs.incident.priority, 'string')}`
        })

        // Add a work note to the incident
        wfa.action(action.core.updateRecord, { $id: Now.ID['apcwn_update_incident'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.inputs.incident, 'reference'),
            values: TemplateValue({ work_notes: 'Priority checked by onboarding subflow' })
        })
    }
)