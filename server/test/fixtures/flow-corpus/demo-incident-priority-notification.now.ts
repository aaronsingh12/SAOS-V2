// nowforge-spec: 525f7204cb19f0a8
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['demo_incident_priority_notification_flow'],
        name: 'Demo Incident Priority Notification',
        description: 'When a new high‑priority incident is created, assign to Service Desk, add work notes, and notify the caller.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['demo_incident_priority_trigger'] },
        {
            table: 'incident',
            condition: 'priorityIN1,2^active=true',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['update_assign_group'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({
                assignment_group: 'd625dccec0a8016700a222a0f7900d06',
                work_notes: 'High-priority incident automatically routed by the Demo Incident Priority Notification flow.',
            }),
        })

        wfa.action(action.core.sendEmail, { $id: Now.ID['send_high_priority_email'] }, {
            ah_to: wfa.dataPill(params.trigger.current.caller_id.email, 'string'),
            ah_subject: `High-Priority Incident Created: ${wfa.dataPill(params.trigger.current.number, 'string')}`,
            ah_body: 'A high-priority incident has been created.',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            table_name: 'incident',
        })

        wfa.action(action.core.updateRecord, { $id: Now.ID['update_work_note_sent'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({
                work_notes: 'Notification sent to the incident caller.',
            }),
        })
    }
)