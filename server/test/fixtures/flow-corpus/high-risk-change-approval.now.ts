// nowforge-spec: 8adebe3048062d0c
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['hrc_flow'],
        name: 'High Risk Change Approval',
        description: 'When a change request is created with high risk, request approval from the Network group manager and add a work note upon approval.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['hrc_trigger'] },
        {
            table: 'change_request',
            condition: 'risk=2',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const grp = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['hrc_lookup_group'] },
            {
                table: 'sys_user_group',
                conditions: `name=Network`,
            }
        )

        const appr = wfa.action(
            action.core.askForApproval,
            { $id: Now.ID['hrc_ask_approval'] },
            {
                record: wfa.dataPill(params.trigger.current, 'reference'),
                table: 'change_request',
                approval_reason: 'High Risk Change Approval',
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
                                        groups: [wfa.dataPill(grp.Record.manager, 'reference')],
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
                $id: Now.ID['hrc_if_approved'],
                condition: `${wfa.dataPill(appr.approval_state, 'choice')}=approved`,
            },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['hrc_update_worknote'] },
                    {
                        table_name: 'change_request',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            work_notes: 'NowForge: change approved by the Network manager',
                        }),
                    }
                )
            }
        )
    }
)