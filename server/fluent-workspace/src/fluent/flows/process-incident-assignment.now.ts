// nowforge-spec: eb7e39e1af4f97be
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn, BooleanColumn, IntegerColumn, StringColumn } from '@servicenow/sdk/core'

export const processIncidentAssignment = Subflow(
    {
        $id: Now.ID['pia_subflow'],
        name: 'Process Incident Assignment',
        description: 'Assigns an incident to a group, sets priority, adds work note, and optionally sends a notification.',
        runAs: 'system',
        inputs: {
            incident: ReferenceColumn({ label: 'Incident', referenceTable: 'incident', mandatory: true }),
            sendNotification: BooleanColumn({ label: 'Send Notification', mandatory: false }),
            assignmentOverrideGroup: ReferenceColumn({ label: 'Assignment Override Group', referenceTable: 'sys_user_group', mandatory: false }),
        },
        outputs: {
            assignmentGroup: ReferenceColumn({ label: 'Assignment Group', referenceTable: 'sys_user_group' }),
            finalPriority: IntegerColumn({ label: 'Final Priority' }),
            processingResult: StringColumn({ label: 'Processing Result' }),
            success: BooleanColumn({ label: 'Success' }),
        },
    },
    (params) => {
        // Validate incident reference
        wfa.flowLogic.if(
            {
                $id: Now.ID['pia_if_incident_empty'],
                condition: `${wfa.dataPill(params.inputs.incident, 'reference')}ISEMPTY`,
            },
            () => {
                wfa.flowLogic.assignSubflowOutputs(
                    { $id: Now.ID['pia_assign_failure'] },
                    params.outputs,
                    {
                        assignmentGroup: '',
                        finalPriority: 0,
                        processingResult: 'Invalid incident reference',
                        success: false,
                    }
                )
            }
        )
        // Incident is present – look it up
        const inc = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['pia_lookup_incident'] },
            {
                table: 'incident',
                conditions: `sys_id=${wfa.dataPill(params.inputs.incident, 'string')}`,
            }
        )
        // Determine assignment group
        wfa.flowLogic.if(
            {
                $id: Now.ID['pia_if_override_empty'],
                condition: `${wfa.dataPill(params.inputs.assignmentOverrideGroup, 'reference')}ISEMPTY`,
            },
            () => {
                // No override – route by category (Hardware special case)
                wfa.flowLogic.if(
                    {
                        $id: Now.ID['pia_if_category_hardware'],
                        condition: `${wfa.dataPill(inc.Record.category, 'string')}=Hardware`,
                    },
                    () => {
                        const grp = wfa.action(
                            action.core.lookUpRecord,
                            { $id: Now.ID['pia_lookup_hw_group'] },
                            {
                                table: 'sys_user_group',
                                conditions: `name=IT Hardware Support^active=true`,
                            }
                        )
                        wfa.action(
                            action.core.updateRecord,
                            { $id: Now.ID['pia_update_hw'] },
                            {
                                table_name: 'incident',
                                record: wfa.dataPill(inc.Record, 'reference'),
                                values: TemplateValue({
                                    assignment_group: wfa.dataPill(grp.Record, 'reference'),
                                    impact: 1,
                                    urgency: 1,
                                    assigned_to: '',
                                }),
                            }
                        )
                        wfa.action(
                            action.core.addWorknoteLinkToContext,
                            { $id: Now.ID['pia_worknote_hw'] },
                            {
                                table: 'incident',
                                journal_field: 'work_notes',
                                record: wfa.dataPill(inc.Record, 'reference'),
                                additional_comments: `Assigned to ${wfa.dataPill(grp.Record.name, 'string')} with priority 1`,
                            }
                        )
                        wfa.flowLogic.if(
                            {
                                $id: Now.ID['pia_if_send_notif_hw'],
                                condition: `${wfa.dataPill(params.inputs.sendNotification, 'boolean')}=true`,
                            },
                            () => {
                                wfa.action(
                                    action.core.sendNotification,
                                    { $id: Now.ID['pia_send_notif_hw'] },
                                    {
                                        notification: 'Incident Assignment',
                                        record: wfa.dataPill(inc.Record, 'reference'),
                                        table_name: 'incident',
                                    }
                                )
                            }
                        )
                        wfa.flowLogic.assignSubflowOutputs(
                            { $id: Now.ID['pia_assign_outputs_hw'] },
                            params.outputs,
                            {
                                assignmentGroup: wfa.dataPill(grp.Record, 'reference'),
                                finalPriority: 1,
                                processingResult: 'Assigned via hardware routing',
                                success: true,
                            }
                        )
                    }
                )
                // All other categories fall back to Service Desk
                wfa.flowLogic.else({ $id: Now.ID['pia_else_fallback'] }, () => {
                    const grp = wfa.action(
                        action.core.lookUpRecord,
                        { $id: Now.ID['pia_lookup_sd_group'] },
                        {
                            table: 'sys_user_group',
                            conditions: `name=Service Desk^active=true`,
                        }
                    )
                    wfa.action(
                        action.core.updateRecord,
                        { $id: Now.ID['pia_update_sd'] },
                        {
                            table_name: 'incident',
                            record: wfa.dataPill(inc.Record, 'reference'),
                            values: TemplateValue({
                                assignment_group: wfa.dataPill(grp.Record, 'reference'),
                                impact: 1,
                                urgency: 1,
                                assigned_to: '',
                            }),
                        }
                    )
                    wfa.action(
                        action.core.addWorknoteLinkToContext,
                        { $id: Now.ID['pia_worknote_sd'] },
                        {
                            table: 'incident',
                            journal_field: 'work_notes',
                            record: wfa.dataPill(inc.Record, 'reference'),
                            additional_comments: `Assigned to ${wfa.dataPill(grp.Record.name, 'string')} with priority 1`,
                        }
                    )
                    wfa.flowLogic.if(
                        {
                            $id: Now.ID['pia_if_send_notif_sd'],
                            condition: `${wfa.dataPill(params.inputs.sendNotification, 'boolean')}=true`,
                        },
                        () => {
                            wfa.action(
                                action.core.sendNotification,
                                { $id: Now.ID['pia_send_notif_sd'] },
                                {
                                    notification: 'Incident Assignment',
                                    record: wfa.dataPill(inc.Record, 'reference'),
                                    table_name: 'incident',
                                }
                            )
                        }
                    )
                    wfa.flowLogic.assignSubflowOutputs(
                        { $id: Now.ID['pia_assign_outputs_sd'] },
                        params.outputs,
                        {
                            assignmentGroup: wfa.dataPill(grp.Record, 'reference'),
                            finalPriority: 1,
                            processingResult: 'Assigned via Service Desk fallback',
                            success: true,
                        }
                    )
                })
            }
        )
        // Override group provided – use it directly
        wfa.flowLogic.else({ $id: Now.ID['pia_else_override'] }, () => {
            const grp = wfa.action(
                action.core.lookUpRecord,
                { $id: Now.ID['pia_lookup_override_group'] },
                {
                    table: 'sys_user_group',
                    conditions: `sys_id=${wfa.dataPill(params.inputs.assignmentOverrideGroup, 'string')}^active=true`,
                }
            )
            wfa.action(
                action.core.updateRecord,
                { $id: Now.ID['pia_update_override'] },
                {
                    table_name: 'incident',
                    record: wfa.dataPill(inc.Record, 'reference'),
                    values: TemplateValue({
                        assignment_group: wfa.dataPill(grp.Record, 'reference'),
                        impact: 1,
                        urgency: 1,
                        assigned_to: '',
                    }),
                }
            )
            wfa.action(
                action.core.addWorknoteLinkToContext,
                { $id: Now.ID['pia_worknote_override'] },
                {
                    table: 'incident',
                    journal_field: 'work_notes',
                    record: wfa.dataPill(inc.Record, 'reference'),
                    additional_comments: `Assigned to ${wfa.dataPill(grp.Record.name, 'string')} with priority 1`,
                }
            )
            wfa.flowLogic.if(
                {
                    $id: Now.ID['pia_if_send_notif_override'],
                    condition: `${wfa.dataPill(params.inputs.sendNotification, 'boolean')}=true`,
                },
                () => {
                    wfa.action(
                        action.core.sendNotification,
                        { $id: Now.ID['pia_send_notif_override'] },
                        {
                            notification: 'Incident Assignment',
                            record: wfa.dataPill(inc.Record, 'reference'),
                            table_name: 'incident',
                        }
                    )
                }
            )
            wfa.flowLogic.assignSubflowOutputs(
                { $id: Now.ID['pia_assign_outputs_override'] },
                params.outputs,
                {
                    assignmentGroup: wfa.dataPill(grp.Record, 'reference'),
                    finalPriority: 1,
                    processingResult: 'Assigned via override group',
                    success: true,
                }
            )
        })
    }
)