/**
 * One adapter, two providers: OpenAI and Ollama both speak the
 * /chat/completions wire format. Ollama exposes it at http://localhost:11434/v1
 * (tool calling requires a tool-capable local model, e.g. llama3.1, qwen2.5).
 */

import { log } from '../../logging.js';
import { estimateTextTokens } from '../../memory/tokens.js';
import { isBlankText } from '../../memory/sanitize.js';
import { withRetry, retryable, isRetryableStatus, isColdStart } from './retry.js';

const DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  /*
   * OpenRouter is OpenAI-compatible, VERIFIED against the live API rather
   * than assumed: POST https://openrouter.ai/api/v1/chat/completions with
   * `Authorization: Bearer <key>`, same request and response shape.
   *
   * The model default is deliberately EMPTY. OpenRouter fronts ~400 models
   * under volatile `vendor/model` ids (measured: 396 on the day this was
   * written), so a hardcoded default is trap #28 — a platform list that goes
   * stale silently — and would fail as an opaque upstream 4xx rather than as
   * a setting nobody chose. The provider refuses with instructions instead.
   */
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '' },
};

/**
 * F6 — how long a model call may hang before it counts as a failure.
 *
 * There was no bound at all, so a queued or wedged upstream held a turn open
 * on whatever the platform's socket defaults happen to be — and a hang is the
 * one failure the retry cannot help with, because it never gets to fail.
 *
 * 120s is generous on purpose: the measurements in memory/budget.js put a real
 * request at 1.0-1.5s up to 51k prompt tokens, so this is not a latency budget.
 * It is the line past which "slow" has become "not coming back".
 */
export const LLM_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The warm-up asks for one token and BLOCKS while the model loads, so it is
 * bounded separately and much tighter. It is an optimisation — losing it costs
 * a slower retry, not a failed one — and a warm-up that hangs would add its own
 * wait to every attempt it was supposed to make cheaper.
 */
export const WARMUP_TIMEOUT_MS = 15_000;

/**
 * `AbortSignal.timeout` rejects with a TimeoutError. undici sometimes surfaces
 * it directly and sometimes wrapped as the `cause` of a TypeError, so both are
 * checked — reading only the outer error reports a timeout as a dead daemon.
 */
const isTimeout = (err) => err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError';

/**
 * Neutral history -> /chat/completions messages.
 *
 * Every `content` is a STRING, never null, and that is not defensive tidying —
 * it is the fix for a session that could brick itself permanently. Measured
 * against gpt-oss:120b-cloud through Ollama's /v1 shim:
 *
 *   assistant content:null, WITH tool_calls   200
 *   assistant content:null, NO tool_calls     400  invalid message content
 *                                                  type: <nil>
 *   assistant content:'',   NO tool_calls     200
 *
 * The OpenAI spec allows a null content beside tool_calls, and Ollama honours
 * that — but it rejects a bare null outright. So one stored assistant turn
 * with no text and no tool calls made EVERY later turn in that session fail at
 * the wire, with an error naming neither the session nor the message.
 *
 * D-7 added the second half. Coercing null to '' stopped the 400, but it also
 * made a degenerate message SENDABLE: an assistant row with empty content and
 * no tool calls goes out clean and contributes nothing but a slot the model has
 * to account for. A whitespace-only completion (a bare newline, which this
 * model emits when reasoning eats the budget) slipped through the
 * orchestrator's truthiness check and landed here as exactly that. So the shape
 * is validated, not merely coerced — and every repair is reported to the caller
 * rather than done quietly.
 */
