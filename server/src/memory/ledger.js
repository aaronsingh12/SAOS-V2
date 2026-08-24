import { getDb } from './db.js';
import { currentActor } from './audit.js';

/**
 * WI-2 — the mutation ledger.
 *
 * THE DEFECT THIS EXISTS FOR. A compaction fired mid-turn (13,348 → 3,062
 * tokens, budget 12,081) immediately before the closing summary, and that
 * summary omitted an approved, executed record creation entirely. A user
 * approved a write at the amber gate, the write happened, and the turn's report
 * did not mention it. Nothing was lying — the model simply no longer had it.
 *
 * The fix is not a bigger budget or a better prompt. It is to stop asking the
 * model to remember what it did. Every executed mutation is appended here, and
 * the end-of-turn report is RENDERED FROM THIS TABLE. The model narrates around
 * a block it did not author and cannot omit.
 *
 * PINNED, structurally. Compaction deletes from `messages` and `chunks` and
 * touches nothing else, so no ledger row can be folded, summarised or degraded
 * by it. That is the same property that makes `tool_events` survive compaction,
 * and it is worth more than a rule someone has to keep remembering — there is
 * no code path that could remove one of these even by mistake.
 */

const now = () => new Date().toISOString();
const cell = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/**
 * The string a human would search the instance for.
 *
 * Ordered by how identifying each is: a number is unique and typed into a
 * search box, a name is what the user asked for, a short description is the
 * last resort. Without one of these a report can only say "a record was
 * created", which is the report being useless in a different way.
 */
function deriveDisplayId(result) {
  if (!result || typeof result !== 'object') return null;
  for (const field of ['number', 'name', 'title', 'short_description']) {
    const v = cell(result[field]);
    if (v) return String(v);
  }
  // Composite builders nest their primary record.
  for (const key of ['item', 'variable', 'flow', 'sla', 'policy']) {
    const nested = result[key];
    if (nested && typeof nested === 'object') {
      const v = cell(nested.number) || cell(nested.name) || cell(nested.title);
      if (v) return String(v);
    }
  }
  return null;
}

