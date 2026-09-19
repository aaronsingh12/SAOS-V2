// nowforge-spec: 2c64333414fe550a
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['mlr_flow'],
        name: 'Manager Approval for Laptop Request',
        description: 'Triggers manager approval for laptop request RITM, creates a catalog task, waits for completion, then closes the RITM.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['mlr_trigger'] },
        {
            table: 'sc_req_item',
            condition: 'cat_item=c15f556fc31fc310341abecdd4013157',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const approval = wfa.action(
            action.core.askForApproval,
            { $id: Now.ID['mlr_approval'] },
            {
                record: wfa.dataPill(params.trigger.current, 'reference'),
                table: 'sc_req_item',
                approval_reason: 'Manager approval required for laptop request',
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
                                        groups: ['113e011bc35b4310341abecdd401315e'],
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
                $id: Now.ID['mlr_if_approved'],
                condition: `${wfa.dataPill(approval.approval_state, 'choice')}=approved`,
            },
            () => {
                const task = wfa.action(
                    action.core.createRecord,
                    { $id: Now.ID['mlr_create_task'] },
                    {
                        table_name: 'sc_task',
                        values: TemplateValue({
                            request_item: wfa.dataPill(params.trigger.current, 'reference'),
                            assignment_group: '113e011bc35b4310341abecdd401315e',
                            short_description: 'Laptop request fulfillment task',
                        }),
                    }
                )

                wfa.action(
                    action.core.waitForCondition,
                    { $id: Now.ID['mlr_wait_task'] },
                    {
                        record: wfa.dataPill(task.record, 'reference'),
                        conditions: 'state=3',
                    }
                )

                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['mlr_close_ritm'] },
                    {
                        table_name: 'sc_req_item',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            state: 3,
                            close_notes: 'Laptop request fulfilled and closed after manager approval.',
                        }),
                    }
                )
            }
        )

        wfa.flowLogic.else(
            { $id: Now.ID['mlr_else_reject'] },
            () => {
                wfa.action(action.core.log, { $id: Now.ID['mlr_log_reject'] }, {
                    log_level: 'info',
                    log_message: `Laptop request RITM ${wfa.dataPill(params.trigger.current.number, 'string')} was rejected by manager approval.`,
                })
            }
        )
    }
)