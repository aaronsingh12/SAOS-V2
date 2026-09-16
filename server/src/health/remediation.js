import { TABLES } from './tables.js';
import { catalogueRule } from './cmdb-quality.js';

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

  /* ══ ITOM ═══════════════════════════════════════════════════════════════
   *
   * A note that applies to most of this section: ITOM findings are frequently
   * OPERATIONAL rather than data problems. Restarting a MID service, opening a
   * firewall port or running a Discovery schedule are not things a REST write
   * can do, and `decision: 'human'` with no entry in FIX_FIELD is how that is
   * said honestly — the proposal then carries steps rather than a field editor.
   * Pretending otherwise would produce a Fix button that cannot work.
   * ═══════════════════════════════════════════════════════════════════════ */

  'DISC-NEVER-RAN': {
    headline: 'Discovery has never run on this instance',
    problem:
      'The Discovery status table was read completely and is empty: no schedule has ever executed. '
      + 'Every CI in the CMDB therefore came from an import, a manual entry or an integration — and nothing is refreshing any of it.',
    why: 'A CMDB nobody is refreshing is a snapshot that started going stale the day it was loaded. Every CMDB rule above will keep reporting it as healthy, because the records are well-formed. They are just no longer true.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Decide first whether Discovery is meant to be in use here. On a sandbox or a data-only instance the honest answer is often no, and then this finding is closed rather than fixed.',
      'If it is meant to run, the prerequisites go in order and each blocks the next: a **MID server**, then **credentials**, then a **schedule**. Check them in that order — a schedule with no working MID fails in a way that looks like a Discovery problem.',
      'Confirm the MID: **MID Server → Servers**, status Up and Validated.',
      'Confirm credentials: **Discovery → Credentials**, at least one active credential per platform you intend to scan.',
      'Create the schedule under **Discovery → Discovery Schedules**, give it an IP range you own, and run it ONCE manually before putting it on a timer.',
      'Read the run afterwards under **Discovery → Status**. A first run that completes with device errors is normal and tells you which credentials are missing.',
    ],
    verify: 'A row appears in Discovery Status with state Completed, and CIs it touched show a recent Last discovered.',
    effort: MIN(120, 20, 'About two hours to stand Discovery up from nothing, most of it network and credential work outside ServiceNow. The agent can confirm the prerequisites and report which are missing in one turn.'),
  },

  'DISC-FAILED': {
    headline: 'A Discovery run ended in error',
    problem:
      'The run finished with an error or cancelled state. Whatever it was scanning was not discovered, so those CIs '
      + 'are missing or stale — and the CMDB gives no sign of it, because the absent records simply are not there.',
    why: 'Failed Discovery runs are invisible downstream. Nothing turns red; the CMDB just quietly stops covering part of the estate.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the run under **Discovery → Status** and read its **Discovery Log** before re-running anything. A run that failed on credentials or a firewall fails again identically.',
      'Group the errors by device. One cause usually explains most of them — an expired credential, a blocked port, a MID that lost its network route.',
      'If the MID is implicated, check it is Up and Validated and that it can reach the range on the required ports.',
      'Fix the cause, then re-run the schedule manually and watch it complete.',
      'If the range is simply no longer in use, narrow or retire the schedule rather than leaving it failing — a schedule that always fails trains people to ignore this table.',
    ],
    verify: 'A fresh manual run of the same schedule reaches Completed, and the device count is what you expect for that range.',
    effort: MIN(30, 10, 'About 30 minutes per failed run, dominated by reading logs. Failures cluster, so the second one is usually much faster than the first.'),
  },

  'DISC-STALE': {
    headline: 'A Discovery schedule has not completed recently',
    problem:
      'The most recent completion of this run is older than the staleness window. Either the schedule stopped, or it is '
      + 'running and never finishing. Both look the same from the CMDB: CIs that stop being refreshed.',
    why: 'A schedule that stops silently is the commonest way a healthy-looking CMDB goes out of date, because nothing anywhere reports it.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the schedule under **Discovery → Discovery Schedules** and check whether it is still **Active** and what its next run time is.',
      'Check the MID server it uses. A MID that went down takes every schedule bound to it with it.',
      'Look for runs that STARTED and never completed — a hung run blocks the next one on some configurations.',
      'Run it manually once and time it. A schedule that now takes longer than its own interval will never look finished.',
      'If the range it covers is retired, retire the schedule too rather than leaving it stale.',
    ],
    verify: 'The schedule shows a recent Completed run, and its next scheduled time is in the future.',
    effort: MIN(20, 8, 'About 20 minutes per schedule. Several stale schedules usually share one dead MID, which is far faster to find than to work through them individually.'),
  },

  'DISC-DEVICE-ISSUE': {
    headline: 'Discovery reached a device but recorded issues against it',
    problem:
      'The device answered, but the scan logged issues — so the CI it produced may be missing attributes, relationships '
      + 'or software. The count shown is the platform\'s own assessment, not this rule\'s.',
    why: 'A partially discovered CI is worse than an absent one: it looks populated, so nobody checks it, and every report treats it as complete.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the record under **Discovery → Device History** and read the issue list. The platform names each one.',
      'Classify before fixing: credential failures, permission gaps and unreachable ports are three different problems with three different owners.',
      'Credential and permission issues are fixed once and clear every device that shares them — do those first.',
      'Re-run Discovery against just that device (**Discovery → Quick Discovery**) to confirm, rather than waiting for the schedule.',
      'Compare the CI afterwards with one that discovered cleanly; the difference is what the issue was costing you.',
    ],
    verify: 'A Quick Discovery of the device completes with zero issues, and the CI gains the attributes it was missing.',
    effort: MIN(15, 6, 'About 15 minutes per device investigated alone — but these cluster hard by credential and by subnet, so the pattern is usually worth finding first.'),
  },

  'DISC-LOG-ERROR': {
    headline: 'Discovery wrote an error to its log',
    problem:
      'An error-level entry from Discovery itself. The message in the evidence is the platform\'s own text, reproduced '
      + 'verbatim — this rule does not interpret it.',
    why: 'Discovery log errors are where the real cause of a failed or partial scan is written down, and nothing surfaces them unless somebody goes looking.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Read the full message under **Discovery → Discovery Log**, filtered to the same source and time.',
      'Find the run it belongs to and check whether that run completed anyway — an error during a completed run is a partial result, not a failure.',
      'Errors naming a pattern or probe are a Discovery configuration problem; errors naming a host are usually network or credentials.',
      'Fix the cause and re-run; the log is the only place that confirms it stopped recurring.',
    ],
    verify: 'A subsequent run produces no error-level entries from the same source.',
    effort: MIN(15, 6, 'About 15 minutes per distinct error. Log errors repeat heavily, so the count of rows overstates the amount of work.'),
  },

  'CRED-NONE': {
    headline: 'No Discovery credentials are configured',
    problem:
      'The credentials table was read completely and is empty. Discovery can reach a device and cannot authenticate to '
      + 'it, so it records only what an unauthenticated scan reveals — typically an IP, a name and almost nothing else.',
    why: 'This is the cause behind a whole class of CMDB findings that look like data-quality problems. Every "CI has no attributes" downstream of it is really this.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Work out which platforms are in scope — Windows, Linux/SSH, SNMP, VMware, cloud — because each needs its own credential type.',
      'Get service accounts created through your normal identity process. Discovery needs read-level access, not administrator; asking for more than that is what gets the request refused.',
      'Add each under **Discovery → Credentials**, set **Applies to** so a credential is only tried where it belongs, and set **Order** so the most specific is tried first.',
      'Test each one with **Test credential** against a known host before running a schedule.',
      'Never share one credential across platforms. A single over-broad account is both a security finding and a debugging problem later.',
    ],
    verify: 'Test credential succeeds for each platform, and a Discovery run produces CIs with full attributes rather than bare IPs.',
    effort: MIN(90, 15, 'About 90 minutes, mostly waiting on service accounts from the identity team. The ServiceNow side of it is quick.'),
  },

  'CRED-INACTIVE': {
    headline: 'A Discovery credential is switched off',
    problem:
      'The credential exists but is inactive, so Discovery will not try it. If anything in the estate needed it, those '
      + 'devices are now being scanned unauthenticated or failing outright.',
    why: 'A credential disabled during an incident and never re-enabled is one of the commonest reasons a Discovery that used to work quietly stopped.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open it under **Discovery → Credentials** and check **Applies to** — that tells you what stopped working when it was switched off.',
      'Find out why it is off. A rotated or expired password is a different fix from a deliberate decommission.',
      'If the account is still valid, re-activate and press **Test credential** immediately — re-enabling a credential whose password expired just moves the failure.',
      'If the account is gone, replace it rather than re-enabling: a credential that fails is worse than one that is absent, because Discovery keeps retrying it.',
    ],
    verify: 'Test credential succeeds, and the next Discovery run against its range produces fully populated CIs.',
    effort: MIN(10, 4, 'About 10 minutes, assuming the underlying account is still good. Re-activating is one field; confirming the password still works is the real step.'),
  },

  'CRED-ALL-INACTIVE': {
    headline: 'Every Discovery credential is switched off',
    problem:
      'All credentials on the instance are inactive. Discovery cannot authenticate to anything, so every scan it runs '
      + 'from now on produces bare, attribute-less CIs.',
    why: 'This is almost never deliberate. It is usually a bulk change, a failed migration, or a security action that was never reversed.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Check the update history on a couple of them — **Discovery → Credentials**, open one, and look at when and by whom `active` was last set. One change that touched all of them points at the cause.',
      'Do NOT simply re-enable them all. If they were disabled for a security reason, re-enabling is the wrong move and somebody needs to say so first.',
      'Once cleared, re-activate the credentials that should be live and **Test credential** on each.',
      'Then re-run one Discovery schedule manually and confirm the CIs come back populated.',
    ],
    verify: 'The credentials that should be live are active and test successfully, and a manual Discovery run produces attribute-rich CIs.',
    effort: MIN(12, 5, 'About 12 minutes per credential once the decision to re-enable has been taken. Establishing that it is safe to re-enable is the part that takes real time.'),
  },

  'MID-NONE': {
    headline: 'No MID server is configured',
    problem:
      'The MID server table was read completely and is empty. Discovery, Service Mapping, Orchestration and every '
      + 'integration configured to use a MID cannot run at all — not slowly, not partially. At all.',
    why: 'This is upstream of every other ITOM finding. Fixing anything else while this is true produces no visible improvement.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Decide whether ITOM is meant to be in use. A PDI or a data-only instance legitimately has no MID, and then this is closed rather than fixed.',
      'If it is, provision a host that can reach both the instance (443 outbound) and the estate you intend to discover. Sizing guidance is in the MID server documentation for your release.',
      'Create the MID user in ServiceNow with the `mid_server` role — not admin.',
      'Install the MID from **MID Server → Downloads**, configure it with the instance URL and that user, and start the service.',
      'Validate it in **MID Server → Servers**. Up but Not Validated is not working — it must be both.',
    ],
    verify: 'The MID shows Up and Validated, and its capabilities populate automatically within a few minutes.',
    effort: MIN(180, 25, 'About three hours to provision, install and validate a first MID, nearly all of it host and network work. The agent can confirm what exists and what is missing, but it cannot install anything.'),
  },

  'MID-NOT-VALIDATED': {
    headline: 'A MID server is up but not validated',
    problem:
      'The MID reports a status other than Down, and the instance has not validated it. An unvalidated MID does not pick '
      + 'up work — but its status reads as healthy, which is why this is easy to miss.',
    why: 'This is the MID failure mode that hides. The dashboard looks fine and nothing runs.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open it under **MID Server → Servers** and press **Validate**. Many are a one-click fix after a restart.',
      'If validation fails, read the MID log on its host (`agent/logs/agent0.log.0`) — the reason is written there and nowhere else.',
      'The three usual causes: the MID user lost the `mid_server` role, the instance certificate changed and the MID does not trust it, or the MID version is too old for the instance after an upgrade.',
      'A version mismatch after a platform upgrade is the most common of the three. Upgrade the MID to match the instance release.',
      'Re-validate and confirm capabilities populate — a validated MID with no capabilities has not really finished.',
    ],
    verify: 'Status reads Up AND Validated, and capability records appear for it.',
    effort: MIN(25, 8, 'About 25 minutes. A click if it is transient; longer if the MID needs upgrading to match the instance.'),
  },

  'MID-NO-CAPABILITY': {
    headline: 'A MID server has no capabilities',
    problem:
      'No capability record references this MID in the complete capability extract. Capabilities are how the instance '
      + 'decides which MID can do which work, so one with none is never selected for anything.',
    why: 'A MID that is Up, Validated and capability-less looks healthy in every list and does no work.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Check validation first — capabilities normally populate automatically once a MID validates, so a MID with none usually never finished validating.',
      'Open it under **MID Server → Servers** and look at the **Capabilities** related list, then at **Supported Applications**.',
      'If it validated cleanly and still has none, restart the MID service: capability detection runs at startup.',
      'If it is meant to be restricted to specific work, capabilities can be set explicitly — but then they should be present and deliberate, not absent.',
    ],
    verify: 'Capability records exist for the MID, and it starts appearing as a selectable MID for the work it should do.',
    effort: MIN(20, 8, 'About 20 minutes. Usually resolves with the validation problem that caused it rather than separately.'),
  },

  'MID-ISSUE': {
    headline: 'An open issue is recorded against a MID server',
    problem:
      'The platform raised an issue against this MID and it has not been resolved. MID issues are the instance\'s own '
      + 'account of what is wrong with it — this rule surfaces them rather than interpreting them.',
    why: 'MID issues are recorded whether or not anybody looks. An unresolved one usually explains a Discovery or integration failure somewhere else in this report.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the issue under **MID Server → Issues** and read its description and severity.',
      'Correlate it with the MID\'s own log on the host for the same time window.',
      'Fix the cause. Common ones: the MID ran out of disk or heap, lost its route to the instance, or hit an expired certificate.',
      'Resolve the issue record once the cause is fixed — leaving resolved problems open makes this table useless for the next reader.',
    ],
    verify: 'The issue is resolved, the MID is Up and Validated, and the ECC queue for that agent is draining.',
    effort: MIN(25, 8, 'About 25 minutes per issue. Access to the MID host is usually required, and that is often the slow part.'),
  },

  'SM-NOT-IN-USE': {
    headline: 'Discovered services exist, and none is mapped to any CI',
    problem:
      'The service-to-CI association table was read completely and is empty while discovered services do exist. '
      + 'Nothing connects those services to the infrastructure that delivers them.',
    why: 'An unmapped service is a name in a list. Impact analysis walks nothing from it, change risk sees nothing under it, and an outage on its infrastructure shows no service impact at all.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Confirm whether Service Mapping is licensed and expected on this instance. If it is not, these services need their CIs associated another way, and that is a CSDM decision rather than an ITOM one.',
      'If it is licensed, check whether any mapping has ever run: **Service Mapping → Discovered Services**.',
      'Map one service end to end first, by entry point, and confirm it produces sensible associations before doing more. A bad pattern applied to fifty services is fifty wrong maps.',
      'Service Mapping depends on Discovery and on credentials, so both of those findings above are prerequisites, not alternatives.',
    ],
    verify: 'At least one service shows CI associations, and its dependency map renders something recognisable to the people who run it.',
    effort: MIN(240, 30, 'Four hours or more for a first service mapped properly; it is a design exercise, not a configuration change. Deciding Service Mapping is not in scope here takes about 10 minutes.'),
  },

  'SM-UNMAPPED': {
    headline: 'A discovered service is not mapped to any CI',
    problem:
      'No association in the complete service-to-CI extract references this service. Other services on this instance '
      + 'ARE mapped, so this is a gap in coverage rather than Service Mapping being unused.',
    why: 'Because the other services are mapped, this one looks equivalent to them in every list — and is invisible to every downstream calculation.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open it under **Service Mapping → Discovered Services** and check whether a mapping ever ran and what it returned.',
      'Confirm the entry point is correct. A wrong or missing entry point is the usual reason one service fails to map while its neighbours succeed.',
      'Check credentials for the hosts it runs on — mapping fails silently without them, exactly as Discovery does.',
      'Re-run the mapping for that service and review the result before accepting it.',
      'If it genuinely has no infrastructure in this CMDB, say so on the record rather than leaving it looking unmapped.',
    ],
    verify: 'The service shows CI associations and its map matches what its owners expect.',
    effort: MIN(45, 12, 'About 45 minutes per service. Entry-point and credential problems dominate, and both recur across services.'),
  },

  'OUTAGE-OPEN': {
    headline: 'An outage has been open for more than a day with no end recorded',
    problem:
      'The outage has a start and no end. Either it is still running, or it ended and nobody closed the record. '
      + 'This rule cannot tell which — but availability reporting counts it as ongoing either way.',
    why: 'Every availability figure for that CI is wrong until the record is closed, and the longer it stays open the more of the reporting period it silently consumes.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Check whether the CI is actually down right now. If it is, this is a live outage and belongs in your incident process rather than a health report.',
      'If it is back, find when it recovered — the related incident, a monitoring alert, or the first successful Discovery afterwards all date it.',
      'Set **End** on the outage record to that time. Guessing a convenient round number is how availability figures become fiction.',
      'If the outage was recorded in error, remove it rather than closing it with a fabricated end.',
      'If these accumulate, the process that opens outages is not closing them — fix that rather than the individual records.',
    ],
    verify: 'The outage has an end time, and the availability figure for that CI matches what its owners believe happened.',
    effort: MIN(12, 5, 'About 12 minutes per outage, most of it establishing the real recovery time from another system.'),
  },

  /* ══ ITSM ═══════════════════════════════════════════════════════════════
   *
   * Unlike most of ITOM, several of these ARE a single field — an assignment
   * group, a CI link — and appear in FIX_FIELD so the proposal can offer a
   * value. The ones about time (stale, overdue, aged P1) are not: "nobody has
   * touched this for 40 days" is fixed by a person doing the work, and a write
   * that merely bumped `sys_updated_on` would hide the finding without fixing
   * anything.
   * ═══════════════════════════════════════════════════════════════════════ */

  'ITSM-INC-UNASSIGNED': {
    headline: 'An open incident is not assigned to any group',
    problem:
      'The incident is active and its assignment group is empty, so it sits in no queue. Nobody is notified and '
      + 'nothing in the platform will pick it up — it waits until someone happens to find it.',
    why: 'Unassigned incidents are the commonest reason an SLA breaches with nobody ever having looked at the ticket.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Open the incident and read the short description, category and affected CI or service.',
      'Route it to the group that owns that CI or service — the CI\'s **Support group** is usually the right answer.',
      'Set **Assignment group** and save. The group\'s queue, notifications and SLA clock start from here.',
      'If several incidents arrive unassigned from the same channel, fix the **Assignment Rules** or the integration that creates them instead of routing each by hand.',
    ],
    verify: 'The incident shows an assignment group and appears in that group\'s queue; re-run the check and it drops out.',
    effort: MIN(3, 2, 'About 3 minutes per incident once you know the owning group. The agent can propose the group from the CI and category; a human confirms.'),
  },

  'ITSM-INC-P1-AGED': {
    headline: 'A priority 1 incident has been open for more than a day',
    problem:
      'A P1 is meant to be a major outage worked continuously. One open for days is either a genuinely long outage, '
      + 'or a record that was never resolved after service came back — and every P1 report counts it as ongoing.',
    why: 'An unresolved P1 distorts major-incident metrics and keeps escalation paths and bridge calls pointed at something that may be over.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Contact the assignment group or major incident manager and ask directly whether service is still affected.',
      'If it is still live, confirm the major incident process is running — communications, bridge, updates on the record.',
      'If service is restored, resolve the incident with the real restoration time and a resolution note.',
      'If the priority was set wrongly, correct impact and urgency rather than priority itself — priority is calculated from them (trap #5).',
      'Raise a problem record if the cause is not yet understood.',
    ],
    verify: 'The incident is either resolved with a real restoration time, or visibly being worked with recent updates.',
    effort: MIN(10, 4, 'About 10 minutes per P1, almost all of it getting a straight answer from the people working it.'),
  },

  'ITSM-INC-STALE': {
    headline: 'An open incident has not been touched in weeks',
    problem:
      'The incident is active and has had no update for longer than the review window. It may be waiting on the '
      + 'caller, blocked on a vendor, or simply forgotten — from the record alone those look the same.',
    why: 'Stale open incidents inflate the backlog, hide the real workload and keep their SLAs quietly breaching.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Ask the assignee what is actually happening with it.',
      'If it is waiting on the caller or a third party, set it **On Hold** with the right reason so it stops looking abandoned and the SLA pauses correctly.',
      'If it is fixed, resolve it with a note.',
      'If nobody owns it any more, reassign it rather than leaving it parked on someone who has moved on.',
    ],
    verify: 'The incident has a fresh update, a hold reason, or a resolution.',
    effort: MIN(5, 3, 'About 5 minutes per incident. These cluster by assignee, so one conversation often clears several.'),
  },

  'ITSM-INC-NO-CI': {
    headline: 'An open incident is not linked to any CI or service',
    problem:
      'Neither a configuration item nor a business service is set. The incident cannot feed impact analysis, problem '
      + 'trending or CI health, and nobody looking at the CI will see that it is failing.',
    why: 'Incidents without CIs are why the CMDB cannot answer "which of our systems break most" — the evidence exists and is not connected.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Read the incident description and identify the affected system.',
      'Set **Configuration item** to that CI, or **Service** if the CI is not known.',
      'If the CI does not exist in the CMDB, that is itself worth raising — the incident is evidence of a gap.',
      'When many incidents arrive without a CI, make the field mandatory on the intake form or map it in the integration that creates them.',
    ],
    verify: 'The incident shows a CI or service, and appears in that CI\'s related incidents.',
    effort: MIN(3, 2, 'About 3 minutes per incident. The agent can propose the CI from the description; confirming it is the human part.'),
  },

  'ITSM-INC-REOPENED': {
    headline: 'An incident keeps being reopened',
    problem:
      'The incident has been reopened at least twice. That almost always means it was resolved before the underlying '
      + 'cause was fixed — the symptom went away, and came back.',
    why: 'Repeat reopens are the clearest signal in ITSM data that a problem record is missing.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Read the work notes across each resolution and reopen — look for the fix that did not hold.',
      'If the cause is not understood, raise a **Problem** and relate this incident to it.',
      'If there is a known workaround, record it as a known error so the next reopen is resolved faster.',
      'Check whether the resolution code was accurate; "resolved by caller" on a recurring fault hides the pattern.',
    ],
    verify: 'The incident is linked to a problem, or its latest resolution addresses the root cause.',
    effort: MIN(15, 6, 'About 15 minutes per incident to read the history and decide on a problem record.'),
  },

  'ITSM-CHG-STALE': {
    headline: 'An open change has not been touched in weeks',
    problem:
      'The change is active and has had no update for longer than the review window. Open changes block the change '
      + 'calendar, appear in conflict checks and make the schedule look busier than it is.',
    why: 'A calendar full of abandoned changes is how real conflicts get missed.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Ask the change owner whether it is still planned.',
      'If it is, update the planned dates so the calendar is accurate.',
      'If it is not, **Cancel** it with a reason rather than leaving it open.',
      'If it was implemented and never closed, close it with the real outcome.',
    ],
    verify: 'The change has current dates, or is cancelled or closed.',
    effort: MIN(5, 3, 'About 5 minutes per change, mostly reaching the owner.'),
  },

  'ITSM-CHG-NO-CI': {
    headline: 'An open change names no configuration item',
    problem:
      'The change does not reference a CI, so conflict detection and impact analysis have nothing to check it '
      + 'against. It can be approved without anyone seeing which services depend on what it touches.',
    why: 'Risk assessment without a CI is a guess; this is how a "low risk" change takes down a service nobody connected to it.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Identify the system the change actually modifies.',
      'Set **Configuration item** on the change, and add further CIs in **Affected CIs** if it touches more than one.',
      'Re-run the risk and conflict assessment now that it has something to assess.',
      'If changes routinely arrive without CIs, make the field mandatory before the Assess state.',
    ],
    verify: 'The change names its CI and its impacted services list is populated.',
    effort: MIN(5, 3, 'About 5 minutes per change. The agent can propose the CI from the description; the change owner confirms.'),
  },

  'ITSM-CHG-OVERDUE': {
    headline: 'A change is past its planned end and still open',
    problem:
      'The planned end date has passed and the change is still active. Either implementation overran, or it finished '
      + 'and nobody closed the record.',
    why: 'An overdue open change makes the change calendar lie, and its outcome — successful or not — is never recorded.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Ask the implementer what happened.',
      'If it was implemented, move it to Review and close it with the real close code — **successful**, **successful with issues** or **unsuccessful**.',
      'If it overran and is still in progress, update the planned end date so the calendar is true.',
      'If it did not happen, cancel it with a reason.',
    ],
    verify: 'The change is closed with an outcome, or its planned end reflects reality.',
    effort: MIN(6, 3, 'About 6 minutes per change.'),
  },

  'ITSM-CHG-FAILED': {
    headline: 'A change was closed as unsuccessful',
    problem:
      'The change failed inside the review window. That is not a data problem — it is an outcome that needs a review, '
      + 'and a CI that may have been left in an unknown state.',
    why: 'Unreviewed failed changes repeat. The review is where the next failure is prevented.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Check a post-implementation review exists and records what went wrong.',
      'Confirm the CI was backed out or left in a known, documented state.',
      'If the same CI or change model fails repeatedly, raise it at CAB rather than approving the next one the same way.',
      'Raise a problem if the cause is not understood.',
    ],
    verify: 'The change has a review recorded and the affected CI is in a documented state.',
    effort: MIN(20, 8, 'About 20 minutes per failed change for a proper review.'),
  },

  'ITSM-PRB-UNASSIGNED': {
    headline: 'An open problem has no owning group',
    problem:
      'The problem is active and nobody owns the investigation, so the root cause is not being worked and the '
      + 'incidents it explains keep arriving.',
    why: 'A known problem nobody owns is a known cause nobody is fixing.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Identify the group that owns the affected service or CI.',
      'Set **Assignment group** and name a problem owner.',
      'Agree a first action — root cause analysis, or a known error with a workaround.',
    ],
    verify: 'The problem has an assignment group and a recent work note.',
    effort: MIN(4, 2, 'About 4 minutes per problem.'),
  },

  'ITSM-PRB-STALE': {
    headline: 'An open problem has not been touched in weeks',
    problem:
      'The problem is active with no recent update. Its related incidents keep looking unexplained, and nobody can '
      + 'tell whether the investigation stalled or quietly finished.',
    why: 'Stalled problems are where recurring incidents go to be forgotten.',
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      'Ask the problem owner for status.',
      'If the cause is known and a workaround exists, record it as a **Known Error** so incident resolvers can use it.',
      'If the fix is in progress, link the change that will deliver it.',
      'If it will not be fixed, close it with the reason and accepted risk rather than leaving it open.',
    ],
    verify: 'The problem has a fresh update, a known error, a linked change, or a documented closure.',
    effort: MIN(8, 4, 'About 8 minutes per problem.'),
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

