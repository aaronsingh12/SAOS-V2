# ITSM scoring — the current score, the gap, and the decisions a 139-rule score needs (Stage 5E)

Date: 2026-09-17; **decided 2026-09-21 — see §5.** Sections 1–4 record the pass
rate as it stood, why it could not take the catalogue, and the eleven decisions
a model needed. §5 records the model that replaced it (`health/itsm-quality.js`,
`itsm-quality/1`) and each decision as taken.

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


---

## 5. The model chosen — ITSM Quality, `itsm-quality/1` (21 Sep 2026)

`health/itsm-quality.js`, called from `scopes.js itsmScore()`. The same
two-part shape as CMDB Quality, so the two numbers mean the same kind of thing:

```
record_score(r) = max(0, 100 − Σ w(band))       distinct charges on record r; w = Critical 40 · High 15 · Moderate 5 · Low 1 · Systemic 100 (effective only)
record_part     = mean record_score            over the incident / change_request / problem slice read COMPLETELY
rule_part       = passes ÷ (passes + fails)    over evaluated, determinate, non-Systemic rules of the ESTATE engines (aggregate, configuration, composite)
score           = 0.6 × record_part + 0.4 × rule_part    (BLEND_BY_KIND.mixed; one part alone when the other is absent; null when both are)
```

**Why not the alternatives.** The record pass rate (§1) is severity-blind and
fails a record for one Moderate finding — 0.7 on dev429978 where the same
findings under a capped deduction read 89. A rule pass rate is severity- and
magnitude-blind (one record and eighty-nine records both "fail" a rule), moves
with configuration rather than the estate (28 UNCONFIGURED rules here), and
answers a compliance question, not a health one. An uncapped severity sum has
no ceiling and is owned by whichever rule fires most. Group-based dimensions do
not exist for ITSM (the workbook observes twelve groups and defines none), and
inventing weights for them is exactly what §7 of the Phase 5 brief forbids.
The per-record capped deduction is the model the CMDB already runs, with a
declared blend from its own table; nothing new is invented.

| # | Decision (§4) | Taken |
|---|---|---|
| 1 | Unit of scoring | **Records, blended with estate-level rule verdicts** — CMDB's two-part shape. No dimensions: the ITSM sheet defines none. |
| 2 | SYSTEMIC | **Posture.** A base-Systemic finding never charges and never gates; it is listed with its count (`itsm_quality.systemic`) beside the score. The catalogue has no `systemicKind`, so a blocker cannot be told from a posture; the CMDB rule "gate only when it invalidates what the number means" is applied conservatively as "never". A `systemicKind` column on the ITSM sheet would let named rules gate later. |
| 3 | Severity weights | **The Schema tab's 100 / 40 / 15 / 5 / 1, per record** (`BAND_WEIGHT`), summed over distinct charges and floored at 0 — never per rule, never per finding. |
| 4 | Non-record findings | **The rule part.** Aggregate, configuration and composite rules reach the score through their verdict; their findings (a rate, a config object) charge no work record. Record, historical and relationship findings charge the records they name. |
| 5 | UNAVAILABLE / UNCONFIGURED | **Out of every denominator, counted** in `itsm_quality.rules`. Missing data is never unhealthy. |
| 6 | Inconclusive / partial scope | **Excluded, counted.** A pass over a partial scope is already `inconclusive` by Phase 4. |
| 7 | Empty populations | **A pass over an empty population is excluded** unless the workbook declares it determinate (`population.determinate_when_empty`). |
| 8 | Confidence | **Reported, not weighted** — as CMDB. |
| 9 | The 11 legacy rules | **Kept as record charges** beside the catalogue's. Overlaps are handled by DEFECT FAMILIES (below), not by retiring rules. |
| 10 | Continuity | **New series.** `scopes.itsm.scoring = { model, key }` hashes every constant; `store.trend()` blanks a scope's points made under another key. The pass-rate points stay stored and read as a gap. Rules being built, configured or made available change COVERAGE under the same key, not the model. |
| 11 | Materiality / consequence scoping | **Not applied.** The slice is small and has no class concept; a record is one record. Revisit if an instance's slice is dominated by one near-universal Moderate finding. |

**Population.** The rows the scan extracted from the three tables (active, or
updated in the window), only from tables read completely; a table read in part
is excluded and named. A catalogue finding that names a record outside the
slice is counted (`records.outside_population`) and not charged. A run stored
without its slice (before this model) charges its legacy findings alone — they
read the slice by construction — and says so in the basis.

**One defect, one charge — DEFECT_FAMILIES.** PHASE5-REPORT §7 measured three
legacy/catalogue pairs that flag the same records (aged P1 ⟷ ITSM-037; stuck
problem ⟷ ITSM-056 / 061; unassigned incident ⟷ ITSM-042). Charges on a
record are keyed by family and a record pays the heavier once — the CMDB
`dedupe_key` rule. Pairs the report marked "No" or "different signal" are not
families. The findings list is untouched: both findings still show.

**What is exposed.** `scopes.itsm` keeps its contract (`score`, `score_basis`,
`score_definition`, `score_withheld_because`, `score_drivers`) and adds
`itsm_quality` — `record_part`, `rule_part`, `blend`, `weights`, `population`
(records, by table, basis, tables usable / excluded), `records` (charged, clean,
charges, merged_by_family, outside_population, unbounded_catalogue), `rules`
(catalogue, evaluated, determinate, pass, fail, inconclusive, unconfigured,
unavailable, skipped, error, systemic_excluded, vacuous_pass, record_rules,
rule_part_pass, rule_part_fail), `systemic` (findings, rules) — and `scoring`.

**Measured (dev429978, 20–21 Sep 2026).** Stored full scan, legacy charges only
(the run kept no slice): pass rate **0.7** → ITSM Quality **78.0** (record part
89.0 over 145 records, 1 clean; rule part 61.5 = 8 of 13 estate-level rules;
16 Systemic-based rules and 32 record-engine rules outside the rule part; 13
inconclusive, 28 unconfigured, 36 unavailable, 1 skipped). A live scan, with the
slice, also charges the catalogue's record findings; see the run recorded after
this change.

**Tests.** `test/health-itsm-quality.test.js` — empty tables, all clean, all
failing, one Critical vs one Moderate, several findings on one record, the
per-record cap, a legacy/catalogue twin charged once, a thousand findings on
one record, an unreadable table, a record outside the slice, a run without its
slice, inconclusive / unconfigured / unavailable / skipped / vacuous rules, a
record-engine pass lifting nothing, Systemic as posture, catalogue expansion
under a stable key, the summary contract, and the trend break.
