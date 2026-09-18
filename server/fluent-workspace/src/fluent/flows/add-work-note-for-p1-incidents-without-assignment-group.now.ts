// nowforge-spec: 5528f1192dc34fb8
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
  {
    $id: Now.ID['awp1_flow'],
    name: 'Add Work Note for P1 Incidents Without Assignment Group',
    description: 'When an incident is updated to priority 1 and has no assignment group, add a triage work note.',
    runAs: 'system',
  },
  wfa.trigger(
    trigger.record.updated,
    { $id: Now.ID['awp1_trigger'] },
    {
      table: 'incident',
      condition: 'priority=1^assignment_groupISEMPTY',
      run_flow_in: 'background',
      trigger_strategy: 'unique_changes',
    }
  ),
  (params) => {
    wfa.action(
      action.core.updateRecord,
      { $id: Now.ID['awp1_update_record'] },
      {
        table_name: 'incident',
        record: wfa.dataPill(params.trigger.current, 'reference'),
        values: TemplateValue({
          work_notes: 'NowForge: P1 with no assignment group - needs triage.',
        }),
      }
    )
  }
)