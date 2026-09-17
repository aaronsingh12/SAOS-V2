import { getSettings } from '../config/store.js';

export class SnowError extends Error {
  constructor(message, status = 500, detail = null) {
    super(message);
    this.name = 'SnowError';
    this.status = status;
    this.detail = detail;
  }
}

let tokenCache = null; // { access_token, expiresAt }

export function resetAuthCache() {
  tokenCache = null;
}

function conn() {
  const { connection } = getSettings();
  if (!connection?.instanceUrl) {
    throw new SnowError('No ServiceNow connection configured. Open Dashboard → Connection and save your PDI details.', 400);
  }
  return connection;
}

async function getAuthHeader() {
  const c = conn();
  if (c.authType === 'oauth') {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
      return `Bearer ${tokenCache.access_token}`;
    }
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      username: c.username,
      password: c.password,
    });
    const res = await fetch(`${c.instanceUrl}/oauth_token.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new SnowError(`OAuth token request failed (${res.status}). Check client id/secret and user credentials.`, res.status, (await res.text()).slice(0, 500));
    }
    const tok = await res.json();
    tokenCache = { access_token: tok.access_token, expiresAt: Date.now() + (Number(tok.expires_in) || 1800) * 1000 };
    return `Bearer ${tokenCache.access_token}`;
  }
  const b64 = Buffer.from(`${c.username}:${c.password}`).toString('base64');
  return `Basic ${b64}`;
}

/** `/api/now/table/<table>/<sys_id>` → the two things a permissions error should name. */
function recordContext(pathname) {
  const m = /\/api\/now\/(?:table|stats)\/([^/?]+)(?:\/([^/?]+))?/.exec(pathname || '');
  return {
    tableName: m?.[1] ? decodeURIComponent(m[1]) : null,
    sysId: m?.[2] ? decodeURIComponent(m[2]) : null,
  };
}

/**
 * Turn a failed response into a message that names a cause you can act on.
 *
 * Pure, and exported, so the offline suite can assert each branch — the whole
 * point of this function is WHICH cause it names, and that is exactly what a
 * live-only test cannot pin down.
 *
 * "User is not authenticated" is true but useless: it names no instance and
 * suggests no next step. But the opposite failure is worse and is what this
 * replaced — every 403 was reported as bad credentials, including three below
 * where the credentials are perfect. That is trap #51 committed in our own
 * code, and the transport sweep hits two of them routinely. Measured on
 * dev442675 (§33, §35):
 *
 *   "…aborted by Business Rule '<name>^<sys_id>'"        a rule refused the write
 *   "Failed API level ACL Validation"                    the TABLE is closed to REST
 *   "ACL Exception <Op> Failed due to security…"         the ROW is protected
 *   anything else                                        genuinely the credentials
 *
 * The table-level and row-level cases are separated because the remedy differs:
 * one is "this table is not reachable over REST at all", the other is "you can
 * read the table, you may not touch that record".
 */
export function diagnoseFailure({ status, statusText, detail = '', message = null, host = 'the instance', username = '', method = 'GET', pathname = '' }) {
  const d = String(detail || '');

  if (status === 403) {
    // The rule's own gs.addErrorMessage reason does NOT cross the REST
    // boundary — only its name does. Name the rule and invent nothing.
    const abortedBy = /aborted by Business Rule '([^'^]+)/i.exec(d);
    if (abortedBy) {
      return {
        status, kind: 'business-rule',
        rule: abortedBy[1],
        message: `${method} ${pathname} was refused by the business rule "${abortedBy[1]}" on ${host}. `
               + 'The credentials are fine — the instance rejected the change itself.',
      };
    }
    if (/Failed API level ACL Validation/i.test(d)) {
      const t = /\/api\/now\/(?:table|stats)\/([^/?]+)/.exec(pathname)?.[1];
      return {
        status, kind: 'table-acl',
        table: t ? decodeURIComponent(t) : null,
        message: `"${username || '(no username set)'}" may not read${t ? ` ${decodeURIComponent(t)}` : ' this table'} over REST on ${host} `
               + '(API-level ACL). This is a table permission, not a bad password — some platform tables are '
               + 'closed to the REST API even for admin.',
      };
    }
    // ROW-level (or field-level) ACL. Distinct from the table-level case above:
    // the table is readable, this particular record is not writable. Measured:
    // deleting a `syslog` row answers
    //   "ACL Exception Delete Failed due to security constraints"
    // and this is the shape the SWEEP hits — collapseDuplicates deletes
    // superseded `sys_update_xml` rows, and a protected one lands here.
    const aclEx = /ACL Exception\s+(\w+)\s+Failed due to security constraints/i.exec(d);
    if (aclEx) {
      const { tableName, sysId } = recordContext(pathname);
      const op = aclEx[1].toLowerCase();
      return {
        status, kind: 'row-acl', operation: op, table: tableName, sys_id: sysId,
        message: `${op} was refused by a record-level ACL on ${host}`
               + (tableName ? ` for ${tableName}${sysId ? ` ${sysId}` : ''}` : '')
               + `. "${username || '(no username set)'}" can reach the table but not ${op} that row — `
               + 'a permissions constraint on the record, not a credentials problem.',
      };
    }
  }

  // A 404 whose detail admits it might be an ACL. The instance will not say
  // which, so neither do we — but "No Record found" alone sends the reader
  // looking for a typo when the row may be there and unreadable.
  if (status === 404 && /ACL restricts the record retrieval/i.test(d)) {
    const { tableName, sysId } = recordContext(pathname);
    return {
      status, kind: 'missing-or-hidden', table: tableName, sys_id: sysId,
      message: `${tableName || 'That record'}${sysId ? ` ${sysId}` : ''} is not readable on ${host}: it either does not exist `
             + 'or an ACL hides it. The instance does not distinguish the two, so neither of those can be ruled out from here.',
    };
  }

  if (status === 401 || status === 403) {
    const who = username || '(no username set)';

    /*
     * THE ADVICE HAS TO FIT THE INSTANCE IT IS TALKING TO.
     *
     * This used to tell every rejected login to "wake the PDI at
     * developer.servicenow.com". On a corporate or demo instance — the kind
     * with a real name rather than `devNNNNNN` — that is not just unhelpful,
     * it sends the reader somewhere the instance does not exist, and it buries
     * the causes that actually apply there.
     *
     * A PDI is `devNNNNNN.service-now.com`. Anything else is somebody's real
     * sub-production instance, where MFA and a missing REST role are the
     * common causes and hibernation is not a thing that happens.
     */
    const isPdi = /^dev\d+\./i.test(String(host));

    const causes = [
      'the password is wrong, or picked up whitespace from a paste',
      ...(isPdi
        ? ['the PDI is hibernating — wake it at developer.servicenow.com, then retry']
        : [
          /* Measured on a real demo instance: the platform answers a wrong
             password, an MFA-required user and a missing REST role with the
             same 401 and the same "Required to provide Auth information", so
             none of these can be ruled out from here. */
          `"${who}" has multi-factor authentication enabled — basic auth over REST cannot satisfy it, so this needs an integration user or OAuth`,
          'this instance requires SSO and the account has no local password set',
        ]),
      `the user "${who}" lacks REST access (the \`snc_platform_rest_api_access\` role)`,
      'repeated failed attempts have locked the account',
    ];

    return {
      status,
      kind: 'credentials',
      isPdi,
      message: `${host} rejected the credentials for "${who}" (${status}). `
             + `The platform answers all of these the same way, so none can be ruled out from here: ${causes.join('; ')}. `
             + `Signing in as "${who}" at https://${host}/login.do is the quickest way to tell a wrong password from the rest.`,
    };
  }

  return {
    status, kind: 'other',
    message: message || `ServiceNow request failed (${status} ${statusText})`,
  };
}

