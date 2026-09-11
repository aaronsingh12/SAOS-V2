import { TABLES } from './tables.js';

/**
 * The remediation catalogue — what a finding means, and what to do about it.
 *
 * Human-authored and keyed by rule, NOT generated. The rules are deterministic,
 * so their remediation can be too: the same rule always means the same thing,
 * and asking a model to re-explain it on every page load would introduce
 * variance into the one part of this module that has none.
 *
 * THE FIELD THAT MATTERS MOST IS `decision`.
 *
 *   'mechanical' — the finding states its own fix. A relationship whose parent
 *                  and child are the same CI is wrong in every estate; there is
 *                  nothing to weigh.
 *   'human'      — the finding states a FACT, and the fix requires a judgement
 *                  the data cannot supply. "This CI has no owner" does not tell
 *                  you who owns it, and a system that picks one is inventing an
 *                  accountable party.
 *
 * Most of these are 'human', and the UI says so rather than offering a Fix
 * button that would quietly guess. That is the same line the Access module
 * draws by refusing to author ACLs at all: the cost of a confident wrong write
 * here lands on somebody's CMDB, not on a test.
 *
 * `effort` is an ESTIMATE and is labelled as one everywhere it surfaces.
 * Nothing here was timed against a stopwatch; the numbers are per-record
 * working estimates for a competent admin, and `basis` says what each assumes
 * so a reader can disagree with it.
 */

/** What the agent is honestly being asked to do. */
export const AI_ACTION = Object.freeze({ FIX: 'fix', INVESTIGATE: 'investigate' });

const MIN = (manualPerRecord, aiFixed, basis) => ({
  manualMinutesPerRecord: manualPerRecord,
  aiMinutes: aiFixed,
  basis,
});

