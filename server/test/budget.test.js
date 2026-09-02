/**
 * D-7 — budgets from reality, and the guards that keep compaction from
 * thrashing against them.
 *
 *   node --test server/test/
 *
 * The defect these pin: a long spec produced THREE compaction digests inside a
 * single turn (9,629 -> 4,308, 7,209 -> 3,774, 6,298 -> 2,476 tokens), several
 * blank assistant rows, and then an empty completion. The model is
 * gpt-oss:120b-cloud, whose context window was read off the daemon rather than
 * assumed — 131,072 tokens — so none of this was context overflow.
 *
 * It was the budget. Measured on the real system prompt and the real 37 tool
 * schemas, the history allowance was 5,452 tokens: 4% of the window. Every
 * "before" number above is over that line and every "after" is under it. And it
 * ratcheted, because each digest is appended to the system prompt, so every
 * compaction raised the fixed overhead and lowered the next turn's allowance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBudget, probeContextWindow, clearContextProbeCache, clearStarvationLog,
  SANE_CONTEXT_CAP, OUTPUT_HEADROOM, FALLBACK_CONTEXT,
} from '../src/memory/budget.js';
import { TOOLS } from '../src/agent/tools.js';
import { buildSystemPrompt } from '../src/agent/prompts.js';
import { estimateTextTokens } from '../src/memory/tokens.js';
import { MIN_COMPACTION_GAIN } from '../src/memory/compaction.js';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; clearContextProbeCache(); clearStarvationLog(); });

/** The daemon's answer for gpt-oss, verbatim in shape. */
function showReturns(contextLength, key = 'gptoss.context_length') {
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/api/show')) throw new Error(`unexpected call to ${url}`);
    return { ok: true, status: 200, json: async () => ({ model_info: { [key]: contextLength } }) };
  };
}

/* ------------------------------------------------------------------ *
 * Probing the window
 * ------------------------------------------------------------------ */

test('the context window is read from the daemon, not assumed', async () => {
  showReturns(131_072);
  const { tokens, source } = await probeContextWindow('gpt-oss:120b-cloud', 'http://localhost:11434/v1');
  assert.equal(tokens, 131_072);
  assert.match(source, /api\/show/);
});

test('the context key is found by suffix, so a new architecture still works', async () => {
  // llama.context_length, qwen2.context_length, gptoss.context_length — the
  // prefix is the architecture, and guessing it wrong is how this silently
  // falls back to a small default on a large model.
  showReturns(32_768, 'qwen2.context_length');
  const { tokens } = await probeContextWindow('qwen2.5:14b', 'http://localhost:11434/v1');
  assert.equal(tokens, 32_768);
});

test('a daemon that cannot be reached falls back rather than throwing', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const { tokens, source } = await probeContextWindow('something-unknown:7b', 'http://localhost:11434/v1');
  assert.equal(tokens, FALLBACK_CONTEXT);
  assert.match(source, /fallback/);
});

test('a known API model uses its documented window without a daemon', async () => {
  globalThis.fetch = async () => { throw new Error('no daemon here'); };
  const { tokens, source } = await probeContextWindow('gpt-4o', 'https://api.openai.com/v1');
  assert.equal(tokens, 128_000);
  assert.match(source, /documented/);
});

test('the probe is cached — it runs per turn and must not be a request per turn', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ model_info: { 'gptoss.context_length': 131_072 } }) };
  };
  await probeContextWindow('gpt-oss:120b-cloud', 'http://localhost:11434/v1');
  await probeContextWindow('gpt-oss:120b-cloud', 'http://localhost:11434/v1');
  await probeContextWindow('gpt-oss:120b-cloud', 'http://localhost:11434/v1');
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ *
 * The three numbers
 * ------------------------------------------------------------------ */

