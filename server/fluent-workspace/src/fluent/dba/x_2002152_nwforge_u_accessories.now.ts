// nowhelpassist-dba: x_2002152_nwforge_u_accessories
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, StringColumn } from '@servicenow/sdk/core'

export const x_2002152_nwforge_u_accessories = Table({
    $id: Now.ID["x_2002152_nwforge_u_accessories_table"],
    name: "x_2002152_nwforge_u_accessories",
    label: "Accessories",
    display: "name",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        name: StringColumn({ label: "Accessory Name", maxLength: 100, mandatory: true }),
    },
})
