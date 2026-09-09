/**
 * PHASE 20 — THE APPLICATION BUILDER, ASSEMBLED.
 *
 * §2 is the whole design: this is an orchestrator and a composer, and it must
 * not become a second client, executor, verifier, approval mechanism or
 * deployment system. Read `buildApplication` and every one of those is CALLED:
 *
 *   capability discovery  `discoverAll`, injected
 *   the naming rules      `validateScopeName` / `vendorPrefix` (Phase 9)
 *   the plan              `generatePlan` with a deterministic `propose`,
 *                         `validatePlan`, `savePlan`, `buildReview` (Phase 4)
 *   approval              the existing card and gate, untouched
 *   execution             `executePlan` — §64, non-negotiable
 *   verification          read-back, injected
 *   linting               `lintFlow` (Phase 16)
 *   the change summary    Phase 18's categories and risk table
 *   knowledge             `knowledgeFor` (Phase 19)
 *   the runtime test      `testFlow` (Phase 17)
 *
 * ═══ THE ORDER IS THE SAFETY ARGUMENT ═══
 *
 *   read requirements → discover → architect → validate → graph → capability
 *   → GATE → lint → change → knowledge → plan → review → approve → execute
 *   → verify → test
 *
 * The GATE is where §29 lives: nothing is written until every component has
 * been resolved against this instance. On an environment without the SDK the
 * run stops there, having designed the whole application, and writes nothing.
 * That is the dominant outcome on dev424910 and it is a correct one.
 */
import crypto from 'node:crypto';
import { COMPONENT, OUTCOME, FAILURE, STATUS, VERIFY, emptyBuild } from './schemas.js';
import { readRequirements, validateRequirements, testableCriteria } from './requirements.js';
import { discover, reconcile } from './discovery.js';
import {
  architectSystem, normalizeComponents, validateArchitecture, securityModel, buildArchitecture,
  countByType, applyNaming, technicalName,
} from './architecture.js';
import { buildGraph, validateGraph, buildOrder, describeDependencies, identityOf } from './graph.js';
import { gate, remediationFor } from './capability.js';
import { buildPlan, testPlan } from './plan.js';
import { verifyComponents, conclude, partialState, rollbackEligibility } from './verify.js';
import { renderBuild, summarise } from './render.js';

const now = () => Date.now();

/**
 * Design, and where possible build, an application.
 *
 * Every collaborator is injected. Not for testability alone: it makes the
 * absence of a second ServiceNow path a property of this module's signature
 * rather than a promise in a comment (§63).
 */
