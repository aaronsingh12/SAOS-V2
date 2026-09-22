// nowforge-spec: 31bcb5193a81cfc9
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['rmh_flow'],
        name: 'Request Manager and HR Approval for Leave Requests',
        description: 'When a Leave Request (sc_req_item) is created, request approval from the requester\'s manager, then from the Service Desk group as HR approvers, and finally send a confirmation email to the requester.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['rmh_trigger'] },
        {
            table: 'sc_req_item',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['rmah_if_manager'],
                condition: `${wfa.dataPill(params.trigger.current.requested_for.manager, 'string')}ISNOTEMPTY`,
            },
            () => {
                const managerApproval = wfa.action(
                    action.core.askForApproval,
                    { $id: Now.ID['rmh_manager_approval'] },
                    {
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table: 'sc_req_item',
                        approval_reason: 'Manager approval required',
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
                                                users: [wfa.dataPill(params.trigger.current.requested_for.manager, 'reference')],
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
                        $id: Now.ID['rmh_if_manager_approved'],
                        condition: `${wfa.dataPill(managerApproval.approval_state, 'choice')}=approved`,
                    },
                    () => {
                        const hrApproval = wfa.action(
                            action.core.askForApproval,
                            { $id: Now.ID['rmh_hr_approval'] },
                            {
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                table: 'sc_req_item',
                                approval_reason: 'HR approval required',
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
                                                        users: [],
                                                        groups: ['d625dccec0a8016700a222a0f7900d06'],
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
                                $id: Now.ID['rmh_if_hr_approved'],
                                condition: `${wfa.dataPill(hrApproval.approval_state, 'choice')}=approved`,
                            },
                            () => {
                                wfa.action(
                                    action.core.sendEmail,
                                    { $id: Now.ID['rmh_send_email'] },
                                    {
                                        ah_to: `${wfa.dataPill(params.trigger.current.requested_for.email, 'string')}`,
                                        ah_subject: `Leave Request ${wfa.dataPill(params.trigger.current.number, 'string')} - Confirmation`,
                                        ah_body: 'Your leave request has been processed and approved.',
                                        record: wfa.dataPill(params.trigger.current, 'reference'),
                                        table_name: 'sc_req_item',
                                    }
                                )
                            }
                        )
                    }
                )
            }
        )

        wfa.flowLogic.else(
            { $id: Now.ID['rmah_else_no_manager'] },
            () => {
                const hrApprovalNoMgr = wfa.action(
                    action.core.askForApproval,
                    { $id: Now.ID['rmah_hr_approval_no_mgr'] },
                    {
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table: 'sc_req_item',
                        approval_reason: 'HR approval required',
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
                                                users: [],
                                                groups: ['d625dccec0a8016700a222a0f7900d06'],
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
                        $id: Now.ID['rmah_hr_approved_no_mgr'],
                        condition: `${wfa.dataPill(hrApprovalNoMgr.approval_state, 'choice')}=approved`,
                    },
                    () => {
                        wfa.action(
                            action.core.sendEmail,
                            { $id: Now.ID['rmah_send_email_no_mgr'] },
                            {
                                ah_to: `${wfa.dataPill(params.trigger.current.requested_for.email, 'string')}`,
                                ah_subject: `Leave Request ${wfa.dataPill(params.trigger.current.number, 'string')} - Confirmation`,
                                ah_body: 'Your leave request has been processed and approved.',
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                table_name: 'sc_req_item',
                            }
                        )
                    }
                )
            }
        )
    }
)