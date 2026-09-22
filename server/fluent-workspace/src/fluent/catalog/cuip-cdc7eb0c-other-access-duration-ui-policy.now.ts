import { CatalogUiPolicy } from '@servicenow/sdk/core'

// Managed by NowHelpAssist. Generated from the policy builder — edit it there.
// nowforge-policy: cuip-cdc7eb0c-other-access-duration-ui-policy
CatalogUiPolicy({
    $id: Now.ID["cuip_cdc7eb0c_other_access_duration_ui_policy"],
    shortDescription: "Other Access Duration UI Policy",
    catalogItem: "cdc7eb0c736b8710e737fb125ab8b7f8",
    appliesTo: 'item',
    catalogCondition: "IO:6bc7ef0c736b8710e737fb125ab8b755=other^EQ",
    active: true,
    onLoad: true,
    reverseIfFalse: true,
    // 'all' is ui_type 10 — the SDK's own default, and unambiguous across every
    // rendering surface. Not a workaround: a policy at ui_type 0 was measured
    // working on the Service Portal too (see the note at the top of this file).
    runScriptsInUiType: 'all',
    order: 100,
    actions: [
        {
            variableName: "3cd7234c736b8710e737fb125ab8b794",
            variable: "other_access_duration",
            visible: true,
            mandatory: true,
            order: 100,
        },
    ],
})
