/**
 * PHASE 10 — RISK B: reproduce, or withdraw the explanation.
 *
 *   node scripts/phase10-riskb.mjs [runs]
 *
 * PHASE 9 OBSERVED ONE TRANSIENT SUITE FAILURE while a benchmark was loading the
 * same machine, then two clean runs. It attributed the failure to load — and
 * said plainly that the attribution was inference, because the failing test was
 * never captured.
 *
 * THIS SCRIPT EXISTS TO TEST THAT INFERENCE HONESTLY. It runs the concurrency
 * suite repeatedly in two conditions — quiet, and under deliberate CPU load —
 * and captures the name of anything that fails. If load does not reproduce a
 * failure, the Phase 9 explanation is withdrawn rather than repeated.
 *
 * A NEGATIVE RESULT IS A REAL RESULT. "N runs, zero failures, so the original
 * cause remains unidentified" is the honest report, and it is better than a
 * plausible story nothing supports.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const RUNS = Number(process.argv[2] ?? 6);

const SUITES = [
  'test/phase9-concurrency.test.js',
  'test/phase8-correlation.test.js',
  'test/phase9-api-contract.test.js',
];

/** Run the concurrency suites once and report what, if anything, failed. */
function runOnce() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', ...SUITES], { cwd: SERVER });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const pass = Number(/^ℹ pass (\d+)$/m.exec(out)?.[1] ?? -1);
      const fail = Number(/^ℹ fail (\d+)$/m.exec(out)?.[1] ?? -1);
      // Capture the NAME of every failure — the thing Phase 9 could not report.
      const failures = [...out.matchAll(/^✖ (.+?) \(\d+/gm)].map((m) => m[1])
        .filter((v, i, a) => a.indexOf(v) === i);
      resolve({ ms: Date.now() - t0, code, pass, fail, failures });
    });
  });
}

/** Saturate every core with real work, so the run is genuinely contended. */
function startLoad() {
  const n = Math.max(2, os.cpus().length);
  const kids = [];
  for (let i = 0; i < n; i += 1) {
    kids.push(spawn(process.execPath, ['-e', `
      const end = Date.now() + 15 * 60 * 1000;
      let x = 0;
      while (Date.now() < end) { for (let k = 0; k < 5e6; k += 1) x += Math.sqrt(k); }
      if (x === -1) console.log(x);
    `], { stdio: 'ignore' }));
  }
  return () => kids.forEach((k) => { try { k.kill(); } catch { /* already gone */ } });
}

console.log(`cpus     : ${os.cpus().length} x ${os.cpus()[0]?.model ?? 'unknown'}`);
console.log(`memory   : ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB total, `
  + `${(os.freemem() / 1024 ** 3).toFixed(1)} GB free`);
console.log(`node     : ${process.version}`);
console.log(`suites   : ${SUITES.join(', ')}`);
console.log(`runs     : ${RUNS} quiet, then ${RUNS} under load`);
console.log();

const results = { quiet: [], loaded: [] };

console.log('--- CONDITION 1: quiet ---');
for (let i = 0; i < RUNS; i += 1) {
  const r = await runOnce();
  results.quiet.push(r);
  console.log(`  run ${i + 1}: ${String(r.ms).padStart(6)}ms  pass=${r.pass} fail=${r.fail}`
    + (r.failures.length ? `  FAILED: ${r.failures.join(' | ')}` : ''));
}

console.log();
console.log('--- CONDITION 2: every core saturated ---');
const stopLoad = startLoad();
try {
  // Let the load actually take hold before measuring.
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < RUNS; i += 1) {
    const r = await runOnce();
    results.loaded.push(r);
    console.log(`  run ${i + 1}: ${String(r.ms).padStart(6)}ms  pass=${r.pass} fail=${r.fail}`
      + (r.failures.length ? `  FAILED: ${r.failures.join(' | ')}` : ''));
  }
} finally { stopLoad(); }

/* ------------------------------------------------------------------ */
const summarise = (label, rs) => {
  const times = rs.map((r) => r.ms).sort((a, b) => a - b);
  const failed = rs.filter((r) => r.fail > 0);
  const names = [...new Set(rs.flatMap((r) => r.failures))];
  console.log(`${label.padEnd(8)} runs=${rs.length}  `
    + `min=${times[0]}ms med=${times[Math.floor(times.length / 2)]}ms max=${times[times.length - 1]}ms  `
    + `failing runs=${failed.length}`);
  if (names.length) console.log(`         failures: ${names.join(' | ')}`);
  return { runs: rs.length, failing: failed.length, names };
};

console.log();
const q = summarise('quiet', results.quiet);
const l = summarise('loaded', results.loaded);

console.log();
const slowdown = (
  results.loaded.reduce((a, r) => a + r.ms, 0) / results.loaded.length
) / (results.quiet.reduce((a, r) => a + r.ms, 0) / results.quiet.length);
console.log(`contention was real: loaded runs are ${slowdown.toFixed(2)}x the quiet mean`);

console.log();
if (q.failing === 0 && l.failing === 0) {
  console.log('VERDICT: not reproduced.');
  console.log(`  ${q.runs + l.runs} runs, ${l.runs} of them with every core saturated, zero failures.`);
  console.log('  Phase 9 attributed its single transient failure to machine load. That attribution is');
  console.log('  NOT supported by this data and is withdrawn. The original cause remains unidentified,');
  console.log('  and it is recorded as an open observation rather than an explained one.');
} else {
  console.log('VERDICT: reproduced.');
  console.log(`  quiet: ${q.failing}/${q.runs} failing   loaded: ${l.failing}/${l.runs} failing`);
  console.log(`  failing tests: ${[...new Set([...q.names, ...l.names])].join(' | ')}`);
}
