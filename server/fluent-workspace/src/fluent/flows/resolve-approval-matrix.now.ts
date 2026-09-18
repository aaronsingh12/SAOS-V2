// nowforge-spec: 1e7e0c35402cc1cc
import { Subflow, action, wfa } from '@servicenow/sdk/automation'

export const resolveApprovalMatrix = Subflow(
    {
        $id: Now.ID['ramm_resolve_approval_matrix'],
        name: 'Resolve Approval Matrix',
        description: 'Resolves the approval matrix for a given context.',
        runAs: 'system',
    },
    () => {
        wfa.action(
            action.core.log,
            {
                $id: Now.ID['ramm_resolve_approval_matrix_log'],
                annotation: 'Log invocation of Resolve Approval Matrix',
            },
            {
                log_level: 'info',
                log_message:
                    'Resolve Approval Matrix invoked. Approval matrix resolution logic is not yet implemented.',
            }
        )
    }
)
