// nowforge-spec: 22e481ffbcecf37b
import { Subflow, wfa, action } from '@servicenow/sdk/automation'

export const validateApplicationData = Subflow(
    {
        $id: Now.ID['vad_subflow'],
        name: 'Validate Application Data',
        description: 'Validates application data.',
        runAs: 'system',
    },
    () => {
        wfa.action(action.core.log, { $id: Now.ID['vad_log'] }, {
            log_level: 'info',
            log_message: 'Validate Application Data subflow executed.',
        })
    }
)