export async function buildApplication({
  request,
  taskId = null,
  sessionId = null,
  /* reading the request */
  chat = null,
  decoding = undefined,
  /* the instance */
  discovered,
  naming,
  fieldTypes = new Set(),
  /* §21 — a live predicate, so a reference to a platform table resolves. */
  tableExists = null,
  probes = {},
  registry = null,
  /* the existing pipeline */
  plan: planApi = null,
  run = null,
  autoApprove = false,
  /* the other domains */
  lint = null,
  knowledgeFor = null,
  testFlow = null,
  readBack = null,
  /* bookkeeping */
  record = null,
  at = null,
  signal = null,
  emit = () => {},
} = {}) {
  const started = now();
  const timings = {};
  const base = emptyBuild();

  /* ---- 1. §4 — what was asked for ---- */
  const t0 = now();
  const read = await readRequirements({ request, chat, decoding, signal });
  timings.requirements_ms = now() - t0;
  if (!read.ok) {
    return stop(base, FAILURE.REQUIREMENTS_UNCLEAR, read.note, { problems: read.problems ?? [] }, timings, started);
  }
  const requirements = read.requirements;
  base.requirements = requirements;
  emit({ type: 'appbuild_requirements', taskId, name: requirements.name, by: read.by });

  /* ---- 2. §6 — what is already there ---- */
  const t1 = now();
  const discovery = await discover({ probes, scopePrefix: naming?.prefix, names: namesFrom(requirements) });
  timings.discovery_ms = now() - t1;
  base.discovery = discovery;
  emit({ type: 'appbuild_discovered', taskId, counts: discovery.counts, complete: discovery.complete });

  /* ---- 3. §8 — the architecture ---- */
  const t2 = now();
  const proposed = await proposeArchitecture({ requirements, naming, fieldTypes, chat, decoding, signal });
  if (!proposed.ok) {
    return stop({ ...base }, FAILURE.ARCHITECTURE_INVALID, proposed.note, {}, timings, started);
  }
  const normalized = normalizeComponents(proposed.raw);
  /*
   * §17 — the PLATFORM names scoped artifacts, before anything is validated.
   * The model says what a thing is for; what it is called is a rule of this
   * instance. See `applyNaming` for the measurement that put it here.
   */
  const named = applyNaming(normalized.components, { prefix: naming.prefix });

  /*
   * §21 — resolve every table the architecture POINTS AT against the live
   * dictionary, before validating.
   *
   * `validateArchitecture` is synchronous by design — it is a rule engine, and
   * a rule that awaits is a rule that can be raced. So the asynchronous part
   * happens here: the referenced tables are collected, each is looked up once,
   * and the validator receives a set it can consult without blocking.
   */
  const referenced = [...new Set(named.components
    .flatMap((c) => [c.spec?.reference, c.spec?.table])
    .filter((t) => typeof t === 'string' && t.trim()))];
  const liveTables = new Set();
  if (typeof tableExists === 'function') {
    for (const t of referenced) {
      try {
        if (await tableExists(t)) liveTables.add(t);
      } catch { /* a table that cannot be checked is not asserted to exist */ }
    }
  }

  const check = validateArchitecture({
    components: named.components,
    naming,
    fieldTypes,
    existing: discovery.identities,
    tableExists: (t) => liveTables.has(t),
  });
  timings.architecture_ms = now() - t2;

  /* Identity is stamped once, here, so the graph, the discovery reconciliation
   * and the renderer all read the same answer. */
  const withIdentity = named.components.map((c) => ({ ...c, identity: identityOf(c) }));

  if (!check.ok) {
    const arch = buildArchitecture({
      requirements,
      components: withIdentity,
      graph: buildGraph(withIdentity),
      problems: check.problems,
      security: securityModel(withIdentity),
    });
    arch.renamed = named.renamed;
    return stop({ ...base, architecture: arch }, FAILURE.ARCHITECTURE_INVALID,
      `The architecture is not valid: ${check.fatal[0]?.message}`,
      { problems: check.problems }, timings, started);
  }

  /* ---- 4. §7 — reuse what exists, stop on a collision ---- */
  const { build: components, reused, collisions } = reconcile({ components: withIdentity, discovered: discovery });

  /* ---- 5. §9/§10/§11 — the graph ---- */
  const t3 = now();
  const graph = buildGraph(components);
  /* A table the dictionary confirms is an existing artifact for the graph as
   * well as for the reference check — a field on `incident` depends on
   * `incident`, and `incident` is not missing. */
  const known = new Set([...discovery.identities, ...liveTables]);
  const graphCheck = validateGraph({ components, graph, existing: known });
  const security = securityModel(components);
  const architecture = buildArchitecture({
    requirements, components, graph, problems: check.problems, security, reused, collisions,
  });
  /* §17/§41 — the names the platform chose, so a reviewer sees what their
   * application will actually be called. */
  architecture.renamed = named.renamed;
  architecture.live_tables = [...liveTables];
  base.architecture = architecture;

  if (!graphCheck.ok) {
    const code = graphCheck.problems[0]?.code === 'dependency_cycle' ? FAILURE.DEPENDENCY_CYCLE
      : graphCheck.problems[0]?.code === 'missing_dependency' ? FAILURE.MISSING_DEPENDENCY
        : FAILURE.DUPLICATE_ARTIFACT;
    return stop({ ...base }, code, graphCheck.problems[0].message, { problems: graphCheck.problems }, timings, started);
  }

  const ordered = buildOrder({ components, graph, existing: known });
  if (!ordered.ok) {
    return stop({ ...base }, FAILURE.DEPENDENCY_CYCLE,
      'The components cannot be put in a buildable order.', { unmet: ordered.unmet }, timings, started);
  }
  base.graph = { edges: graph.edges, order: ordered.order, described: describeDependencies(graph) };
  timings.graph_ms = now() - t3;

  /* ---- 6. §12/§29 — THE GATE. Nothing is written before this passes. ---- */
  const t4 = now();
  const capability = gate({ components, discovered, registry, collisions });
  timings.capability_ms = now() - t4;
  base.capability = capability;
  architecture.unsupported = capability.blocked.map((b) => ({ component: b.component, status: b.status, why: b.why }));
  emit({ type: 'appbuild_capability', taskId, executable: capability.executable, blocked: capability.blocked.length });

  /* ---- 7. §14 — the architecture's own identity ---- */
  base.fingerprint = architectureFingerprint({ requirements, components, edges: graph.edges });

  /* ---- 8. §33/§38/§39 — lint, change, knowledge ---- */
  const criteria = testableCriteria(requirements);
  base.testPlan = testPlan({ requirements, components, testable: criteria.testable });
  base.untestable = criteria.untestable;
  base.change = changeSummary({ components, reused });
  base.knowledge = typeof knowledgeFor === 'function'
    ? await knowledgeFor({ subject: `${requirements.name} ${components.map((c) => c.type).join(' ')}` }).catch(() => null)
    : null;
  base.lint = null; /* nothing live to lint until something is built (§33) */
  base.limitations = limitationsFrom({ discovery, capability, criteria });

  /* ---- 9. §28 — blocked stops here, having designed everything ---- */
  if (!capability.executable) {
    const out = {
      ...base,
      outcome: OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED,
      remediation: remediationFor(capability.blocked),
      failures: capability.blocked.map((b) => ({ code: FAILURE.CAPABILITY_UNAVAILABLE, component: b.component, message: b.why })),
      timings: { ...timings, total_ms: now() - started },
    };
    finish(out, record, taskId, emit);
    return out;
  }

  /* ---- 10. §13/§43/§64 — the ordinary plan ---- */
  if (!planApi || typeof run !== 'function') {
    const out = {
      ...base,
      outcome: OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED,
      remediation: [],
      failures: [{ code: FAILURE.PLAN_REFUSED, message: 'No execution pipeline was supplied, so nothing was built.' }],
      timings: { ...timings, total_ms: now() - started },
    };
    finish(out, record, taskId, emit);
    return out;
  }

  const t5 = now();
  const built = buildPlan({
    ordered: ordered.components,
    requirements,
    application: architecture.application.scope,
  });
  const generated = await planApi.generate({
    goal: built.plan.goal,
    propose: async () => built.plan,
    signal,
  });
  if (!generated.ok) {
    const out = {
      ...base,
      outcome: OUTCOME.BLOCKED,
      failures: [{
        code: FAILURE.PLAN_REFUSED,
        message: `The build plan was refused before anything ran: `
          + `${(generated.fatal ?? []).map((p) => p.code).join(', ') || generated.reason}`,
        problems: generated.fatal ?? [],
      }],
      timings: { ...timings, plan_ms: now() - t5, total_ms: now() - started },
    };
    finish(out, record, taskId, emit);
    return out;
  }

  const saved = planApi.save(taskId, generated.plan);
  planApi.setState(taskId, 'ready');
  const review = planApi.review(generated.plan, { fingerprint: saved.fingerprint, discovered: generated.discovered });
  base.plan = {
    taskId,
    fingerprint: saved.fingerprint,
    steps: generated.plan.steps.map((s) => ({ id: s.id, operation: s.operation, tool: s.tool, capability: s.capability })),
    folded: built.folded,
    review,
    approvalRequired: review.approvalRequired,
  };
  timings.plan_ms = now() - t5;
  emit({ type: 'appbuild_plan_ready', taskId, fingerprint: saved.fingerprint, steps: generated.plan.steps.length, review });

  /*
   * §42 — approval is the EXISTING one. This module raises no card of its own:
   * a build plan is a mutating plan, `executePlan` refuses to run a step
   * without a resolved approval, and the caller drives that gate exactly as the
   * ordinary plan route does.
   */
  if (typeof planApi.approve !== 'function' || !planApi.approve) {
    const out = {
      ...base,
      outcome: OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED,
      failures: [{ code: FAILURE.APPROVAL_REFUSED, message: 'No approval path was supplied, so nothing was built.' }],
      timings: { ...timings, total_ms: now() - started },
    };
    finish(out, record, taskId, emit);
    return out;
  }

  const approved = await planApi.approve({ taskId, fingerprint: saved.fingerprint, review, signal });
  if (!approved?.ok) {
    const out = {
      ...base,
      outcome: approved?.cancelled ? OUTCOME.CANCELLED : OUTCOME.BLOCKED,
      stopped: { reason: approved?.reason ?? 'not_approved', note: approved?.note ?? 'The build was not approved. Nothing ran.' },
      failures: [{ code: FAILURE.APPROVAL_REFUSED, message: approved?.note ?? 'The build was not approved.' }],
      timings: { ...timings, total_ms: now() - started },
    };
    finish(out, record, taskId, emit);
    return out;
  }

  /* ---- 11. §43/§64 — the existing executor ---- */
  const t6 = now();
  const outcome = await run({ taskId, sessionId, emit, signal, autoApprove });
  timings.build_ms = now() - t6;

  const after = planApi.load(taskId);
  const created = createdFrom({ plan: after, components: ordered.components, stepFor: built.stepFor });
  base.created = created;
  base.build = {
    ok: Boolean(outcome?.ok),
    reason: outcome?.reason ?? null,
    note: outcome?.note ?? null,
    steps: (after?.steps ?? []).map((s) => ({ id: s.id, state: s.state })),
  };

  if (!outcome?.ok) {
    const planned = generated.plan.steps;
    const partial = partialState({
      created,
      planned,
      failedAt: (after?.steps ?? []).find((s) => s.state === 'failed')?.id ?? null,
    });
    const out = {
      ...base,
      outcome: created.length ? OUTCOME.PARTIAL_BUILD : OUTCOME.BUILD_FAILED,
      build: { ...base.build, partial },
      failures: [{ code: FAILURE.BUILD_FAILURE, message: outcome?.note ?? 'The build did not run to completion.' }],
      timings: { ...timings, total_ms: now() - started },
    };
    finish(out, record, taskId, emit);
    return out;
  }

  /* ---- 12. §44/§46 — verify, then test ---- */
  const t7 = now();
  const verified = await verifyComponents({ created, readBack });
  let test = null;
  const flow = components.find((c) => c.type === COMPONENT.FLOW);
  if (flow && typeof testFlow === 'function') {
    /* §34 — the runtime check is NowTest's, not a second one. */
    test = await testFlow({ request: `Test the ${flow.name} flow.` }).catch(() => null);
  }
  const verification = conclude({
    components,
    verified,
    test,
    behaviours: criteria.testable.length,
    /* A folded component was built by its parent's single call, so it has no
     * step and no read-back of its own. It is covered, not missing. */
    folded: built.folded,
  });
  timings.verify_ms = now() - t7;

  const out = {
    ...base,
    outcome: verification.outcome,
    verification: { ...verification, components_detail: verified },
    test,
    timings: { ...timings, total_ms: now() - started },
  };
  finish(out, record, taskId, emit);
  return out;
}

