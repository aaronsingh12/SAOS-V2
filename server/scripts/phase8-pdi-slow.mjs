/** PHASE 8 — are the three 25s timeouts HUNG, or just slow (SDK-backed)? */
const { toolMap } = await import('../src/agent/tools.js');
for (const name of ['list_live_flows', 'list_applications', 'dba_context']) {
  const t0 = Date.now();
  try {
    const out = await Promise.race([
      toolMap.get(name).execute({}, { sessionId: 'phase8-slow', signal: null }),
      new Promise((_, r) => setTimeout(() => r(new Error('deadline 300s')), 300000)),
    ]);
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    console.log(`SLOW_BUT_PROVEN ${name} ${Date.now()-t0}ms ${s.length}B :: ${s.slice(0,140).replace(/\s+/g,' ')}`);
  } catch (e) {
    console.log(`HUNG_OR_FAILED  ${name} ${Date.now()-t0}ms :: ${e.message.slice(0,180)}`);
  }
}
