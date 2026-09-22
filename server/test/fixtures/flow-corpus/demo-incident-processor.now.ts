// nowforge-spec: a0679c1c99b457ca
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['dip_demo_incident_processor_flow'],
        name: 'Demo Incident Processor',
        description: 'Processes newly created hardware incidents: assigns group, sets critical impact/urgency, and notifies manager.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['dip_trigger'] },
        {
            table: 'incident',
            condition: 'category=hardware',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const grp = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['dip_lookup_hardware_group'] },
            {
                table: 'sys_user_group',
                conditions: `name=Hardware`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['dip_if_manager_exists'],
                condition: `${wfa.dataPill(grp.Record.manager, 'reference')}ISNOTEMPTY`,
            },
            () => {
                wfa.action(
                    action.core.sendEmail,
                    { $id: Now.ID['dip_send_email_manager'] },
                    {
                        ah_to: `${wfa.dataPill(grp.Record.manager.email, 'string')}`,
                        ah_subject: `New Hardware Incident - ${wfa.dataPill(params.trigger.current.number, 'string')}`,
                        ah_body: 'A new hardware incident has been created and assigned to your group. Please review it promptly.',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        table_name: 'incident',
                    }
                )
            }
        )

        wfa.flowLogic.else(
            { $id: Now.ID['dip_else_no_manager'] },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['dip_log_no_manager'] },
                    {
                        log_level: 'warn',
                        log_message: `Demo Incident Processor: Hardware group has no manager; email not sent for incident ${wfa.dataPill(params.trigger.current.number, 'string')}.`,
                    }
                )
            }
        )

        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['dip_update_incident'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({
                    impact: '1',
                    urgency: '1',
                    assignment_group: wfa.dataPill(grp.Record, 'reference'),
                }),
            }
        )

        wfa.action(
            action.core.log,
            { $id: Now.ID['dip_extra_test_log'] },
            {
                log_level: 'info',
                log_message: `Demo Incident Processor: processed incident ${wfa.dataPill(params.trigger.current.number, 'string')}`,
            }
        )
    }
)