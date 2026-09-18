import { SnowError } from '../../src/servicenow/client.js';

/**
 * An in-memory ServiceNow for the ITSM engine suite.
 *
 * Understands the encoded-query subset the engines emit — `=`, `!=`, `IN`,
 * `NOT IN`, `ISEMPTY`, `ISNOTEMPTY`, `<`, `>`, `<=`, `>=`, `LIKE`, `ORDERBY`, `^OR`,
 * the keyset `sys_id>` watermark — and the three client shapes the engines
 * call: `query`, `count`, `aggregate` (+ `countBy`, `changeStamp` for
 * compatibility). Field projection drops fields a row does not carry, which is
 * exactly how an ACL-hidden field looks over REST (trap #4).
 *
 * `forbidden` tables answer 403; `absent` tables answer the platform's
 * `400 Invalid table`. `calls` counts requests so a test can prove a read
 * happened once.
 */
export function fakeInstance(tables, { forbidden = [], absent = [] } = {}) {
  const calls = { query: 0, count: 0, aggregate: 0, byTable: {} };
  const bump = (kind, t) => { calls[kind] += 1; calls.byTable[t] = (calls.byTable[t] || 0) + 1; };
  const guard = (t) => {
    if (absent.includes(t)) throw new SnowError(`Invalid table ${t}`, 400, 'Invalid table');
    if (forbidden.includes(t)) throw new SnowError(`"admin" may not read ${t} over REST`, 403, 'Failed API level ACL Validation');
  };

  function matches(row, clause) {
    if (!clause || clause.startsWith('ORDERBY')) return true;
    let m;
    if ((m = /^(\w[\w.]*)ISEMPTY$/.exec(clause))) return row[m[1]] == null || String(row[m[1]]).trim() === '';
    if ((m = /^(\w[\w.]*)ISNOTEMPTY$/.exec(clause))) return !(row[m[1]] == null || String(row[m[1]]).trim() === '');
    if ((m = /^(\w[\w.]*)NOT IN(.*)$/.exec(clause))) return !m[2].split(',').includes(String(row[m[1]] ?? ''));
    if ((m = /^(\w[\w.]*)IN(.*)$/.exec(clause))) return m[2].split(',').includes(String(row[m[1]] ?? ''));
    if ((m = /^(\w[\w.]*)LIKE(.*)$/.exec(clause))) return String(row[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase());
    if ((m = /^(\w[\w.]*)(<=|>=|!=|<|>|=)(.*)$/.exec(clause))) {
      const [, f, op, v] = m;
      const a = String(row[f] ?? ''); const b = v;
      switch (op) {
        case '=': return a === b;
        case '!=': return a !== b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        default: return false;
      }
    }
    throw new Error(`fake instance cannot evaluate clause "${clause}"`);
  }

  function select(t, query) {
    guard(t);
    const rows = [...(tables[t] || [])].sort((a, b) => String(a.sys_id).localeCompare(String(b.sys_id)));
    /* `^` is AND; `^OR` opens a new OR-group, as the platform reads `a^b^ORc^d` = (a AND b) OR (c AND d). */
    const groups = String(query || '').split(/^OR(?!DERBY)/).map((g) => g.split('^').filter(Boolean));
    return rows.filter((r) => groups.some((clauses) => clauses.every((c) => matches(r, c))));
  }

  return {
    calls, tables,
    async query(t, { query = '', fields = '', limit = 500 } = {}) {
      bump('query', t);
      const rows = select(t, query);
      const wanted = String(fields || '').split(',').filter(Boolean);
      return rows.slice(0, limit).map((r) => {
        if (!wanted.length) return { ...r };
        const out = {};
        for (const f of wanted) if (f in r) out[f] = r[f];
        return out;
      });
    },
    async count(t, query = '') { bump('count', t); return select(t, query).length; },
    async countBy(t, query, groupBy) {
      bump('aggregate', t);
      const out = {};
      for (const r of select(t, query)) { const k = String(r[groupBy] ?? ''); out[k] = (out[k] || 0) + 1; }
      return out;
    },
    async aggregate(t, { query = '', groupBy = [], avg = [], sum = [] } = {}) {
      bump('aggregate', t);
      const groups = new Map();
      for (const r of select(t, query)) {
        const key = groupBy.map((f) => `${f}=${r[f] ?? ''}`).join('|');
        if (!groups.has(key)) groups.set(key, { group: Object.fromEntries(groupBy.map((f) => [f, String(r[f] ?? '')])), count: 0, s: {}, n: {} });
        const g = groups.get(key); g.count += 1;
        for (const f of [...avg, ...sum]) { const v = Number(r[f]); if (Number.isFinite(v)) { g.s[f] = (g.s[f] || 0) + v; g.n[f] = (g.n[f] || 0) + 1; } }
      }
      return [...groups.values()].map((g) => ({ group: g.group, count: g.count, avg: Object.fromEntries(avg.map((f) => [f, g.n[f] ? g.s[f] / g.n[f] : null])), sum: Object.fromEntries(sum.map((f) => [f, g.s[f] ?? 0])), min: {}, max: {} }));
    },
    async changeStamp(t, query) { const rows = select(t, query); return { count: rows.length, maxUpdated: rows.map((r) => r.sys_updated_on).sort().pop() || null, basis: 'sys_updated_on' }; },
  };
}

/** sys_db_object + sys_dictionary rows that make the probes answer AVAILABLE for a table and its fields. */
export function platformMeta({ tables = {}, audited = [] } = {}) {
  const sys_db_object = []; const sys_dictionary = [];
  for (const [name, { fields = [], superClass = null } = {}] of Object.entries(tables)) {
    sys_db_object.push({ sys_id: `dbo-${name}`, name, 'super_class.name': superClass, sys_class_name: 'sys_db_object' });
    sys_dictionary.push({ sys_id: `dict-${name}`, name, element: '', internal_type: 'collection', audit: audited.includes(name) ? 'true' : 'false' });
    for (const f of fields) sys_dictionary.push({ sys_id: `dict-${name}-${f}`, name, element: f, internal_type: 'string', mandatory: 'false' });
  }
  return { sys_db_object, sys_dictionary };
}
