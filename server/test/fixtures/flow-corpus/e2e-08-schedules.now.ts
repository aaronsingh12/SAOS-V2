// nowforge-spec: e2e-matrix-08
/*
 * E2E 08–11 — the four scheduled forms `daily` did not cover.
 *
 * A flow takes exactly one trigger, so each form needs its own artifact. They
 * are kept in one FILE because they are one experiment: weekly by day-of-week,
 * monthly by day-of-month, a repeating interval, and a one-shot at a fixed
 * datetime — each with the parameters the SDK marks mandatory for it.
 *
 * None of them is published, and every body is a single log. `runOnce` is dated
 * 2027 so that even an accidental activation has nothing to do today.
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['e2e08_flow'],
        name: 'E2E 08 Scheduled Weekly',
        description: 'E2E matrix: scheduled.weekly, day_of_week + time.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.weekly,
        { $id: Now.ID['e2e08_trigger'] },
        { day_of_week: 3, time: Time({ hours: 9, minutes: 15, seconds: 0 }, 'UTC') }
    ),
    () => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e08_log'] },
            { log_level: 'info', log_message: 'E2E 08 weekly tick.' }
        )
    }
)

Flow(
    {
        $id: Now.ID['e2e09_flow'],
        name: 'E2E 09 Scheduled Monthly',
        description: 'E2E matrix: scheduled.monthly, day_of_month + time.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.monthly,
        { $id: Now.ID['e2e09_trigger'] },
        { day_of_month: 15, time: Time({ hours: 6, minutes: 45, seconds: 0 }, 'UTC') }
    ),
    () => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e09_log'] },
            { log_level: 'info', log_message: 'E2E 09 monthly tick.' }
        )
    }
)

Flow(
    {
        $id: Now.ID['e2e10_flow'],
        name: 'E2E 10 Scheduled Repeat',
        description: 'E2E matrix: scheduled.repeat with a Duration interval.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.repeat,
        { $id: Now.ID['e2e10_trigger'] },
        { repeat: Duration({ minutes: 30 }) }
    ),
    () => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e10_log'] },
            { log_level: 'info', log_message: 'E2E 10 repeat tick.' }
        )
    }
)

Flow(
    {
        $id: Now.ID['e2e11_flow'],
        name: 'E2E 11 Scheduled Run Once',
        description: 'E2E matrix: scheduled.runOnce at a fixed datetime.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.runOnce,
        { $id: Now.ID['e2e11_trigger'] },
        { run_in: '2027-01-01 09:00:00' }
    ),
    () => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e11_log'] },
            { log_level: 'info', log_message: 'E2E 11 one-shot.' }
        )
    }
)