/**
 * SESSION 2 — THE TRANSPORT, SPLIT FROM THE POLICY THAT THROWS ON IT.
 *
 * Every REST call in this project went through one function that threw a
 * `SnowError` for any non-2xx. That is the right policy for the Table API,
 * where a 4xx means the call was wrong. It is the WRONG policy for at least one
 * endpoint we now have to call: the platform's own flow-activation processor,
 * `POST /api/now/wfa_fluent/activate_flows`, answers **HTTP 422 as a normal
 * response** meaning "every flow failed to activate", and the body carries the
 * per-flow reasons. Read from the SDK's own client
 * (sdk-api/dist/flow-activation.js:34), which deliberately parses 422 rather
 * than treating it as an error. Throwing there would discard the only
 * explanation of what went wrong.
 *
 * So this returns the response — status, parsed body, raw text — and NEVER
 * throws on an HTTP status. It throws only when the instance could not be
 * reached at all, because that is not a response.
 *
 * It is exported so the flow layer can reach a non-Table-API endpoint without
 * a second HTTP client appearing outside `servicenow/`. It is deliberately
 * low-level and deliberately narrow: `snowFetch` below is still the funnel
 * every ordinary read and write goes through, and still applies the diagnosis
 * and the throw.
 */
export async function instanceRequest(pathname, { method = 'GET', body, params } = {}) {
  const c = conn();
  const url = new URL(c.instanceUrl.replace(/\/$/, '') + pathname);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: await getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new SnowError(`Could not reach ${url.host}: ${err.message}. Is the instance URL correct and the PDI awake?`, 502);
  }
  if (res.status === 204) return { ok: true, status: 204, json: null, text: '', host: url.host };
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* HTML error pages etc. */ }
  return { ok: res.ok, status: res.status, statusText: res.statusText, json, text, host: url.host, method, pathname };
}

