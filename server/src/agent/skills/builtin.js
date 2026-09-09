/**
 * SKILLS — THE SEVEN BUILT-IN SKILLS.
 *
 * §39 is unusually specific about what these are and are not: "Existing domains
 * should become built-in skills only as a presentation/registry mapping
 * initially. Do not duplicate the existing implementation. The skill registry
 * points to existing capabilities."
 *
 * So every entry below is a POINTER. Each names capabilities that already exist
 * in `agent/context-capabilities.js` and rules that already exist in the prompt
 * layer; not one line of Incident Operations, the Doctor, NowLint, NowTest,
 * Change Intelligence, Knowledge or the Application Builder is restated here,
 * and disabling one of these does not remove an implementation — it removes the
 * capabilities from the planner's view, which is what §41 asks for.
 *
 * WHY CAPABILITIES AND NOT TOOL LISTS. A tool list would be a second copy of
 * `TOOL_CAPABILITIES`, and a second copy is a thing that falls behind: add a
 * tool to the incident domain and the skill would silently stop covering it.
 * Naming the CAPABILITY means the skill covers whatever that capability covers
 * today, and `test/experience-skills.test.js` asserts every capability named
 * here exists in the live taxonomy.
 *
 * The `tools` list is therefore left EMPTY on purpose for every built-in. It
 * exists in the manifest schema for user-installed skills that want to name a
 * specific tool; a built-in that filled it in would be pinning itself to a
 * snapshot of the registry.
 */

/**
 * The declared `permissions` are informational only (§32). What each skill can
 * actually do is computed from its capabilities against the live registry by
 * `permissions.js`, and the UI shows the computed answer — these strings are
 * the human-readable gloss beside it, and a test asserts the gloss cannot claim
 * a change capability the computation does not find.
 */
export const BUILT_IN = Object.freeze([
  {
    id: 'incident-operations',
    name: 'Incident Operations',
    version: '1.0.0',
    description:
      'Read, triage, assign and update incidents, with reference resolution and read-back verification on every change.',
    capabilities: ['incident', 'record_mutation', 'reference_analysis', 'verification'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['incident', 'sys_user', 'sys_user_group', 'task SLAs'],
      change: ['incident fields'],
      note: 'Every mutation stops at the approval gate and is verified by reading the record back.',
    },
  },
  {
    id: 'doctor',
    name: 'Doctor',
    version: '1.0.0',
    description:
      'Investigate why something happened on the instance: audit history, journals, SLAs, flow executions and CI relationships. Read-only.',
    capabilities: ['record_read'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['incident', 'audit history', 'journals', 'SLAs', 'flow executions', 'CI relationships'],
      change: [],
      note: 'Diagnosis only. The Doctor cannot execute a plan the registry says would write.',
    },
  },
  {
    id: 'nowlint',
    name: 'NowLint',
    version: '1.0.0',
    description:
      'Analyse a published flow against deterministic rules and report findings with evidence. Never edits the flow.',
    capabilities: ['flow_read', 'verification'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['flows', 'flow actions', 'triggers', 'subflows'],
      change: [],
      note: 'Findings are produced by rules, not by the model deciding a flow looks wrong.',
    },
  },
  {
    id: 'nowtest',
    name: 'NowTest',
    version: '1.0.0',
    description:
      'Exercise a flow at runtime against a disposable fixture, assert on effects the flow itself produced, and clean up.',
    capabilities: ['flow_read', 'record_mutation', 'verification'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['flows', 'flow executions', 'the records under test'],
      change: ['disposable test records it created itself'],
      note: 'Cleanup is mandatory, and only records this test created are ever deleted.',
    },
  },
  {
    id: 'change-intelligence',
    name: 'Change Intelligence',
    version: '1.0.0',
    description:
      'Compare two authoritative states of an artifact, classify what changed and assess impact. Never deploys.',
    capabilities: ['flow_read'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['flows', 'snapshots', 'update versions', 'dependencies'],
      change: [],
      note: 'A diff needs two authoritative states. A description is not a baseline.',
    },
  },
  {
    id: 'knowledge',
    name: 'Knowledge',
    version: '1.0.0',
    description:
      'Retrieve indexed ServiceNow documentation and verified instance observations, ranked under the truth hierarchy.',
    capabilities: ['knowledge', 'memory'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['indexed documentation', 'the fact ledger', 'verified observations'],
      change: [],
      note: 'Retrieval is context, never authority: it cannot override live instance truth.',
    },
  },
  {
    id: 'application-builder',
    name: 'Application Builder',
    version: '1.0.0',
    description:
      'Design a scoped application as a dependency graph, validate it against the instance, and build only what the environment can legitimately build.',
    capabilities: ['application', 'schema_authoring', 'catalog', 'acl', 'flow_authoring'],
    tools: [],
    rules: [],
    knowledge: [],
    permissions: {
      read: ['applications', 'tables', 'roles', 'catalog items', 'the dictionary'],
      change: ['roles', 'catalog items and variables'],
      note: 'One unbuildable component blocks the whole build. Nothing is written until every component validates.',
    },
  },
]);

export const BUILT_IN_IDS = Object.freeze(BUILT_IN.map((s) => s.id));
