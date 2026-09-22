// nowforge-spec: b171058af686a2d3
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { softwareFulfillmentTask } from './software-fulfillment-task.now'

Flow(
    {
        $id: Now.ID['candidate_b171058af686a2d3_now_ts_srf_flow'],
        name: 'Software Request Fulfillment',
        description: 'Handles fulfillment of Non-standard software requests with price‑based approval routing.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['candidate_b171058af686a2d3_now_ts_srf_trigger'] },
        {
            table: 'sc_req_item',
            condition: 'cat_item.name=Non-standard software request',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        // Branch based on price
        wfa.flowLogic.if(
            {
                $id: Now.ID['srf_price_gt_10000'],
                condition: `${wfa.dataPill(params.trigger.current.price, 'currency')}>10000`,
            },
            () => {
                // Approval sequence for high‑price requests: Manager → IT Group
                const apprMgr = wfa.action(
                    action.core.askForApproval,
                    { $id: Now.ID['srf_approval_mgr_high'] },
                    {
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table: 'sc_req_item',
                        approval_reason: 'Manager approval required (price > 10,000).',
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
                                                groups: ['019ad92ec7230010393d265c95c260dd'], // Analytics Settings Managers
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
                        $id: Now.ID['srf_mgr_approved'],
                        condition: `${wfa.dataPill(apprMgr.approval_state, 'choice')}=approved`,
                    },
                    () => {
                        const apprIt = wfa.action(
                            action.core.askForApproval,
                            { $id: Now.ID['srf_approval_it_high'] },
                            {
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                table: 'sc_req_item',
                                approval_reason: 'IT group approval required (price > 10,000).',
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
                                                        groups: ['553032e853165110b846ddeeff7b12aa'], // App Engine Studio User Limited
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
                                $id: Now.ID['srf_it_approved'],
                                condition: `${wfa.dataPill(apprIt.approval_state, 'choice')}=approved`,
                            },
                            () => {
                                // All approvals granted – invoke fulfillment subflow
                                const fulfill = wfa.subflow(
                                    softwareFulfillmentTask,
                                    { $id: Now.ID['srf_call_fulfill'] },
                                    {
                                        requestItem: wfa.dataPill(params.trigger.current, 'reference'),
                                        shortDescription: 'Software request fulfillment',
                                        waitForCompletion: true,
                                    }
                                )

                                // Add work note with created task number
                                wfa.action(
                                    action.core.updateRecord,
                                    { $id: Now.ID['srf_add_work_note'] },
                                    {
                                        table_name: 'sc_req_item',
                                        record: wfa.dataPill(params.trigger.current, 'reference'),
                                        values: TemplateValue({
                                            work_notes: wfa.dataPill(fulfill.taskNumber, 'string'),
                                        }),
                                    }
                                )

                                // Mark request as fulfilled
                                wfa.action(
                                    action.core.updateRecord,
                                    { $id: Now.ID['srf_set_fulfilled'] },
                                    {
                                        table_name: 'sc_req_item',
                                        record: wfa.dataPill(params.trigger.current, 'reference'),
                                        values: TemplateValue({ stage: 'fulfillment' }),
                                    }
                                )
                            }
                        )

                        // IT group rejected
                        wfa.flowLogic.else({ $id: Now.ID['srf_it_reject'] }, () => {
                            wfa.action(
                                action.core.updateRecord,
                                { $id: Now.ID['srf_reject_it'] },
                                {
                                    table_name: 'sc_req_item',
                                    record: wfa.dataPill(params.trigger.current, 'reference'),
                                    values: TemplateValue({ approval: 'rejected' }),
                                }
                            )
                        })
                    }
                )

                // Manager rejected
                wfa.flowLogic.else({ $id: Now.ID['srf_mgr_reject'] }, () => {
                    wfa.action(
                        action.core.updateRecord,
                        { $id: Now.ID['srf_reject_mgr'] },
                        {
                            table_name: 'sc_req_item',
                            record: wfa.dataPill(params.trigger.current, 'reference'),
                            values: TemplateValue({ approval: 'rejected' }),
                        }
                    )
                })
            }
        )

        // Price <= 10,000: approvals Manager → IT Group
        wfa.flowLogic.else({ $id: Now.ID['srf_price_le_10000'] }, () => {
            const apprMgrLow = wfa.action(
                action.core.askForApproval,
                { $id: Now.ID['srf_approval_mgr_low'] },
                {
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table: 'sc_req_item',
                    approval_reason: 'Manager approval required (price ≤ 10,000).',
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
                                            groups: ['019ad92ec7230010393d265c95c260dd'], // Analytics Settings Managers
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
                    $id: Now.ID['srf_mgr_low_approved'],
                    condition: `${wfa.dataPill(apprMgrLow.approval_state, 'choice')}=approved`,
                },
                () => {
                    const apprItLow = wfa.action(
                        action.core.askForApproval,
                        { $id: Now.ID['srf_approval_it_low'] },
                        {
                            record: wfa.dataPill(params.trigger.current, 'reference'),
                            table: 'sc_req_item',
                            approval_reason: 'IT group approval required (price ≤ 10,000).',
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
                                                    groups: ['553032e853165110b846ddeeff7b12aa'], // App Engine Studio User Limited
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
                            $id: Now.ID['srf_it_low_approved'],
                            condition: `${wfa.dataPill(apprItLow.approval_state, 'choice')}=approved`,
                        },
                        () => {
                            // All approvals granted – invoke fulfillment subflow
                            const fulfillLow = wfa.subflow(
                                softwareFulfillmentTask,
                                { $id: Now.ID['srf_call_fulfill_low'] },
                                {
                                    requestItem: wfa.dataPill(params.trigger.current, 'reference'),
                                    shortDescription: 'Software request fulfillment',
                                    waitForCompletion: true,
                                }
                            )

                            // Add work note with created task number
                            wfa.action(
                                action.core.updateRecord,
                                { $id: Now.ID['srf_add_work_note_low'] },
                                {
                                    table_name: 'sc_req_item',
                                    record: wfa.dataPill(params.trigger.current, 'reference'),
                                    values: TemplateValue({
                                        work_notes: wfa.dataPill(fulfillLow.taskNumber, 'string'),
                                    }),
                                }
                            )

                            // Mark request as fulfilled
                            wfa.action(
                                action.core.updateRecord,
                                { $id: Now.ID['srf_set_fulfilled_low'] },
                                {
                                    table_name: 'sc_req_item',
                                    record: wfa.dataPill(params.trigger.current, 'reference'),
                                    values: TemplateValue({ stage: 'fulfillment' }),
                                }
                            )
                        }
                    )

                    // IT group rejected (low price)
                    wfa.flowLogic.else({ $id: Now.ID['srf_it_low_reject'] }, () => {
                        wfa.action(
                            action.core.updateRecord,
                            { $id: Now.ID['srf_reject_it_low'] },
                            {
                                table_name: 'sc_req_item',
                                record: wfa.dataPill(params.trigger.current, 'reference'),
                                values: TemplateValue({ approval: 'rejected' }),
                            }
                        )
                    })
                }
            )

            // Manager rejected (low price)
            wfa.flowLogic.else({ $id: Now.ID['srf_mgr_low_reject'] }, () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['srf_reject_mgr_low'] },
                    {
                        table_name: 'sc_req_item',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({ approval: 'rejected' }),
                    }
                )
            })
        })
    }
)