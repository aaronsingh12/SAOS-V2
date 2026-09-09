import { withRetry, retryable, isRetryableStatus, isAbort, abortedError } from './retry.js';
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function toAnthropicMessages(history) {
  const out = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: (m.results || []).map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.output === 'string' ? r.output : String(r.output ?? ''),
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

export async function chat({ apiKey, model, system, history, tools, maxTokens = 4096, decoding, signal = null }) {
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: toAnthropicMessages(history),
  };
  // A1 passthrough. This API has a temperature and no seed, so the seed is
  // dropped here rather than silently pretended at — `DECODING_SENT` records
  // that, so a caller can report what it actually got.
  if (decoding?.temperature !== undefined) body.temperature = decoding.temperature;
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  // Same bounded retry as the OpenAI-compatible adapter: a 5xx, a 429 or a
  // dropped connection gets another attempt; a 4xx does not, because that is
  // our own request being wrong. See ./retry.js for the measurement.
  const payload = JSON.stringify(body);
  const data = await withRetry('anthropic chat', async () => {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: payload,
        // Phase 0. The model call is a read: aborting it in flight costs
        // nothing and leaves nothing half-written, which is what makes it the
        // one thing in a turn that IS safe to interrupt.
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Checked before the unreachable branch, which marks its error retryable
      // — a cancelled request answered with three more requests is the opposite
      // of cancelling it.
      if (isAbort(err, signal)) throw abortedError('the Anthropic request');
      throw retryable(new Error(`Anthropic unreachable: ${err.message}`));
    }
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error(parsed?.error?.message || `Anthropic API error (${res.status})`);
      e.status = res.status;
      if (isRetryableStatus(res.status)) e.retryable = true;
      throw e;
    }
    return parsed;
  });
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return { text, toolCalls, stopReason: data.stop_reason };
}

export const anthropicDefaults = { model: DEFAULT_MODEL };
