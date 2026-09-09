/**
 * PHASE 17 — THE TEST, EXPRESSED AS AN ORDINARY PLAN.
 *
 * There is no NowTest executor, and this file is the reason none is needed. A
 * test is a plan: create the fixture, wait, read back, read the journal, delete
 * the fixture. Every step is a registry tool, every mutation goes through the
 * gate, the read-back verifier and the mutation ledger, and the whole thing is
 * fingerprinted by `fingerprintPlan` — which is also §30, satisfied without a
 * second fingerprint system, because any change to the fixture is a change to a
 * step's inputs.
 *
 * THE PLAN IS BUILT, NOT PROMPTED. `generatePlan` takes a `propose` function
 * precisely so a caller can supply a candidate instead of asking a model for
 * one, and this uses that seam: every value in the plan came from the live flow
 * artifact or the live dictionary. The model cannot propose a fixture, so
 * §61's "the model may propose, the platform validates" is satisfied in the
 * strongest available direction — there is nothing to validate away. What the
 * proposal then goes through is unchanged: `validatePlan`, `stampPlatformFacts`,
 * `canonicalisePlan`, `savePlan`.
 *
 * WHY CLEANUP IS A STEP AND ALSO A `finally`. As a step it is fingerprinted and
 * approved together with the create, so one card describes the whole test and a
 * person sees that the record will be removed. But the executor stops a plan at
 * its first failed step, so a failure before the end would leave the fixture
 * behind — and §17 says cleanup runs anyway. The runner therefore checks
 * afterwards whether the cleanup step actually completed, and if it did not it
 * runs `cleanupPlan` below through the SAME executor. Two plans, one executor,
 * one approval engine.
 */

/** §20/§65 — a bound, sized from measurement rather than from impatience.
 *  On dev424910 a real flow reached COMPLETE in ~37s and ERROR in ~11s. */
export const DEFAULT_TEST_TIMEOUT_MS = 90_000;
export const DEFAULT_POLL_MS = 3000;

const STEPS = Object.freeze({
  CREATE: 'create_fixture',
  WAIT: 'await_flow',
  READ: 'read_back',
  JOURNAL: 'read_journal',
  COUNT: 'count_created',
  CLEANUP: 'delete_fixture',
});

export const STEP_IDS = STEPS;

/**
 * The plan that runs one test.
 *
 * @param contract   from `buildContract`
 * @param flow       { sys_id, name }
 * @param timeoutMs  bound on the wait
 * @param countable  Map<assertionId, { table, link_field }> — the record-count
 *                   assertions whose target table this build could read, so a
 *                   locator can be written for them
 */
