import { CatalogUiPolicy } from '@servicenow/sdk/core'

// Managed by NowHelpAssist. Generated from the policy builder — edit it there.
// nowforge-policy: cuip-38239200-dept-read-only
CatalogUiPolicy({
    $id: Now.ID["cuip_38239200_dept_read_only"],
    shortDescription: "Dept read‑only",
    catalogItem: "382392002f1b03503bcc48aa6fa4e369",
    appliesTo: 'item',
    catalogCondition: "IO:fd2316002f1b03503bcc48aa6fa4e356ISNOTEMPTY^EQ",
    active: true,
    onLoad: true,
    reverseIfFalse: true,
    // 'all' is ui_type 10 — the SDK's own default, and unambiguous across every
    // rendering surface. Not a workaround: a policy at ui_type 0 was measured
    // working on the Service Portal too (see the note at the top of this file).
    runScriptsInUiType: 'all',
    order: 10,
    actions: [
        {
            variableName: "0f2316002f1b03503bcc48aa6fa4e317",
            variable: "department",
            visible: true,
            order: 100,
        },
    ],
})