async function snowFetch(pathname, { method = 'GET', body, params } = {}) {
  const c = conn();
  const res = await instanceRequest(pathname, { method, body, params });
  if (res.status === 204) return null;
  if (!res.ok) {
    const detail = res.json?.error?.detail || res.text.slice(0, 500);
    const diagnosed = diagnoseFailure({
      status: res.status, statusText: res.statusText, detail,
      message: res.json?.error?.message, host: res.host, username: c.username, method, pathname,
    });
    throw new SnowError(diagnosed.message, diagnosed.status, detail);
  }
  return res.json;
}

/**
 * Which field carries SCOPE INTENT on a create, per table.
 *
 * `application` means "the owning scope" only on the update-set tables; on
 * others it is an unrelated field name, so the map is explicit rather than a
 * blanket check on the word.
 */
const SCOPE_INTENT_FIELD = {
  sys_update_set: 'application',
  sys_update_xml: 'application',
};
const DEFAULT_SCOPE_INTENT_FIELD = 'sys_scope';

/**
 * REST IS A GLOBAL-TIER WRITER — the standing invariant from §33 E4.
 *
 * `sys_scope` on an insert, and `application` on a new update set, are both
 * ACCEPTED and silently demoted to `global`. The response is `201`, every other
 * field lands, and a record created with an explicit scope is indistinguishable
 * from the control that asked for nothing. Nothing about the call says it did
 * not do what you asked.
 *
 * So any create that carries scope intent reads it back and fails LOUDLY on
 * mismatch. This is cheap — the create already returns the record — and it is
 * enforced at the one funnel every REST create goes through, rather than being
 * remembered at each call site.
 *
 * Asking for `global` and getting `global` is not a mismatch. The only thing
 * this refuses is a silent demotion.
 */