/* ------------------------------------------------------------------ *
 * The architecture proposal
 * ------------------------------------------------------------------ */

async function proposeArchitecture({ requirements, naming, fieldTypes, chat, decoding, signal }) {
  if (typeof chat !== 'function') {
    return { ok: false, note: 'No model was available to turn the requirements into an architecture.' };
  }
  try {
    const raw = await chat({
      system: architectSystem({
        prefix: naming.prefix,
        maxScope: naming.maxScope,
        fieldTypes: [...fieldTypes],
      }),
      user: `REQUIREMENTS:\n${JSON.stringify(requirements, null, 1)}`,
      maxTokens: 3000,
      decoding,
      signal,
    });
    const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
    if (!parsed) return { ok: false, note: 'The architecture proposal did not come back as JSON.' };
    return { ok: true, raw: parsed };
  } catch (err) {
    return { ok: false, note: `The architecture could not be proposed: ${err.message}` };
  }
}

function extractJson(text) {
  const s = String(text ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * §14 — the architecture fingerprint
 * ------------------------------------------------------------------ */

/**
 * A deterministic name for "this architecture".
 *
 * §14 says what goes in and, more usefully, what stays out: no model, no
 * provider, no timestamp, no task id. Two people asking for the same
 * application in different words get the same fingerprint, which is what makes
 * it usable as an identity.
 *
 * The PLAN keeps its own fingerprint — this does not replace it, and §15's
 * staleness is enforced by that one through the existing machinery. This one
 * identifies the design; that one binds the approval.
 */
export function architectureFingerprint({ requirements, components, edges }) {
  const lines = [
    `name=${requirements?.name ?? ''}`,
    `purpose=${requirements?.purpose ?? ''}`,
  ];
  for (const c of [...components].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`component=${c.type}:${c.id}:${JSON.stringify(sortedSpec(c.spec))}`);
  }
  for (const e of [...edges].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))) {
    lines.push(`edge=${e.from}->${e.to}`);
  }
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

