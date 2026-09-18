// nowforge-spec: 0809bcd6f5fa7e51
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['lrf_flow'],
        name: 'Laptop Request Fulfillment',
        description: "Automates the end‑to‑end processing of a New Laptop Request catalog item: acknowledges the request, verifies the requester's manager, creates required approvals, monitors approvals and task completion, and notifies the requester of success or failure.",
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['lrf_trigger'] },
        {
            table: 'sc_req_item',
            condition: 'cat_item=86b710978313c75037f1fcb6feaad3cf',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        // 1. Send acknowledgement email
        wfa.action(action.core.sendEmail, { $id: Now.ID['lrf_send_ack'] }, {
            ah_to: `${wfa.dataPill(params.trigger.current.requested_for.email, 'string')}`,
            ah_subject: `Your Laptop Request has been received`,
            ah_body: 'Your laptop request has been received and is being processed.',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            table_name: 'sc_req_item',
        })

        // 2. Look up the requester’s manager
        const lookupUser = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['lrf_lookup_user'] },
            {
                table: 'sys_user',
                conditions: `sys_id=${wfa.dataPill(params.trigger.current.requested_for, 'string')}`,
            }
        )

        // 3. If manager is missing
        wfa.flowLogic.if(
            {
                $id: Now.ID['lrf_if_no_manager'],
                condition: `${wfa.dataPill(lookupUser.Record.manager, 'reference')}ISEMPTY`,
            },
            () => {
                // Send error email
                wfa.action(action.core.sendEmail, { $id: Now.ID['lrf_send_no_manager'] }, {
                    ah_to: `${wfa.dataPill(params.trigger.current.requested_for.email, 'string')}`,
                    ah_subject: `Laptop Request cannot be processed`,
                    ah_body: 'Your request cannot be processed because a manager is not defined.',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table_name: 'sc_req_item',
                })
                // Close RITM as unresolved
                wfa.action(action.core.updateRecord, { $id: Now.ID['lrf_close_unresolved'] }, {
                    table_name: 'sc_req_item',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({
                        close_code: 'unresolved',
                        state: '4',
                    }),
                })
                // End flow
                wfa.flowLogic.endFlow({ $id: Now.ID['lrf_end_no_manager'] })
            }
        )

        // 4. Else (manager exists) – continue processing
        wfa.flowLogic.else({ $id: Now.ID['lrf_else_manager_exists'] }, () => {
            // Create manager approval record
            wfa.action(action.core.createRecord, { $id: Now.ID['lrf_create_manager_approval'] }, {
                table_name: 'sysapproval_approver',
                values: TemplateValue({
                    approver: wfa.dataPill(lookupUser.Record.manager, 'reference'),
                    document_id: wfa.dataPill(params.trigger.current.sys_id, 'string'),
                    state: 'requested',
                }),
            })

            // 5. If laptop_type is Gaming or High-End
            wfa.flowLogic.if(
                {
                    $id: Now.ID['lrf_if_high_end_laptop'],
                    condition: `${wfa.dataPill((params.trigger.current as any).variables.laptop_type, 'string')}=Gaming^OR${wfa.dataPill((params.trigger.current as any).variables.laptop_type, 'string')}=High-End`,
                },
                () => {
                    // Create group approval record
                    wfa.action(action.core.createRecord, { $id: Now.ID['lrf_create_group_approval'] }, {
                        table_name: 'sysapproval_approver',
                        values: TemplateValue({
                            document_id: wfa.dataPill(params.trigger.current.sys_id, 'string'),
                            group: '5f63e48fc0a8010e00eeaad81cd4dd37',
                            state: 'requested',
                        }),
                    })
                }
            )
            // End of laptop_type conditional (no explicit else needed)

            // 6. Wait for approvals (up to 7 days) – wait on first pending approval
            const firstApproval = wfa.action(
                action.core.lookUpRecord,
                { $id: Now.ID['lrf_lookup_first_approval'] },
                {
                    table: 'sysapproval_approver',
                    conditions: `document_id=${wfa.dataPill(params.trigger.current.sys_id, 'string')}^state=requested`,
                }
            )
            wfa.action(action.core.waitForCondition, { $id: Now.ID['lrf_wait_approvals'] }, {
                record: wfa.dataPill(firstApproval.Record, 'reference'),
                conditions: `${wfa.dataPill(firstApproval.Record.state, 'string')}=approved`,
                timeout_duration: Duration({ days: 7 }),
            })

            // 7. Look up any rejected approvals
            const rejectedApprovals = wfa.action(
                action.core.lookUpRecords,
                { $id: Now.ID['lrf_lookup_rejected'] },
                {
                    table: 'sysapproval_approver',
                    conditions: `document_id=${wfa.dataPill(params.trigger.current.sys_id, 'string')}^state=rejected`,
                }
            )

            // 8. If any rejected approvals exist
            wfa.flowLogic.if(
                {
                    $id: Now.ID['lrf_if_rejected'],
                    condition: `${wfa.dataPill(rejectedApprovals.Count, 'integer')}>0`,
                },
                () => {
                    // Send rejection email
                    wfa.action(action.core.sendEmail, { $id: Now.ID['lrf_send_rejection'] }, {
                        ah_to: `${wfa.dataPill(params.trigger.current.requested_for.email, 'string')}`,
                        ah_subject: `Laptop Request Rejected`,
                        ah_body: 'Your laptop request was rejected.',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table_name: 'sc_req_item',
                    })
                    // Close RITM as rejected
                    wfa.action(action.core.updateRecord, { $id: Now.ID['lrf_close_rejected'] }, {
                        table_name: 'sc_req_item',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            close_code: 'rejected',
                            state: '4',
                        }),
                    })
                    // End flow
                    wfa.flowLogic.endFlow({ $id: Now.ID['lrf_end_rejection'] })
                }
            )

            // 9. Else (all approvals approved) – continue
            wfa.flowLogic.else({ $id: Now.ID['lrf_else_approvals_approved'] }, () => {
                // Create provisioning task
                const provisionTask = wfa.action(
                    action.core.createRecord,
                    { $id: Now.ID['lrf_create_provision_task'] },
                    {
                        table_name: 'sc_task',
                        values: TemplateValue({
                            assignment_group: '5f63e48fc0a8010e00eeaad81cd4dd37',
                            request_item: wfa.dataPill(params.trigger.current.sys_id, 'string'),
                            short_description: `Provision New Laptop for ${wfa.dataPill(params.trigger.current.requested_for.name, 'string')}`,
                            state: '1',
                        }),
                    }
                )
                // Wait for task to reach Closed Complete (state=3) – up to 7 days
                wfa.action(action.core.waitForCondition, { $id: Now.ID['lrf_wait_task'] }, {
                    record: wfa.dataPill(provisionTask.record, 'reference'),
                    conditions: `${wfa.dataPill(provisionTask.record.state, 'string')}=3`,
                    timeout_duration: Duration({ days: 7 }),
                })
                // Update RITM to Closed Complete
                wfa.action(action.core.updateRecord, { $id: Now.ID['lrf_close_complete'] }, {
                    table_name: 'sc_req_item',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({
                        close_code: 'completed',
                        state: '3',
                    }),
                })
                // Send completion email
                wfa.action(action.core.sendEmail, { $id: Now.ID['lrf_send_completion'] }, {
                    ah_to: `${wfa.dataPill(params.trigger.current.requested_for.email, 'string')}`,
                    ah_subject: `Laptop Request Completed`,
                    ah_body: 'Your laptop request has been fulfilled.',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table_name: 'sc_req_item',
                })
                // End flow
                wfa.flowLogic.endFlow({ $id: Now.ID['lrf_end_success'] })
            })
        })
    }
)