import crypto from 'node:crypto';
import { getDb } from './db.js';
import { getSettings } from '../config/store.js';
import { log, shortId } from '../logging.js';

/**
 * D-5 — the audit trail.
 *
 * The acceptance test is a sentence: *reconstruct everything a past session did
 * to the instance — with sys_ids and who approved — from this page alone.* Two
 * things stopped `tool_events` meeting it, and both are fixed here rather than
 * in the UI, because a page can only render what was written down.
 *
 *   1. Results were never stored. The sys_id of a created record exists only in
 *      the tool's return value, so "what did this session create" was
 *      unanswerable from the table named after it.
 *   2. Builds driven from the UI — a flow deploy, a catalog UI policy, an SLA
 *      verification — write to the instance through the SDK and belonged to no
 *      session, so they left no trace anywhere at all.
 *
 * On "who approved": this tool has no user management, so inventing a person's
 * name would be a lie. What CAN be stated truthfully is recorded, at both
 * levels that matter — the local decision (`approved` by a human at the gate,
 * `rejected`, `auto` when auto-approve was on and no human ever saw it, or
 * nothing for a read) and the ServiceNow account the write actually landed
 * under. The `auto` case is the one worth keeping honest: a page that showed
 * it as "approved" would be describing a human decision that never happened.
 */

const now = () => new Date().toISOString();

/** The instance and account a write is landing on, read at the moment it happens. */
export function currentActor() {
  const c = getSettings().connection || {};
  return {
    instance: (c.instanceUrl || '').replace(/\/+$/, '') || null,
    actor: c.username || null,
  };
}

/* ------------------------------------------------------------------ *
 * Build runs — the UI-driven half
 * ------------------------------------------------------------------ */

/**
 * Events dropped per run, in memory.
 *
 * An audit write failing must not kill a deploy that is already touching the
 * instance — but it must not vanish either. The count is carried into the run
 * row so the page can say "this stream is incomplete" instead of rendering a
 * partial history as a complete one.
 */
const dropped = new Map();

export function startBuildRun({ kind, label = null, request = null, session = null }) {
  const db = getDb();
  const id = crypto.randomUUID();
  const { instance, actor } = currentActor();
  db.prepare(
    `INSERT INTO build_runs (id, kind, label, instance, actor, session, status, request, summary, dropped, started, finished)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, 0, ?, NULL)`
  ).run(id, kind, label, instance, actor, session, request === null ? null : json(request), now());
  dropped.set(id, 0);
  log.info('build', `${kind} started  run=${shortId(id)}  ${label || ''}`);
  return id;
}

