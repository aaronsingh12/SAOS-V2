// nowhelpassist-dba: x_2225382_nwforge_emp_assets
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, DateColumn, StringColumn } from '@servicenow/sdk/core'

export const x_2225382_nwforge_emp_assets = Table({
    $id: Now.ID["x_2225382_nwforge_emp_assets_table"],
    name: "x_2225382_nwforge_emp_assets",
    label: "Employee Assets",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        employee_name: StringColumn({ label: "Employee Name" }),
        asset_name: StringColumn({ label: "Asset Name" }),
        asset_tag: StringColumn({ label: "Asset Tag" }),
        asset_type: StringColumn({
            label: "Asset Type",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Laptop" },
                "1": { label: "Desktop" },
                "2": { label: "Mobile Phone" },
                "3": { label: "Tablet" },
            },
        }),
        assigned_date: DateColumn({ label: "Assigned Date" }),
    },
})
