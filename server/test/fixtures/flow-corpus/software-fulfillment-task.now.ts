// nowforge-spec: 62045354c6086723
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn, ReferenceColumn } from '@servicenow/sdk/core'

export const softwareFulfillmentTask = Subflow(
  {
    $id: Now.ID['sft_software_fulfillment_task'],
    name: 'Software Fulfillment Task',
    description: 'Creates a catalog task for a request item, assigns to Software group, updates request item stage, and adds a work note.',
    runAs: 'system',
    inputs: {
      requestItem: ReferenceColumn({ label: 'Request Item', referenceTable: 'sc_req_item', mandatory: true }),
      shortDescription: StringColumn({ label: 'Short Description', mandatory: true }),
    },
    outputs: {
      taskSysId: StringColumn({ label: 'Task Sys ID' }),
      taskNumber: StringColumn({ label: 'Task Number' }),
      successMessage: StringColumn({ label: 'Success Message' }),
    },
  },
  (params) => {
    const task = wfa.action(
      action.core.createRecord,
      { $id: Now.ID['sft_create_task'] },
      {
        table_name: 'sc_task',
        values: TemplateValue({
          short_description: wfa.dataPill(params.inputs.shortDescription, 'string'),
          assignment_group: '8a4dde73c6112278017a6a4baf547aa7',
          request_item: wfa.dataPill(params.inputs.requestItem, 'reference'),
        }),
      }
    )

    wfa.action(
      action.core.updateRecord,
      { $id: Now.ID['sft_update_req_stage'] },
      {
        table_name: 'sc_req_item',
        record: wfa.dataPill(params.inputs.requestItem, 'reference'),
        values: TemplateValue({ stage: 'fulfillment' }),
      }
    )

    wfa.action(
      action.core.updateRecord,
      { $id: Now.ID['sft_add_work_note'] },
      {
        table_name: 'sc_req_item',
        record: wfa.dataPill(params.inputs.requestItem, 'reference'),
        values: TemplateValue({
          work_notes: wfa.dataPill(task.record.number, 'string'),
        }),
      }
    )

    wfa.flowLogic.assignSubflowOutputs(
      { $id: Now.ID['sft_assign_outputs'] },
      params.outputs,
      {
        taskSysId: wfa.dataPill(task.record.sys_id, 'string'),
        taskNumber: wfa.dataPill(task.record.number, 'string'),
        successMessage: 'Task created',
      }
    )
  }
)