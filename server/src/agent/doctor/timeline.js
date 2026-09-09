/**
 * PHASE 15 — WHAT HAPPENED, IN ORDER, AND WHAT THAT DOES NOT PROVE.
 *
 * A timeline is the most persuasive artefact a diagnostic tool can produce and
 * therefore the most dangerous. Four events in a row read as a causal chain
 * whether or not one exists — the eye supplies the arrows. §24 is explicit
 * about the line this module must hold:
 *
 *   ALLOWED    "the flow failed after assignment_group changed"
 *   FORBIDDEN  "the assignment_group change caused the flow failure"
 *
 * So this module orders events and says nothing else. It has no notion of
 * cause, exposes no function that returns one, and the phrases it generates are
 * deliberately temporal — `before`, `after`, `at the same time as`. Causation
 * is decided in `diagnosis.js`, from evidence that is not merely chronological.
 *
 * EVERY ENTRY REFERENCES A FACT (§50). A timeline entry is not a new claim; it
 * is an existing fact plus the time it carries. `fact_id` is required, so a
 * reader can always get from a line on the timeline back to the tool result it
 * came from, and nothing can appear on the timeline that is not already
 * evidence.
 */

/** The kinds of thing that can appear on a timeline, and where each comes from. */
export const EVENT_KINDS = Object.freeze({
  RECORD_CREATED: 'record_created',
  FIELD_CHANGED: 'field_changed',
  JOURNAL_ENTRY: 'journal_entry',
  EXECUTION_STARTED: 'execution_started',
  EXECUTION_UPDATED: 'execution_updated',
  SLA_STARTED: 'sla_started',
  SLA_ENDED: 'sla_ended',
});

/**
 * ServiceNow date-times arrive as `2026-09-04 08:40:36`, which `Date.parse`
 * treats as local time in some runtimes and rejects in others. Normalising to
 * an ISO-ish form makes ordering deterministic across machines, which matters
 * because a timeline that sorts differently on two hosts is not evidence.
 *
 * Returns null rather than NaN for anything unparseable: an event with no
 * usable time is reported as UNTIMED rather than silently sorted to 1970.
 */