export function buildTestPlan({ contract, flow, timeoutMs = DEFAULT_TEST_TIMEOUT_MS, countable = new Map() }) {
  const table = contract.fixture.table;
  const marker = contract.fixture.marker;
  const markerField = contract.fixture.marker_field;
  const steps = [];

  steps.push({
    id: STEPS.CREATE,
    operation: `create a disposable ${table} that satisfies the trigger of "${flow.name}"`,
    description: `The fixture carries ${marker} in ${markerField} so it is identifiable as test data, `
      + 'and is deleted by the last step of this plan.',
    capability: 'record_create',
    tool: 'create_record',
    mutating: true,
    target: { table },
    inputs: { table, data: contract.fixture.data },
    depends_on: [],
    expected_effects: [
      `a ${table} record exists whose ${markerField} carries the test marker ${marker}`,
    ],
    verification: {
      strategy: 'read_back',
      asserts: [`${table}.${markerField} contains ${marker}`],
    },
  });

  steps.push({
    id: STEPS.WAIT,
    operation: `wait up to ${Math.round(timeoutMs / 1000)}s for "${flow.name}" to finish running against the fixture`,
    description: 'Reads the execution history repeatedly. Creates nothing and changes nothing.',
    capability: 'diagnostic_read',
    tool: 'wait_for_flow_execution',
    mutating: false,
    target: { table },
    inputs: {
      table,
      sys_id: { $ref: `${STEPS.CREATE}.result.sys_id` },
      flow_sys_id: flow.sys_id,
      timeout_ms: timeoutMs,
      poll_ms: DEFAULT_POLL_MS,
    },
    depends_on: [STEPS.CREATE],
    expected_effects: [],
    verification: null,
  });

  steps.push({
    id: STEPS.READ,
    operation: `read the ${table} back after the flow has run`,
    description: 'The read-back that every field assertion is decided against.',
    capability: 'record_read',
    tool: 'get_record',
    mutating: false,
    target: { table },
    inputs: { table, sys_id: { $ref: `${STEPS.CREATE}.result.sys_id` } },
    /*
     * BOTH dependencies are stated, and Phase 12 is right to insist. The wait
     * is an ORDERING dependency — read the record before the flow has finished
     * and the answer is about the wrong moment — and the create is a DATA
     * dependency. `validateDataflow` refuses a step that consumes an output
     * without saying it depends on the producer, because the ordering a person
     * approves has to be the ordering that runs.
     */
    depends_on: [STEPS.CREATE, STEPS.WAIT],
    expected_effects: [],
    verification: null,
  });

  const wantsJournal = (contract.assertions ?? []).some((a) => a.type === 'journal_added');
  if (wantsJournal) {
    steps.push({
      id: STEPS.JOURNAL,
      operation: `read the work notes and comments written on the ${table}`,
      description: 'A journal entry is a row of its own, so it is read as one rather than inferred from a field.',
      capability: 'diagnostic_read',
      tool: 'get_record_journal',
      mutating: false,
      target: { table },
      inputs: { table, sys_id: { $ref: `${STEPS.CREATE}.result.sys_id` } },
      depends_on: [STEPS.CREATE, STEPS.WAIT],
      expected_effects: [],
      verification: null,
    });
  }

  /*
   * §27 — counting what the flow created, without interpolating a runtime value.
   *
   * The obvious locator, "<link_field> = the fixture's sys_id", cannot be
   * written: the sys_id does not exist when the plan is fingerprinted, and this
   * build deliberately has no way to splice a reference into the middle of a
   * string. The marker solves it — the fixture's marker is known before
   * anything runs, so the locator dot-walks THROUGH the link field to the
   * marker on the record it points at, and matches only records created for
   * this run.
   *
   * A dot-walked term whose field does not exist is SILENTLY DROPPED by the
   * platform, returning every row (measured; it is in the ledger). So a locator
   * is only written for a table this build could read the dictionary of and
   * confirm the link field on; otherwise the assertion is left with no evidence
   * and reports UNAVAILABLE, which is the honest answer.
   *
   * THE OPERATOR IS `STARTSWITH`, NOT `=`, AND THAT IS NOT A STYLE CHOICE.
   * `buildFixture` does not store the bare marker: it stores
   * `<marker> NowForge flow test fixture - safe to delete`, because somebody who
   * finds a leftover record has to be able to read what it is. `=` is the
   * platform's `is`, so an equality locator compares the marker against a value
   * forty-four characters longer and matches NOTHING - every count would read
   * zero, and every flow that created its record correctly would be reported as
   * having failed to. The marker is the label's PREFIX by construction and the
   * only transformation applied to it is `slice(0, maxLength)`, which can trim
   * the tail and never the head, so an anchored match is exact enough and stays
   * unique to this run.
   */
  let countIndex = 0;
  const order = [];
  for (const [assertionId, spec] of countable) {
    countIndex += 1;
    steps.push({
      id: `${STEPS.COUNT}_${countIndex}`,
      operation: `count the ${spec.table} records this test's fixture caused to be created`,
      description: `Located through ${spec.link_field}.${spec.marker_field}, which matches only records linked to this run's fixture.`,
      capability: 'record_read',
      tool: 'query_records',
      mutating: false,
      target: { table: spec.table },
      inputs: {
        table: spec.table,
        query: `${spec.link_field}.${spec.marker_field}STARTSWITH${marker}`,
        limit: 10,
      },
      depends_on: [STEPS.WAIT],
      expected_effects: [],
      verification: null,
    });
    /* The step id carries the mapping back to the assertion. A step field
     * would not survive `normalizeCandidate`, which keeps only the fields the
     * plan schema declares — and inventing a field it would silently drop is
     * exactly the class of mistake this build keeps finding. */
    order.push(assertionId);
  }

  steps.push({
    id: STEPS.CLEANUP,
    operation: `delete the disposable ${table} this test created`,
    description: 'Deletes exactly the record this plan created, by the sys_id the create returned.',
    capability: 'record_delete',
    tool: 'delete_record',
    mutating: true,
    target: { table },
    inputs: { table, sys_id: { $ref: `${STEPS.CREATE}.result.sys_id` } },
    depends_on: steps.map((s) => s.id),
    expected_effects: [`the ${table} record created by this test no longer exists`],
    verification: {
      strategy: 'read_back',
      asserts: [`the ${table} record created by this test cannot be read back`],
    },
  });

  return {
    plan: {
      goal: `Test the ServiceNow flow "${flow.name}" by creating a disposable ${table} that satisfies its trigger, `
        + 'waiting for the flow to run, checking what it actually did, and deleting the test record.',
      steps,
    },
    /* `count_created_<n>` in step order, so the runner can hand each read back
     * to the assertion it answers without a field on the step. */
    countOrder: order,
  };
}

/**
 * The plan that removes a fixture the main plan did not get to (§17, §32).
 *
 * Its own plan and its own approval, because it is a real mutation and §31
 * forbids inventing a second approval path for it. When the policy in force
 * auto-approves mutations, it needs no card; when it does not, the person is
 * asked to authorise a delete of a record this run created and can name. A
 * refusal is recorded as a refusal — never as a successful cleanup.
 */
export function cleanupPlan({ table, sysId, marker }) {
  return {
    goal: `Delete the disposable ${table} record ${sysId} that a NowTest run created${marker ? ` (${marker})` : ''}.`,
    steps: [{
      id: 'delete_leftover',
      operation: `delete the leftover test ${table} record ${sysId}`,
      description: 'The test did not reach its own cleanup step. This removes exactly the record it created.',
      capability: 'record_delete',
      tool: 'delete_record',
      mutating: true,
      target: { table, sys_id: sysId },
      inputs: { table, sys_id: sysId },
      depends_on: [],
      expected_effects: [`the ${table} record ${sysId} no longer exists`],
      verification: { strategy: 'read_back', asserts: [`${table} ${sysId} cannot be read back`] },
    }],
  };
}

/**
 * Which record-count assertions can be given a locator.
 *
 * Injected `hasField` answers from the live dictionary, so a table this build
 * cannot read produces no locator rather than a query that would silently match
 * everything.
 */
export async function countableAssertions({ assertions, markerField, hasField }) {
  const out = new Map();
  for (const a of assertions) {
    if (a.type !== 'record_count' || !a.table || !a.field) continue;
    let ok = false;
    try {
      ok = await hasField(a.table, a.field);
    } catch {
      ok = false;
    }
    if (ok) out.set(a.id, { table: a.table, link_field: a.field, marker_field: markerField });
  }
  return out;
}