export const REMEDIATION = Object.freeze({
  'CMDB-OWNER': {
    headline: 'A configuration item has nobody accountable for it',
    problem:
      'The `owned_by` field on this CI is empty. Ownership is how every downstream process finds a human: '
      + 'incident routing, change approval, access review and lifecycle decisions all start by asking who owns the record. '
      + 'An unowned CI is not a cosmetic gap — it is a record that cannot be actioned when something goes wrong with it.',
    why: 'Unowned CIs are the most common reason an incident sits unassigned and an outage lasts longer than it should.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the CI in ServiceNow: **Configuration → All CIs**, then search for the name shown in the evidence below.',
      'Work out who actually owns it. Good sources, in order: the support group already on the CI, the assignment group on recent incidents against it, the Discovery source that found it, and the owner of its parent CI or business service.',
      'Confirm with that person or their manager. Do not assign ownership to someone who has not agreed to it — an owner who does not know they are one is the same as no owner.',
      'Set **Owned by** on the CI, and set **Managed by** and **Support group** at the same time if they are also empty.',
      'Save, then re-open the record and check the value stored — a reference field that did not resolve saves as empty without complaint.',
    ],
    verify: 'Run the health check again. This CI should no longer appear under CMDB-OWNER.',
    effort: MIN(4, 3, 'About 4 minutes per CI, most of it confirming the owner rather than typing. The agent can propose owners from related records in one turn, but a human still confirms each one.'),
  },

  'CMDB-STALE': {
    headline: 'A configuration item has not changed in a long time',
    problem:
      'This CI has not been updated for longer than the staleness window. That is a REVIEW SIGNAL, not proof of anything. '
      + 'A stale record can mean Discovery stopped reaching the device, the device was decommissioned and nobody told the CMDB, '
      + 'or it is a perfectly healthy item that genuinely has not changed.',
    why: 'A CMDB people stop trusting is a CMDB people stop using. Stale records are how that trust erodes, because each one makes every query slightly wrong.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the CI and look at **Last discovered** next to **Updated**. If Last discovered is also old, this is a Discovery problem, not a data problem.',
      'Check whether Discovery still reaches it: **Discovery → Status**, filter to the CI. A device that stopped answering usually stopped answering for a reason — decommissioned, re-IPed, or credentials expired.',
      'If Discovery is healthy and the device is real, nothing needs fixing; the record is simply stable. Note it and move on.',
      'If the device is gone, retire the CI properly: set **Install status** to Retired rather than deleting it. Deleting destroys the history that every past incident and change points at.',
      'If Discovery is broken, fix the schedule or credentials — that will clear a whole class of these at once rather than one CI at a time.',
    ],
    verify: 'After a Discovery run, Updated and Last discovered should both move. Re-run the health check to confirm the CI drops out.',
    effort: MIN(6, 4, 'About 6 minutes per CI investigated individually — but these cluster: one broken Discovery schedule often explains dozens, and finding that is far faster than triaging each.'),
  },

  'CMDB-DUPLICATE': {
    headline: 'Two or more CIs claim the same serial number',
    problem:
      'These records share a normalised serial number within the same CI class. That usually means one physical device was '
      + 'inserted twice — commonly by two import sources that do not agree on an identification rule. '
      + 'It can also be legitimate: some vendors reuse serials across product lines.',
    why: 'Duplicates split a device history in half. Incidents attach to one copy, changes to the other, and impact analysis sees two machines where there is one.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open each CI listed in the evidence side by side and compare the stable identifiers: serial, MAC, FQDN, and the Discovery source that created each.',
      'Decide which record SURVIVES. Prefer the one with the richer relationship graph and the longer incident history — that is the one other records already point at.',
      'Before merging, look at **Identification and Reconciliation → CI Identifiers** for this class. If two sources keep re-creating the pair, fixing the identifier rule prevents the next hundred; merging without that just recreates them.',
      'Use **CI Class Manager → De-duplication tasks**, or the platform de-duplication workflow, rather than deleting by hand. It re-parents relationships; a manual delete orphans them.',
      'Re-check the survivor afterwards: relationships, incidents and changes from both records should now hang off it.',
    ],
    verify: 'Re-run the health check. The duplicate group should be gone, and the survivor should still hold both histories.',
    effort: MIN(15, 6, 'About 15 minutes per duplicate group — comparing identifiers and confirming the survivor is careful work. The agent can assemble the comparison quickly, but a human must choose.'),
  },

  'CMDB-UNRELATED': {
    headline: 'A configuration item is connected to nothing',
    problem:
      'No relationship in the (completely read) relationship table references this CI. It sits in the CMDB as an island. '
      + 'This rule only runs when relationship coverage was complete, so it is not an artefact of a partial read — but records '
      + 'hidden from this account by ACL or domain separation are still outside its view.',
    why: 'Impact analysis, service mapping and change risk all walk relationships. A CI with none is invisible to every one of them, so an outage on it looks like it affects nothing.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the CI and check the **Related Items** / dependency map. Confirm it really is isolated rather than related through a class this extract did not read.',
      'Decide what it should connect to: the host it runs on, the cluster it belongs to, or the application service it supports.',
      'Add the relationship from the dependency map view rather than the related list — the map enforces valid parent/child directions for the relationship type, and a backwards edge is worse than none.',
      'If the CI is genuinely orphaned because it is dead, retire it instead (Install status → Retired).',
      'If many CIs of one class are unrelated, the gap is usually a Service Mapping or Discovery pattern that is not running, not hundreds of individual mistakes.',
    ],
    verify: 'The dependency map should show at least one edge, and the health check should no longer list the CI.',
    effort: MIN(8, 5, 'About 8 minutes per CI. Clusters of these usually share one root cause, so investigating the pattern first is normally faster than fixing them one by one.'),
  },

  'REL-SELF': {
    headline: 'A relationship points a CI at itself',
    problem:
      'The parent and the child of this relationship are the same CI. Nothing depends on itself, so this edge is wrong in '
      + 'every estate — there is no configuration in which it is correct.',
    why: 'Self-referencing edges make dependency walks loop. Impact analysis and service maps either cut the traversal short or spin on it.',
    decision: 'mechanical',
    aiAction: AI_ACTION.FIX,
    manualSteps: [
      'Open **Configuration → Relationships → CI Relationships** and locate the row by the sys_id in the evidence below.',
      'Confirm parent and child really are identical — the display values can look different if one side renders a class name.',
      'Work out what it was meant to say. Usually a bad import mapped the same column into both sides; occasionally someone meant to point at a neighbouring CI.',
      'Either correct the child to the CI it should have referenced, or delete the row if it is pure noise.',
      'If an integration created it, fix the transform map as well — otherwise it comes back on the next import.',
    ],
    verify: 'The relationship no longer appears, and the dependency map for that CI no longer loops back on itself.',
    effort: MIN(3, 2, 'About 3 minutes each. The fix itself is one delete; the time goes on confirming which of the two sides was wrong.'),
  },

  'REL-DUPLICATE': {
    headline: 'The same relationship is recorded more than once',
    problem:
      'Several rows carry the same parent, the same child and the same relationship type. One of them is the relationship; '
      + 'the rest are copies, almost always from an import that ran without a coalesce field.',
    why: 'Duplicate edges inflate every dependency count and make impact analysis report a blast radius larger than the real one.',
    decision: 'mechanical',
    aiAction: AI_ACTION.FIX,
    manualSteps: [
      'Open the rows listed in the evidence. Confirm parent, child and type are identical across them.',
      'Keep the OLDEST row — it is the one other records and any audit history already reference — and delete the rest.',
      'Check what created them. If they share a Discovery source or an import set, the coalesce configuration on that transform map is the actual defect.',
      'Fix the transform map before cleaning up, or the duplicates return on the next run.',
    ],
    verify: 'Exactly one edge remains between that pair for that type, and the next import does not add another.',
    effort: MIN(4, 2, 'About 4 minutes per group. Mechanical once the survivor is chosen; the import-side fix takes longer but prevents recurrence.'),
  },

  'CSDM-OWNER': {
    headline: 'A business service has no owner',
    problem:
      'The `owned_by` field on this service is empty. A service without an owner has nobody to approve changes to it, '
      + 'nobody to escalate to during an incident, and nobody accountable for its lifecycle.',
    why: 'CSDM makes the service the unit of accountability. An unowned service breaks that model at its root — every process that escalates "to the service owner" has nowhere to go.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the service under **Configuration → Business Services**.',
      'Identify the owner: the service owner named in your service catalogue, the manager of the group handling its incidents, or the owner of the application it fronts.',
      'Confirm with that person. A service owner has real obligations — approving changes and being called during outages — so it is not a field to fill in speculatively.',
      'Set **Owned by**, and set **Managed by** if your CSDM policy distinguishes the two.',
      'Save and re-read the record to confirm the reference resolved.',
    ],
    verify: 'Re-run the health check; the service should no longer appear under CSDM-OWNER.',
    effort: MIN(10, 4, 'About 10 minutes per service — longer than a CI because service ownership is a real commitment and usually needs a conversation.'),
  },

  'CSDM-LIFECYCLE': {
    headline: 'A service has no lifecycle stage',
    problem:
      'The `life_cycle_stage` field is empty. CSDM uses this to decide which services are in scope for reporting, '
      + 'which are being retired, and which are not live yet. Empty means the service is excluded from that reasoning entirely.',
    why: 'Services with no lifecycle stage silently fall out of CSDM reporting — they look absent rather than unclassified.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Check your own CSDM policy first. The valid stages and what each means are an instance decision, not a platform constant — pick from the list your organisation actually uses.',
      'Open the service and determine its real state: is it in design, being built, live and operational, or on its way out?',
      'Set **Life cycle stage**, and set **Life cycle stage status** with it — the pair is what CSDM reads; a stage without a status is only half the answer.',
      'If many services are blank, set them in a batch through a list view rather than one at a time, but confirm the stage per service — they are not all "Operational".',
    ],
    verify: 'Both lifecycle fields are populated and the service appears in CSDM lifecycle reporting.',
    effort: MIN(5, 3, 'About 5 minutes per service once the policy is settled. The first one takes longest because it means agreeing the vocabulary.'),
  },

  'CSDM-OFFERING': {
    headline: 'A business service has no service offering',
    problem:
      'No service offering references this business service in the (completely read) offering table. In CSDM, the offering '
      + 'is what people actually consume — the commitment, the SLA and the entitlement all hang off it, not off the service.',
    why: 'A business service with no offering cannot be requested, committed to, or measured. It exists in the model and nowhere in the experience.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the business service and check its **Service Offerings** related list to confirm it really has none.',
      'Decide whether it should have one. Some internal or technical services deliberately have no consumer-facing offering — that is a valid answer, not a gap.',
      'If it should, create the offering under **Service Offerings**, set its **Parent** to this business service, and give it an owner and a lifecycle stage of its own.',
      'Attach the commitments — availability, support hours, and any SLA — to the OFFERING, not to the service.',
    ],
    verify: 'The service shows at least one offering in its related list, and the health check stops reporting it.',
    effort: MIN(20, 6, 'About 20 minutes per offering created — it is a small design exercise, not a field edit. Deciding an offering is not needed takes about 2 minutes.'),
  },

  'CUSTOM-BEFORE-UPDATE': {
    headline: 'An active before-rule calls current.update()',
    problem:
      'A static pattern matched `current.update()` inside an active BEFORE business rule. In a before rule the platform '
      + 'writes the record for you after the script runs, so calling update() yourself writes it twice — and can re-enter the '
      + 'same rule. This is a pattern match on source text, so a commented-out line or an unreachable branch is a false positive.',
    why: 'Recursive business rules are one of the classic causes of a slow instance, and the symptom (everything is slow) points nowhere near the cause.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the rule under **System Definition → Business Rules** and read the script. Confirm the `current.update()` is actually reachable — not in a comment, not behind a condition that is never true.',
      'If it is reachable: in a BEFORE rule, setting `current.field = value` is enough. The platform saves the record after the rule. Remove the update() call.',
      'If the rule genuinely needs to write a DIFFERENT record, that is fine — but it should use its own GlideRecord, not `current`.',
      'If it needs to run after the save, change **When** to `after` rather than keeping the explicit update.',
      'Test in a sub-production instance and watch for recursion. Package the change through your normal update-set or pipeline process — never edit it live.',
    ],
    verify: 'The rule no longer calls update() on current, and a test transaction on the table runs once rather than twice.',
    effort: MIN(25, 10, 'About 25 minutes per rule including a sub-production test. This is code review — the estimate assumes a short script and no surprises.'),
  },

  'INT-HTTP': {
    headline: 'An integration endpoint is configured over plain HTTP',
    problem:
      'This REST message points at an `http://` endpoint. Traffic to it — including any credential in the header or body — '
      + 'crosses the network unencrypted. The stored configuration is what was checked; a runtime override could still change it.',
    why: 'An outbound integration usually carries an API key or a token. Over plain HTTP that credential is readable by anything on the path.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the REST message under **System Web Services → Outbound → REST Message** and check the endpoint on the message and on each of its HTTP methods — a method can override the parent.',
      'Confirm the target actually supports TLS. Ask the endpoint owner; do not assume, because switching to a port that is not listening turns a security finding into an outage.',
      'Check whether the endpoint needs a MID server. An internal host may only be reachable over HTTPS from inside the network.',
      'Change the endpoint to `https://` in a sub-production instance and run the method once. Watch for certificate errors — a self-signed certificate needs its CA loaded into the instance trust store.',
      'Promote the change through your normal release process, then rotate any credential that was previously sent over plain HTTP. Assume it was exposed.',
    ],
    verify: 'The endpoint reads https://, a test call succeeds, and the old credential has been rotated.',
    effort: MIN(30, 10, 'About 30 minutes per integration, most of it coordinating with the endpoint owner and testing. Credential rotation is extra and depends on the system.'),
  },

  'PERF-JOB-ERROR': {
    headline: 'A scheduled job is sitting in the error state',
    problem:
      'This `sys_trigger` row has state 3, which is the error state. The job is not running, and depending on what it does '
      + 'that could mean events are not processing, SLAs are not ticking, or a nightly import has silently stopped.',
    why: 'A failed scheduled job is invisible until something downstream is missing. The gap between "it stopped" and "somebody noticed" is usually measured in days.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Find the job under **System Scheduler → Scheduled Jobs** and note its name and what it runs.',
      'Read the actual error before touching anything: **System Logs → System Log → All**, filtered to around the job name and the time it failed.',
      'Fix the cause, not the state. Restarting a job whose script throws just produces the same error on the next run.',
      'Common causes worth checking: a referenced record that was deleted, a script that throws on an empty result, an integration the job calls that is down, or a permissions change.',
      'Once the cause is fixed, re-run the job manually and watch it complete before leaving it to the schedule.',
    ],
    verify: 'The job state is no longer 3, and a manual execution completes without an entry in the system log.',
    effort: MIN(20, 8, 'About 20 minutes per job, dominated by reading logs. Varies widely — some are a one-line fix, some are an integration outage.'),
  },

  'PERF-ECC-AGE': {
    headline: 'An ECC queue item has been waiting over an hour',
    problem:
      'A `ready` record in the ECC queue is more than an hour old. The ECC queue is how the instance and its MID servers talk, '
      + 'so an item stuck there means one side stopped collecting: either no MID server is picking the work up, or it picked it '
      + 'up and never answered.',
    why: 'A stalled ECC queue stops Discovery, integrations and orchestration at once — and each of those fails quietly rather than raising anything.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Check the MID servers first: **MID Server → Servers**. Any that are Down or not Validated explain this immediately.',
      'If the MIDs are up, look at the queue itself — **ECC → Queue**, filtered to `state=ready` — and see whether the backlog is one agent or all of them.',
      'Check the MID server log on the host (`agent/logs/agent0.log.0`) for connection or credential errors.',
      'Restart the MID service if it is running but not collecting. Confirm it revalidates afterwards.',
      'If the backlog is large, let it drain before judging — the queue clears at the rate the MID can process, not instantly.',
    ],
    verify: 'The ready backlog drains and new ECC items move to processed within their normal window.',
    effort: MIN(15, 8, 'About 15 minutes to diagnose. A backlog usually has ONE cause, so this is per incident rather than per queued row.'),
  },

  'UPGRADE-SKIPPED': {
    headline: 'An upgrade skipped a file because it was customised',
    problem:
      'The upgrade engine found a local change to this file and left your version in place rather than overwriting it. '
      + 'That is the engine working correctly — but it means this file did NOT receive whatever the upgrade changed, '
      + 'including any fix or security change.',
    why: 'Skipped files are how an instance drifts from the release it claims to be on. Each one is a small, deliberate exception that nobody revisits.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open **System Diagnostics → Upgrade History**, find the run, and open the skipped file.',
      'Compare your version with the one shipped. The upgrade record holds both — read what the new version changed before deciding anything.',
      'Decide per file: if your customisation is still needed, keep it and record WHY, so the next upgrade reviewer is not solving this again. If it is obsolete, revert to the out-of-box version.',
      'If the shipped change is a fix you want and your customisation is still needed, merge them by hand rather than choosing one.',
      'Test in sub-production. A reverted customisation can break the process it was written for.',
    ],
    verify: 'The file is either reverted to out-of-box or explicitly marked as a reviewed, intentional customisation.',
    effort: MIN(20, 8, 'About 20 minutes per file to compare and decide. A large upgrade can produce hundreds; triage by table importance rather than working the list in order.'),
  },

  'SEC-INACTIVE-ROLE': {
    headline: 'A deactivated user still holds a role',
    problem:
      'This role assignment belongs to a user whose account is inactive. The account cannot log in today, so this is not an '
      + 'open door right now — but the grant survives, and reactivating the account restores every privilege with it.',
    why: 'Leavers who return as contractors, or accounts reactivated for one task, silently regain their old access. Access reviews that read active users miss this entirely.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Confirm the user is genuinely inactive and not mid-onboarding: **User Administration → Users**.',
      'Check how the role was granted. An **inherited** grant comes from a group — removing the role directly will not hold, because the group membership re-applies it.',
      'Follow your identity process. Access removal is usually governed, and doing it outside that process breaks the audit trail even when the outcome is right.',
      'For a group-derived role, remove the user from the GROUP instead. For a direct grant, remove the role.',
      'Prioritise `admin` and other elevated roles first; an inactive account holding admin is a different class of risk from one holding itil.',
    ],
    verify: 'The role no longer appears for that user, and a re-run of the health check confirms it.',
    effort: MIN(5, 3, 'About 5 minutes per assignment. Governance approval usually dominates the wall-clock time and is not counted here.'),
  },

  'MID-DOWN': {
    headline: 'A MID server is down',
    problem:
      'ServiceNow reports this MID server as Down. Everything that runs through it has stopped: Discovery, orchestration, '
      + 'and any integration configured to use a MID.',
    why: 'A MID server going down stops several unrelated capabilities at once, and each of them fails silently rather than raising an alert.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open **MID Server → Servers** and check **Last refreshed**. How long ago it stopped usually points straight at the cause.',
      'Check the host itself: is the machine up, and is the MID service running on it?',
      'Read `agent/logs/agent0.log.0` on the MID host. Expired credentials, a network change and a full disk all look identical from the ServiceNow side and completely different in that log.',
      'Restart the MID service, then confirm the instance revalidates it — Up but Not Validated is still not working.',
      'If this MID is the only one for a capability, that is the real finding. A single MID is a single point of failure for Discovery.',
    ],
    verify: 'Status reads Up and Validated, and the ECC queue backlog for that agent drains.',
    effort: MIN(20, 8, 'About 20 minutes to diagnose and restart, assuming access to the MID host. A credential or firewall cause takes considerably longer.'),
  },

  'EVENT-UNBOUND': {
    headline: 'An open alert is not bound to any CI',
    problem:
      'This alert is open or reopened and its `cmdb_ci` field is empty. Event Management could not match the incoming event '
      + 'to a configuration item, so the alert exists but points at nothing.',
    why: 'An unbound alert cannot drive impact, cannot find a service, and cannot route to an owner. It will sit in the console until a human notices it by eye.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the alert under **Event Management → All Alerts** and look at the raw event behind it — specifically the node, resource and source fields.',
      'Work out why binding failed. Usually the node name in the event does not match any CI: a short hostname against an FQDN, an IP where the CI has a name, or a CI that simply is not in the CMDB.',
      'If the CI exists, fix the matching: **Event Management → Event Rules**, and correct the field mapping or add a binding rule for that source.',
      'If the CI does not exist, the real gap is Discovery coverage for that device, not the alert.',
      'Bind this alert manually to clear it, then fix the rule — otherwise the next event from that source arrives unbound too.',
    ],
    verify: 'The alert shows a CI, and new events from the same source bind automatically.',
    effort: MIN(10, 5, 'About 10 minutes per alert investigated alone. These cluster hard by source: one event rule usually explains all of them.'),
  },
});

