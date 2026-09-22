// nowforge-spec: 548c9c56af79aee0
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { multiLevelApprovalsForSoftwareRequests } from './multi-level-approvals-for-software-requests.now'

Flow(
    {
        $id: Now.ID['asri_flow'],
        name: 'Assign Software Request Items',
        description: 'Assigns sc_req_item based on total cost and invokes approvals if needed.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.updated,
        { $id: Now.ID['asri_trigger'] },
        {
            table: 'sc_req_item',
            condition: 'stateCHANGES',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['asri_if_low_cost'],
                condition: `${wfa.dataPill(params.trigger.current.price, 'currency')}*${wfa.dataPill(params.trigger.current.quantity, 'integer')}<=10000`,
            },
            () => {
                wfa.action(action.core.updateRecord, { $id: Now.ID['asri_update_assign'] }, {
                    table_name: 'sc_req_item',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({
                        assignment_group: 'd513ae82730f0b90a40ef7303ab8b73f',
                        work_notes: 'Assigned to IT Support group as total cost is within limit.',
                    }),
                })

                const verifyLow = wfa.action(action.core.lookUpRecord, { $id: Now.ID['asri_verify_low'] }, {
                    table: 'sc_req_item',
                    conditions: `sys_id=${wfa.dataPill(params.trigger.current.sys_id, 'string')}`,
                })

                wfa.action(action.core.log, { $id: Now.ID['asri_log_low'] }, {
                    log_level: 'info',
                    log_message: `Verification: assignment_group = ${wfa.dataPill(verifyLow.Record.assignment_group, 'string')}`,
                })
            }
        )
        wfa.flowLogic.else({ $id: Now.ID['asri_else_high'] }, () => {
            wfa.subflow(
                multiLevelApprovalsForSoftwareRequests,
                { $id: Now.ID['asri_call_approvals'] },
                {
                    requestItem: wfa.dataPill(params.trigger.current, 'reference'),
                    waitForCompletion: true,
                }
            )

            const verifyHigh = wfa.action(action.core.lookUpRecord, { $id: Now.ID['asri_verify_high'] }, {
                table: 'sc_req_item',
                conditions: `sys_id=${wfa.dataPill(params.trigger.current.sys_id, 'string')}`,
            })

            wfa.action(action.core.log, { $id: Now.ID['asri_log_high'] }, {
                log_level: 'info',
                log_message: `Post‑approval verification: assignment_group = ${wfa.dataPill(verifyHigh.Record.assignment_group, 'string')}`,
            })
        })
    }
)