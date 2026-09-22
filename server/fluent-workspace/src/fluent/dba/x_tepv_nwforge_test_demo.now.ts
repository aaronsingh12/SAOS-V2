// nowhelpassist-dba: x_tepv_nwforge_test_demo
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, IntegerColumn, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_tepv_nwforge_test_demo = Table({
    $id: Now.ID["x_tepv_nwforge_test_demo_table"],
    name: "x_tepv_nwforge_test_demo",
    label: "Test Demo",
    extends: "task",
    display: "u_name",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        u_name: StringColumn({ label: "Name", maxLength: 40 }),
        u_priority: IntegerColumn({ label: "Priority" }),
        u_status: StringColumn({
            label: "Status",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "New" },
                "1": { label: "In Progress" },
                "2": { label: "Closed" },
            },
        }),
        u_assigned_to: ReferenceColumn({ label: "Assigned To", referenceTable: "sys_user" }),
    },
})
