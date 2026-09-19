import { CatalogUiPolicy } from '@servicenow/sdk/core'

// Managed by NowHelpAssist. Generated from the policy builder — edit it there.
// nowforge-policy: cuip-c15f556f-make-os-read-only-when-macbook-selected
CatalogUiPolicy({
    $id: Now.ID["cuip_c15f556f_make_os_read_only_when_macbook_selected"],
    shortDescription: "Make OS read‑only when MacBook selected",
    catalogItem: "c15f556fc31fc310341abecdd4013157",
    appliesTo: 'item',
    catalogCondition: "IO:6d5f196fc31fc310341abecdd4013141=macbook^EQ",
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
            variableName: "df5f996fc31fc310341abecdd401313f",
            variable: "operating_system",
            readOnly: true,
            order: 100,
        },
    ],
})
