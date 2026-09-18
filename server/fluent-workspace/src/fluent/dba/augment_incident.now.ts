// nowhelpassist-dba: augment incident
// Generated from a validated augment spec. The base object is NOT edited —
// these columns are owned by this application and attached to incident.
// Additive only: undoing an augment is drop_column, which is irreversible.
import { Table, StringColumn, CrossScopePrivilege } from '@servicenow/sdk/core'

export const incident = Table({
    $id: Now.ID["x_2225382_nwforge_augment_incident"],
    augments: "incident",
    schema: {
        x_2225382_nwforge_triage_note: StringColumn({ label: "Triage Note", maxLength: 400 }),
    },
})

CrossScopePrivilege({
    $id: Now.ID["x_2225382_nwforge_xsp_incident_read"],
    operation: "read",
    status: 'allowed',
    targetType: 'sys_db_object',
    targetScope: "global",
    targetName: "incident",
})

CrossScopePrivilege({
    $id: Now.ID["x_2225382_nwforge_xsp_incident_write"],
    operation: "write",
    status: 'allowed',
    targetType: 'sys_db_object',
    targetScope: "global",
    targetName: "incident",
})
