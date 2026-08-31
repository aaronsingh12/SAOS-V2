import { getSettings } from '../../config/store.js';
import { DECODING_SENT, decodingReality } from '../decoding.js';
import * as anthropic from './anthropic.js';
import * as openaiCompat from './openaiCompat.js';

/*
 * Providers that speak the OpenAI chat-completions shape.
 *
 * OpenRouter is one of them — verified against the live API, not assumed: it
 * takes the same body at `/chat/completions` with `Authorization: Bearer`, and
 * normalises every model it fronts to OpenAI's response shape. So it needs no
 * special-casing beyond a base URL, a credential check and its optional
 * attribution headers.
 */
const OPENAI_COMPATIBLE = new Set(['openai', 'ollama', 'openrouter']);

const KEY_REQUIRED = {
  openai: 'OpenAI API key not set. Add it in Settings.',
  openrouter: 'OpenRouter API key not set. Add it in Settings — it is the key from openrouter.ai/keys.',
};

function assertCompatCredentials(llm) {
  const missing = KEY_REQUIRED[llm.provider];
  if (missing && !llm.apiKey) throw new Error(missing);

  /*
   * OpenRouter has no sensible default model, and guessing one is worse than
   * refusing. It fronts hundreds of `vendor/model` ids that change constantly,
   * so a stale default fails as an opaque upstream error about a model the user
   * never chose. Refuse here, naming where the list comes from.
   */
  if (llm.provider === 'openrouter' && !llm.model) {
    throw new Error(
      'No OpenRouter model is set. OpenRouter fronts hundreds of models under vendor/model ids '
      + '(for example anthropic/claude-opus-5 or openai/gpt-5.6-luna), and there is no safe default to pick for you. '
      + 'Choose one in Settings — the list is loaded live from openrouter.ai/api/v1/models.'
    );
  }
}

/**
 * OpenRouter's optional attribution headers, which let it label the traffic.
 *
 * Confirmed against the docs: `HTTP-Referer` for the site and `X-Title` for the
 * display name (`X-OpenRouter-Title` is the canonical spelling and `X-Title` is
 * accepted). Entirely optional — nothing breaks without them — so they are
 * static identification for this app rather than anything user-configurable.
 */
function attributionHeaders(provider) {
  if (provider !== 'openrouter') return null;
  return {
    'HTTP-Referer': 'https://github.com/nowhelpassist',
    'X-Title': 'NowHelpAssist',
  };
}

export function providerInfo() {
  const { llm } = getSettings();
  const defaults = openaiCompat.openAiDefaults[llm.provider];
  /*
   * A provider with no default model reports an empty one rather than borrowing
   * OpenAI's. Showing "gpt-4o" for an unconfigured OpenRouter setup would be a
   * confident wrong answer about what the next turn will actually call.
   */
  const model =
    llm.model
    || (llm.provider === 'anthropic'
      ? anthropic.anthropicDefaults.model
      : (defaults ? defaults.model : openaiCompat.openAiDefaults.openai.model));
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
  if (OPENAI_COMPATIBLE.has(llm.provider)) {
    assertCompatCredentials(llm);
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
      extraHeaders: attributionHeaders(llm.provider),
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