/** A finding with no catalogue entry still gets an honest, generic answer. */
const FALLBACK = Object.freeze({
  headline: 'This rule has no remediation guidance yet',
  problem:
    'The rule that produced this finding does not have an entry in the remediation catalogue. The finding itself is still '
    + 'sound — it came from the deterministic rule pack and carries the records it was derived from — but no step-by-step '
    + 'guidance has been written for it.',
  why: 'Guidance is written per rule by hand. A missing entry is a gap in the catalogue, not a sign the finding is wrong.',
  decision: 'human',
  aiAction: AI_ACTION.INVESTIGATE,
  manualSteps: [
    'Read the evidence below — it names the exact table, record and field the rule read.',
    'Open those records in ServiceNow and confirm the finding against the live data.',
    'Use the recommendation attached to the finding as the starting point.',
  ],
  verify: 'Re-run the health check and confirm the finding no longer appears.',
  effort: MIN(10, 5, 'A generic placeholder, not an estimate for this rule specifically.'),
});

/**
 * Effort, as a comparison — explicitly an estimate.
 *
 * The manual side scales with record count because somebody opens each record.
 * The agent side is broadly FIXED: one turn resolves the batch, and the human
 * cost is reviewing the approval card rather than doing the work. That is the
 * honest shape of the difference, and it is why the saving grows with the size
 * of the finding rather than being a constant multiplier.
 *
 * Nothing here is measured. `basis` travels with the numbers so a reader can
 * disagree with the assumption rather than the arithmetic.
 */
