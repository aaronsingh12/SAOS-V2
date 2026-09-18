// nowhelpassist-dba: x_2225382_nwforge_asset
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
//
// RECONCILED 2026-08-31: u_archived was dropped from the instance by the E2
// Tier 3 acceptance (drop_column, gated and irreversible). The column is
// removed here too, because a source that still declared it would silently
// re-create it on the next install — the drop would look undone by accident.
import { Table, IntegerColumn, ReferenceColumn, StringColumn, Acl } from '@servicenow/sdk/core'

export const x_2225382_nwforge_asset = Table({
    $id: Now.ID["x_2225382_nwforge_asset_table"],
    name: "x_2225382_nwforge_asset",
    label: "DBA Demo Asset",
    display: "u_name",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    index: [{ name: "x_2225382_nwforge_asset_u_name", unique: false, element: "u_name" }],
    schema: {
        u_name: StringColumn({ label: "Name", maxLength: 100, mandatory: true }),
        u_owner: ReferenceColumn({ label: "Owner", referenceTable: "sys_user" }),
        u_status: StringColumn({
            label: "Status",
            maxLength: 40,
            dropdown: 'none',
            default: "active",
            choices: {
                "active": { label: "Active" },
                "retired": { label: "Retired" },
                "lost": { label: "Lost" },
            },
        }),
        u_quantity: IntegerColumn({ label: "Quantity", default: 1 }),
    },
})

Acl({
    $id: Now.ID["x_2225382_nwforge_asset_acl_read_table_0"],
    type: 'record',
    operation: "read",
    table: "x_2225382_nwforge_asset",
    active: true,
    adminOverrides: true,
    roles: ["itil"],
    description: "read access to x_2225382_nwforge_asset",
    })

Acl({
    $id: Now.ID["x_2225382_nwforge_asset_acl_write_table_1"],
    type: 'record',
    operation: "write",
    table: "x_2225382_nwforge_asset",
    active: true,
    adminOverrides: true,
    roles: ["admin"],
    description: "write access to x_2225382_nwforge_asset",
    })
