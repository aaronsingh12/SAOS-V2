// nowforge-spec: 7b0fd84b04c4f9dd
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn, BooleanColumn } from '@servicenow/sdk/core'

export const validateIdentity = Subflow(
    {
        $id: Now.ID['vi_validate_identity_subflow'],
        name: 'Validate Identity',
        description: 'Validates that a user is active and has an email address.',
        runAs: 'system',
        inputs: {
            user: ReferenceColumn({ label: 'User', referenceTable: 'sys_user', mandatory: true })
        },
        outputs: {
            isValid: BooleanColumn({ label: 'Is Valid' })
        }
    },
    (params) => {
        const userRec = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['vi_lookup_user'] },
            {
                table: 'sys_user',
                conditions: `sys_id=${wfa.dataPill(params.inputs.user, 'string')}`
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['vi_if_active'],
                condition: `${wfa.dataPill(userRec.Record.active, 'boolean')}=true`
            },
            () => {
                wfa.flowLogic.if(
                    {
                        $id: Now.ID['vi_if_email'],
                        condition: `${wfa.dataPill(userRec.Record.email, 'string')}ISNOTEMPTY`
                    },
                    () => {
                        wfa.flowLogic.assignSubflowOutputs(
                            { $id: Now.ID['vi_out_valid'] },
                            params.outputs,
                            { isValid: true }
                        )
                    }
                )
                wfa.flowLogic.else(
                    { $id: Now.ID['vi_else_no_email'] },
                    () => {
                        wfa.flowLogic.assignSubflowOutputs(
                            { $id: Now.ID['vi_out_invalid_no_email'] },
                            params.outputs,
                            { isValid: false }
                        )
                    }
                )
            }
        )
        wfa.flowLogic.else(
            { $id: Now.ID['vi_else_not_active'] },
            () => {
                wfa.flowLogic.assignSubflowOutputs(
                    { $id: Now.ID['vi_out_invalid_not_active'] },
                    params.outputs,
                    { isValid: false }
                )
            }
        )
    }
)