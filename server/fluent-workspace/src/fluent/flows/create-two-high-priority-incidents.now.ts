// nowforge-spec: 05061d9e7d2ab025
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['cth_flow'],
        name: 'Create Two High Priority Incidents',
        description: 'Creates two high‑priority incidents: WIFI issue and VPN caller.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.daily,
        { $id: Now.ID['cth_trigger'] },
        { time: Time({ hours: 0, minutes: 0, seconds: 0 }, 'UTC') }
    ),
    () => {
        wfa.action(
            action.core.createRecord,
            { $id: Now.ID['cth_create_inc1'] },
            {
                table_name: 'incident',
                values: TemplateValue({
                    short_description: 'WIFI is not working',
                    impact: '2',
                    urgency: '1',
                }),
            }
        )

        wfa.action(
            action.core.createRecord,
            { $id: Now.ID['cth_create_inc2'] },
            {
                table_name: 'incident',
                values: TemplateValue({
                    short_description: 'Abel tuter caller for VPN',
                    impact: '2',
                    urgency: '1',
                }),
            }
        )
    }
)