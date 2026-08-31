import crypto from 'node:crypto';

/**
 * A1 — deterministic decoding for structured generation.
 *
 * Codegen and verification-spec generation are not creative tasks: the same
 * spec should produce the same source. Both knobs that buy that are requested
 * here and PASSED THROUGH by the adapters to whatever the provider supports.
 *
 * What is actually honoured is a provider/model property, and it was measured
 * rather than assumed (docs/fluent-research.md §19). On this machine's only
 * available model, `gpt-oss:120b-cloud` via Ollama:
 *
 *   - `seed` is IGNORED. Not dropped by the OpenAI-compat shim — ignored by the
 *     backend: three calls to the NATIVE /api/chat with identical
 *     `options.seed` at temperature 1.0 returned three different answers.
 *   - `temperature: 0` is only APPROXIMATELY stable. Repeated identical calls
 *     share a prefix and then diverge, which is what batched GPU inference
 *     looks like when two candidate tokens are near-tied.
 *
 * So nothing downstream may ASSUME reproducibility. These values are requested
 * because a stronger model swapped in through Settings may well honour them,
 * and because temperature 0 measurably narrows the spread even here. Every
 * guard in the pipeline is written to hold when decoding is non-deterministic,
 * which is the state this repo is actually in.
 */

/** Structured generation wants the mode, not a sample from the distribution. */
export const CODEGEN_TEMPERATURE = 0;

/**
 * Seed derived from the spec fingerprint, so the same request asks for the same
 * sample every time. `attempt` shifts it deliberately: a retry that re-asked
 * with an identical seed AND an identical prompt would be entitled to return
 * the identical broken answer. A5 makes the prompt differ; this makes the
 * sample differ too, without either one depending on entropy.
 */
export function seedFrom(fingerprint, attempt = 1) {
  const digest = crypto.createHash('sha256').update(`${fingerprint}#${attempt}`).digest();
  // Signed-32-bit range: the widest value every provider accepts.
  return digest.readUInt32BE(0) % 2147483647;
}

/** The decoding block for one codegen/verification attempt. */
export function codegenDecoding(fingerprint, attempt = 1) {
  return { temperature: CODEGEN_TEMPERATURE, seed: seedFrom(fingerprint, attempt) };
}

/**
 * What each adapter SENDS. Not a claim about what the provider honours — see
 * the note above, and `seedHonoured` below, which is the measured half.
 */
export const DECODING_SENT = {
  anthropic: { temperature: true, seed: false },
  openai: { temperature: true, seed: true },
  ollama: { temperature: true, seed: true },
  // Same body as OpenAI's, so the same parameters go out. Whether the model
  // BEHIND OpenRouter honours a seed is a property of that model, not of
  // OpenRouter — which is why SEED_HONOURED leaves it unmeasured rather than
  // claiming anything on ~400 backends' behalf.
  openrouter: { temperature: true, seed: true },
};

/**
 * Measured, per provider. `null` means "not measured on this machine" — which
 * is an honest answer, and the only one available for providers with no key.
 */
export const SEED_HONOURED = {
  anthropic: null,
  openai: null,
  // Unmeasurable as a single value: OpenRouter routes to hundreds of different
  // models and providers, and the answer differs per model. `null` is the only
  // honest entry.
  openrouter: null,
  // Measured 2026-08-18 against gpt-oss:120b-cloud on both the /v1 and the
  // native path. A locally-pulled model may differ; a *-cloud model does not.
  ollama: false,
};

/** Human-readable statement of what determinism is actually available. */
export function decodingReality(provider) {
  const sent = DECODING_SENT[provider] || { temperature: false, seed: false };
  const honoured = SEED_HONOURED[provider];
  if (!sent.seed) return `${provider}: temperature is sent; this API has no seed parameter.`;
  if (honoured === false) {
    return `${provider}: temperature and seed are both sent, but seed is provably NOT honoured by this backend — identical seeded calls return different completions. Treat every generation as non-reproducible.`;
  }
  if (honoured === null) return `${provider}: temperature and seed are both sent; whether seed is honoured has not been measured here.`;
  return `${provider}: temperature and seed are both sent and honoured.`;
}
