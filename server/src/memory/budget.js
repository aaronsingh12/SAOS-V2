import { log } from '../logging.js';
import { getSettings } from '../config/store.js';
import { estimateTextTokens } from './tokens.js';

/**
 * D-7 — budgets from reality, instead of from a bad afternoon.
 *
 * The number this replaces was 18,000 tokens for the whole request, which after
 * the measured 12,548 tokens of fixed overhead (system prompt + 37 tool
 * schemas) left the conversation 5,452 tokens to remember anything in. The
 * model is gpt-oss:120b-cloud. Read off the daemon rather than assumed:
 *
 *   $ curl -s localhost:11434/api/show -d '{"model":"gpt-oss:120b-cloud"}'
 *     "gptoss.context_length": 131072
 *
 * So the agent was using 4% of its context window, and paying for it: a single
 * turn produced THREE compaction digests (9,629 -> 4,308, 7,209 -> 3,774,
 * 6,298 -> 2,476 tokens). Every "before" is above 5,452 and every "after" is
 * below it. That is not a coincidence, it is the budget, and it thrashed
 * because each digest is appended to the SYSTEM PROMPT — so every compaction
 * raised the fixed overhead and lowered the next turn's allowance. A ratchet.
 *
 * The old constant was honestly derived; it is the derivation that expired.
 * It came from a measured cliff — ~27,900 tokens succeeding 4/8 while ~20,100
 * went 8/8 — and `retry.js` argues at length that this upstream is simply
 * flaky, with failure probability rising with size. Re-measured on 2026-08-19,
 * single attempt, no retry, five shots per size:
 *
 *    ~8,000 est (  5,798 real prompt_tokens)  5/5   avg 1044ms
 *   ~16,000 est ( 11,502 real)                5/5   avg 1356ms
 *   ~24,000 est ( 17,209 real)                5/5   avg 1456ms
 *   ~32,000 est ( 22,911 real)                5/5   avg 1204ms
 *   ~40,000 est ( 28,614 real)                5/5   avg 1465ms
 *   ~56,000 est ( 40,023 real)                5/5   avg 1526ms
 *   ~72,000 est ( 51,429 real)                5/5   avg 1523ms
 *
 * 35/35, with latency flat to 51k real tokens. The cliff did not reproduce.
 * Two things follow. First, the 18,000 budget was calibrated against a
 * transient upstream problem that no longer exists — and the retry and
 * cold-start warm-up added since are what now cover the flakiness it was
 * dodging. Second, the estimator is pessimistic by design (3.5 chars/token):
 * 32,000 ESTIMATED tokens measured as 22,911 real ones, about 40% high. Every
 * number in this file is in estimated tokens, so the real request is smaller
 * than it says — which is the safe direction to be wrong in.
 *
 * ---
 *
 * WHICH OF THESE NUMBERS YOU MAY BUILD ON.
 *
 * The 35/35 latency table above is a MEASUREMENT of the upstream and stands
 * until someone re-measures it. Everything describing this application's own
 * size — the fixed overhead, the tool count, the resulting history budget — is
 * a SNAPSHOT, and snapshots of a growing system go stale by being correct on
 * the day they were written. The D-7 write-up's closing figures were
 * "13,160 fixed / 37 tool schemas / 12,696 history budget"; two tracks later
 * the same probe reported roughly 15,700 fixed against 41 tools, and a history
 * budget near 10,100. Nothing regressed — the prompt and the toolset grew, and
 * the allowance is what is left over.
 *
 * So do not quote a figure from this comment, and do not tune against one.
 * `computeBudget()` measures the fixed cost of the ACTUAL system prompt and
 * the ACTUAL tool schemas on every turn, `probeContextWindow()` reads the
 * window off the daemon, and the orchestrator logs all four numbers at meta
 * time and streams them to the UI badge. That runtime output is the source of
 * truth; this comment is the reasoning behind it. Trap #59 in the ledger is
 * about exactly this, and it applies to its own write-up.
 */

/**
 * The ceiling we impose on ourselves, well below the model's 131,072.
 *
 * Not a reliability limit — the measurement above found none up to 51k real
 * tokens. It is a cost-and-latency limit: a 128K request would be sent on every
 * iteration of a 15-iteration tool loop, and nothing in this product needs a
 * conversation that long. Raising it is safe if a session ever justifies it.
 */
export const SANE_CONTEXT_CAP = 60_000;

/**
 * Room reserved for the answer, and deliberately more than we ask for.
 *
 * `max_tokens` is 4,096. It needs more than that reserved because this model
 * bills hidden REASONING tokens against the same completion budget — measured
 * directly, a 20-token request came back `finish_reason: "length"` with an
 * empty `content` and a populated `reasoning` field. Reserving exactly
 * max_tokens would be reserving for the visible half only.
 */
export const OUTPUT_HEADROOM = 6_144;

/** Never squeeze history below this, whatever the overhead says. */
const MIN_HISTORY_TOKENS = 4_000;

/**
 * Context windows for models whose daemon cannot be asked. Ollama can be, and
 * is — this is the fallback for OpenAI/Anthropic, where the window is a
 * published fact rather than a queryable one.
 */
const DOCUMENTED_CONTEXT = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'o3': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-opus-4-5': 200_000,
};

/** Used when nothing else is known. Small on purpose: guessing high fails hard. */
export const FALLBACK_CONTEXT = 32_768;

const probeCache = new Map();

/**
 * Ask the daemon what the model's context window is.
 *
 * `/api/show` is the native endpoint, not the /v1 shim, so the base URL has its
 * `/v1` suffix stripped. The answer is cached per model for the process — it
 * cannot change under a running model, and this is called on every turn.
 */
