# ITSM Health Checker — approved decision lock

Authoritative for all ITSM implementation work from 16 September 2026. These
decisions are not to be replaced, reinterpreted or substituted with
alternatives. Anything the workbook does not define and this document does not
define is `UNDEFINED` and is reported for explicit resolution — never invented.

Source workbook: `SAOS_Health_Rules_Tracker_ITSM.xlsx` 

## 1. Text similarity

**TF-IDF cosine similarity** on normalised text: normalise case and whitespace,
normalise obvious variable identifiers/numbers where appropriate, tokenise,
build TF-IDF vectors, take the cosine. Thresholds are the workbook's (0.9,
0.85, 0.8 …) and are not re-tuned. No embeddings, no LLM similarity, no
third-party string-similarity library unless approved later.

## 2. Expected distribution

No hard-coded "ideal ServiceNow distribution". Distribution rules compute the
empirical distribution of the relevant population, apply the rule's explicit
threshold, enforce minimum-volume guards, and report the observed distribution
as evidence. Small populations are not flagged without sufficient evidence.
**ITSM-024** evaluates the observed category × resolution-code relationship —
not a generic model. Where the workbook does not give enough to determine the
anomaly threshold, it stays configurable/undefined.

## 3. Undefined thresholds

"Configurable" with no workbook default → **no default is invented**. The rule
resolves to `UNCONFIGURED` until an instance-level parameter is supplied. No
silent 30/60/90 days, 70 %, 80 %.

## 4. Rule parameters

Every workbook threshold/window gets a typed declaration. Precedence:
workbook default → instance override → runtime override. No workbook default ⇒
`resolved_value = undefined` and the rule cannot execute. Parameter changes
invalidate the relevant cached/incremental results.

## 5. Undefined ServiceNow objects

Table names are not guessed. Resolution is by instance inspection:
candidate object → table discovery → schema verification → capability
confirmation. An object that cannot be confidently identified is
`unavailable / not_configured` — never PASS, and never an unrelated table.

## 6. Severity

`Systemic→SYSTEMIC`, `Critical→CRITICAL`, `High→HIGH`, **`Moderate→MEDIUM`**
(the engine stores MEDIUM and displays "Moderate"), `Low→LOW`. No new severity
weights in this phase; severity does not modify the overall ITSM score until the
scoring model is explicitly designed.

## 7. Composite confidence

`confidence = min(own, confidence(input_1), confidence(input_2), …)`. Never an
average; a composite is never more confident than any required input.

## 8. Incremental engine key

When catalogue rules become executable the ITSM engine key covers every
result-affecting input: rule definitions, rule parameters, engine
implementation version, relevant configuration, applicable dependency state.
Any change invalidates the relevant ITSM result and nothing else's.

## 9. Recurring schedules

Recurring schedules are expanded into concrete intervals within the rule's
analysis window, respecting the schedule timezone, the window and the
recurrence definition. An unexpanded recurring schedule is **never** read as
"no blackout/freeze". If expansion cannot be done reliably: `unavailable`, not
PASS.

## 10. ITSM-072 state ordering

No hard-coded state numbers. Inspect the instance's configured state
choices/ordering, construct the order from verified instance metadata, and
evaluate backward transitions against it. No reliable ordering ⇒
`ITSM-072 = UNAVAILABLE`; the absence of detected transitions is not PASS.

## 11. CMDB dependencies in ITSM

`cmdb_ci` and `cmdb_rel_ci` are **not** unconditional dependencies of an ITSM
scan. The scan determines which rules need CI/relationship data, retrieves
only the referenced CIs and only the required relationships, and evaluates
those rules. A rule without a CMDB need triggers no CMDB read. Required CMDB
data that is unavailable/incomplete marks the dependent rule accordingly —
never a false PASS.

## Absolute rule

Not in the workbook and not here ⇒ `UNDEFINED`, reported for explicit
resolution. This document takes precedence over implementation assumptions and
convenience, and is changed only on explicit instruction.
