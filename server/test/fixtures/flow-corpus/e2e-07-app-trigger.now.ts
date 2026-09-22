// nowforge-spec: e2e-matrix-07
/*
 * E2E 07 — an APPLICATION trigger.
 *
 * The SDK ships five (serviceCatalog, inboundEmail, slaTask,
 * knowledgeManagement, remoteTableQuery). This proves the family is real and
 * reaches the instance; `serviceCatalog` is the one with an input to set.
 *
 * It fires only when a catalog item that names this flow is ordered, and no
 * catalog item does. The body only logs.
 */
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['e2e07_flow'],
        name: 'E2E 07 Service Catalog Trigger',
        description: 'E2E matrix: an application trigger (service catalog).',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.application.serviceCatalog,
        { $id: Now.ID['e2e07_trigger'] },
        { run_flow_in: 'background' }
    ),
    () => {
        wfa.action(
            action.core.log,
            { $id: Now.ID['e2e07_log'] },
            { log_level: 'info', log_message: 'E2E 07 catalog trigger fired.' }
        )
    }
)
