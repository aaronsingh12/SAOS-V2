// nowhelpassist-dba: x_tepv_nwforge_net_inc_demo
// Generated from a validated table spec by dba-authoring.js. Deterministic —
// no model output reaches this file. Edit the spec, not this source.
import { Table, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_tepv_nwforge_net_inc_demo = Table({
    $id: Now.ID["x_tepv_nwforge_net_inc_demo_table"],
    name: "x_tepv_nwforge_net_inc_demo",
    label: "Network Incident Demo",
    extensible: false,
    audit: false,
    allowWebServiceAccess: true,
    accessibleFrom: "package_private",
    schema: {
        incident_number: StringColumn({ label: "Incident Number", maxLength: 20, unique: true }),
        short_description: StringColumn({ label: "Short Description", maxLength: 200, mandatory: true }),
        description: StringColumn({ label: "Description", maxLength: 1000 }),
        category: StringColumn({
            label: "Category",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Network" },
                "1": { label: "Hardware" },
                "2": { label: "Software" },
                "3": { label: "Other" },
            },
        }),
        impact: StringColumn({
            label: "Impact",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "High" },
                "1": { label: "Medium" },
                "2": { label: "Low" },
            },
        }),
        urgency: StringColumn({
            label: "Urgency",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "High" },
                "1": { label: "Medium" },
                "2": { label: "Low" },
            },
        }),
        priority: StringColumn({
            label: "Priority",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "Critical" },
                "1": { label: "High" },
                "2": { label: "Moderate" },
                "3": { label: "Low" },
            },
        }),
        assignment_group: ReferenceColumn({ label: "Assignment Group", referenceTable: "sys_user_group" }),
        state: StringColumn({
            label: "State",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "New" },
                "1": { label: "In Progress" },
                "2": { label: "Resolved" },
                "3": { label: "Closed" },
            },
        }),
        work_notes: StringColumn({ label: "Work Notes", maxLength: 2000 }),
    },
})