export function toOpenAiMessages(system, history) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const out = [{ role: 'system', content: str(system) }];
  const repairs = [];
  const seenCallIds = new Set();

  for (const m of history || []) {
    if (m?.role === 'user') {
      if (isBlankText(m.text)) { repairs.push('dropped a blank user message'); continue; }
      out.push({ role: 'user', content: str(m.text) });
    } else if (m?.role === 'assistant') {
      const hasCalls = m.toolCalls?.length > 0;
      // The one shape that must never reach the wire: nothing said, nothing
      // called. It is not a turn, and sending it is what a degenerate request
      // is made of.
      if (!hasCalls && isBlankText(m.text)) {
        repairs.push('dropped a blank assistant turn (no content, no tool calls)');
        continue;
      }
      const msg = { role: 'assistant', content: str(m.text) };
      if (hasCalls) {
        msg.tool_calls = m.toolCalls.map((tc) => {
          if (tc?.id) seenCallIds.add(tc.id);
          return {
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
          };
        });
      }
      out.push(msg);
    } else if (m?.role === 'tool') {
      for (const r of m.results || []) {
        // A tool result with no matching call is rejected outright by the
        // wire format, and is the shape a half-folded compaction leaves behind.
        if (!r?.id || !seenCallIds.has(r.id)) {
          repairs.push('dropped an orphaned tool result with no matching tool call');
          continue;
        }
        // An empty tool result is legal but useless; say so rather than
        // sending a blank the model has to interpret.
        out.push({
          role: 'tool',
          tool_call_id: r.id,
          content: isBlankText(r.output) ? '(the tool returned no output)' : str(r.output),
        });
      }
    } else if (m) {
      repairs.push(`dropped a history row with an unknown role: ${String(m.role)}`);
    }
  }
  /*
   * F3 — a PRESENCE invariant, alongside all the absence ones above.
   *
   * Every other check here removes a shape that cannot legally be sent. This
   * one reports a shape that is missing: a conversation with no user message in
   * it. That request is perfectly well-formed and Ollama accepts it — with a
   * 200, `finish_reason: "load"` and no content, which is how a compaction that
   * folded away the active turn's user row read as a broken model for six
   * attempts.
   *
   * REPORTED here, refused in `chat()`. This function's contract is that it
   * translates and tells the caller what it had to repair; throwing from it
   * would make it the one shape it handles by exploding instead.
   */
  return { messages: out, repairs, hasUserTurn: out.some((m) => m.role === 'user') };
}

/**
 * What actually went out, per message. This is the view that was missing when
 * a turn died on an empty completion: the error named a finish reason and
 * nothing about the request that produced it, so telling a degenerate request
 * from an unlucky one meant reading the database by hand.
 */
export function describeOutbound(messages) {
  let chars = 0;
  const shapes = [];
  let blanks = 0;
  for (const m of messages) {
    const len = (m.content || '').length;
    const calls = m.tool_calls?.length || 0;
    chars += len + JSON.stringify(m.tool_calls || '').length;
    const blank = len === 0 && calls === 0;
    if (blank) blanks += 1;
    shapes.push(`${m.role}(${len}ch${calls ? `,calls=${calls}` : ''}${blank ? ',BLANK' : ''})`);
  }
  return { count: messages.length, blanks, chars, estTokens: Math.ceil(chars / 3.5), shapes };
}

/**
 * The upstream's own incident id, out of whatever it came wrapped in.
 *
 * Ollama's cloud shim answers a 500 with `Internal Server Error (ref: <uuid>)`.
 * That ref is the only handle anyone outside this process has on the failure —
 * it is what a support thread is opened with — and it was being thrown away
 * with the rest of the response body. Deliberately not uuid-shaped: the point
 * is to capture whatever the upstream chose to call it, not to assert a format
 * it never promised.
 */
export function upstreamRefFrom(text) {
  const m = /\(ref:\s*([^)\s]+)\)/i.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * Force the model resident before retrying a cold start.
 *
 * A `load` finish reason means the backend spent the request loading the model
 * and produced nothing. Sleeping through that was guesswork about how long a
 * 120b cloud model takes to come up. This is the same question asked directly:
 * a one-token request that BLOCKS until the model is loaded, so the retry lands
 * on a warm model rather than on a longer guess.
 */
async function warmUp({ url, headers, model }) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
  });
  await res.json().catch(() => null);
  log.warn('llm', `warm-up request finished in ${Date.now() - started}ms (status ${res.status}) — model should now be resident`);
}

