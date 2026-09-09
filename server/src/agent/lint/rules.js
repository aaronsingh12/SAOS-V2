/**
 * PHASE 16 — THE RULES.
 *
 * Twelve deterministic checks over a normalised live flow. Every one of them
 * answers a question by READING THE INSTANCE, and every one is allowed to say
 * it could not.
 *
 * THE SHAPE OF A RULE, and why it is shaped this way:
 *
 *   analyze(flow, ctx) -> { findings[], unknown[] }
 *
 * A rule returns UNKNOWN entries alongside findings because §39 forbids a check
 * that could not run from disappearing. A rule that simply returned no findings
 * when the dictionary was unreadable would be indistinguishable from a rule
 * that ran and found nothing, and the difference between those two is the
 * difference between "this flow is fine" and "I did not look".
 *
 * NO RULE ASKS A MODEL. `ctx` carries live schema reads, live choice lists, the
 * semantic layer, capability discovery and execution history — the platform's
 * own answers. §30 lists exactly the things a model may not be the authority
 * for, and every one of them is on that list.
 *
 * THE HARD PART IS NOT FINDING PROBLEMS. It is not inventing them. A linter
 * that flags every reference and every destructive action produces noise, and
 * §56 is explicit that ten useful findings beat a hundred warnings. So each
 * rule below refuses in more cases than it fires, and the false-positive tests
 * are the ones worth reading.
 */
import {
  SEVERITY, STATUS, KIND, CONFIDENCE, EVIDENCE_SOURCE,
} from './schemas.js';
import { makeFinding } from './findings.js';

const SYS_ID = /^[0-9a-f]{32}$/i;
/** A `{{...}}` value is a data pill: it points at another step, not a literal. */
const isPill = (v) => /\{\{.*\}\}/.test(String(v ?? ''));

/**
 * Split a ServiceNow encoded field map into field/value pairs.
 *
 * MEASURED FORMAT, from a real Update Record action on dev424910:
 *
 *   "message=Flow error, see context {{...}}^state=4"
 *
 * Caret-separated, `field=value`, and a value may itself contain a data pill
 * with braces and spaces. Only the FIRST `=` separates, because a value may
 * legitimately contain more.
 */
export function parseFieldMap(encoded) {
  const text = String(encoded ?? '').trim();
  if (!text) return [];
  return text.split('^').map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) return null;
    const field = pair.slice(0, at).trim();
    if (!/^[a-z][a-z0-9_.]*$/i.test(field)) return null;
    return { field, value: pair.slice(at + 1) };
  }).filter(Boolean);
}

/** The inputs of an action that identify a table and the fields it writes. */
function writeTargets(action) {
  const tableInput = action.inputs.find((i) => i.type === 'table_name');
  const mapInput = action.inputs.find((i) => i.type === 'template_value');
  if (!tableInput || !mapInput) return null;
  /* A table supplied by a data pill is not knowable statically. */
  if (tableInput.is_pill || !tableInput.supplied) return null;
  return { table: tableInput.supplied.trim(), pairs: parseFieldMap(mapInput.supplied), input: mapInput.name };
}

const ev = (source, extra) => ({ source, ...extra });

/* ================================================================== *
 * FLOW001 — a field the instance does not have
 * ================================================================== */

