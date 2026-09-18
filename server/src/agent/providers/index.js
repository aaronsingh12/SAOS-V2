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
const OPENAI_COMPATIBLE = new Set(['openai', 'ollama', 'openrouter', 'opencode']);

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

  /*
   * The same refusal, for the same reason, on the provider that has even less
   * to guess with.
   *
   * An OpenCode-compatible gateway is an address on the operator's own network
   * and a model id that gateway happens to serve. Neither is knowable from
   * here. Defaulting the baseUrl would silently send a system prompt, the whole
   * conversation and 100+ tool schemas to localhost:11434 — the Ollama default
   * one line above — under a provider name the user chose specifically because
   * they did NOT mean that. Refusing is the only option that cannot leak.
   */
  if (llm.provider === 'opencode') {
    if (!llm.baseUrl) {
      throw new Error(
        'No OpenCode base URL is set. "OpenCode-compatible" is a wire format (OpenAI /chat/completions), '
        + 'not a hosted service, so there is no address to default to and guessing one would send this '
        + 'conversation somewhere you did not choose. Set the base URL in Settings — it is the root your '
        + 'gateway serves /chat/completions under, e.g. http://localhost:4096/v1.'
      );
    }
    if (!llm.model) {
      throw new Error(
        'No OpenCode model is set. The model ids an OpenCode-compatible gateway serves are whatever that '
        + 'gateway was configured with, so there is no safe default to pick for you. Set the model in '
        + 'Settings — your gateway lists them at GET <base URL>/models.'
      );
    }
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

/**
 * Full agent turn with tool support. history uses the neutral format (see orchestrator).
 *
 * PHASE 0 — `signal` is part of the request, exactly like `decoding`: something
 * the caller ASKS for, which an adapter may or may not be able to honour. An
 * adapter that ignores it is not broken, and the caller must not assume its
 * request stopped because it passed one — cancellation is guaranteed only at
 * the orchestrator's own boundaries. Nothing here inspects the provider to
 * decide whether to pass it; every adapter receives it and answers for itself.
 */
export async function chatTurn({ system, history, tools, maxTokens, decoding, signal }) {
  if (scripted) return scripted({ system, history, tools, maxTokens, decoding, signal });
  const { llm } = getSettings();
  if (llm.provider === 'anthropic') {
    if (!llm.apiKey) throw new Error('Anthropic API key not set. Add it in Settings.');
    return anthropic.chat({ apiKey: llm.apiKey, model: llm.model, system, history, tools, maxTokens, decoding, signal });
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
      signal,
      extraHeaders: attributionHeaders(llm.provider),
    });
  }
  throw new Error(`Unknown LLM provider: ${llm.provider}`);
}

/** One-shot text completion (no tools) — used by the flow blueprint designer. */
export async function chatOnce({ system, user, maxTokens = 2048, decoding, signal, withMeta = false }) {
  const res = await chatTurn({
    system,
    history: [{ role: 'user', text: user }],
    tools: [],
    maxTokens,
    decoding,
    signal,
  });
  /*
   * `withMeta` exists for one reason: a completion that hits the token ceiling
   * with SOME content already emitted comes back as ordinary text. The caller
   * cannot tell a finished answer from a severed one, and for generated source
   * that means a half-written file going to the compiler, which reports a
   * syntax error that has nothing to do with the real problem. The stop reason
   * is the only reliable signal, so a caller that cares can ask for it.
   */
  return withMeta ? { text: res.text, stopReason: res.stopReason ?? res.finishReason ?? null } : res.text;
}
