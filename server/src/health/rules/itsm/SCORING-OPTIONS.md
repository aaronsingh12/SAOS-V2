# ITSM scoring — the current score, the gap, and the decisions a 139-rule score needs (Stage 5E)

Date: 2026-09-17. **No scoring model is chosen here.** DECISIONS.md §6 holds
severity out of the ITSM score "until the scoring model is explicitly designed",
and the Phase 5 brief (§7, §19) forbids inventing weights, penalties,
normalisation or treatments of UNAVAILABLE / UNCONFIGURED. This document records
what exists, why it does not fit the catalogue, and what has to be decided.

---

## 1. The score today (unchanged by Phase 5)

`health/scopes.js itsmScore(coverage, findings)`:

```
usable   = those of incident, change_request, problem read COMPLETELY
scanned  = records read in the ITSM slice ("active, or updated in the last 90 days")
affected = distinct (table, sys_id) targeted by any finding whose domain is in ITSM_SCORED_DOMAINS
score    = 100 × (1 − affected / scanned)
```

- `ITSM_SCORED_DOMAINS = INCIDENT, CHANGE, PROBLEM` — the eleven hard-coded
  rules' domains, frozen in Phase 5. The catalogue's findings carry domain `ITSM`
  and are routed to the scope but excluded from the arithmetic; a test proves the
  score, basis and drivers are identical with and without them.
- Withheld (null, with the reason) when no table was read completely or the slice
  is empty.
- Drivers: distinct records per rule, as shares of the scanned set.
- Live value on dev424910 (full scan, 17 Sep 2026): **0.6** — 341 legacy findings
  over a small slice.

It is a **record pass rate**: one finding of any severity fails a whole record,
exactly the shape the CMDB score abandoned when an estate scored 0.3 %.

## 2. Why it cannot absorb the catalogue as it stands

| Catalogue property | Why the pass rate cannot represent it |
|---|---|
| **139 rules, 11 legacy** | The number would move by an order of magnitude for reasons of coverage, not of the estate. |
| **Finding kinds** — record, aggregate, configuration, historical, relationship, cross-domain | Only `record` findings name records. A dominance share, a missing SLA definition or a reopen-rate trend has no record to fail; the formula ignores them or would have to invent one. |
| **Five bands, SYSTEMIC included** (33 SYSTEMIC, 51 Critical, 41 High, 14 Moderate, 0 Low base severities in the workbook) | The pass rate is severity-blind. The CMDB model treats base-SYSTEMIC as a trust gate, not a deduction; nothing decides whether ITSM does. |
| **Run states** — evaluated / unconfigured / unavailable / skipped (input) / error | The formula has no notion of a rule that could not run; a denominator built from rules would have to decide what a non-evaluated rule is worth. |
| **Verdicts** — pass / fail / inconclusive | `inconclusive` (a detection gap, a blocked variant) is neither; the formula has no third state. |
| **Partial scopes** — 27 detection gaps, 3 false-positive risks, 15 evidence gaps | A pass over half a detection is not a pass (Phase 4); a score would need to weight or exclude them. |
| **Empty populations** — 55 passes when incident / problem / change are empty (Phase 5 finding) | Until Phase 4 decides the verdict semantics (PHASE5-REPORT.md), a rule-based score would count vacuous passes as health. |
| **UNCONFIGURED parameters** — 29 instance-supplied gaps | Coverage grows as a customer fills them; a score that rises when a threshold is entered is measuring configuration, not the estate. |
| **Composite confidence** (min, DECISION 7) | The pass rate has no confidence input. |
| **Legacy overlap** | Several legacy rules and catalogue rules describe the same defect (PHASE5-REPORT.md §old rules); summing both double-counts. |

## 3. What any future model can read (already produced every scan)

`manifest.itsm.rules[139]`: classification, status, verdict, blocker, scope,
confidence, finding count, kpis (numerator / denominator / pass_pct / basis),
parameters with source, dependencies, `empty_population_evidence`.
`manifest.itsm.aggregation`: counts by classification, status, verdict, finding
severity, blocker kind; errors; unconfigured parameters; passes over an empty
population. Findings: severity, base severity, kind, detail, confidence, target
records, priority.

A model can therefore be computed from a stored run without re-reading the
instance.

## 4. Decisions required

Each is independent; none is taken.

1. **Unit of scoring.** Records (as today); rules (share of evaluated rules that
   pass); dimensions (groups of the workbook — the ITSM workbook defines none, and
   `groups_observed` is an observation, not a dimension list); or a two-layer model
   like CMDB (gate + weighted dimensions).
2. **SYSTEMIC.** A trust gate that withholds or qualifies the number (CMDB's
   choice), the heaviest deduction band, or neither.
3. **Severity weights.** The Schema tab states 100 / 40 / 15 / 5 / 1; whether ITSM
   adopts them for deductions, and per record or per rule.
4. **Non-record findings.** How an aggregate / configuration / historical /
   relationship / cross-domain finding affects the number — as a KPI part (CMDB's
   KPI half), a rule-level deduction, or posture outside the number.
5. **UNAVAILABLE and UNCONFIGURED.** Out of the denominator with the coverage
   disclosed (CMDB's "not measured"), counted against the estate, or shown as a
   separate coverage figure.
6. **Inconclusive and partial scope.** Excluded, counted at reduced weight, or
   disclosed only.
7. **Empty populations.** Depends on the Phase 4 verdict decision; until then,
   whether `empty_population_evidence` excludes a pass from any score.
8. **Confidence.** Whether finding confidence weights a deduction.
9. **The 11 legacy rules.** Kept in the number, replaced by their catalogue
   equivalents, or retired — after the Phase 5 comparison.
10. **Continuity.** Whether the new number is a new series (the CMDB precedent:
    comparability key, trend only within a model) and how the switch is shown.
11. **Consequence scoping / materiality.** Whether the CMDB rules for near-universal
    defects (scope the per-record charge, raise one estate-wide pattern) apply to
    ITSM populations.

Until these are decided the ITSM number remains the legacy pass rate, labelled as
such, and the catalogue's results are reported beside it rather than in it.
