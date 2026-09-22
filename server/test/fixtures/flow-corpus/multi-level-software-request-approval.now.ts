// nowforge-spec: 30e872650bbc19da
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['mlsra_flow'],
        name: 'Multi‑Level Software Request Approval',
        description: 'Handles a software request with manager and security approvals before marking the request approved.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.application.serviceCatalog,
        { $id: Now.ID['mlsra_trigger'] },
        {
            table: 'sc_req_item',
            condition: `cat_item.name=Software Request`,
        }
    ),
    (params) => {
        const managerGroup = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['mlsa_mgr_group_lookup'] },
            {
                table: 'sys_user_group',
                conditions: `name=Software Request Managers`,
            }
        )

        const securityGroup = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['mlsa_sec_group_lookup'] },
            {
                table: 'sys_user_group',
                conditions: `name=Software Security Group`,
            }
        )

        const managerApproval = wfa.action(
            action.core.askForApproval,
            { $id: Now.ID['mlsra_manager_approval'] },
            {
                record: wfa.dataPill(params.trigger.request_item, 'reference'),
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
                                        groups: [wfa.dataPill(managerGroup.Record.sys_id, 'string')],
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
                $id: Now.ID['mlsra_if_manager_approved'],
                condition: `${wfa.dataPill(managerApproval.approval_state, 'choice')}=approved`,
            },
            () => {
                const securityApproval = wfa.action(
                    action.core.askForApproval,
                    { $id: Now.ID['mlsra_security_approval'] },
                    {
                        record: wfa.dataPill(params.trigger.request_item, 'reference'),
                        table: 'sc_req_item',
                        approval_reason: 'Security approval required',
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
                                                groups: [wfa.dataPill(securityGroup.Record.sys_id, 'string')],
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
                        $id: Now.ID['mlsra_if_security_approved'],
                        condition: `${wfa.dataPill(securityApproval.approval_state, 'choice')}=approved`,
                    },
                    () => {
                        wfa.action(
                            action.core.updateRecord,
                            { $id: Now.ID['mlsra_update_approved'] },
                            {
                                table_name: 'sc_req_item',
                                record: wfa.dataPill(params.trigger.request_item, 'reference'),
                                values: TemplateValue({ state: '3' }), // Approved
                            }
                        )
                    }
                )
                wfa.flowLogic.else(
                    { $id: Now.ID['mlsra_else_security_rejected'] },
                    () => {
                        wfa.action(
                            action.core.updateRecord,
                            { $id: Now.ID['mlsra_update_rejected_security'] },
                            {
                                table_name: 'sc_req_item',
                                record: wfa.dataPill(params.trigger.request_item, 'reference'),
                                values: TemplateValue({ state: '4' }), // Rejected
                            }
                        )
                    }
                )
            }
        )
        wfa.flowLogic.else(
            { $id: Now.ID['mlsra_else_manager_rejected'] },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['mlsra_update_rejected_manager'] },
                    {
                        table_name: 'sc_req_item',
                        record: wfa.dataPill(params.trigger.request_item, 'reference'),
                        values: TemplateValue({ state: '4' }), // Rejected
                    }
                )
            }
        )
    }
)