const LANE_STEP = Object.freeze({
  1: 'Lane 1 — direct apply. The change is reversible data: correct the records named in the evidence and keep their before-values.',
  2: 'Lane 2 — staged update set. Make the configuration change in a sub-production instance, capture it in an update set, test it there, then promote it.',
  3: 'Lane 3 — guided human decision. The right answer is a judgement; the owner decides, using the evidence below.',
});

/**
 * Guidance for a SAOS catalogue rule, built from its own articulation.
 *
 * The catalogue already states what the defect is, why it matters, how it is
 * detected, how it is fixed and when the rule is wrong. Writing a second,
 * hand-made paraphrase would be a copy that drifts; this reads the source.
 */
function fromCatalogue(rule) {
  return {
    headline: rule.title,
    problem: rule.whatItMeans,
    why: rule.whyItMatters,
    decision: 'human',
    aiAction: AI_ACTION.INVESTIGATE,
    manualSteps: [
      `Confirm it in your own instance — the detection logic is re-runnable: ${rule.detectionLogic}`,
      `Rule out the known wrong case first: ${rule.falsePositiveGuard}`,
      LANE_STEP[rule.lane] || rule.remediationLane,
    ],
    verify: `Re-run the health check: ${rule.id} should no longer fire.`,
    effort: MIN(15, 5, 'No per-rule estimate has been written for this catalogue rule yet; this is a generic placeholder.'),
    catalogue: {
      id: rule.id, group: rule.group, groupName: rule.groupName, base: rule.base, dimension: rule.dimension, lane: rule.lane,
      sourceTables: rule.sourceTables, detectionLogic: rule.detectionLogic, threshold: rule.threshold,
      confidenceBasis: rule.confidenceBasis, evidenceToShow: rule.evidenceToShow,
      falsePositiveGuard: rule.falsePositiveGuard, remediationLane: rule.remediationLane, crossDomainLink: rule.crossDomainLink,
    },
  };
}

/** Everything the detail view needs for one finding. */
export function remediationFor(finding) {
  const rule = catalogueRule(finding.rule_id);
  const entry = REMEDIATION[finding.rule_id] || (rule ? fromCatalogue(rule) : FALLBACK);
  return {
    ruleId: finding.rule_id,
    known: Boolean(REMEDIATION[finding.rule_id] || rule),
    catalogue: entry.catalogue ?? (rule ? fromCatalogue(rule).catalogue : null),
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
