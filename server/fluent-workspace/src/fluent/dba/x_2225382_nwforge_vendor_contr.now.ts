// nowhelpassist-dba: x_2225382_nwforge_vendor_contr
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, DateColumn, DecimalColumn, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_2225382_nwforge_vendor_contr = Table({
    $id: Now.ID["x_2225382_nwforge_vendor_contr_table"],
    name: "x_2225382_nwforge_vendor_contr",
    label: "Vendor Contract",
    display: "vendor_name",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        vendor_name: StringColumn({ label: "Vendor Name" }),
        contract_number: StringColumn({ label: "Contract Number", mandatory: true }),
        contract_value: DecimalColumn({ label: "Contract Value" }),
        start_date: DateColumn({ label: "Start Date" }),
        end_date: DateColumn({ label: "End Date" }),
        status: StringColumn({
            label: "Status",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Draft" },
                "1": { label: "Active" },
                "2": { label: "Expired" },
                "3": { label: "Terminated" },
            },
        }),
        owner: ReferenceColumn({ label: "Owner", referenceTable: "sys_user" }),
    },
})
