import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

/**
 * UC3 - "Daily P1 Digest"
 *
 * Every day at 07:00 IST, find active unassigned P1 incidents and email a
 * summary to the Network team.
 */
Flow(
    {
        $id: Now.ID['daily_p1_digest_flow'],
        name: 'Daily P1 Digest',
        description: 'Emails a daily summary of unassigned active P1 incidents.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.daily,
        { $id: Now.ID['dpd_trigger'] },
        { time: Time({ hours: 7, minutes: 0, seconds: 0 }, 'Asia/Kolkata') }
    ),
    // No `params` binding: a scheduled trigger exposes no `current` record, and the
    // build enforces noUnusedParameters (TS6133).
    () => {
        const open = wfa.action(
            action.core.lookUpRecords,
            { $id: Now.ID['dpd_lookup'], annotation: 'Find unassigned active P1 incidents' },
            {
                table: 'incident',
                conditions: 'active=true^priority=1^assigned_toISEMPTY',
                max_results: 100,
                sort_column: 'sys_created_on',
                sort_type: 'sort_desc',
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['dpd_any_found'],
                label: 'At least one unassigned P1',
                condition: `${wfa.dataPill(open.Count, 'integer')}>0`,
            },
            () => {
                wfa.action(
                    action.core.sendEmail,
                    { $id: Now.ID['dpd_email'], annotation: 'Email the digest' },
                    {
                        ah_to: 'network-team@example.com',
                        ah_subject: `Daily P1 digest - ${wfa.dataPill(open.Count, 'integer')} unassigned P1 incidents`,
                        ah_body: 'Unassigned active P1 incidents require triage. Open the P1 queue in ServiceNow.',
                    }
                )

                wfa.flowLogic.forEach(
                    wfa.dataPill(open.Records, 'records'),
                    { $id: Now.ID['dpd_each'] },
                    (inc) => {
                        wfa.action(
                            action.core.log,
                            { $id: Now.ID['dpd_log_each'] },
                            {
                                log_level: 'info',
                                log_message: `Unassigned P1: ${wfa.dataPill(inc.number, 'string')}`,
                            }
                        )
                    }
                )
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['dpd_none'] }, () => {
            wfa.action(
                action.core.log,
                { $id: Now.ID['dpd_log_none'] },
                {
                    log_level: 'info',
                    log_message: 'Daily P1 digest: no unassigned P1 incidents.',
                }
            )
        })
    }
)
