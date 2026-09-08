// nowforge-spec: 35a58c949a7e1031
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn } from '@servicenow/sdk/core'

export const multiLevelApprovalsForSoftwareRequests = Subflow(
  {
    $id: Now.ID['mlap_software_requests_subflow'],
    name: 'Multi‑Level Approvals for Software Requests',
    description: 'Handles multi‑level approvals for software request items.',
    runAs: 'system',
    inputs: {
      requestItem: ReferenceColumn({ label: 'Request Item', referenceTable: 'sc_req_item', mandatory: true })
    }
  },
  (params) => {
    // Initial work note
    wfa.action(action.core.updateRecord, { $id: Now.ID['mlap_add_initial_note'] }, {
      table_name: 'sc_req_item',
      record: wfa.dataPill(params.inputs.requestItem, 'reference'),
      values: TemplateValue({ work_notes: 'Starting multi‑level approval process.' })
    })

    // Lookup requestor user
    const reqUser = wfa.action(action.core.lookUpRecord, { $id: Now.ID['mlap_lookup_req_user'] }, {
      table: 'sys_user',
      conditions: `sys_id=${wfa.dataPill(params.inputs.requestItem.requested_for, 'string')}`
    })

    // Requestor manager approval
    const mgrApproval = wfa.action(action.core.askForApproval, { $id: Now.ID['mlap_mgr_approval'] }, {
      record: wfa.dataPill(params.inputs.requestItem, 'reference'),
      table: 'sc_req_item',
      approval_reason: 'Requestor manager approval required',
      approval_conditions: wfa.approvalRules({
        conditionType: 'OR',
        ruleSets: [{
          action: 'ApprovesRejects',
          conditionType: 'AND',
          rules: [[{ ruleType: 'Any', users: [wfa.dataPill(reqUser.Record.manager, 'string')] }]]
        }]
      })
    })

    wfa.flowLogic.if(
      {
        $id: Now.ID['mlap_mgr_approved'],
        condition: `${wfa.dataPill(mgrApproval.approval_state, 'choice')}=approved`
      },
      () => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['mlap_note_mgr_approved'] }, {
          table_name: 'sc_req_item',
          record: wfa.dataPill(params.inputs.requestItem, 'reference'),
          values: TemplateValue({ work_notes: 'Requestor manager approved.' })
        })
      }
    )

    // Lookup IT Support group manager
    const itGroup = wfa.action(action.core.lookUpRecord, { $id: Now.ID['mlap_lookup_it_group'] }, {
      table: 'sys_user_group',
      conditions: `name=IT Support`
    })

    // IT Support manager approval
    const itApproval = wfa.action(action.core.askForApproval, { $id: Now.ID['mlap_it_approval'] }, {
      record: wfa.dataPill(params.inputs.requestItem, 'reference'),
      table: 'sc_req_item',
      approval_reason: 'IT Support manager approval required',
      approval_conditions: wfa.approvalRules({
        conditionType: 'OR',
        ruleSets: [{
          action: 'ApprovesRejects',
          conditionType: 'AND',
          rules: [[{ ruleType: 'Any', users: [wfa.dataPill(itGroup.Record.manager, 'string')] }]]
        }]
      })
    })

    wfa.flowLogic.if(
      {
        $id: Now.ID['mlap_it_approved'],
        condition: `${wfa.dataPill(itApproval.approval_state, 'choice')}=approved`
      },
      () => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['mlap_note_it_approved'] }, {
          table_name: 'sc_req_item',
          record: wfa.dataPill(params.inputs.requestItem, 'reference'),
          values: TemplateValue({ work_notes: 'IT Support manager approved.' })
        })
      }
    )

    // Conditional CIO approval if price > 50000
    wfa.flowLogic.if(
      {
        $id: Now.ID['mlap_cio_condition'],
        condition: `${wfa.dataPill(params.inputs.requestItem.price, 'integer')}>50000`
      },
      () => {
        const cioApproval = wfa.action(action.core.askForApproval, { $id: Now.ID['mlap_cio_approval'] }, {
          record: wfa.dataPill(params.inputs.requestItem, 'reference'),
          table: 'sc_req_item',
          approval_reason: 'CIO approval required',
          approval_conditions: wfa.approvalRules({
            conditionType: 'OR',
            ruleSets: [{
              action: 'ApprovesRejects',
              conditionType: 'AND',
              rules: [[{ ruleType: 'Any', users: ['5613ae82730f0b90a40ef7303ab8b7bb'] }]]
            }]
          })
        })

        wfa.flowLogic.if(
          {
            $id: Now.ID['mlap_cio_approved'],
            condition: `${wfa.dataPill(cioApproval.approval_state, 'choice')}=approved`
          },
          () => {
            wfa.action(action.core.updateRecord, { $id: Now.ID['mlap_note_cio_approved'] }, {
              table_name: 'sc_req_item',
              record: wfa.dataPill(params.inputs.requestItem, 'reference'),
              values: TemplateValue({ work_notes: 'CIO approved.' })
            })
          }
        )
      }
    )

    // Final work note marking request as approved
    wfa.action(action.core.updateRecord, { $id: Now.ID['mlap_final_note'] }, {
      table_name: 'sc_req_item',
      record: wfa.dataPill(params.inputs.requestItem, 'reference'),
      values: TemplateValue({ work_notes: 'All approvals completed. Request approved.' })
    })
  }
)