export function estimateEffort(entry, recordCount) {
  const n = Math.max(1, recordCount || 1);
  const manual = entry.effort.manualMinutesPerRecord * n;
  /* Reviewing an approval card scales a little with how much is on it, but far
     less than doing the work — a card listing 40 records is read once. */
  const ai = entry.effort.aiMinutes + Math.min(10, Math.floor(n / 10));
  return {
    manualMinutes: manual,
    aiMinutes: ai,
    recordCount: n,
    savedMinutes: Math.max(0, manual - ai),
    basis: entry.effort.basis,
    disclaimer:
      'An estimate, not a measurement. Manual time assumes a competent admin opening each record; agent time assumes one turn '
      + 'plus a human reading the approval card. Neither was timed.',
  };
}

/**
 * The prompt handed to the agent.
 *
 * Built HERE rather than in the browser so there is one wording, and so the
 * rules it carries cannot be edited away by a page. Two properties matter:
 *
 *  - it names the exact records, so the agent does not have to search for them
 *    and cannot pick different ones;
 *  - on a `human` decision it asks the agent to INVESTIGATE AND PROPOSE, never
 *    to apply. The agent's own approval gate would still stop a write, but a
 *    prompt that asks for a fix the data cannot justify is asking the model to
 *    invent the missing judgement.
 */