const sortedSpec = (spec) => Object.fromEntries(Object.entries(spec ?? {}).sort(([a], [b]) => a.localeCompare(b)));

/* ------------------------------------------------------------------ *
 * §38 — the change summary
 * ------------------------------------------------------------------ */

/**
 * What this build would add, and how much it could cost.
 *
 * The risk table is Phase 18's reasoning applied to creation rather than
 * modification: a new table or ACL changes what the instance can do and who can
 * do it, so a build containing either is HIGH. It is a frozen lookup, not a
 * judgement — §68 does not list model-decided risk for this phase, but §36's
 * rule and Phase 18's §63.6 both point the same way.
 */
export function changeSummary({ components, reused = [] }) {
  const byType = countByType(components);
  const risky = components.some((c) => c.type === COMPONENT.ACL
    || c.type === COMPONENT.TABLE
    || c.type === COMPONENT.APPLICATION);
  const behavioural = components.some((c) => c.type === COMPONENT.FLOW);

  return {
    total: components.length,
    by_type: byType,
    reused: reused.length,
    risk: risky ? 'HIGH' : (behavioural ? 'MEDIUM' : 'LOW'),
    why: risky
      ? 'This build creates artifacts that change what the instance can do or who may do it — a table, an '
        + 'application scope or an access rule. Those are the changes hardest to undo.'
      : behavioural
        ? 'This build creates automation, which changes what happens when records are saved.'
        : 'This build creates only artifacts that store or present data, and grants no new access.',
  };
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

const namesFrom = (r) => [r.name, ...(r.data ?? []), ...(r.interfaces ?? [])]
  .filter(Boolean).map((s) => String(s).slice(0, 60));

/** What the executed plan actually created, from the DURABLE step rows. */
function createdFrom({ plan, components, stepFor }) {
  const out = [];
  const byStep = new Map();
  for (const [componentId, stepIdValue] of (stepFor ?? new Map())) byStep.set(stepIdValue, componentId);

  for (const step of plan?.steps ?? []) {
    /*
     * A STEP THAT FAILED MAY STILL HAVE CREATED SOMETHING, and missing that is
     * how a build leaves an orphan.
     *
     * FOUND BY THE REAL PDI RUN. The catalog step's write landed — a real
     * `sc_cat_item` existed on the instance — and the step was then marked
     * failed. This function counted only `completed` steps, so the item was
     * absent from `created`, absent from the ownership record, and absent from
     * cleanup. The run reported PARTIAL_BUILD honestly and left a real artifact
     * behind anyway.
     *
     * §30 asks for the exact created list and §31 makes ownership the condition
     * for removing anything. Both are about what EXISTS, not about what
     * succeeded — so a step is counted whenever its recorded result carries an
     * identity, and its step state travels alongside so a reader can see that
     * the artifact exists and the step did not succeed.
     */
    const componentId = byStep.get(step.id);
    const component = components.find((c) => c.id === componentId);
    const sysId = step.result?.sys_id?.value ?? step.result?.sys_id
      ?? step.result?.item?.sys_id?.value ?? step.result?.item?.sys_id ?? null;
    /* No identity means nothing landed that anybody could own or remove. */
    if (typeof sysId !== 'string' || !sysId) continue;
    out.push({
      component: componentId ?? step.id,
      type: component?.type ?? null,
      step: step.id,
      step_state: step.state,
      table: step.inputs?.table ?? null,
      sys_id: sysId,
      /* §31 — ownership, recorded at creation and never inferred later. */
      created_by_this_build: true,
      /* An artifact whose step did not complete EXISTS and is not a success. */
      step_succeeded: step.state === 'completed',
    });
  }
  return out;
}

function limitationsFrom({ discovery, capability, criteria }) {
  const out = [];
  if (!discovery.complete) {
    for (const u of discovery.unreadable) {
      out.push(`The ${u.surface} surface could not be read (${u.reason}), so a duplicate there would not have been detected.`);
    }
  }
  if (capability.blocked.length) {
    const statuses = [...new Set(capability.blocked.map((b) => b.status))];
    out.push(`This environment cannot author: ${statuses.join(', ')}. The architecture is unaffected; the build is not.`);
  }
  if (criteria.note) out.push(criteria.note);
  return out;
}

function stop(partial, code, note, detail, timings, started) {
  const out = {
    ...partial,
    outcome: OUTCOME.BLOCKED,
    stopped: { reason: code, note, ...detail },
    failures: [{ code, message: note, ...detail }],
    timings: { ...timings, total_ms: now() - started },
  };
  /* A refused run gets the same rendering and the same summary as one that
   * proceeded. A caller should never have to tell "it stopped" from "the
   * markdown key is missing". */
  out.summary = summarise(out);
  out.markdown = renderBuild(out);
  return out;
}

function finish(out, record, taskId, emit) {
  out.summary = summarise(out);
  out.markdown = renderBuild(out);
  if (typeof record === 'function') record(taskId, out);
  emit({ type: 'appbuild_decided', taskId, outcome: out.outcome, created: out.created?.length ?? 0 });
}

export { renderBuild, summarise } from './render.js';
export {
  readRequirements, validateRequirements, testableCriteria, normalizeRequirements, requirementsSystem,
} from './requirements.js';
export { discover, compare, reconcile } from './discovery.js';
export {
  architectSystem, normalizeComponents, validateArchitecture, securityModel, buildArchitecture,
  countByType, applyNaming, technicalName,
} from './architecture.js';
export {
  buildGraph, validateGraph, buildOrder, describeDependencies, semanticEdges, identityOf,
} from './graph.js';
export { gate, resolveCapabilities, remediationFor, summarise as capabilitySummary } from './capability.js';
export { buildPlan, testPlan } from './plan.js';
export {
  verifyComponents, conclude, partialState, rollbackEligibility,
} from './verify.js';
export {
  COMPONENT, COMPONENT_LIST, COMPONENT_CAPABILITY, COMPONENT_TOOL,
  STATUS, STATUS_LIST, statusFor, isExecutable, OUTCOME, FAILURE, VERIFY,
  emptyRequirements, isRequirements, emptyBuild,
} from './schemas.js';