export function assertScopeIntentHeld(tableName, payload, created) {
  if (!payload || !created) return created;
  const field = SCOPE_INTENT_FIELD[tableName] || DEFAULT_SCOPE_INTENT_FIELD;
  const asked = payload[field];
  if (asked === undefined || asked === null || asked === '') return created;

  const cell = created[field];
  const got = cell && typeof cell === 'object' ? cell.value : cell;
  if (got === asked) return created;

  // The record already EXISTS by the time this runs — REST wrote it, returned
  // 201, and the demotion is only visible in the response. This guard reports;
  // it cannot un-write. Deleting automatically would be worse: a global copy of
  // the artifact may be exactly what the caller wants to keep, and a rollback
  // nobody asked for is a destructive default. So the sys_id is named in the
  // message, not just the detail, and the decision stays with the caller.
  const sysId = created.sys_id?.value ?? created.sys_id ?? '(unknown)';
  throw new SnowError(
    `${tableName} was created with ${field}="${asked}" but the instance stored "${got}". `
    + 'REST is a global-tier writer: it accepts a scope on an insert and silently ignores it '
    + '(docs/fluent-research.md §33 E4). Scoped artifacts are born through the SDK tier, and a '
    + `scoped update set through the execution harness — not here. The record was still created, `
    + `as ${sysId} in "${got}"; delete it if a global one is not wanted.`,
    502,
    JSON.stringify({ table: tableName, field, asked, got, sys_id: sysId })
  );
}

/**
 * Table API wrapper.
 * display: 'all' returns every field as { value, display_value } — this is how
 * reference fields stay usable end-to-end (sys_id for writes, label for humans).
 */