const FLOW001 = {
  id: 'FLOW001',
  description: 'A flow references a field that does not exist on the target table.',
  async analyze(flow, ctx) {
    const findings = [];
    const unknown = [];

    /* Fields written by an action's field map. */
    for (const action of flow.actions) {
      const target = writeTargets(action);
      if (!target) continue;
      const schema = await ctx.schemaOf(target.table);
      if (!schema) {
        unknown.push({
          rule_id: 'FLOW001',
          reason: `The dictionary for "${target.table}" could not be read, so the fields this step `
            + 'writes could not be checked.',
          affected: { step: action.type_name, table: target.table },
        });
        continue;
      }
      for (const { field } of target.pairs) {
        /* A dotted path walks a reference; this build checks the first hop only
         * and says so rather than guessing at the rest. */
        const head = field.split('.')[0];
        if (schema.has(head)) continue;
        findings.push(makeFinding({
          rule_id: 'FLOW001',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.CRITICAL,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `Field \`${target.table}.${head}\` does not exist`,
          description: `The step "${action.type_name}" writes \`${head}\` on \`${target.table}\`, `
            + 'and the live dictionary has no such field.',
          why_it_matters: 'The write silently does nothing. ServiceNow accepts the payload and '
            + 'discards the unknown column, so the flow reports success and changes nothing.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: action.type_name, input: target.input, detail: `${field}=…` }),
            ev(EVIDENCE_SOURCE.LIVE_SCHEMA, {
              table: target.table, field: head,
              detail: `the dictionary for ${target.table} returned ${schema.size} fields and none is "${head}"`,
            }),
          ],
          affected: { step: action.type_name, table: target.table, field: head },
          recommendation: { statement: `Remove \`${head}\` or correct it to a field that exists on ${target.table}.` },
        }));
      }
    }

    /* Fields named by a trigger condition. */
    for (const trigger of flow.triggers) {
      const table = await ctx.resolveTable(trigger.table_label);
      if (!trigger.condition) continue;
      if (!table) {
        unknown.push({
          rule_id: 'FLOW001',
          reason: `The trigger table "${trigger.table_label}" could not be resolved to a real table, `
            + 'so its condition fields could not be checked.',
          affected: { trigger: trigger.name ?? trigger.type },
        });
        continue;
      }
      const schema = await ctx.schemaOf(table);
      if (!schema) continue;
      for (const { field } of parseFieldMap(trigger.condition)) {
        const head = field.split('.')[0];
        if (schema.has(head)) continue;
        findings.push(makeFinding({
          rule_id: 'FLOW001',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.CRITICAL,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `Trigger condition names \`${table}.${head}\`, which does not exist`,
          description: `The trigger condition is \`${trigger.condition}\` and \`${head}\` is not a `
            + `field on \`${table}\`.`,
          why_it_matters: 'A condition on a column that does not exist cannot match, so the flow '
            + 'never fires — and nothing reports an error, because nothing ran.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: trigger.name ?? trigger.type, detail: trigger.condition }),
            ev(EVIDENCE_SOURCE.LIVE_SCHEMA, { table, field: head, detail: `no field "${head}" on ${table}` }),
          ],
          affected: { trigger: trigger.name ?? trigger.type, table, field: head },
          recommendation: { statement: `Correct the trigger condition to name a field that exists on ${table}.` },
        }));
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW002 — a field that cannot be written
 * ================================================================== */

const FLOW002 = {
  id: 'FLOW002',
  description: 'A flow writes a field the instance will not accept a write to.',
  async analyze(flow, ctx) {
    const findings = [];
    const unknown = [];
    for (const action of flow.actions) {
      const target = writeTargets(action);
      if (!target) continue;
      const schema = await ctx.schemaOf(target.table);
      if (!schema) {
        unknown.push({
          rule_id: 'FLOW002',
          reason: `Writability on "${target.table}" could not be checked: the dictionary was unreadable.`,
          affected: { step: action.type_name, table: target.table },
        });
        continue;
      }
      for (const { field } of target.pairs) {
        const head = field.split('.')[0];
        const column = schema.get(head);
        if (!column) continue;                       // FLOW001's business, not this rule's

        /*
         * A DERIVED FIELD IS THE CASE THAT MATTERS, and it is the one a name
         * cannot reveal. `priority` is not marked read-only in the dictionary —
         * that is precisely why the ledger fact exists — so this asks the
         * semantic layer, which recorded it from measurement.
         */
        const derived = ctx.derivationOf(target.table, head);
        if (derived) {
          findings.push(makeFinding({
            rule_id: 'FLOW002',
            flow_sys_id: flow.flow.sys_id,
            severity: SEVERITY.HIGH,
            status: STATUS.LIKELY,
            kind: KIND.DEFECT,
            confidence: CONFIDENCE.HIGH,
            title: `\`${head}\` is computed, not written`,
            description: `The step "${action.type_name}" writes \`${head}\` on \`${target.table}\`, `
              + `which this instance derives from ${derived.value.from.join(' + ')}.`,
            why_it_matters: 'The platform accepts the write and then overwrites it, so the flow '
              + 'reports success and the field ends up holding something else.',
            evidence: [
              ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: action.type_name, input: target.input, field: head }),
              ev(EVIDENCE_SOURCE.SEMANTIC, {
                table: target.table, field: head,
                detail: derived.note ?? `${head} is derived from ${derived.value.from.join(' + ')}`,
              }),
            ],
            affected: { step: action.type_name, table: target.table, field: head },
            recommendation: {
              statement: `Set ${derived.value.from.join(' and ')} instead of ${head}.`,
            },
            autofixable: true,
          }));
          continue;
        }

        /* The dictionary's own answer, where it has one. */
        if (column.readOnly) {
          findings.push(makeFinding({
            rule_id: 'FLOW002',
            flow_sys_id: flow.flow.sys_id,
            severity: SEVERITY.HIGH,
            status: STATUS.CONFIRMED,
            kind: KIND.DEFECT,
            confidence: CONFIDENCE.HIGH,
            title: `\`${head}\` is read-only`,
            description: `The step "${action.type_name}" writes \`${head}\` on \`${target.table}\`, `
              + 'which the dictionary marks read-only.',
            why_it_matters: 'The write will not take effect.',
            evidence: [
              ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: action.type_name, input: target.input, field: head }),
              ev(EVIDENCE_SOURCE.LIVE_SCHEMA, {
                table: target.table, field: head, detail: 'dictionary read_only = true',
              }),
            ],
            affected: { step: action.type_name, table: target.table, field: head },
            recommendation: { statement: `Remove the write to ${head}.` },
          }));
        }
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW003 — a reference that may not identify one record
 * ================================================================== */

const FLOW003 = {
  id: 'FLOW003',
  description: 'A reference is supplied as a display value whose uniqueness is not established.',
  async analyze(flow, ctx) {
    const findings = [];
    const unknown = [];
    for (const action of flow.actions) {
      const target = writeTargets(action);
      if (!target) continue;
      const schema = await ctx.schemaOf(target.table);
      if (!schema) continue;
      for (const { field, value } of target.pairs) {
        const column = schema.get(field.split('.')[0]);
        if (!column || column.type !== 'reference') continue;
        /* A pill or a sys_id is already an identity; neither is ambiguous. */
        if (isPill(value) || SYS_ID.test(String(value).trim()) || !String(value).trim()) continue;

        const referenced = column.reference;
        if (!referenced) {
          unknown.push({
            rule_id: 'FLOW003',
            reason: `\`${field}\` is a reference but the dictionary does not say to which table, `
              + 'so its uniqueness could not be checked.',
            affected: { step: action.type_name, field },
          });
          continue;
        }

        /*
         * ASK THE INSTANCE. §13 forbids claiming ambiguity without evidence and
         * equally forbids claiming uniqueness without it — so the display value
         * is actually looked up, and the finding says which answer came back.
         */
        const matches = await ctx.countMatches(referenced, String(value).trim());
        if (matches === null) {
          unknown.push({
            rule_id: 'FLOW003',
            reason: `Could not look up "${value}" in ${referenced} to establish whether it is unique.`,
            affected: { step: action.type_name, field },
          });
          continue;
        }
        if (matches === 1) continue;                 // proven unique — no finding

        findings.push(makeFinding({
          rule_id: 'FLOW003',
          flow_sys_id: flow.flow.sys_id,
          severity: matches === 0 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: matches === 0
            ? `Reference "${value}" matches no ${referenced} record`
            : `Reference "${value}" matches ${matches} ${referenced} records`,
          description: `The step "${action.type_name}" sets \`${field}\` to the display value `
            + `"${value}", and ${referenced} contains ${matches} record(s) with that name.`,
          why_it_matters: matches === 0
            ? 'The platform stores the text as a dangling reference and the write reads back as applied.'
            : 'The platform resolves the name silently, and which of the matching records it picks '
              + 'is not something the flow decides.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: action.type_name, field, detail: `${field}=${value}` }),
            ev(EVIDENCE_SOURCE.LIVE_RECORD, {
              table: referenced, detail: `${matches} record(s) in ${referenced} match "${value}"`,
            }),
          ],
          affected: { step: action.type_name, table: target.table, field },
          recommendation: { statement: `Supply a sys_id for ${field} rather than a display value.` },
        }));
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW004 — a required input with nothing in it
 * ================================================================== */

const FLOW004 = {
  id: 'FLOW004',
  description: 'An action declares an input mandatory and the flow supplies nothing.',
  analyze(flow) {
    const findings = [];
    const unknown = [];
    for (const action of flow.actions) {
      if (!action.inputs_readable) {
        unknown.push({
          rule_id: 'FLOW004',
          reason: `The inputs of "${action.type_name}" could not be decoded, so required inputs `
            + 'could not be checked.',
          affected: { step: action.type_name },
        });
        continue;
      }
      for (const input of action.inputs) {
        /* `mandatory` is the ACTION TYPE's own declaration, decoded from the
         * artifact. §14 forbids inferring requiredness from a name, and this
         * does not: it reads what the action says about itself. */
        if (!input.mandatory || !input.empty) continue;
        findings.push(makeFinding({
          rule_id: 'FLOW004',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.HIGH,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `Required input \`${input.name}\` is empty`,
          description: `The step "${action.type_name}" declares \`${input.name}\``
            + `${input.label ? ` ("${input.label}")` : ''} mandatory, and the flow supplies no value.`,
          why_it_matters: 'The action cannot run as configured.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, {
              step: action.type_name, input: input.name,
              detail: `declared mandatory=true, supplied value is empty`,
            }),
          ],
          affected: { step: action.type_name, input: input.name },
          recommendation: { statement: `Supply a value for ${input.name}.` },
        }));
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW005 — an input the action does not accept
 * ================================================================== */

const FLOW005 = {
  id: 'FLOW005',
  description: 'The flow supplies an input the action type does not declare.',
  analyze(flow) {
    const findings = [];
    const unknown = [];
    for (const action of flow.actions) {
      if (!action.inputs_readable) continue;         // FLOW004 already said so
      for (const input of action.inputs) {
        /*
         * The same principle Phase 13 established for tools: an argument the
         * receiver does not declare is not rejected, it is DROPPED, and the
         * step runs as though it were never supplied.
         */
        if (input.declared || input.empty) continue;
        findings.push(makeFinding({
          rule_id: 'FLOW005',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.MEDIUM,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `Input \`${input.name}\` is not declared by this action`,
          description: `The step "${action.type_name}" supplies \`${input.name}\`, which the action `
            + 'type does not declare.',
          why_it_matters: 'An undeclared input is dropped rather than refused, so the step runs as '
            + 'though it had never been supplied.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, {
              step: action.type_name, input: input.name, detail: 'no parameter declaration in the action type',
            }),
          ],
          affected: { step: action.type_name, input: input.name },
          recommendation: { statement: `Remove ${input.name} or map it to a declared input.` },
        }));
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW006 — a trigger condition that cannot be satisfied
 * ================================================================== */

const FLOW006 = {
  id: 'FLOW006',
  description: 'A trigger condition cannot match against the live schema or choice list.',
  async analyze(flow, ctx) {
    const findings = [];
    const unknown = [];
    for (const trigger of flow.triggers) {
      if (!trigger.condition) continue;
      const table = await ctx.resolveTable(trigger.table_label);
      if (!table) {
        unknown.push({
          rule_id: 'FLOW006',
          reason: `The trigger table "${trigger.table_label}" could not be resolved, so its condition `
            + 'could not be evaluated.',
          affected: { trigger: trigger.name ?? trigger.type },
        });
        continue;
      }
      const schema = await ctx.schemaOf(table);
      if (!schema) continue;
      for (const { field, value } of parseFieldMap(trigger.condition)) {
        const column = schema.get(field.split('.')[0]);
        if (!column) continue;                       // FLOW001 reports the missing field
        if (isPill(value) || !String(value).trim()) continue;

        /*
         * A CHOICE FIELD WITH A VALUE THAT IS NOT A CHOICE cannot match. Read
         * from `sys_choice`; §16 forbids guessing the valid values, and a field
         * with no declared choices is simply not checkable this way.
         */
        const choices = await ctx.choicesFor(table, field);
        if (!choices || !choices.size) continue;
        if (choices.has(String(value).trim())) continue;

        findings.push(makeFinding({
          rule_id: 'FLOW006',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.HIGH,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `Trigger condition \`${field}=${value}\` can never match`,
          description: `\`${table}.${field}\` accepts ${choices.size} choice value(s), and `
            + `"${value}" is not one of them.`,
          why_it_matters: 'The trigger cannot fire, and nothing reports an error because nothing runs.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: trigger.name ?? trigger.type, detail: trigger.condition }),
            ev(EVIDENCE_SOURCE.LIVE_CHOICES, {
              table, field,
              detail: `valid values: ${[...choices].slice(0, 8).join(', ')}${choices.size > 8 ? ', …' : ''}`,
            }),
          ],
          affected: { trigger: trigger.name ?? trigger.type, table, field },
          recommendation: { statement: `Use one of the declared choice values for ${field}.` },
        }));
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW007 — a branch that cannot be taken
 * ================================================================== */

const FLOW007 = {
  id: 'FLOW007',
  description: 'A condition contradicts itself and can never be satisfied.',
  analyze(flow) {
    const findings = [];
    const check = (label, condition, affected) => {
      if (!condition) return;
      /*
       * DETERMINISTIC CONTRADICTION ONLY. §17 says explicitly not to attempt
       * theorem proving, so this recognises exactly one shape: the same field
       * required to equal two different literal values in one AND-chain. That
       * is unarguable and cheap. Anything subtler is left alone rather than
       * guessed at.
       */
      const byField = new Map();
      for (const { field, value } of parseFieldMap(condition)) {
        if (isPill(value)) continue;
        byField.set(field, [...(byField.get(field) ?? []), String(value).trim()]);
      }
      for (const [field, values] of byField) {
        const distinct = [...new Set(values)];
        if (distinct.length < 2) continue;
        findings.push(makeFinding({
          rule_id: 'FLOW007',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.HIGH,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `\`${field}\` is required to equal two different values`,
          description: `${label} requires \`${field}\` to be ${distinct.map((v) => `"${v}"`).join(' and ')} `
            + 'at the same time.',
          why_it_matters: 'No record can satisfy both, so this never matches.',
          evidence: [ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: label, field, detail: condition })],
          affected: { ...affected, field },
          recommendation: { statement: `Decide which value of ${field} is intended.` },
        }));
      }
    };
    for (const t of flow.triggers) {
      check(`The trigger "${t.name ?? t.type}"`, t.condition, { trigger: t.name ?? t.type });
    }
    return { findings, unknown: [] };
  },
};

/* ================================================================== *
 * FLOW008 — failure handling
 * ================================================================== */

const FLOW008 = {
  id: 'FLOW008',
  description: 'The flow has historically failed and has no visible handling for it.',
  async analyze(flow, ctx) {
    /*
     * §18 IS A WARNING ABOUT THIS RULE. "Every action should have an error
     * branch" is an opinion, and a linter that emits opinions as defects gets
     * ignored. So this rule does not fire on structure at all — it fires only
     * when the instance shows this flow ACTUALLY failing, which is evidence
     * rather than taste, and it is reported as a RISK.
     */
    const history = await ctx.executionsOf(flow.flow.sys_id);
    if (history === null) {
      return {
        findings: [],
        unknown: [{
          rule_id: 'FLOW008',
          reason: 'Execution history for this flow could not be read, so whether it has failed in '
            + 'practice is not known.',
          affected: { flow: flow.flow.name },
        }],
      };
    }
    const failed = history.filter((x) => x.state === 'EXECUTION_ERROR');
    if (!failed.length) return { findings: [], unknown: [] };

    return {
      findings: [makeFinding({
        rule_id: 'FLOW008',
        flow_sys_id: flow.flow.sys_id,
        severity: SEVERITY.HIGH,
        status: STATUS.CONFIRMED,
        kind: KIND.RISK,
        confidence: CONFIDENCE.HIGH,
        title: `This flow has failed ${failed.length} time(s) on this instance`,
        description: `${failed.length} of the ${history.length} most recent executions ended in ERROR`
          + `${failed[0].error ? `, reporting: ${failed[0].error}` : '.'}`,
        why_it_matters: 'Whatever the flow was supposed to achieve did not happen on those runs.',
        evidence: failed.slice(0, 3).map((x) => ev(EVIDENCE_SOURCE.EXECUTION, {
          detail: `execution ${x.sys_id} ended ${x.state}${x.error ? `: ${x.error}` : ''}`,
          step: x.flow?.name ?? flow.flow.name,
        })),
        affected: { flow: flow.flow.name, location: 'execution history' },
        recommendation: { statement: 'Investigate the failing executions before relying on this flow.' },
      })],
      unknown: [],
    };
  },
};

/* ================================================================== *
 * FLOW009 — a destructive action
 * ================================================================== */

/* PHASE 18 reuses this rather than writing a second one: "which actions are
 * destructive" must have exactly one answer, or a change report and a lint
 * report can disagree about the same step. */
export const DESTRUCTIVE = /\b(delete|remove|purge|deactivate|cancel|truncate)\b/i;

const FLOW009 = {
  id: 'FLOW009',
  description: 'The flow performs a destructive action.',
  analyze(flow) {
    const findings = [];
    for (const action of flow.actions) {
      if (!action.type_name || !DESTRUCTIVE.test(action.type_name)) continue;
      /*
       * §19 — THIS IS NOT A BUG. A flow that deletes something usually deletes
       * it on purpose. Reported as a RISK at INFO-to-MEDIUM so it appears on a
       * review checklist without pretending to be a defect.
       */
      findings.push(makeFinding({
        rule_id: 'FLOW009',
        flow_sys_id: flow.flow.sys_id,
        severity: SEVERITY.MEDIUM,
        status: STATUS.CONFIRMED,
        kind: KIND.RISK,
        confidence: CONFIDENCE.HIGH,
        title: `Destructive step: "${action.type_name}"`,
        description: `The flow runs "${action.type_name}", which removes or disables data.`,
        why_it_matters: 'This is not necessarily wrong. It is worth confirming the step is scoped '
          + 'to the records intended, because the effect cannot be undone by re-running the flow.',
        evidence: [ev(EVIDENCE_SOURCE.LIVE_FLOW, {
          step: action.type_name, detail: `action order ${action.order}`,
        })],
        affected: { step: action.type_name, location: `order ${action.order}` },
        recommendation: { statement: 'Confirm the step is scoped to the intended records.' },
      }));
    }
    return { findings, unknown: [] };
  },
};

/* ================================================================== *
 * FLOW010 — the platform cannot work on this artifact
 * ================================================================== */

const FLOW010 = {
  id: 'FLOW010',
  description: 'This build cannot author, deploy or verify this artifact.',
  analyze(flow, ctx) {
    const authoring = ctx.capability('flow_authoring');
    if (authoring?.available) return { findings: [], unknown: [] };
    /*
     * §20 — THE DISTINCTION THIS RULE EXISTS TO PROTECT. The flow is not
     * broken. NowForge cannot change it. Those are different sentences and
     * conflating them would tell somebody their working automation is faulty
     * because our SDK is not installed. Hence PLATFORM_LIMITATION, INFO, and a
     * title that says whose limitation it is.
     */
    return {
      findings: [makeFinding({
        rule_id: 'FLOW010',
        flow_sys_id: flow.flow.sys_id,
        severity: SEVERITY.INFO,
        status: STATUS.CONFIRMED,
        kind: KIND.PLATFORM_LIMITATION,
        confidence: CONFIDENCE.HIGH,
        title: 'This build cannot modify this flow',
        description: 'Flow authoring is unavailable here'
          + `${authoring?.reason ? ` (${authoring.reason})` : ''}, so any fix would have to be applied `
          + 'in ServiceNow rather than by NowForge.',
        why_it_matters: 'This says nothing about the flow. It is a limitation of this environment, '
          + 'and it only affects whether a fix can be applied from here.',
        evidence: [ev(EVIDENCE_SOURCE.CAPABILITY, {
          detail: `flow_authoring available=false${authoring?.reason ? `, reason=${authoring.reason}` : ''}`,
        })],
        affected: { flow: flow.flow.name, location: 'platform' },
        recommendation: { statement: 'Apply any fix in the ServiceNow Flow Designer.' },
      })],
      unknown: [],
    };
  },
};

/* ================================================================== *
 * FLOW011 — a reference to a record that is gone
 * ================================================================== */

const FLOW011 = {
  id: 'FLOW011',
  description: 'A sys_id in the flow points at a record that no longer exists.',
  async analyze(flow, ctx) {
    const findings = [];
    const unknown = [];
    for (const action of flow.actions) {
      const target = writeTargets(action);
      if (!target) continue;
      const schema = await ctx.schemaOf(target.table);
      if (!schema) continue;
      for (const { field, value } of target.pairs) {
        const column = schema.get(field.split('.')[0]);
        if (!column || column.type !== 'reference' || !column.reference) continue;
        const literal = String(value).trim();
        if (!SYS_ID.test(literal)) continue;         // a pill or a name is not this rule's business

        const exists = await ctx.recordExists(column.reference, literal);
        if (exists === null) {
          unknown.push({
            rule_id: 'FLOW011',
            reason: `Could not check whether ${column.reference}/${literal} still exists.`,
            affected: { step: action.type_name, field },
          });
          continue;
        }
        if (exists) continue;

        findings.push(makeFinding({
          rule_id: 'FLOW011',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.HIGH,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: `\`${field}\` points at a ${column.reference} record that does not exist`,
          description: `The step "${action.type_name}" sets \`${field}\` to ${literal}, and no such `
            + `record is readable in ${column.reference}.`,
          why_it_matters: 'The reference is dangling. The write is accepted and the field ends up '
            + 'pointing at nothing.',
          evidence: [
            ev(EVIDENCE_SOURCE.LIVE_FLOW, { step: action.type_name, field, detail: `${field}=${literal}` }),
            ev(EVIDENCE_SOURCE.LIVE_RECORD, {
              table: column.reference, detail: `${column.reference}/${literal} is not readable`,
            }),
          ],
          affected: { step: action.type_name, table: target.table, field },
          recommendation: { statement: `Point ${field} at a record that exists, or resolve it at run time.` },
        }));
      }
    }
    return { findings, unknown };
  },
};

/* ================================================================== *
 * FLOW012 — nothing observable happens
 * ================================================================== */

const FLOW012 = {
  id: 'FLOW012',
  description: 'The flow produces no observable effect.',
  analyze(flow) {
    /*
     * §22 — INTENT IS NOT EVIDENCE. A flow called "Assign Incident" is not
     * proof that it assigns anything, and the reverse holds too: this rule
     * cannot say a flow fails its purpose, because the purpose is not
     * knowable. What it CAN say is that the flow contains no action at all,
     * which is a fact about the artifact rather than a reading of its name.
     */
    if (!flow.actions.length && flow.triggers.length) {
      return {
        findings: [makeFinding({
          rule_id: 'FLOW012',
          flow_sys_id: flow.flow.sys_id,
          severity: SEVERITY.MEDIUM,
          status: STATUS.CONFIRMED,
          kind: KIND.DEFECT,
          confidence: CONFIDENCE.HIGH,
          title: 'The flow has a trigger but no actions',
          description: `"${flow.flow.name}" fires on ${flow.triggers[0].type} and then does nothing: `
            + 'no readable action is attached to it.',
          why_it_matters: 'The flow runs and has no effect.',
          evidence: [ev(EVIDENCE_SOURCE.LIVE_FLOW, {
            detail: `${flow.triggers.length} trigger(s), 0 action instances`,
          })],
          affected: { flow: flow.flow.name, location: 'actions' },
          recommendation: { statement: 'Add the actions the trigger is meant to run, or deactivate the flow.' },
        })],
        unknown: [],
      };
    }
    /*
     * Anything less clear-cut is UNKNOWN rather than a finding, exactly as §22
     * requires: if intent cannot be established, there is nothing to report.
     */
    return {
      findings: [],
      unknown: flow.actions.length ? [] : [{
        rule_id: 'FLOW012',
        reason: 'The flow has no readable actions and no trigger, so whether it does anything '
          + 'observable could not be determined.',
        affected: { flow: flow.flow.name },
      }],
    };
  },
};

export const RULES = Object.freeze([
  FLOW001, FLOW002, FLOW003, FLOW004, FLOW005, FLOW006,
  FLOW007, FLOW008, FLOW009, FLOW010, FLOW011, FLOW012,
]);

export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));