export function buildAgentPrompt(finding, entry) {
  const ids = (finding.target_ids || []).slice(0, 25);
  const more = (finding.target_ids || []).length - ids.length;
  const isFix = entry.aiAction === AI_ACTION.FIX;

  const lines = [
    `A ServiceNow estate health check flagged this on the connected instance. Rule: ${finding.rule_id} (${finding.domain}, ${finding.severity}).`,
    '',
    `FINDING: ${finding.title}`,
    `WHAT THE RULE OBSERVED: ${finding.description}`,
    '',
    `TABLE: ${finding.table}`,
    `RECORDS (sys_id), ${ids.length}${more > 0 ? ` of ${finding.target_ids.length} shown` : ''}:`,
    ...ids.map((id) => `  - ${id}`),
    '',
  ];

  if (isFix) {
    lines.push(
      'WHAT I WANT:',
      '1. Read each record above and confirm the finding against the live data before changing anything — the health check read a snapshot, and the record may have moved since.',
      '2. If confirmed, apply the fix. I will review it at the approval gate.',
      '3. Read back every record you change and tell me what actually landed, field by field.',
      '',
      'If any record no longer matches the finding, skip it and say so rather than changing it.',
    );
  } else {
    lines.push(
      'WHAT I WANT — INVESTIGATE AND PROPOSE. Do not apply anything yet.',
      '1. Read each record above and confirm the finding against the live data.',
      '2. Gather the context needed to decide the fix. This finding needs a judgement the data does not contain, so the useful thing is evidence, not an edit.',
      `   For this rule specifically: ${entry.manualSteps[1] || entry.manualSteps[0]}`,
      '3. Tell me what you found and what you would change, per record, and WAIT for me to choose.',
      '',
      'Do not guess a value on my behalf. If the right answer depends on something you cannot read, say which records are affected and what you would need to know.',
    );
  }

  return lines.join('\n');
}

