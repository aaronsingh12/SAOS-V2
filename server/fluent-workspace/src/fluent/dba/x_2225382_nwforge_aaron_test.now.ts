// nowhelpassist-dba: x_2225382_nwforge_aaron_test
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, DateColumn, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_2225382_nwforge_aaron_test = Table({
    $id: Now.ID["x_2225382_nwforge_aaron_test_table"],
    name: "x_2225382_nwforge_aaron_test",
    label: "AAron test",
    extends: "task",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    autoNumber: { prefix: "EAR", number: 1000, numberOfDigits: 7 },
    schema: {
        requested_for: ReferenceColumn({ label: "Requested For", referenceTable: "sys_user", mandatory: true }),
        request_type: StringColumn({
            label: "Request Type",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "New" },
                "1": { label: "Replacement" },
                "2": { label: "Upgrade" },
            },
        }),
        asset_type: StringColumn({
            label: "Asset Type",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Laptop" },
                "1": { label: "Desktop" },
                "2": { label: "Monitor" },
                "3": { label: "Mobile Device" },
            },
        }),
        existing_asset: ReferenceColumn({ label: "Existing Asset", referenceTable: "alm_asset" }),
        business_justification: StringColumn({ label: "Business Justification", maxLength: 4000, mandatory: true }),
        needed_by: DateColumn({ label: "Needed By", mandatory: true }),
        delivery_location: ReferenceColumn({ label: "Delivery Location", referenceTable: "cmn_location" }),
    },
})
