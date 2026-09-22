// nowforge-spec: 70cc5b8ab562ccc0
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { incidentApprovalAndAssignmentAction } from './incident-approval-and-assignment-action.now'

Flow(
    {
        $id: Now.ID['iaac_flow'],
        name: 'Incident Assignment and Approval Based on Category',
        description: 'Determines assignment and approval chain based on incident category/subcategory.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['iaac_trigger'] },
        {
            table: 'incident',
            condition: '',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        // Network category path – use existing subflow
        wfa.flowLogic.if(
            {
                $id: Now.ID['iaac_if_network'],
                condition: `${wfa.dataPill(params.trigger.current.category, 'string')}=network`,
            },
            () => {
                wfa.subflow(
                    incidentApprovalAndAssignmentAction,
                    { $id: Now.ID['iaac_call_network_subflow'] },
                    {
                        incidentRecordSysId: wfa.dataPill(params.trigger.current.sys_id, 'string'),
                        waitForCompletion: true,
                    }
                )
            }
        )

        // Security category path – custom approval chain
        wfa.flowLogic.elseIf(
            {
                $id: Now.ID['iaac_if_security'],
                condition: `${wfa.dataPill(params.trigger.current.category, 'string')}=security`,
            },
            () => {
                // Caller manager approval
                const callerMgrApproval = wfa.action(
                    action.core.askForApproval,
                    { $id: Now.ID['iaac_ask_caller_mgr'] },
                    {
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table: 'incident',
                        approval_reason: 'Caller manager approval required',
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
                                                users: [wfa.dataPill(params.trigger.current.caller_id.manager, 'reference')],
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
                        $id: Now.ID['iaac_if_caller_approved'],
                        condition: `${wfa.dataPill(callerMgrApproval.approval_state, 'choice')}=approved`,
                    },
                    () => {
                        // Security manager lookup (using an existing user)
                        const secMgrLookup = wfa.action(
                            action.core.lookUpRecord,
                            { $id: Now.ID['iaac_lookup_sec_mgr'] },
                            {
                                table: 'sys_user',
                                conditions: `name=Aagamya Tanwar`,
                            }
                        )

                        // Security manager approval
                        const secMgrApproval = wfa.action(
                            action.core.askForApproval,
                            { $id: Now.ID['iaac_ask_sec_mgr'] },
                            {
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                table: 'incident',
                                approval_reason: 'Security manager approval required',
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
                                                        users: [wfa.dataPill(secMgrLookup.Record, 'reference')],
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
                                $id: Now.ID['iaac_if_sec_approved'],
                                condition: `${wfa.dataPill(secMgrApproval.approval_state, 'choice')}=approved`,
                            },
                            () => {
                                wfa.action(
                                    action.core.updateRecord,
                                    { $id: Now.ID['iaac_update_worknote_sec_approved'] },
                                    {
                                        table_name: 'incident',
                                        record: wfa.dataPill(params.trigger.current, 'reference'),
                                        values: TemplateValue({
                                            work_notes: 'Security approvals completed.',
                                        }),
                                    }
                                )
                            }
                        )
                        wfa.flowLogic.else(
                            { $id: Now.ID['iaac_else_sec_reject'] },
                            () => {
                                wfa.action(
                                    action.core.updateRecord,
                                    { $id: Now.ID['iaac_update_worknote_sec_reject'] },
                                    {
                                        table_name: 'incident',
                                        record: wfa.dataPill(params.trigger.current, 'reference'),
                                        values: TemplateValue({
                                            work_notes: 'Security manager rejected the request.',
                                        }),
                                    }
                                )
                                wfa.flowLogic.endFlow({ $id: Now.ID['iaac_end_sec_reject'] })
                            }
                        )
                    }
                )
                wfa.flowLogic.else(
                    { $id: Now.ID['iaac_else_caller_reject'] },
                    () => {
                        wfa.action(
                            action.core.updateRecord,
                            { $id: Now.ID['iaac_update_worknote_caller_reject'] },
                            {
                                table_name: 'incident',
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                values: TemplateValue({
                                    work_notes: 'Caller manager rejected the request.',
                                }),
                            }
                        )
                        wfa.flowLogic.endFlow({ $id: Now.ID['iaac_end_caller_reject'] })
                    }
                )
            }
        )

        // Fallback for other categories
        wfa.flowLogic.else(
            { $id: Now.ID['iaac_else_other'] },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['iaac_log_other'] },
                    {
                        log_level: 'info',
                        log_message: `Incident ${wfa.dataPill(params.trigger.current.number, 'string')} does not match any approval routing rules.`,
                    }
                )
            }
        )
    }
)