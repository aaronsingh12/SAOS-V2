// nowforge-spec: 760d0f37ea51f7e5
import { Flow, Subflow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { StringColumn, BooleanColumn } from '@servicenow/sdk/core'

export const notifyManager = Subflow(
    {
        $id: Now.ID['notify_manager_subflow'],
        name: 'Notify Manager',
        description: 'Emails the manager of the task record\'s assignment group.',
        runAs: 'system',
        inputs: {
            taskTable: StringColumn({ label: 'Task Table', mandatory: true }),
            taskSysId: StringColumn({ label: 'Task Sys ID', mandatory: true }),
            message: StringColumn({ label: 'Message', mandatory: true }),
        },
        outputs: {
            notified: BooleanColumn({ label: 'Notified' }),
            managerEmail: StringColumn({ label: 'Manager Email' }),
        },
    },
    (params) => {
        const task = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['nm_lookup_task'] },
            {
                table: wfa.dataPill(params.inputs.taskTable, 'string'),
                conditions: `sys_id=${wfa.dataPill(params.inputs.taskSysId, 'string')}`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['nm_has_manager_email'],
                condition: `${wfa.dataPill(task.Record.assignment_group.manager.email, 'string')}ISEMPTY`,
            },
            () => {
                wfa.action(action.core.log, { $id: Now.ID['nm_no_manager'] }, {
                    log_level: 'warn',
                    log_message: 'Notify Manager: assignment group has no manager email.',
                })

                wfa.flowLogic.assignSubflowOutputs(
                    { $id: Now.ID['nm_outputs_no_manager'] },
                    params.outputs,
                    { notified: false, managerEmail: '' }
                )
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['nm_send_email_path'] }, () => {
            wfa.action(action.core.sendEmail, { $id: Now.ID['nm_send_email'] }, {
                ah_to: `${wfa.dataPill(task.Record.assignment_group.manager.email, 'string')}`,
                ah_subject: `${wfa.dataPill(params.inputs.message, 'string')} - ${wfa.dataPill(task.Record.number, 'string')}`,
                ah_body: 'A record assigned to your group requires your attention.',
                record: wfa.dataPill(task.Record, 'reference'),
                table_name: wfa.dataPill(params.inputs.taskTable, 'string'),
            })

            wfa.flowLogic.assignSubflowOutputs(
                { $id: Now.ID['nm_outputs_sent'] },
                params.outputs,
                {
                    notified: true,
                    managerEmail: wfa.dataPill(task.Record.assignment_group.manager.email, 'string'),
                }
            )
        })
    }
)

Flow(
    {
        $id: Now.ID['escalate_network_p1_incident_flow'],
        name: 'Escalate Network P1 Incident',
        description: 'Escalates P1 incidents assigned to the Network group by notifying the group manager and assigning the incident.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['escalate_network_p1_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1^assignment_group.name=Network^assigned_toISEMPTY',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const group = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['lookup_network_group'] },
            {
                table: 'sys_user_group',
                conditions: `name=Network`,
            }
        )

        wfa.subflow(
            notifyManager,
            { $id: Now.ID['call_notify_manager'], annotation: 'Notify Manager' },
            {
                taskTable: 'incident',
                taskSysId: wfa.dataPill(params.trigger.current.sys_id, 'string'),
                message: 'P1 escalation - Network group manager notification',
                waitForCompletion: true,
            }
        )

        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['add_work_note'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    work_notes: 'NowForge URGENT escalation to the Network group manager',
                }),
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['assign_if_unassigned'],
                condition: `${wfa.dataPill(params.trigger.current.assigned_to, 'reference')}ISEMPTY`,
            },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['set_assigned_to_manager'] },
                    {
                        table_name: 'incident',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            assigned_to: wfa.dataPill(group.Record.manager, 'reference'),
                        }),
                    }
                )
            }
        )
    }
)