export function toEpoch(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/** One timeline event. `fact_id` ties it to evidence; `at` may be null. */
const event = ({ kind, at, label, detail = null, factId, source }) => ({
  kind,
  at: at ?? null,
  epoch: toEpoch(at),
  label,
  detail,
  fact_id: factId,
  source,
});

/**
 * Build a timeline from the normalised diagnostic results.
 *
 * @param {Array} steps  durable step rows: { id, tool, inputs, result, state }
 * @param {Array} facts  the facts already extracted from those steps
 *
 * Only steps that COMPLETED contribute. A read that failed observed nothing,
 * and putting a placeholder on the timeline for it would invent an event.
 */
export function buildTimeline(steps = [], facts = []) {
  const events = [];
  const factFor = (stepId, field) =>
    facts.find((f) => f.source?.step === stepId && f.field === field)?.id ?? null;

  for (const step of steps) {
    if (!step?.id || step.state !== 'completed') continue;
    const r = step.result;
    if (!r || typeof r !== 'object') continue;
    const source = { step: step.id, tool: step.tool };

    /* ---- record creation, from the record read itself ---- */
    if (step.tool === 'get_record' || step.tool === 'query_records') {
      const rows = Array.isArray(r) ? r : [r];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const created = row.sys_created_on?.value ?? row.sys_created_on ?? row.opened_at?.value ?? row.opened_at;
        if (!created) continue;
        const number = row.number?.value ?? row.number ?? null;
        events.push(event({
          kind: EVENT_KINDS.RECORD_CREATED,
          at: created,
          label: `${step.inputs?.table ?? 'record'}${number ? ` ${number}` : ''} created`,
          /*
           * The id is DERIVED the same way `evidence.js` derives it, rather
           * than looked up. A lookup returns null when the caller passes no
           * facts, and §23/§50 require every timeline entry to reference one —
           * an entry whose anchor depends on how it was called is not evidence.
           */
          factId: `fact_${step.id}_${row.sys_created_on ? 'sys_created_on' : 'opened_at'}`,
          source,
        }));
      }
    }

    /* ---- field changes, from the audit ---- */
    if (step.tool === 'get_record_audit' && Array.isArray(r.changes)) {
      for (const c of r.changes) {
        events.push(event({
          kind: EVENT_KINDS.FIELD_CHANGED,
          at: c.changed_at,
          label: `${c.field} changed`,
          detail: {
            field: c.field, old_value: c.old_value, new_value: c.new_value, changed_by: c.changed_by,
          },
          factId: `fact_${step.id}_${c.sys_id}`,
          source,
        }));
      }
    }

    /* ---- what people wrote ---- */
    if (step.tool === 'get_record_journal' && Array.isArray(r.entries)) {
      for (const e of r.entries) {
        events.push(event({
          kind: EVENT_KINDS.JOURNAL_ENTRY,
          at: e.created_at,
          label: `${e.element} written by ${e.author}`,
          detail: { element: e.element, value: e.value, author: e.author },
          factId: `fact_${step.id}_${e.sys_id}`,
          source,
        }));
      }
    }

    /* ---- automation ---- */
    const executions = Array.isArray(r.executions) ? r.executions : (r.execution ? [r.execution] : []);
    if ((step.tool === 'find_flow_executions' || step.tool === 'get_flow_execution') && executions.length) {
      for (const x of executions) {
        events.push(event({
          kind: EVENT_KINDS.EXECUTION_STARTED,
          at: x.started_at,
          label: `${x.flow?.name ?? 'automation'} started`,
          detail: { flow: x.flow?.name ?? null, execution_id: x.execution_id },
          factId: `fact_${step.id}_${x.sys_id}_started`,
          source,
        }));
        /*
         * The context's last update is when it reached its current state. That
         * is reported as "reached STATE", not as "ended" — a WAITING context is
         * still running, and calling its last update an ending would be a
         * claim the column does not make.
         */
        if (x.last_updated_at && x.last_updated_at !== x.started_at) {
          events.push(event({
            kind: EVENT_KINDS.EXECUTION_UPDATED,
            at: x.last_updated_at,
            label: `${x.flow?.name ?? 'automation'} reached ${x.state}`,
            detail: { state: x.state, error: x.error ?? null },
            factId: `fact_${step.id}_${x.sys_id}_state`,
            source,
          }));
        }
      }
    }

    /* ---- SLA clocks ---- */
    if (step.tool === 'get_record_slas' && Array.isArray(r.slas)) {
      for (const s of r.slas) {
        if (s.start_time) {
          events.push(event({
            kind: EVENT_KINDS.SLA_STARTED,
            at: s.start_time,
            label: `SLA "${s.definition?.name ?? 'unknown'}" started`,
            detail: { sla: s.definition?.name ?? null, stage: s.stage },
            factId: `fact_${step.id}_${s.sys_id}_start`,
            source,
          }));
        }
        if (s.end_time) {
          events.push(event({
            kind: EVENT_KINDS.SLA_ENDED,
            at: s.end_time,
            label: `SLA "${s.definition?.name ?? 'unknown'}" ended as ${s.stage}`,
            detail: { sla: s.definition?.name ?? null, stage: s.stage, breached: s.has_breached },
            factId: `fact_${step.id}_${s.sys_id}_end`,
            source,
          }));
        }
      }
    }
  }

  /*
   * DETERMINISTIC ORDER. Timed events first, oldest first; ties broken by kind
   * then label so the same evidence always renders the same way. Untimed events
   * go last and are labelled as such rather than being given an invented
   * position — several ServiceNow timestamps share a second, and a timeline
   * that reordered itself between runs would not be evidence.
   */
  const timed = events.filter((e) => e.epoch !== null);
  const untimed = events.filter((e) => e.epoch === null);
  timed.sort((a, b) => (a.epoch - b.epoch)
    || String(a.kind).localeCompare(String(b.kind))
    || String(a.label).localeCompare(String(b.label)));

  return {
    events: [...timed, ...untimed],
    timed: timed.length,
    untimed: untimed.length,
    /*
     * Events sharing a second cannot be ORDERED relative to each other, only
     * grouped. Saying so is the difference between "A then B" and "A and B in
     * the same second, in an order nobody recorded".
     */
    simultaneous: groupsOfSameInstant(timed),
    span: timed.length
      ? { from: timed[0].at, to: timed[timed.length - 1].at }
      : null,
  };
}

function groupsOfSameInstant(timed) {
  const byEpoch = new Map();
  for (const e of timed) byEpoch.set(e.epoch, [...(byEpoch.get(e.epoch) ?? []), e.label]);
  return [...byEpoch.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([epoch, labels]) => ({ epoch, labels }));
}

/**
 * The ORDERING relationship between two events, and nothing more.
 *
 * The return values are the vocabulary §24 permits. There is deliberately no
 * `caused` and no way to express one: a module that could say "A caused B"
 * would eventually be asked to, and the answer would be built from ordering,
 * which is exactly the forbidden inference.
 */
export function relate(a, b) {
  if (!a || !b || a.epoch === null || b.epoch === null) return 'unordered';
  if (a.epoch < b.epoch) return 'before';
  if (a.epoch > b.epoch) return 'after';
  return 'same_instant';
}

/**
 * Did `later` happen after `earlier`? A precondition for causation, never a
 * demonstration of it.
 *
 * Used by the causal rules to REJECT candidates — an execution that started
 * after the symptom was already true cannot explain it — which is the only
 * direction chronology can be used in safely. Ruling a hypothesis out on order
 * is sound; ruling one in is not.
 */
export function happenedAfter(later, earlier) {
  if (!later || !earlier) return null;
  const l = toEpoch(later);
  const e = toEpoch(earlier);
  if (l === null || e === null) return null;
  return l >= e;
}
