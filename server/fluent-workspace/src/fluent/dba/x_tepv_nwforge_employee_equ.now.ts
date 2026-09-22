// nowhelpassist-dba: x_tepv_nwforge_employee_equ
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, DateTimeColumn, ReferenceColumn } from '@servicenow/sdk/core'

export const x_tepv_nwforge_employee_equ = Table({
    $id: Now.ID["x_tepv_nwforge_employee_equ_table"],
    name: "x_tepv_nwforge_employee_equ",
    label: "Employee Equipment Request",
    extends: "task",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        u_requested_for: ReferenceColumn({ label: "Requested For", referenceTable: "sys_user", mandatory: true }),
        u_requested_by: ReferenceColumn({ label: "Requested By", referenceTable: "sys_user", mandatory: true }),
        u_due_date: DateTimeColumn({ label: "Due Date" }),
    },
})