test('the budget subtracts the fixed overhead the request actually carries', async () => {
  showReturns(131_072);
  // The measured sizes: the real system prompt is ~5,882 tokens and the 37
  // tool schemas ~6,666, for 12,548 of overhead. Not subtracting them is what
  // let a "24k" allowance ship a 35k request.
  const system = 'x'.repeat(20_586);
  const tools = [{ name: 'a', description: 'y'.repeat(23_330), inputSchema: {} }];

  const bare = await computeBudget({ system: '', tools: [] });
  const loaded = await computeBudget({ system, tools });

  assert.ok(loaded.fixed > 12_000, `the prompt and tool schemas must be counted, got ${loaded.fixed}`);
  assert.ok(loaded.budget < bare.budget, 'the history allowance must shrink as the envelope fills');
  assert.equal(loaded.budget, loaded.ceiling - loaded.fixed - loaded.headroom);
});

test('the history budget is a real share of the window, not 4% of it', async () => {
  showReturns(131_072);
  const system = 'x'.repeat(20_586);
  const tools = [{ name: 'a', description: 'y'.repeat(23_330), inputSchema: {} }];
  const { budget } = await computeBudget({ system, tools });

  // The measured old value was 5,452 on exactly this input. Anything in that
  // region is the defect, not a tuning choice.
  assert.ok(budget > 10_000, `history budget regressed to ${budget}; the thrash starts around 5,452`);
});

test('a small model caps the budget below our own ceiling', async () => {
  // The cap protects cost and latency; the model's own window protects
  // correctness. Whichever is smaller has to win, and it must be the model's
  // when the model is the smaller one.
  showReturns(8_192);
  const { ceiling, modelCtx } = await computeBudget({ system: 'x', tools: [] });
  assert.equal(modelCtx, 8_192);
  assert.equal(ceiling, 8_192, 'an 8k model must not be sent a 32k request');
});

test('output headroom exceeds the max_tokens we ask for', async () => {
  showReturns(131_072);
  const { headroom } = await computeBudget({ system: 'x', tools: [], maxTokens: 4096 });
  // This model bills hidden reasoning tokens against the same completion
  // budget — measured directly: a 20-token request returned finish_reason
  // "length" with empty content and a populated `reasoning` field. Reserving
  // exactly max_tokens reserves for the visible half only.
  assert.ok(headroom >= 4096, `headroom ${headroom} is under the requested max_tokens`);
  assert.equal(headroom, OUTPUT_HEADROOM);
});

test('the history allowance never collapses to nothing', async () => {
  // An enormous prompt must not drive the budget to zero and compact the
  // conversation out of existence; it hits a floor and lets the orchestrator's
  // size warning do the talking.
  showReturns(131_072);
  const { budget } = await computeBudget({ system: 'x'.repeat(5_000_000), tools: [] });
  assert.ok(budget >= 4_000, `floor breached: ${budget}`);
});

test('the self-imposed cap stays well inside the measured-safe range', () => {
  /*
   * Re-measured 2026-08-19, single attempt, no retry, 5 shots per size:
   * 35/35 succeeded from ~5,798 to 51,429 real prompt tokens, latency flat.
   * The estimator runs ~40% high, so an estimated cap of N is ~N/1.4 real.
   *
   * The upper bound is DERIVED from that measurement rather than picked: the
   * largest request proven to work was 51,429 real, which is ~72,000 estimated.
   * A cap above that would be sending sizes nobody has shot. The previous
   * bound of 40,000 was not the measurement — it was headroom above the
   * then-current 32,000, and it expired the moment the cap moved.
   *
   * NOTE (WI-BUDGET-1): that latency table is a snapshot of the upstream dated
   * 2026-08-19 and single-attempt. It has not been re-shot since, and it is the
   * sole evidence under the 60,000 cap. Re-measure it before raising further.
   */
  const MEASURED_SAFE_REAL = 51_429;
  const ESTIMATOR_INFLATION = 1.4;
  const measuredSafeEstimated = Math.round(MEASURED_SAFE_REAL * ESTIMATOR_INFLATION);
  assert.ok(SANE_CONTEXT_CAP <= measuredSafeEstimated,
    `cap ${SANE_CONTEXT_CAP} is past the largest request ever measured (~${measuredSafeEstimated} estimated)`);
  assert.ok(SANE_CONTEXT_CAP >= 24_000, 'below this the 5,452-token thrash comes back');
});

test('the token estimate is pessimistic, because guessing low fails the request', () => {
  // 3.5 chars/token rather than the usual 4: tool results are JSON, and JSON
  // tokenises worse than prose. Confirmed against real usage numbers — 32,000
  // estimated tokens measured as 22,911 real ones.
  assert.ok(estimateTextTokens('a'.repeat(3500)) >= 1000);
});