/** Record one executed mutation. Never throws — a ledger failure must not fail a turn. */
export function appendMutation({
  sessionId, turnSeq, tool, descriptor, result, verification, approval,
  approvedSource = null, approvedAt = null, capture = null,
}) {
  try {
    const { instance, actor } = currentActor();
    const status = verification?.status || 'unverified';
    getDb().prepare(
      `INSERT INTO mutation_ledger
         (session, turn_seq, ts, tool, table_name, sys_id, display_id, requested, verification, status, approval,
          approved_source, approved_at, capture, instance, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      Number(turnSeq ?? 0),
      now(),
      tool,
      descriptor?.table ?? null,
      descriptor?.sys_id ?? cell(result?.sys_id) ?? null,
      deriveDisplayId(result),
      JSON.stringify(descriptor?.requested ?? {}),
      JSON.stringify(verification ?? null),
      status,
      approval ?? null,
      // WI-4 — an approval with no attributable source is stored as 'unknown',
      // never inferred from the fact that the write succeeded.
      approval ? (approvedSource ?? 'unknown') : null,
      approvedAt ?? null,
      capture ? JSON.stringify(capture) : null,
      instance,
      actor,
    );
    return true;
  } catch {
    return false;
  }
}

/** Attach the transport capture verdict to the newest entry for this tool. */
export function annotateLatestCapture(sessionId, turnSeq, captureEvent) {
  try {
    const row = getDb().prepare(
      'SELECT id FROM mutation_ledger WHERE session = ? AND turn_seq = ? ORDER BY id DESC LIMIT 1'
    ).get(sessionId, Number(turnSeq ?? 0));
    if (!row) return false;
    getDb().prepare('UPDATE mutation_ledger SET capture = ? WHERE id = ?')
      .run(JSON.stringify({ captured: captureEvent?.captured ?? null, message: captureEvent?.message ?? null }), row.id);
    return true;
  } catch { return false; }
}

export function mutationsForTurn(sessionId, turnSeq) {
  return getDb()
    .prepare('SELECT * FROM mutation_ledger WHERE session = ? AND turn_seq = ? ORDER BY id')
    .all(sessionId, Number(turnSeq ?? 0))
    .map(hydrate);
}

export function mutationsForSession(sessionId, { limit = 200 } = {}) {
  return getDb()
    .prepare('SELECT * FROM mutation_ledger WHERE session = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, limit)
    .map(hydrate);
}

function hydrate(r) {
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    id: r.id, turnSeq: r.turn_seq, ts: r.ts, tool: r.tool,
    table: r.table_name, sys_id: r.sys_id, displayId: r.display_id,
    requested: parse(r.requested) || {}, verification: parse(r.verification),
    status: r.status, approval: r.approval,
    approvedSource: r.approved_source ?? null, approvedAt: r.approved_at ?? null,
    capture: parse(r.capture),
    instance: r.instance, actor: r.actor,
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

const GLYPH = {
  applied: '✅',
  'self-verified': '✅',
  transformed: '⚠️',
  partial: '⚠️',
  'no-op': '❌',
  unverified: '❔',
};

/**
 * Render the turn's mutations as markdown, OUTSIDE the model.
 *
 * This is the half of WI-2 that makes the invariant hold rather than merely
 * encouraging it: the block is appended to the turn's output by the harness, so
 * an executed mutation is present in the report whether or not the model
 * mentions it, remembers it, or was compacted out of knowing about it.
 *
 * The glyph comes from the verification status, so a discarded write cannot
 * carry a success mark. That is the same rule the renderer follows (WI-6), from
 * the same source of truth — which is why the two can never disagree.
 */
export function renderMutationReport(entries) {
  if (!entries?.length) return '';
  const lines = ['', '---', '', `**What changed on the instance this turn** — ${entries.length} mutation${entries.length === 1 ? '' : 's'}, recorded by the harness:`, ''];
  for (const e of entries) {
    const glyph = GLYPH[e.status] || '❔';
    const what = e.displayId ? `**${e.displayId}**` : (e.sys_id ? `\`${e.sys_id}\`` : '(no identifier returned)');
    const where = e.table ? ` on \`${e.table}\`` : '';
    lines.push(`- ${glyph} \`${e.tool}\` → ${what}${where}${e.sys_id && e.displayId ? ` — \`${e.sys_id}\`` : ''}`);

    const v = e.verification;
    if (v?.status === 'no-op') {
      lines.push(`    - **The platform discarded this write.** ${fieldList(v.dropped)} unchanged. Nothing was stored.`);
    } else if (v?.status === 'partial') {
      lines.push(`    - **Partially applied.** The platform dropped ${fieldList(v.dropped)}; the other fields landed.`);
    } else if (v?.status === 'transformed') {
      lines.push(`    - Stored, but ${fieldList(v.transformed)} differ from what was sent${transformReason(v.transformed)}.`);
    } else if (v?.status === 'unverified') {
      lines.push(`    - Could not be verified by read-back: ${v.summary}.`);
    }
    const provenance = approvalLine(e);
    if (provenance) lines.push(`    - ${provenance}`);
    if (e.capture?.message) lines.push(`    - ${e.capture.message}`);
  }
  return lines.join('\n');
}

/**
 * WI-4 — who authorised this write, said out loud.
 *
 * Every executed mutation gets a line, including the ordinary one. The report
 * used to speak up only for auto-approve, which made "a human approved this" an
 * inference drawn from silence — and the 2026-08-24 investigation is what that
 * inference costs when it has to be checked and cannot be.
 *
 * `unknown` is reported as unknown. Every row written before the provenance
 * columns existed carries it, and it is also what a resolver that could not
 * identify itself gets: an approval that cannot be attributed is a real finding,
 * not a rendering gap to smooth over.
 *
 * The clock is stamped UTC explicitly. The session renders local time and the
 * platform stores UTC, and an unlabelled HH:MM between them is a whole class of
 * trap this project has already paid for once.
 */
export function approvalLine(entry) {
  if (!entry?.approval) return '';
  const at = entry.approvedAt ? ` · ${String(entry.approvedAt).slice(11, 16)} UTC` : '';
  if (entry.approval === 'auto') {
    return `ran under auto-approve — no human saw the gate${at}`;
  }
  if (entry.approval === 'approved') {
    return entry.approvedSource === 'user_click'
      ? `approved by you at the gate${at}`
      : `approved, but the source was never recorded (${entry.approvedSource || 'unknown'})${at}`;
  }
  return `approval recorded as "${entry.approval}"${at}`;
}

const fieldList = (arr) => (arr?.length ? arr.map((d) => `\`${d.field}\``).join(', ') : 'no fields');
function transformReason(arr) {
  const r = arr?.find((t) => t.reason)?.reason;
  return r ? ` (${r})` : '';
}

/**
 * The same facts, compressed for the model's own context.
 *
 * Injected system-side immediately before the final completion of any turn that
 * mutated something, so the model narrates from the record rather than from
 * memory it may no longer have. System-side because compaction rewrites
 * `messages` — a reminder posted as a message could be folded away by the very
 * mechanism this is defending against.
 */
export function ledgerDigestForModel(entries) {
  if (!entries?.length) return '';
  const lines = entries.map((e) => {
    const bits = [`${e.tool}`, e.table && `on ${e.table}`, e.displayId && `"${e.displayId}"`, e.sys_id && `sys_id ${e.sys_id}`, `status ${e.status}`];
    const v = e.verification;
    const detail = v?.status === 'no-op' ? ` — DISCARDED by the platform (${fieldsPlain(v.dropped)} unchanged); do not report this as done`
      : v?.status === 'partial' ? ` — PARTIAL, the platform dropped ${fieldsPlain(v.dropped)}`
      : '';
    return `- ${bits.filter(Boolean).join(' ')}${detail}`;
  });
  return [
    'MUTATIONS EXECUTED THIS TURN (recorded by the harness, not by you).',
    'Report every one of these in your closing summary, with its real status.',
    'A no-op or partial must be stated as such — never as a success.',
    '',
    ...lines,
  ].join('\n');
}

const fieldsPlain = (arr) => (arr?.length ? arr.map((d) => d.field).join(', ') : 'nothing');
