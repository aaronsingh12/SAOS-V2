import { getSettings } from '../../config/store.js';
import { DECODING_SENT, decodingReality } from '../decoding.js';
import * as anthropic from './anthropic.js';
import * as openaiCompat from './openaiCompat.js';

export function providerInfo() {
  const { llm } = getSettings();
  const model =
    llm.model ||
    (llm.provider === 'anthropic'
      ? anthropic.anthropicDefaults.model
      : (openaiCompat.openAiDefaults[llm.provider]?.model || openaiCompat.openAiDefaults.openai.model));
  return {
    provider: llm.provider,
    model,
    // A1: what determinism this provider actually offers, stated rather than
    // assumed. The UI shows it so a non-reproducible backend is visible.
    decoding: { sends: DECODING_SENT[llm.provider] || null, reality: decodingReality(llm.provider) },
  };
}

/**
 * Test seam, mirroring `_setDbForTests` in memory/db.js.
 *
 * The turn-control invariants (WI-2, WI-3) are properties of the LOOP — how
 * many times it speaks to the provider, and what it does between those calls.
 * Nothing short of driving `runTurn` against a scripted provider tests them,
 * and a test that reaches a real model could not assert a call count on a
 * backend measured to be non-deterministic.
 *
 * Null in every non-test process: only the test suite ever calls this.
 */
let scripted = null;
export function _setChatTurnForTests(fn) { scripted = fn; }

/** Full agent turn with tool support. history uses the neutral format (see orchestrator). */
export async function chatTurn({ system, history, tools, maxTokens, decoding }) {
  if (scripted) return scripted({ system, history, tools, maxTokens, decoding });
  const { llm } = getSettings();
  if (llm.provider === 'anthropic') {
    if (!llm.apiKey) throw new Error('Anthropic API key not set. Add it in Settings.');
    return anthropic.chat({ apiKey: llm.apiKey, model: llm.model, system, history, tools, maxTokens, decoding });
  }
  if (llm.provider === 'openai' || llm.provider === 'ollama') {
    if (llm.provider === 'openai' && !llm.apiKey) throw new Error('OpenAI API key not set. Add it in Settings.');
    return openaiCompat.chat({
      provider: llm.provider,
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      system,
      history,
      tools,
      maxTokens,
      decoding,
    });
  }
  throw new Error(`Unknown LLM provider: ${llm.provider}`);
}

/** One-shot text completion (no tools) — used by the flow blueprint designer. */
export async function chatOnce({ system, user, maxTokens = 2048, decoding }) {
  const res = await chatTurn({
    system,
    history: [{ role: 'user', text: user }],
    tools: [],
    maxTokens,
    decoding,
  });
  return res.text;
}
