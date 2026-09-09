/**
 * PHASE 8 — REAL PDI TEST: the read path.
 *
 * Read-only. Nothing here mutates. It exercises the EXISTING tools against the
 * configured instance and reports, for each, whether the capability is
 * CONFIGURED, DISCOVERED, PROVEN or VERIFIED — words that are not
 * interchangeable and are not promoted into one another.
 */
process.chdir(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const { toolMap } = await import('../src/agent/tools.js');
const { getSettings } = await import('../src/config/store.js');

const results = [];
async function probe(label, toolName, input) {
  const tool = toolMap.get(toolName);
  if (!tool) { results.push({ label, tool: toolName, verdict: 'NO_SUCH_TOOL' }); return null; }
  const t0 = Date.now();
  try {
    // Per-probe deadline. A tool that hangs must report as a hang, not stall
    // the whole validation — that IS a finding, not a reason to wait.
    const out = await Promise.race([
      tool.execute(input, { sessionId: 'phase8-read', signal: null }),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('probe deadline 25s exceeded'), { status: 'TIMEOUT' })), 25000)),
    ]);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    results.push({ label, tool: toolName, verdict: 'PROVEN', ms: Date.now() - t0, bytes: text.length,
      sample: text.slice(0, 160).replace(/\s+/g, ' ') });
    return out;
  } catch (err) {
    results.push({ label, tool: toolName, verdict: 'FAILED', ms: Date.now() - t0,
      status: err.status ?? null, message: err.message.slice(0, 200) });
    return null;
  }
}

console.log('instance:', getSettings().connection.instanceUrl);
console.log();

await probe('connection', 'test_connection', {});
await probe('live schema — incident', 'get_table_schema', { table: 'incident' });
await probe('incident lookup (query)', 'query_records', { table: 'incident', query: 'active=true', limit: 3 });
await probe('reference resolution', 'lookup_reference', { table: 'sys_user', value: 'admin' });
await probe('table lookup', 'lookup_table', { name: 'incident' });
await probe('SLA read', 'list_slas', {});
await probe('ACL report', 'acl_report', { table: 'incident' });
await probe('flow list (live)', 'list_live_flows', {});
await probe('applications', 'list_applications', {});
await probe('DBA context', 'dba_context', {});

for (const r of results) {
  const head = `${r.verdict.padEnd(12)} ${r.label.padEnd(28)} ${String(r.tool).padEnd(20)}`;
  if (r.verdict === 'PROVEN') console.log(`${head} ${String(r.ms).padStart(6)}ms  ${r.bytes}B  ${r.sample}`);
  else if (r.verdict === 'FAILED') console.log(`${head} ${String(r.ms).padStart(6)}ms  status=${r.status}  ${r.message}`);
  else console.log(head);
}
console.log();
console.log('PROVEN:', results.filter((r) => r.verdict === 'PROVEN').length,
  ' FAILED:', results.filter((r) => r.verdict === 'FAILED').length,
  ' of', results.length);