export const table = {
  async query(t, { query, fields, limit = 25, offset = 0, orderBy, orderByDesc, display = 'all' } = {}) {
    let q = query || '';
    if (orderBy) q += `${q ? '^' : ''}ORDERBY${orderBy}`;
    if (orderByDesc) q += `${q ? '^' : ''}ORDERBYDESC${orderByDesc}`;
    const data = await snowFetch(`/api/now/table/${encodeURIComponent(t)}`, {
      params: {
        sysparm_query: q,
        sysparm_fields: fields,
        sysparm_limit: limit,
        sysparm_offset: offset,
        sysparm_display_value: display,
        sysparm_exclude_reference_link: 'true',
      },
    });
    return data?.result ?? [];
  },

  async get(t, sysId, display = 'all') {
    const data = await snowFetch(`/api/now/table/${encodeURIComponent(t)}/${encodeURIComponent(sysId)}`, {
      params: { sysparm_display_value: display, sysparm_exclude_reference_link: 'true' },
    });
    return data?.result;
  },

  async create(t, payload, display = 'all') {
    const data = await snowFetch(`/api/now/table/${encodeURIComponent(t)}`, {
      method: 'POST',
      body: payload,
      params: { sysparm_display_value: display, sysparm_exclude_reference_link: 'true' },
    });
    assertScopeIntentHeld(t, payload, data?.result);
    return data?.result;
  },

  async update(t, sysId, payload, display = 'all') {
    const data = await snowFetch(`/api/now/table/${encodeURIComponent(t)}/${encodeURIComponent(sysId)}`, {
      method: 'PATCH',
      body: payload,
      params: { sysparm_display_value: display, sysparm_exclude_reference_link: 'true' },
    });
    return data?.result;
  },

  async remove(t, sysId) {
    await snowFetch(`/api/now/table/${encodeURIComponent(t)}/${encodeURIComponent(sysId)}`, { method: 'DELETE' });
    return { deleted: true, table: t, sys_id: sysId };
  },

  /** Aggregate API — used for dashboard counts. */
  async count(t, query) {
    const data = await snowFetch(`/api/now/stats/${encodeURIComponent(t)}`, {
      params: { sysparm_count: 'true', sysparm_query: query },
    });
    return Number(data?.result?.stats?.count ?? 0);
  },

  /**
   * Aggregate API — the row count AND the newest `sys_updated_on`, in one call.
   *
   * Health Assist's change check. An insert or an update moves the newest
   * timestamp; a delete moves the count. If neither moved since the last read,
   * nothing in that slice changed.
   *
   * A log table has no `sys_updated_on` at all — measured on dev424910:
   * `discovery_log` extends `syslog`, and asking for its newest update answers
   * `400 Aggregate Query Failed`. Log rows are only ever inserted, so the newest
   * `sys_created_on` is the exact equivalent there, and `basis` says which one
   * was used.
   */
  async changeStamp(t, query) {
    const ask = (field) => snowFetch(`/api/now/stats/${encodeURIComponent(t)}`, {
      params: { sysparm_count: 'true', sysparm_max_fields: field, sysparm_query: query },
    });
    let basis = 'sys_updated_on';
    let data;
    try {
      data = await ask(basis);
    } catch (err) {
      if (err?.status !== 400) throw err;
      basis = 'sys_created_on';
      data = await ask(basis);
    }
    const stats = data?.result?.stats || {};
    return { count: Number(stats.count ?? 0), maxUpdated: stats.max?.[basis] || null, basis };
  },

  /** Aggregate API — counts grouped by one field, as `{ value: count }`. */
  async countBy(t, query, groupBy) {
    const data = await snowFetch(`/api/now/stats/${encodeURIComponent(t)}`, {
      params: { sysparm_count: 'true', sysparm_group_by: groupBy, sysparm_query: query },
    });
    const out = {};
    for (const r of data?.result || []) {
      const value = r?.groupby_fields?.[0]?.value;
      if (value != null) out[value] = Number(r?.stats?.count ?? 0);
    }
    return out;
  },

  /**
   * Aggregate API — the general form: count, avg, sum, min and max over an
   * encoded query, grouped by zero or more fields.
   *
   * ITSM Phase 3. `countBy` above answers one group-by field with counts and
   * nothing else; the ITSM aggregate rules need "share per (impact, urgency,
   * priority)" and "resolution effort per cluster" — several group-by fields
   * and avg/sum — and the alternative is reading every row into memory, which
   * is the thing the aggregate engine exists to avoid. `countBy` is left as it
   * is: its callers and its shape are unchanged.
   *
   * Returns one row per group: `{ group: { field: value, ... }, count, avg: {field: n},
   * sum: {…}, min: {…}, max: {…} }`. With no group-by there is exactly one row
   * whose `group` is `{}`.
   */
  async aggregate(t, { query = '', groupBy = [], avg = [], sum = [], min = [], max = [] } = {}) {
    const list = (xs) => (Array.isArray(xs) ? xs : [xs]).filter(Boolean);
    const params = { sysparm_count: 'true', sysparm_query: query };
    if (list(groupBy).length) params.sysparm_group_by = list(groupBy).join(',');
    if (list(avg).length) params.sysparm_avg_fields = list(avg).join(',');
    if (list(sum).length) params.sysparm_sum_fields = list(sum).join(',');
    if (list(min).length) params.sysparm_min_fields = list(min).join(',');
    if (list(max).length) params.sysparm_max_fields = list(max).join(',');
    const data = await snowFetch(`/api/now/stats/${encodeURIComponent(t)}`, { params });
    const rows = Array.isArray(data?.result) ? data.result : (data?.result ? [data.result] : []);
    const num = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v === '' || v == null ? null : Number(v)]));
    return rows.map((r) => ({
      group: Object.fromEntries((r?.groupby_fields || []).map((g) => [g.field, g.value])),
      count: Number(r?.stats?.count ?? 0),
      avg: num(r?.stats?.avg),
      sum: num(r?.stats?.sum),
      min: num(r?.stats?.min),
      max: num(r?.stats?.max),
    }));
  },
};

export async function testConnection() {
  resetAuthCache();
  const users = await table.query('sys_user', { limit: 1, fields: 'sys_id,user_name', display: 'false' });
  let build = null;
  try {
    const props = await table.query('sys_properties', {
      query: 'name=glide.buildname.full', fields: 'value', limit: 1, display: 'false',
    });
    build = props[0]?.value ?? null;
  } catch { /* property may be ACL-restricted; connection still fine */ }
  return { ok: true, sampleUser: users[0]?.user_name ?? null, build };
}