/** The tables this rule reads, with the fields it reads from each. */
export function referencedTables(finding, entry) {
  const primary = finding.table;
  const out = [];
  const fields = new Set((finding.evidence || []).filter((e) => e.sn_table === primary).map((e) => e.field_name));
  out.push({
    table: primary,
    role: 'the records this finding is about',
    fields: fields.size ? [...fields].sort() : (TABLES[primary]?.fields ?? []).slice(0, 8),
    inAllowList: Boolean(TABLES[primary]),
  });
  for (const extra of entry.alsoReads || []) {
    out.push({ table: extra.table, role: extra.role, fields: extra.fields || [], inAllowList: Boolean(TABLES[extra.table]) });
  }
  return out;
}

/** Everything the detail view needs for one finding. */
export function remediationFor(finding) {
  const entry = REMEDIATION[finding.rule_id] || FALLBACK;
  return {
    ruleId: finding.rule_id,
    known: Boolean(REMEDIATION[finding.rule_id]),
    headline: entry.headline,
    problem: entry.problem,
    why: entry.why,
    decision: entry.decision,
    aiAction: entry.aiAction,
    aiActionLabel: entry.aiAction === AI_ACTION.FIX ? 'Fix with AI' : 'Investigate with AI',
    decisionNote: entry.decision === 'human'
      ? 'This finding states a fact; choosing the fix needs a judgement the data cannot supply. The agent will gather evidence and propose — it will not decide for you.'
      : 'This finding states its own fix. The agent can apply it, and you still approve the write at the gate.',
    tables: referencedTables(finding, entry),
    manualSteps: entry.manualSteps,
    verify: entry.verify,
    effort: estimateEffort(entry, (finding.target_ids || []).length),
    prompt: buildAgentPrompt(finding, entry),
  };
}
