// nowforge-spec: a761451fbca44f21
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['demo_incident_flow_main'],
        name: 'Demo Incident Flow',
        description: 'When a new Incident is created, if priority is 1 send email to Incident Manager group and set u_demo_flag, otherwise add work note.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['demo_incident_created_trigger'] },
        {
            table: 'incident',
            condition: '',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const mgrGroup = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['lookup_incident_manager_group'] },
            {
                table: 'sys_user_group',
                conditions: `name=Incident Manager`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['if_priority_critical'],
                condition: `${wfa.dataPill(params.trigger.current.priority, 'integer')}=1`,
            },
            () => {
                wfa.action(action.core.sendEmail, { $id: Now.ID['email_to_incident_manager'] }, {
                    ah_to: `${wfa.dataPill(mgrGroup.Record.email, 'string')}`,
                    ah_subject: `Critical incident ${wfa.dataPill(params.trigger.current.number, 'string')} created`,
                    ah_body: 'A critical incident has been created and requires your attention.',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    table_name: 'incident',
                })

                wfa.action(action.core.updateRecord, { $id: Now.ID['update_demo_flag'] }, {
                    table_name: 'incident',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({ u_demo_flag: true }),
                })
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['else_non_critical'] }, () => {
            wfa.action(action.core.updateRecord, { $id: Now.ID['add_non_critical_work_note'] }, {
                table_name: 'incident',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({ work_notes: 'Demo flow executed: non‑critical incident.' }),
            })
        })
    }
)