// nowforge-spec: a93c1b0d5b259daa
/*
 * SESSION 2c / G1 — THE CONTROL.
 *
 * This is a measuring instrument, not a feature. It is an exact structural
 * mirror of "Onboarding Priority Check Flow" with ONE variable changed: the
 * trigger table lives inside this application's own scope
 * (x_2002152_nwforge_net_inc_demo) instead of the global `incident` table.
 *
 * Everything else is held constant on purpose — trigger.record.created, an
 * empty condition, run_flow_in 'background', runAs 'system', and a single
 * core.updateRecord action stamping one literal into a plain string column.
 * There is deliberately no subflow: the golden flow produced ZERO
 * sys_flow_context rows, so nothing after the trigger can be implicated, and
 * the probe must not add a second thing that could fail.
 *
 * Fires  -> cross-scope trigger registration is why the golden flow is silent.
 * Silent -> scope is exonerated and the suspect becomes registration at
 *           install time. Either way the answer comes from the normal
 *           install/activate channel; nothing writes to sys_trigger.
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation';

Flow(
    {
        $id: Now.ID['tsp_flow'],
        name: 'Trigger Scope Probe Flow',
        description: 'Session 2c control. Record-create trigger on an own-scope table, one action, one literal. Isolates cross-scope trigger registration.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['tsp_trigger'] },
        {
            table: 'x_2002152_nwforge_net_inc_demo',
            condition: '',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['tsp_update_note'] },
            {
                table_name: 'x_2002152_nwforge_net_inc_demo',
                record: wfa.dataPill(params.trigger.current, 'reference'),
                values: TemplateValue({ work_notes: 'Own scope trigger fired' }),
            }
        );
    }
)