/* ------------------------------------------------------------------ *
 * The minimum-gain floor
 * ------------------------------------------------------------------ */

test('the minimum compaction gain is large enough to break the thrash loop', () => {
  // The observed thrash folded spans worth ~2,000-5,000 tokens to land just
  // under the line, where the next tool result pushed it straight back over.
  // A floor below ~1,000 would not have stopped any of the three.
  assert.ok(MIN_COMPACTION_GAIN >= 1_000, 'too low to prevent the observed thrash');
});


/* ------------------------------------------------------------------ *
 * WI-BUDGET-1 — STARVATION IS LOUD
 *
 * `Math.max(MIN_HISTORY_TOKENS, ...)` is a floor, and a floor is silent: once
 * the subtraction goes negative it returns 4,000 and the arithmetic that got
 * there vanishes. That is how the ratchet hid — at cap 32,000 the real prompt
 * and the real 90 tool schemas put fixed + headroom at 37,012 against a 32,000
 * ceiling, and nothing said so. These pin the reporting, not the repair: the
 * returned budget is deliberately unchanged.
 * ------------------------------------------------------------------ */

/** Count the BUDGET STARVED lines a block of work emits. Errors go to stderr. */
async function captureStarvationLog(fn) {
  const realWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1]() : true;
  };
  try { return { result: await fn(), starvedLines: lines.filter((l) => l.includes('BUDGET STARVED')) }; }
  finally { process.stderr.write = realWrite; }
}

test('an over-ceiling envelope is reported as starved rather than absorbed by the floor', async () => {
  showReturns(131_072);
  // Deliberately bigger than the 60,000 ceiling on its own, so the subtraction
  // is negative and only the floor is left.
  const system = 'x'.repeat(60_000 * 4);
  const { result, starvedLines } = await captureStarvationLog(() => computeBudget({ system, tools: [] }));

  assert.equal(result.starved, true, 'the state must be reported on the result');
  assert.ok(result.fixed + result.headroom >= result.ceiling, 'the fixture must actually starve');
  // The repair is a human decision about the cap or the registry. The floor
  // still applies and the returned value is untouched.
  assert.equal(result.budget, 4_000, 'the floor still holds — this reports, it does not repair');
  assert.equal(starvedLines.length, 1, `expected exactly one loud line, got ${starvedLines.length}`);
  assert.match(starvedLines[0], /BUDGET STARVED/);
});

test('the same starvation logs once, not once per iteration of the agent loop', async () => {
  showReturns(131_072);
  const system = 'x'.repeat(60_000 * 4);
  const { starvedLines } = await captureStarvationLog(async () => {
    // computeBudget runs on every iteration of every turn; an unconditional
    // error here would be tens of identical lines per turn.
    for (let i = 0; i < 5; i++) await computeBudget({ system, tools: [] });
  });
  assert.equal(starvedLines.length, 1, `deduped per distinct state, got ${starvedLines.length} lines`);
});

test('a starvation that gets WORSE is a new line, not a suppressed one', async () => {
  showReturns(131_072);
  const { starvedLines } = await captureStarvationLog(async () => {
    await computeBudget({ system: 'x'.repeat(60_000 * 4), tools: [] });
    await computeBudget({ system: 'x'.repeat(70_000 * 4), tools: [] });
  });
  assert.equal(starvedLines.length, 2, 'the signature is the numbers, so a bigger overflow reports again');
});

test('the LIVE artifacts are not starved at the current cap', async () => {
  // The regression this WI closes. Asserted against the real system prompt and
  // the real registry, never a fixture — see the note on the live-artifact
  // tests below.
  showReturns(131_072);
  const { result, starvedLines } = await captureStarvationLog(
    () => computeBudget({ system: buildSystemPrompt({}), tools: TOOLS, maxTokens: 4096 }),
  );
  assert.equal(result.starved, false,
    `live fixed ${result.fixed} + headroom ${result.headroom} >= ceiling ${result.ceiling} — the envelope is over-full`);
  assert.equal(starvedLines.length, 0, 'nothing to say when the envelope has room');
});