export function recordBuildEvent(runId, event) {
  if (!runId) return;
  try {
    const db = getDb();
    const row = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM build_events WHERE run = ?').get(runId);
    db.prepare('INSERT INTO build_events (run, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(runId, (row?.m ?? -1) + 1, event?.type ?? null, json(event), now());
  } catch (err) {
    // Loud in the log, counted in the row, never fatal to the build in flight.
    dropped.set(runId, (dropped.get(runId) || 0) + 1);
    log.error('audit', `dropped a build event for run ${shortId(runId)}: ${err.message}`);
  }
}

export function finishBuildRun(runId, { status, summary = null }) {
  if (!runId) return;
  try {
    const lost = dropped.get(runId) || 0;
    getDb().prepare('UPDATE build_runs SET status = ?, summary = ?, dropped = ?, finished = ? WHERE id = ?')
      .run(status, summary === null ? null : json(summary), lost, now(), runId);
    log[status === 'ok' ? 'info' : 'error']('build', `run=${shortId(runId)} ${status}` + (lost ? `  (${lost} events dropped)` : ''));
  } catch (err) {
    log.error('audit', `could not close run ${shortId(runId)}: ${err.message}`);
  } finally {
    dropped.delete(runId);
  }
}

/**
 * Wrap an SSE emitter so every event streamed to the browser is also written
 * down. One call site per route, and the route keeps its own `emit` shape.
 */
export function auditedEmit(runId, emit) {
  return (event) => {
    recordBuildEvent(runId, event);
    emit(event);
  };
}

export function loadBuildEvents(runId) {
  return getDb()
    .prepare('SELECT seq, type, payload, ts FROM build_events WHERE run = ? ORDER BY seq ASC')
    .all(runId)
    .map((r) => ({ seq: r.seq, type: r.type, ts: r.ts, payload: parse(r.payload) }));
}

/* ------------------------------------------------------------------ *
 * The unified timeline
 * ------------------------------------------------------------------ */

/**
 * Agent tool calls and UI builds, interleaved, newest first.
 *
 * A build run collapses to ONE row rather than one row per streamed event: the
 * run is the auditable unit ("this deployed X, and here is its sys_id"), and
 * its forty progress lines are the evidence behind it, fetched on expand.
 *
 * `mutating` for a build run is always true, and that is not a shortcut — every
 * kind recorded here installs or removes an application, or writes a record to
 * run a verification against.
 */
export function auditRows({ session = null, mutatingOnly = false, limit = 500 } = {}) {
  const db = getDb();
  const rows = [];

  const toolWhere = [];
  const toolArgs = [];
  if (session && session !== 'ui') { toolWhere.push('t.session = ?'); toolArgs.push(session); }
  if (session === 'ui') toolWhere.push('1 = 0');   // UI builds only: no agent rows at all
  // A capture row is not itself a mutation, but it is the record of what
  // happened to one — filtering it out of "mutations only" would hide the
  // answer to "and where did that change go?" from the only view that asks.
  if (mutatingOnly) toolWhere.push("(t.mutating = 1 OR t.kind = 'capture')");
  const toolSql =
    `SELECT t.*, s.title AS session_title
       FROM tool_events t
       LEFT JOIN sessions s ON s.id = t.session
      ${toolWhere.length ? `WHERE ${toolWhere.join(' AND ')}` : ''}
      ORDER BY t.ts DESC LIMIT ?`;
  for (const r of db.prepare(toolSql).all(...toolArgs, limit)) {
    rows.push({
      source: 'agent',
      id: `${r.session}:${r.seq}`,
      ts: r.ts,
      session: r.session,
      sessionTitle: r.session_title || null,
      kind: r.kind,
      name: r.name,
      mutating: Boolean(r.mutating),
      approval: r.approval,
      status: r.result_status,
      instance: r.instance,
      actor: r.actor,
      payload: parse(r.payload),
      result: r.result ?? null,
      sysIds: harvestSysIds(r.payload, r.result),
    });
  }

  if (!session || session === 'ui') {
    const buildWhere = session === 'ui' ? 'WHERE session IS NULL' : '';
    for (const r of db.prepare(`SELECT * FROM build_runs ${buildWhere} ORDER BY started DESC LIMIT ?`).all(limit)) {
      rows.push({
        source: 'build',
        id: r.id,
        ts: r.finished || r.started,
        started: r.started,
        finished: r.finished,
        session: r.session,
        sessionTitle: null,
        kind: r.kind,
        name: r.label || r.kind,
        mutating: true,
        approval: r.session ? null : 'ui',
        status: r.status,
        instance: r.instance,
        actor: r.actor,
        dropped: r.dropped,
        payload: parse(r.request),
        result: r.summary ?? null,
        sysIds: harvestSysIds(r.request, r.summary),
      });
    }
  }

  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return rows.slice(0, limit);
}

/** The session filter's options, plus the synthetic "UI, no session" bucket. */
export function auditSessions() {
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT s.id, s.title, s.updated,
              (SELECT COUNT(*) FROM tool_events t WHERE t.session = s.id) AS events,
              (SELECT COUNT(*) FROM tool_events t WHERE t.session = s.id AND t.mutating = 1) AS mutations
         FROM sessions s
        ORDER BY s.updated DESC`
    )
    .all()
    .filter((s) => s.events > 0);
  const ui = db.prepare('SELECT COUNT(*) AS n FROM build_runs WHERE session IS NULL').get();
  return { sessions, uiBuilds: ui?.n ?? 0 };
}

/**
 * Every 32-hex string in the request and the result.
 *
 * Deliberately naive and deliberately not filtered against a whitelist of
 * field names: the point is to surface the identifiers so a person can go and
 * look, and a stricter matcher would quietly miss the one that mattered.
 *
 * The boundary is "not more hex", NOT \b — and that distinction was a real bug.
 * The agent routinely reports its work as a link, and a ServiceNow deep link
 * URL-encodes the separator: `catalog_ui_policy.do%3Fsys_id%3D196e6cb2…`. The
 * `D` of `%3D` is a word character, so \b never matched there and the page
 * dropped precisely the identifier of the thing that had just been created.
 * Found by a test written from a real transcript rather than from an example.
 */
export function harvestSysIds(...blobs) {
  const found = new Set();
  for (const b of blobs) {
    if (!b) continue;
    for (const m of String(b).matchAll(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g)) found.add(m[0]);
  }
  return [...found];
}

function json(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function parse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

const CSV_COLUMNS = [
  'timestamp', 'source', 'session', 'session_title', 'kind', 'name',
  'mutating', 'approval', 'status', 'instance', 'actor', 'sys_ids', 'payload', 'result',
];

/**
 * Excel and Sheets both read a leading `=`, `+`, `-` or `@` as a formula, and
 * these cells carry model-authored text. Prefixing a quote neutralises it
 * without changing what a human reads.
 */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function auditCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      r.ts, r.source, r.session || '', r.sessionTitle || '', r.kind, r.name,
      r.mutating ? 'yes' : 'no', r.approval || '', r.status || '',
      r.instance || '', r.actor || '', (r.sysIds || []).join(' '),
      r.payload, r.result,
    ].map(csvCell).join(','));
  }
  // CRLF and a BOM: this file's whole purpose is to be opened in a spreadsheet,
  // and without the BOM Excel renders every non-ASCII character as mojibake.
  return `﻿${lines.join('\r\n')}\r\n`;
}
