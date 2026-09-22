// nowforge-spec: 5fbc131e1cd5b4f8
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn } from '@servicenow/sdk/core'

export const incidentApprovalAndAssignmentAction = Subflow(
    {
        $id: Now.ID['iaa_incident_approval_and_assignment_action'],
        name: 'Incident Approval and Assignment Action',
        description: 'Sends an approval to the Network Manager; on approval assigns the incident to the Network group and adds a work note, otherwise adds a rejection work note.',
        runAs: 'system',
        inputs: {
            incidentRecordSysId: StringColumn({ label: 'Incident Sys ID', mandatory: true }),
        },
    },
    (params) => {
        const incident = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['iaa_lookup_incident'] },
            {
                table: 'incident',
                conditions: `sys_id=${wfa.dataPill(params.inputs.incidentRecordSysId, 'string')}`,
            }
        )

        const approval = wfa.action(
            action.core.askForApproval,
            { $id: Now.ID['iaa_ask_approval'] },
            {
                record: wfa.dataPill(incident.Record, 'reference'),
                table: 'incident',
                approval_reason: 'Network Manager approval required for assignment to Network group',
                approval_conditions: wfa.approvalRules({
                    conditionType: 'OR',
                    ruleSets: [
                        {
                            action: 'ApprovesRejects',
                            conditionType: 'AND',
                            rules: [
                                [
                                    {
                                        ruleType: 'Any',
                                        users: ['f298d2d2c611227b0106c6be7f154bc8'],
                                        groups: [],
                                        manual: false,
                                    },
                                ],
                            ],
                        },
                    ],
                }),
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['iaa_if_approved'],
                condition: `${wfa.dataPill(approval.approval_state, 'choice')}=approved`,
            },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['iaa_update_approved'] },
                    {
                        table_name: 'incident',
                        record: wfa.dataPill(incident.Record, 'reference'),
                        values: TemplateValue({
                            assignment_group: '287ebd7da9fe198100f92cc8d1d2154e',
                            work_notes: 'Approved by Network Manager – assigned to Network Support',
                        }),
                    }
                )
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['iaa_else_rejected'] }, () => {
            wfa.action(
                action.core.updateRecord,
                { $id: Now.ID['iaa_update_rejected'] },
                {
                    table_name: 'incident',
                    record: wfa.dataPill(incident.Record, 'reference'),
                    values: TemplateValue({
                        work_notes: `Rejected: ${wfa.dataPill(approval.approval_reason, 'string')}`,
                    }),
                }
            )
        })
    }
)