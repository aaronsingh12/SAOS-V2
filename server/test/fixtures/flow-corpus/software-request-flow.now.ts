// nowforge-spec: fc867a58f714a386
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['srf_flow'],
        name: 'Software Request Flow',
        description: 'Handles software request approvals and task creation based on price.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['srf_trigger'] },
        {
            table: 'sc_req_item',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        // Price check: > 10000
        wfa.flowLogic.if(
            {
                $id: Now.ID['srf_if_price_high'],
                condition: `${wfa.dataPill(params.trigger.current.price, 'currency')}>10000`,
            },
            () => {
                // ----- High price path: Help Desk -> Network CAB Managers -> ITSM Engineering -----
                const apprHelp = wfa.action(
                    action.core.askForApproval,
                    { $id: Now.ID['srf_approval_help'] },
                    {
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table: 'sc_req_item',
                        approval_reason: 'Approval required from Help Desk',
                        approval_conditions: wfa.approvalRules({
                            conditionType: 'OR',
                            ruleSets: [
                                {
                                    action: 'ApprovesRejects',
                                    conditionType: 'AND',
                                    rules: [[{ ruleType: 'Any', groups: ['679434f053231300e321ddeeff7b12d8'] }]],
                                },
                            ],
                        }),
                    }
                )

                wfa.flowLogic.if(
                    {
                        $id: Now.ID['srf_if_help_approved'],
                        condition: `${wfa.dataPill(apprHelp.approval_state, 'choice')}=approved`,
                    },
                    () => {
                        const apprNetwork = wfa.action(
                            action.core.askForApproval,
                            { $id: Now.ID['srf_approval_network_high'] },
                            {
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                table: 'sc_req_item',
                                approval_reason: 'Approval required from Network CAB Managers',
                                approval_conditions: wfa.approvalRules({
                                    conditionType: 'OR',
                                    ruleSets: [
                                        {
                                            action: 'ApprovesRejects',
                                            conditionType: 'AND',
                                            rules: [[{ ruleType: 'Any', groups: ['5418973d93a0220050bef157b67ffbe6'] }]],
                                        },
                                    ],
                                }),
                            }
                        )

                        wfa.flowLogic.if(
                            {
                                $id: Now.ID['srf_if_network_approved_high'],
                                condition: `${wfa.dataPill(apprNetwork.approval_state, 'choice')}=approved`,
                            },
                            () => {
                                const apprITSM = wfa.action(
                                    action.core.askForApproval,
                                    { $id: Now.ID['srf_approval_itsm_high'] },
                                    {
                                        record: wfa.dataPill(params.trigger.current, 'reference'),
                                        table: 'sc_req_item',
                                        approval_reason: 'Approval required from ITSM Engineering',
                                        approval_conditions: wfa.approvalRules({
                                            conditionType: 'OR',
                                            ruleSets: [
                                                {
                                                    action: 'ApprovesRejects',
                                                    conditionType: 'AND',
                                                    rules: [[{ ruleType: 'Any', groups: ['5f721d93c0a8010e015533746de18bf9'] }]],
                                                },
                                            ],
                                        }),
                                    }
                                )

                                wfa.flowLogic.if(
                                    {
                                        $id: Now.ID['srf_if_itsm_approved_high'],
                                        condition: `${wfa.dataPill(apprITSM.approval_state, 'choice')}=approved`,
                                    },
                                    () => {
                                        // All approvals passed – create task and update request
                                        const newTask = wfa.action(
                                            action.core.createRecord,
                                            { $id: Now.ID['srf_create_task_high'] },
                                            {
                                                table_name: 'sc_task',
                                                values: TemplateValue({
                                                    short_description: 'Install requested software',
                                                    assignment_group: '8a4dde73c6112278017a6a4baf547aa7',
                                                    request_item: wfa.dataPill(params.trigger.current, 'reference'),
                                                    request: wfa.dataPill(params.trigger.current.request, 'reference'),
                                                }),
                                            }
                                        )

                                        wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_high'] }, {
                                            table_name: 'sc_request',
                                            record: wfa.dataPill(params.trigger.current.request, 'reference'),
                                            values: TemplateValue({
                                                request_state: 2,
                                                work_notes: wfa.dataPill(newTask.record.number, 'string'),
                                            }),
                                        })
                                    }
                                )

                                // ITSM rejection handling
                                wfa.flowLogic.else({ $id: Now.ID['srf_reject_itsm_high'] }, () => {
                                    wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_reject_itsm_high'] }, {
                                        table_name: 'sc_request',
                                        record: wfa.dataPill(params.trigger.current.request, 'reference'),
                                        values: TemplateValue({
                                            request_state: 5,
                                            work_notes: 'Rejected at ITSM Engineering approval stage.',
                                        }),
                                    })
                                    wfa.flowLogic.endFlow({ $id: Now.ID['srf_end_itsm_high'] })
                                })
                            }
                        )

                        // Network rejection handling
                        wfa.flowLogic.else({ $id: Now.ID['srf_reject_network_high'] }, () => {
                            wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_reject_network_high'] }, {
                                table_name: 'sc_request',
                                record: wfa.dataPill(params.trigger.current.request, 'reference'),
                                values: TemplateValue({
                                    request_state: 5,
                                    work_notes: 'Rejected at Network CAB Managers approval stage.',
                                }),
                            })
                            wfa.flowLogic.endFlow({ $id: Now.ID['srf_end_network_high'] })
                        })
                    }
                )

                // Help Desk rejection handling
                wfa.flowLogic.else({ $id: Now.ID['srf_reject_help'] }, () => {
                    wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_reject_help'] }, {
                        table_name: 'sc_request',
                        record: wfa.dataPill(params.trigger.current.request, 'reference'),
                        values: TemplateValue({
                            request_state: 5,
                            work_notes: 'Rejected at Help Desk approval stage.',
                        }),
                    })
                    wfa.flowLogic.endFlow({ $id: Now.ID['srf_end_help'] })
                })
            }
        )

        // ----- Low price path: Network CAB Managers -> ITSM Engineering -----
        wfa.flowLogic.else({ $id: Now.ID['srf_else_low_price'] }, () => {
            const apprNetworkLow = wfa.action(
                action.core.askForApproval,
                { $id: Now.ID['srf_approval_network_low'] },
                {
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table: 'sc_req_item',
                    approval_reason: 'Approval required from Network CAB Managers',
                    approval_conditions: wfa.approvalRules({
                        conditionType: 'OR',
                        ruleSets: [
                            {
                                action: 'ApprovesRejects',
                                conditionType: 'AND',
                                rules: [[{ ruleType: 'Any', groups: ['5418973d93a0220050bef157b67ffbe6'] }]],
                            },
                        ],
                    }),
                }
            )

            wfa.flowLogic.if(
                {
                    $id: Now.ID['srf_if_network_approved_low'],
                    condition: `${wfa.dataPill(apprNetworkLow.approval_state, 'choice')}=approved`,
                },
                () => {
                    const apprITSMLow = wfa.action(
                        action.core.askForApproval,
                        { $id: Now.ID['srf_approval_itsm_low'] },
                        {
                            record: wfa.dataPill(params.trigger.current, 'reference'),
                            table: 'sc_req_item',
                            approval_reason: 'Approval required from ITSM Engineering',
                            approval_conditions: wfa.approvalRules({
                                conditionType: 'OR',
                                ruleSets: [
                                    {
                                        action: 'ApprovesRejects',
                                        conditionType: 'AND',
                                        rules: [[{ ruleType: 'Any', groups: ['5f721d93c0a8010e015533746de18bf9'] }]],
                                    },
                                ],
                            }),
                        }
                    )

                    wfa.flowLogic.if(
                        {
                            $id: Now.ID['srf_if_itsm_approved_low'],
                            condition: `${wfa.dataPill(apprITSMLow.approval_state, 'choice')}=approved`,
                        },
                        () => {
                            // All approvals passed – create task and update request
                            const newTaskLow = wfa.action(
                                action.core.createRecord,
                                { $id: Now.ID['srf_create_task_low'] },
                                {
                                    table_name: 'sc_task',
                                    values: TemplateValue({
                                        short_description: 'Install requested software',
                                        assignment_group: '8a4dde73c6112278017a6a4baf547aa7',
                                        request_item: wfa.dataPill(params.trigger.current, 'reference'),
                                        request: wfa.dataPill(params.trigger.current.request, 'reference'),
                                    }),
                                }
                            )

                            wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_low'] }, {
                                table_name: 'sc_request',
                                record: wfa.dataPill(params.trigger.current.request, 'reference'),
                                values: TemplateValue({
                                    request_state: 2,
                                    work_notes: wfa.dataPill(newTaskLow.record.number, 'string'),
                                }),
                            })
                        }
                    )

                    // ITSM rejection handling (low price)
                    wfa.flowLogic.else({ $id: Now.ID['srf_reject_itsm_low'] }, () => {
                        wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_reject_itsm_low'] }, {
                            table_name: 'sc_request',
                            record: wfa.dataPill(params.trigger.current.request, 'reference'),
                            values: TemplateValue({
                                request_state: 5,
                                work_notes: 'Rejected at ITSM Engineering approval stage.',
                            }),
                        })
                        wfa.flowLogic.endFlow({ $id: Now.ID['srf_end_itsm_low'] })
                    })
                }
            )

            // Network rejection handling (low price)
            wfa.flowLogic.else({ $id: Now.ID['srf_reject_network_low'] }, () => {
                wfa.action(action.core.updateRecord, { $id: Now.ID['srf_update_req_reject_network_low'] }, {
                    table_name: 'sc_request',
                    record: wfa.dataPill(params.trigger.current.request, 'reference'),
                    values: TemplateValue({
                        request_state: 5,
                        work_notes: 'Rejected at Network CAB Managers approval stage.',
                    }),
                })
                wfa.flowLogic.endFlow({ $id: Now.ID['srf_end_network_low'] })
            })
        })
    }
)