export async function chat({ provider, apiKey, baseUrl, model, system, history, tools, maxTokens = 4096, decoding, extraHeaders = null }) {
  const d = DEFAULTS[provider] || DEFAULTS.openai;
  const url = `${(baseUrl || d.baseUrl).replace(/\/$/, '')}/chat/completions`;
  const resolvedModel = model || d.model;
  const { messages, repairs, hasUserTurn } = toOpenAiMessages(system, history);

  // Loud, not silent. A repair means something upstream wrote a message that
  // cannot legally be sent, and the only way that gets fixed is by being seen.
  if (repairs.length) {
    log.warn('llm', `outbound request repaired: ${repairs.length} unsendable message(s) removed`, {
      repairs: [...new Set(repairs)],
    });
  }

  /*
   * F3 — the tripwire. Terminal, and deliberately NOT repaired.
   *
   * Injecting a synthetic user message here would make this send succeed while
   * the state that produced it stayed broken — and the turn would carry on into
   * the approval gate with mutations, on a conversation nobody actually had.
   * Refusing is the only honest option: it is not retryable (three attempts at
   * the same corrupt history is what turned this into six identical failures),
   * and it names the invariant so the fix lands upstream where it belongs.
   */
  if (!hasUserTurn) {
    throw new Error(
      'outbound conversation contains no user message — refusing to send ' +
      '(invariant: compaction/sanitation must preserve the active user turn)'
    );
  }

  const body = {
    model: resolvedModel,
    max_tokens: maxTokens,
    messages,
  };
  // A1 passthrough. Both knobs exist on this wire format, so both are sent.
  // Whether the backend HONOURS them is a separate question with a measured
  // answer — see agent/decoding.js. Nothing here may assume it did.
  if (decoding?.temperature !== undefined) body.temperature = decoding.temperature;
  if (decoding?.seed !== undefined) body.seed = decoding.seed;
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    body.tool_choice = 'auto';
  }
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // Provider-specific extras (OpenRouter's optional attribution headers). Kept
  // as a parameter rather than a branch so this module stays provider-shaped
  // rather than provider-aware.
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) if (v) headers[k] = v;

  const data = await withRetry(
    `${provider} chat`,
    // `attempt` so a persisted failure can say how many tries it took (F13).
    async (attempt) => {
      /*
       * F5 — serialised per attempt, on purpose.
       *
       * This was hoisted above `withRetry`, so every attempt POSTed the same
       * bytes. That is correct behaviour and it stays correct behaviour — but
       * it was a property of where a `const` happened to sit, not a decision,
       * and it is why the live incident produced six byte-identical failures.
       * Inside the closure, "each attempt re-sends exactly the same request"
       * is something this function chooses, and anything that ever needs to
       * vary between attempts has somewhere to go.
       */
      const payload = JSON.stringify(body);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // A hang and a dead daemon are different problems and must not read the
        // same. The timeout is shaped like the 408 it stands in for, so it goes
        // through exactly the retry path an upstream-reported timeout would.
        if (isTimeout(err)) {
          throw retryable(
            new Error(`${provider} did not respond within ${LLM_REQUEST_TIMEOUT_MS}ms at ${url}`),
            408
          );
        }
        // Nothing came back at all — the daemon is down, or the network blinked.
        throw retryable(new Error(`${provider} unreachable at ${url}: ${err.message}`));
      }
      const parsed = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(parsed?.error?.message || `${provider} API error (${res.status})`);
        err.status = res.status;
        // A 4xx is our malformed request; retrying it three times only makes a
        // clear bug slower to find.
        if (isRetryableStatus(res.status)) err.retryable = true;
        /*
         * F13 — the same evidence F4 keeps for an empty completion, kept for a
         * failure that never got as far as a completion.
         *
         * An empty 200 is dumped and persisted in full; an HTTP 500 produced
         * one line of stderr and nothing durable. That is backwards — the 500
         * is the failure that actually killed a turn on 2026-08-24, and the
         * two questions it raises are exactly the ones F4's dump was built to
         * answer: was the request we sent degenerate, and does the upstream
         * agree it was its own fault? `upstreamRef` answers the second: three
         * DISTINCT refs across three attempts is what proved the upstream was
         * genuinely failing three times rather than replaying one cached
         * answer, and it is the only handle a support thread can be opened
         * with.
         *
         * Same shape, same `tool_events` home, different name — a 500 and an
         * empty completion must stay countable apart.
         */
        const outbound = describeOutbound(messages);
        // Bounded: a raw body is unbounded and this row is written on a
        // failure path, where a runaway write would be a second incident.
        const bodyText = JSON.stringify(parsed ?? null).slice(0, 16_384);
        err.guard = { name: 'f13_http_error', status: `http-${res.status}` };
        err.guardDump = {
          status: res.status,
          upstreamRef: upstreamRefFrom(bodyText) || upstreamRefFrom(err.message),
          attempts: attempt,
          roleSequence: messages.map((m) => m.role).join('>'),
          historyEntries: (history || []).length,
          estRequestTokens: outbound.estTokens + estimateTextTokens(JSON.stringify(body.tools || [])),
          body: bodyText,
        };
        throw err;
      }
      // Parsed INSIDE the retry, so an empty completion gets another attempt.
      // It used to sit after `withRetry` returned, which meant the one failure
      // mode most worth retrying was the one that never could be.
      const choice = parsed?.choices?.[0];
      const msg = choice?.message || {};
      const toolCalls = (msg.tool_calls || []).map((tc) => {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep {} */ }
        return { id: tc.id, name: tc.function?.name, input };
      });
      // Whitespace is not content. This was truthiness-checked upstream, so a
      // bare newline became a real assistant turn, an empty bubble, and a
      // permanent passenger in every later request.
      const text = isBlankText(msg.content) ? '' : msg.content;
      if (text || toolCalls.length) {
        return { text, toolCalls, stopReason: choice?.finish_reason };
      }

      // Nothing came back. Everything known about the request that produced it
      // gets logged HERE, where it is still in scope.
      const outbound = describeOutbound(messages);
      log.warn('llm', `${provider} returned an empty completion — dumping the request that produced it`, {
        finishReason: choice?.finish_reason,
        outboundMessages: outbound.count,
        blankMessages: outbound.blanks,
        estRequestTokens: outbound.estTokens + estimateTextTokens(JSON.stringify(body.tools || [])),
        shapes: outbound.shapes,
        options: {
          model: resolvedModel,
          max_tokens: maxTokens,
          temperature: body.temperature,
          seed: body.seed,
          tools: body.tools?.length || 0,
        },
        // The provider's own answer, verbatim. Ollama's /v1 shim is
        // OpenAI-shaped, so it reports `finish_reason` and `usage` — the
        // native /api/chat fields (done_reason, eval_count, load_duration)
        // are NOT available on this endpoint and are not claimed here.
        rawResponse: parsed,
      });

      const finish = choice?.finish_reason;

      /*
       * F4 — the same dump, attached to the error so it can be PERSISTED.
       *
       * The block above is the only record of what produced an empty
       * completion, and it goes to stderr. In the session that produced this
       * branch it was gone by the time anyone looked, so answering "was the
       * request degenerate or was the upstream unlucky?" meant reading SQLite
       * by hand — which is the exact cost this diagnostic was written to
       * remove. The orchestrator writes it to `tool_events`, the table
       * compaction structurally cannot reach.
       *
       * `roleSequence` is the field the live incident actually needed and the
       * log did not have: it says at a glance whether a user turn was in the
       * request.
       */
      const err = (e) => Object.assign(e, {
        guardDump: {
          finishReason: finish ?? null,
          roleSequence: messages.map((m) => m.role).join('>'),
          shapes: outbound.shapes,
          outboundMessages: outbound.count,
          blankMessages: outbound.blanks,
          estRequestTokens: outbound.estTokens + estimateTextTokens(JSON.stringify(body.tools || [])),
          model: resolvedModel,
          maxTokens,
          // Bounded: a raw body is unbounded and this row is written on a
          // failure path, where a runaway write would be a second incident.
          rawResponse: JSON.stringify(parsed ?? null).slice(0, 16_384),
        },
      });

      // `length` is deterministic: reasoning models (gpt-oss, o-series,
      // deepseek-r1) spend the budget on hidden reasoning before emitting any
      // content, and the API still answers 200 with an empty string. Retrying
      // burns three attempts to arrive at the same place, so this one is final
      // and carries the remedy.
      if (finish === 'length') {
        const reasoned = typeof msg.reasoning === 'string' && msg.reasoning.length > 0;
        throw err(new Error(
          `${provider} returned no content: the max_tokens budget (${maxTokens}) was exhausted before any output was produced` +
          (reasoned ? ' — the model spent it on reasoning tokens.' : '.') +
          ' Raise max_tokens, or pick a non-reasoning model in Settings.'
        ));
      }

      // Everything else is transient. `load` is Ollama's own: the request loaded
      // the model and generated nothing — a cold start, reported to the user as
      // a hard failure that blamed their model choice. An empty `stop` is the
      // model simply hiccupping. Both are worth another attempt.
      throw retryable(err(new Error(
        `${provider} returned an empty completion (finish reason: ${finish || 'none'})`
      )));
    },
    {
      // Only a cold start gets a warm-up; a 5xx blip does not need one and an
      // extra request during an outage is the last thing the upstream wants.
      beforeRetry: async (err) => {
        if (isColdStart(err)) await warmUp({ url, headers, model: resolvedModel });
      },
    }
  );

  return data;
}

export const openAiDefaults = DEFAULTS;
