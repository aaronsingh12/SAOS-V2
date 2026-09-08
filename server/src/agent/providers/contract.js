/**
 * The LLMProvider interface, written down.
 *
 * It already EXISTED — `chatTurn` / `chatOnce` in this directory have been the
 * only door between the agent and any model since A-1, and
 * `openrouter-provider.test.js` already asserts that nothing outside
 * `agent/providers/` names a vendor. What was missing is the thing a fifth
 * provider needs and a fourth one could do without: a statement of what an
 * adapter must accept and must return, that a test can check rather than a
 * reviewer having to read two adapters and diff them by eye.
 *
 * So this file adds NO capability. It names the contract the adapters already
 * satisfy, so that adding one cannot quietly satisfy a different one.
 *
 * THE INTERFACE
 *
 *   chat(request) -> Promise<response>
 *
 *   request:
 *     system    string            the system prompt
 *     history   NeutralMessage[]  see below — vendor-independent
 *     tools     ToolSchema[]      { name, description, inputSchema }
 *     maxTokens number            output ceiling
 *     decoding  { temperature?, seed? } | undefined
 *                                 REQUESTED, never assumed honoured. See
 *                                 agent/decoding.js for the measured half.
 *     signal    AbortSignal | undefined
 *                                 REQUESTED, never assumed honoured — exactly
 *                                 like `decoding`. An adapter that can abort its
 *                                 request in flight should; one that cannot is
 *                                 still a valid adapter, because the caller's
 *                                 cancellation guarantee comes from the
 *                                 orchestrator's own boundaries and not from
 *                                 here. What an adapter MUST NOT do is retry a
 *                                 request it was asked to abandon — see
 *                                 `isAbort`/`abortedError` in ./retry.js.
 *
 *   response:
 *     text       string           '' rather than null when nothing was said
 *     toolCalls  { id, name, input }[]   [] rather than null
 *     stopReason string | undefined
 *
 * The neutral history format is the load-bearing part of the abstraction: the
 * orchestrator stores and reasons about messages in it, and each adapter
 * translates on the way out. It is
 *
 *   { role: 'user',      text }
 *   { role: 'assistant', text, toolCalls?: [{ id, name, input }] }
 *   { role: 'tool',      results: [{ id, output }] }
 *
 * Anything an adapter needs that is not in `request` — a key, a base URL, a
 * model id, vendor headers — is CONFIGURATION, and is passed by
 * `providers/index.js` from settings. An adapter never reads settings itself:
 * that is what keeps the agent depending on the interface rather than on a
 * vendor, and it is why `_setChatTurnForTests` can stand in for all of them.
 */

/** Method every adapter module must export. */
export const REQUIRED_METHODS = Object.freeze(['chat']);

/**
 * Keys `chat` must accept. Extra keys are an adapter's own configuration.
 *
 * `signal` joined the list in Phase 0. "Must accept" is the whole requirement:
 * an adapter may ignore it, and one that cannot abort mid-request is still
 * conformant — but it may not reject the key, because the orchestrator now
 * passes it on every call.
 */
export const REQUEST_KEYS = Object.freeze(['system', 'history', 'tools', 'maxTokens', 'decoding', 'signal']);

/** Keys every completion must carry back. */
export const RESPONSE_KEYS = Object.freeze(['text', 'toolCalls']);

export const NEUTRAL_ROLES = Object.freeze(['user', 'assistant', 'tool']);

/**
 * Does this module look like an LLMProvider?
 *
 * Structural, deliberately: it checks the shape of the exported function rather
 * than calling it, because calling it means reaching a network. The response
 * half is checked by `assertCompletionShape`, which the adapters' own tests
 * apply to real (or scripted) completions.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkProviderModule(name, mod) {
  const problems = [];
  for (const m of REQUIRED_METHODS) {
    if (typeof mod?.[m] !== 'function') {
      problems.push(`${name} does not export a ${m}() function`);
      continue;
    }
    // An adapter that took positional arguments could not be handed a request
    // object, and would fail at the call site rather than here.
    if (mod[m].length > 1) {
      problems.push(`${name}.${m}() must take ONE request object, not ${mod[m].length} positional arguments`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Is this a completion the orchestrator can consume?
 *
 * `text: null` and `toolCalls: null` are the two shapes that have historically
 * poisoned a session — a null content that could not be re-sent, and a missing
 * tool-call array that read as "the model said nothing". Both adapters
 * normalise them; this is the assertion that a THIRD one has to as well.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkCompletionShape(res) {
  const problems = [];
  if (!res || typeof res !== 'object') return { ok: false, problems: ['completion is not an object'] };
  if (typeof res.text !== 'string') problems.push('completion.text must be a string ("" when nothing was said, never null)');
  if (!Array.isArray(res.toolCalls)) problems.push('completion.toolCalls must be an array ([] when none, never null)');
  for (const tc of res.toolCalls || []) {
    if (!tc?.id) problems.push('a tool call has no id — the wire format needs one to match the result back');
    if (!tc?.name) problems.push('a tool call has no name');
    if (tc?.input !== undefined && (typeof tc.input !== 'object' || tc.input === null)) {
      problems.push(`tool call ${tc.name} has a non-object input`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Throwing forms, for use at a boundary rather than in a test assertion. */
export function assertProviderModule(name, mod) {
  const { ok, problems } = checkProviderModule(name, mod);
  if (!ok) throw new Error(`LLMProvider contract violated: ${problems.join('; ')}`);
  return true;
}

export function assertCompletionShape(res) {
  const { ok, problems } = checkCompletionShape(res);
  if (!ok) throw new Error(`LLMProvider completion contract violated: ${problems.join('; ')}`);
  return true;
}
