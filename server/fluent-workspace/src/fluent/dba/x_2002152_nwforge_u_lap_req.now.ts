// nowhelpassist-dba: x_2002152_nwforge_u_lap_req
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, BooleanColumn, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_2002152_nwforge_u_lap_req = Table({
    $id: Now.ID["x_2002152_nwforge_u_lap_req_table"],
    name: "x_2002152_nwforge_u_lap_req",
    label: "Laptop Request",
    display: "u_number",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        u_number: StringColumn({ label: "Request Number" }),
        u_requested_for: ReferenceColumn({ label: "Requested For", referenceTable: "sys_user", mandatory: true }),
        u_laptop_type: StringColumn({
            label: "Laptop Type",
            maxLength: 40,
            dropdown: 'none',
            default: "Standard",
            choices: {
                "0": { label: "Standard" },
                "1": { label: "Gaming" },
                "2": { label: "High-End" },
            },
        }),
        u_operating_system: StringColumn({
            label: "Operating System",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Windows 11" },
                "1": { label: "macOS" },
                "2": { label: "Linux" },
            },
        }),
        u_ram: StringColumn({
            label: "RAM",
            maxLength: 40,
            dropdown: 'none',
            default: "16 GB",
            choices: {
                "0": { label: "8 GB" },
                "1": { label: "16 GB" },
                "2": { label: "32 GB" },
            },
        }),
        u_storage: StringColumn({
            label: "Storage",
            maxLength: 40,
            dropdown: 'none',
            default: "512 GB SSD",
            choices: {
                "0": { label: "256 GB SSD" },
                "1": { label: "512 GB SSD" },
                "2": { label: "1 TB SSD" },
            },
        }),
        u_accessories: StringColumn({
            label: "Accessories Required",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Mouse" },
                "1": { label: "Keyboard" },
                "2": { label: "Docking Station" },
            },
        }),
        u_business_justification: StringColumn({ label: "Business Justification", maxLength: 4000, mandatory: true }),
        u_delivery_location: ReferenceColumn({ label: "Delivery Location", referenceTable: "cmn_location", mandatory: true }),
        u_approval_required: BooleanColumn({ label: "Approval Required", default: false }),
        u_priority: StringColumn({
            label: "Priority",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Low" },
                "1": { label: "Medium" },
                "2": { label: "High" },
            },
        }),
        u_status: StringColumn({
            label: "Status",
            maxLength: 40,
            dropdown: 'none',
            default: "New",
            choices: {
                "0": { label: "New" },
                "1": { label: "Awaiting Approval" },
                "2": { label: "Approved" },
                "3": { label: "In Progress" },
                "4": { label: "Completed" },
                "5": { label: "Rejected" },
            },
        }),
        u_assignment_group: ReferenceColumn({ label: "Assignment Group", referenceTable: "sys_user_group" }),
        u_assigned_to: ReferenceColumn({ label: "Assigned To", referenceTable: "sys_user" }),
        u_comments: StringColumn({ label: "Comments" }),
    },
})
