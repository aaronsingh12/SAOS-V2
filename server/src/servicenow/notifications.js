import { table, SnowError } from './client.js';
import { tableExists } from './business-rules.js';

/**
 * Email notifications — `sysevent_email_action`, created over the Table API.
 *
 * Two ways a notification fires, both read off the instance's own choice list
 * for `generation_type`:
 *   engine — "Record inserted or updated": `action_insert` / `action_update`
 *            plus an optional condition on the record;
 *   event  — "Event is fired": `event_name`.
 *
 * Checked before anything is sent: the table exists, the trigger is complete,
 * and there is at least one recipient and a subject — a notification with no
 * recipient saves perfectly and never sends, which is the failure this exists
 * to refuse. Read back field by field afterwards.
 */

const NOTIFY_FIELDS = 'sys_id,name,collection,active,generation_type,action_insert,action_update,condition,event_name,recipient_users,recipient_groups,recipient_fields,send_self,subject,message_html,type,content_type,category,sys_scope';
const bool = (v) => (v === true || v === 'true' ? 'true' : 'false');
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const SYS_ID = /^[0-9a-f]{32}$/i;

export function notificationProblems(spec = {}) {
  const problems = [];
  if (!String(spec.name || '').trim()) problems.push('a notification needs a name');
  if (!String(spec.table || '').trim()) problems.push('a notification needs the table it watches');
  const on = String(spec.trigger || 'engine');
  if (on === 'engine' && !(spec.on_insert === true || spec.on_update === true)) {
    problems.push('choose when it sends: on_insert and/or on_update (or trigger "event" with an event_name)');
  }
  if (on === 'event' && !String(spec.event_name || '').trim()) problems.push('an event-triggered notification needs event_name');
  if (!['engine', 'event'].includes(on)) problems.push(`trigger must be "engine" (record inserted or updated) or "event" (got "${on}")`);
  const recipients = list(spec.recipient_users).length + list(spec.recipient_groups).length + list(spec.recipient_fields).length;
  if (!recipients) problems.push('a notification needs at least one recipient — users, groups, or recipient_fields such as assigned_to — or it never sends');
  for (const id of [...list(spec.recipient_users), ...list(spec.recipient_groups)]) {
    if (!SYS_ID.test(id)) problems.push(`recipient "${id}" is not a sys_id — resolve users and groups with lookup_reference first`);
  }
  if (!String(spec.subject || '').trim()) problems.push('a notification needs a subject');
  return problems;
}

export async function listNotifications({ table: tableName = '', search = '', limit = 50 } = {}) {
  const q = [];
  if (tableName) q.push(`collection=${String(tableName).replace(/\^/g, '')}`);
  if (search) q.push(`nameLIKE${String(search).replace(/\^/g, '')}`);
  const rows = await table.query('sysevent_email_action', {
    query: q.join('^'), fields: 'sys_id,name,collection,active,generation_type,action_insert,action_update,event_name,recipient_fields,subject,sys_updated_on',
    orderBy: 'collection', limit: Math.min(Number(limit) || 50, 500), display: 'false',
  });
  return { count: rows.length, notifications: rows };
}

export async function createNotification(spec = {}) {
  const problems = notificationProblems(spec);
  if (problems.length) {
    throw new SnowError(`The notification was refused before anything was written:\n- ${problems.join('\n- ')}`, 400, { problems });
  }
  const tableName = String(spec.table).trim();
  if (!(await tableExists(tableName))) throw new SnowError(`There is no table named "${tableName}" on this instance.`, 400);

  const on = String(spec.trigger || 'engine');
  const requested = {
    name: String(spec.name).trim(),
    collection: tableName,
    active: bool(spec.active !== false),
    generation_type: on,
    ...(on === 'engine' ? { action_insert: bool(spec.on_insert), action_update: bool(spec.on_update) } : { event_name: String(spec.event_name).trim() }),
    ...(spec.condition ? { condition: String(spec.condition) } : {}),
    ...(list(spec.recipient_users).length ? { recipient_users: list(spec.recipient_users).join(',') } : {}),
    ...(list(spec.recipient_groups).length ? { recipient_groups: list(spec.recipient_groups).join(',') } : {}),
    ...(list(spec.recipient_fields).length ? { recipient_fields: list(spec.recipient_fields).join(',') } : {}),
    send_self: bool(spec.send_self),
    subject: String(spec.subject),
    ...(spec.message_html ? { message_html: String(spec.message_html) } : {}),
    type: 'email',
    content_type: 'text/html',
  };
  const created = await table.create('sysevent_email_action', requested, 'false');
  const sysId = created?.sys_id;
  const back = sysId ? (await table.query('sysevent_email_action', { query: `sys_id=${sysId}`, fields: NOTIFY_FIELDS, limit: 1, display: 'false' }))[0] : null;
  const mismatches = back
    ? Object.entries(requested).filter(([f, want]) => String(back[f] ?? '') !== String(want)).map(([field, sent]) => ({ field, sent, stored: back[field] ?? '' }))
    : [{ field: '(record)', sent: 'insert', stored: 'not readable' }];
  return {
    ok: Boolean(back) && mismatches.length === 0,
    sys_id: sysId ?? null,
    record: back,
    requested,
    mismatches,
    message: !back
      ? 'The insert returned but the notification could not be read back.'
      : mismatches.length
        ? `Created notification ${sysId}, but ${mismatches.length} field(s) did not store as sent: ${mismatches.map((m) => m.field).join(', ')}.`
        : `Created notification "${requested.name}" on ${tableName} (${on === 'engine' ? [requested.action_insert === 'true' && 'insert', requested.action_update === 'true' && 'update'].filter(Boolean).join(' + ') : `event ${requested.event_name}`}), ${requested.active === 'true' ? 'active' : 'inactive'}. sys_id ${sysId}.`,
  };
}
