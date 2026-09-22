// nowforge-spec: b14bd73624ec1f03
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn, BooleanColumn } from '@servicenow/sdk/core'
import { validateApplicationData } from './validate-application-data.now'
import { validateIdentity } from './validate-identity.now'

export const validateLaptopReplacementRequest = Subflow(
    {
        $id: Now.ID['vlr_subflow'],
        name: 'Validate Laptop Replacement Request',
        description: 'Validates a laptop replacement request by checking application data and user identity.',
        runAs: 'system',
        inputs: {
            requestItem: ReferenceColumn({ label: 'Request Item', referenceTable: 'sc_req_item', mandatory: true }),
            user: ReferenceColumn({ label: 'User', referenceTable: 'sys_user', mandatory: true }),
        },
        outputs: {
            isValid: BooleanColumn({ label: 'Is Valid' }),
        },
    },
    (params) => {
        wfa.action(action.core.log, { $id: Now.ID['vlr_log_req_item'] }, {
            log_level: 'info',
            log_message: `Validating request item ${wfa.dataPill(params.inputs.requestItem, 'reference')}`,
        })

        wfa.subflow(validateApplicationData, { $id: Now.ID['vlr_call_validate_app'] }, {
            waitForCompletion: true,
        })

        const identityResult = wfa.subflow(validateIdentity, { $id: Now.ID['vlr_call_validate_identity'] }, {
            user: wfa.dataPill(params.inputs.user, 'reference'),
            waitForCompletion: true,
        })

        wfa.flowLogic.assignSubflowOutputs(
            { $id: Now.ID['vlr_assign_outputs'] },
            params.outputs,
            {
                isValid: wfa.dataPill(identityResult.isValid, 'boolean'),
            }
        )
    }
)