// nowforge-spec: 6769741c90807f2b
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['sra_flow'],
        name: 'Software Request Approval Flow',
        description: 'Handles approvals for Software Request catalog items and creates a task on approval.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['sra_trigger'] },
        {
            table: 'sc_req_item',
            condition: 'cat_item=8fd1ee7297c2019021983d1e6253af28',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const managerApproval = wfa.action(
            action.core.askForApproval,
            { $id: Now.ID['sra_manager_approval'] },
            {
                record: wfa.dataPill(params.trigger.current, 'reference'),
                table: 'sc_req_item',
                approval_reason: 'Software request requires manager approval',
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
                                        groups: ['019ad92ec7230010393d265c95c260dd'],
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
                $id: Now.ID['sra_approval_if'],
                condition: `${wfa.dataPill(managerApproval.approval_state, 'choice')}=approved`,
            },
            () => {
                const taskResult = wfa.action(
                    action.core.createRecord,
                    { $id: Now.ID['sra_create_task'] },
                    {
                        table_name: 'sc_task',
                        values: TemplateValue({
                            short_description: 'Install/Provision requested software',
                            description: 'Provisioning task for software request.',
                            request_item: wfa.dataPill(params.trigger.current, 'reference'),
                            state: 1,
                        }),
                    }
                )

                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['sra_update_req_approved'] },
                    {
                        table_name: 'sc_req_item',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            state: 2,
                            work_notes: `Approved by manager. Provisioning task ${wfa.dataPill(taskResult.record, 'reference')} created.`,
                        }),
                    }
                )
            }
        )

        wfa.flowLogic.else(
            { $id: Now.ID['sra_approval_else'] },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['sra_update_req_rejected'] },
                    {
                        table_name: 'sc_req_item',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            state: 3,
                            work_notes: 'Request rejected by manager.',
                        }),
                    }
                )
            }
        )
    }
)