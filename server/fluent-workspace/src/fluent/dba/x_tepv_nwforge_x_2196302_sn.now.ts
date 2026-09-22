// nowhelpassist-dba: x_tepv_nwforge_x_2196302_sn
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, BooleanColumn, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_tepv_nwforge_x_2196302_sn = Table({
    $id: Now.ID["x_tepv_nwforge_x_2196302_sn_table"],
    name: "x_tepv_nwforge_x_2196302_sn",
    label: "Demo Table",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        short_description: StringColumn({ label: "Short Description", maxLength: 100 }),
        description: StringColumn({ label: "Description", maxLength: 500 }),
        active: BooleanColumn({ label: "Active", default: true }),
        assigned_to: ReferenceColumn({ label: "Assigned To", referenceTable: "sys_user" }),
    },
})