export async function probeContextWindow(model, baseUrl) {
  if (!model) return { tokens: FALLBACK_CONTEXT, source: 'fallback (no model configured)' };
  if (probeCache.has(model)) return probeCache.get(model);

  const root = String(baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  let result = null;
  try {
    const res = await fetch(`${root}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      const info = (await res.json())?.model_info || {};
      // The key is architecture-prefixed (gptoss.context_length,
      // llama.context_length, qwen2.context_length), so find it by suffix
      // rather than guessing the architecture.
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const tokens = key ? Number(info[key]) : null;
      if (tokens > 0) result = { tokens, source: `${root}/api/show (${key})` };
    }
  } catch { /* the daemon may not be Ollama at all — fall through */ }

  if (!result) {
    const documented = DOCUMENTED_CONTEXT[model] || DOCUMENTED_CONTEXT[model.split(':')[0]];
    result = documented
      ? { tokens: documented, source: 'documented constant' }
      : { tokens: FALLBACK_CONTEXT, source: 'fallback — model context unknown' };
  }
  probeCache.set(model, result);
  log.info('llm', `model context window for ${model}: ${result.tokens} tokens (${result.source})`);
  return result;
}

/** Only for tests — the cache is per-process and per-model otherwise. */
export function clearContextProbeCache() {
  probeCache.clear();
}

/**
 * The three numbers, measured rather than assumed, for THIS turn.
 *
 * `system` and `tools` are what the adapter will actually serialise, so the
 * fixed cost includes the fact ledger and every digest written so far — which
 * is the ratchet made visible instead of silent.
 */
export async function computeBudget({ system, tools, maxTokens = 4096 } = {}) {
  const { llm } = getSettings();
  const model = llm.model || '';
  const { tokens: modelCtx, source } = await probeContextWindow(model, llm.baseUrl);

  /*
   * PHASE 2 — the fixed cost, itemised.
   *
   * `fixed` is unchanged and is still the sum of the two halves, so every
   * existing assertion about it holds. What is new is that the two halves are
   * REPORTED separately, because "the fixed overhead is 31,759" was a number
   * nobody could act on: it did not say whether the prompt or the registry was
   * the weight, and the answer (20,856 of it tool schemas) is what decided
   * where Phase 2 spent its effort.
   */
  const systemTokens = estimateTextTokens(system);
  const toolSchemaTokens = estimateTextTokens(JSON.stringify(tools ?? []));
  const fixed = systemTokens + toolSchemaTokens;
  const headroom = Math.max(OUTPUT_HEADROOM, maxTokens);
  const ceiling = Math.min(modelCtx, SANE_CONTEXT_CAP);
  /*
   * WI-BUDGET-1 — STARVATION, SAID OUT LOUD.
   *
   * `Math.max` below is a floor, and a floor is silent by construction: once
   * `ceiling - fixed - headroom` goes negative it returns MIN_HISTORY_TOKENS
   * and the arithmetic that produced it disappears. That is how the ratchet
   * hid. Measured at cap 32,000 with the real prompt and the real 90 tool
   * schemas: fixed 30,868 + headroom 6,144 = 37,012 against a 32,000 ceiling,
   * so the subtraction was -5,012 and every turn silently ran on the 4,000
   * floor — LESS conversation than the 5,452 D-7 calls the defect.
   *
   * The envelope is over-full BEFORE a single word of history: there is no
   * allowance left to divide, and no compaction can make one. Reported rather
   * than repaired, because the repair is a decision about the cap or the
   * registry that belongs to a human, and a budget that quietly rewrote itself
   * is what this whole file exists to stop.
   */
  const starved = fixed + headroom >= ceiling;
  const budget = Math.max(MIN_HISTORY_TOKENS, ceiling - fixed - headroom);

  if (starved) reportStarvation({ fixed, headroom, ceiling, budget, tools });

  return {
    modelCtx, modelCtxSource: source, cap: SANE_CONTEXT_CAP, ceiling,
    fixed, headroom, budget, starved,
    // Phase 2 — the breakdown, so a context optimisation is measurable rather
    // than asserted. Additive: nothing that read this object before reads less.
    systemTokens, toolSchemaTokens, toolCount: Array.isArray(tools) ? tools.length : 0,
  };
}

/**
 * One line per DISTINCT starvation, not one per turn.
 *
 * `computeBudget` runs on every iteration of every turn, so an unconditional
 * error would emit tens of identical lines per turn and become the noise it is
 * meant to be the signal against. The signature is the three numbers that
 * define the state, so a starvation that gets WORSE — another tool, a longer
 * digest — is a new line rather than a suppressed one.
 */
const starvationSeen = new Set();

function reportStarvation({ fixed, headroom, ceiling, budget, tools }) {
  const signature = `${fixed}:${headroom}:${ceiling}`;
  if (starvationSeen.has(signature)) return;
  starvationSeen.add(signature);
  const toolCount = Array.isArray(tools) ? tools.length : 0;
  log.error('llm',
    `BUDGET STARVED: fixed ${fixed} + output headroom ${headroom} = ${fixed + headroom}, which is at or over `
    + `the ${ceiling}-token ceiling. There is no history allowance left to compute, so the budget fell back to `
    + `the ${budget}-token floor and the conversation is running on it. This is not something compaction can `
    + `fix — the request is over budget before any history is added. Raise SANE_CONTEXT_CAP, or shrink the `
    + `system prompt or the ${toolCount} tool schemas.`);
}

/** Only for tests — the dedupe set is per-process otherwise. */
export function clearStarvationLog() {
  starvationSeen.clear();
}
