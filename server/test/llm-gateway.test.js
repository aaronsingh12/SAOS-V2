import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { _setSettingsForTests } from '../src/config/store.js';
import { providerInfo, chatTurn, chatOnce, _setChatTurnForTests } from '../src/agent/providers/index.js';
import { openAiDefaults } from '../src/agent/providers/openaiCompat.js';
import * as anthropic from '../src/agent/providers/anthropic.js';
import * as openaiCompat from '../src/agent/providers/openaiCompat.js';
import {
  checkProviderModule, checkCompletionShape, assertCompletionShape,
  REQUEST_KEYS, RESPONSE_KEYS,
} from '../src/agent/providers/contract.js';
import { DECODING_SENT, SEED_HONOURED, decodingReality } from '../src/agent/decoding.js';

/*
 * The LLM gateway: the interface every adapter satisfies, and the fifth
 * provider added through it.
 *
 * The abstraction already existed — chatTurn/chatOnce have been the only door
 * between the agent and any model since A-1. What is under test here is that
 * the door has a stated shape (contract.js), that both existing adapters fit
 * it, and that adding an OpenCode-compatible endpoint needed no code outside
 * the provider directory.
 */

const bind = (llm) => _setSettingsForTests({ llm });
test.afterEach(() => { _setSettingsForTests(null); _setChatTurnForTests(null); });

/* ── the interface ────────────────────────────────────────────────────────── */

test('both shipped adapters satisfy the LLMProvider contract', () => {
  for (const [name, mod] of [['anthropic', anthropic], ['openaiCompat', openaiCompat]]) {
    const { ok, problems } = checkProviderModule(name, mod);
    assert.equal(ok, true, `${name}: ${problems.join('; ')}`);
  }
});

test('the contract names the request and response keys the orchestrator relies on', () => {
  // Not a tautology: these are the keys runTurn actually passes and reads, and
  // an adapter that quietly dropped one would fail at the wire, far from here.
  for (const k of ['system', 'history', 'tools', 'maxTokens', 'decoding']) {
    assert.ok(REQUEST_KEYS.includes(k), `request key ${k} must be part of the contract`);
  }
  assert.deepEqual([...RESPONSE_KEYS], ['text', 'toolCalls']);
});

test('a completion with null text or null toolCalls violates the contract', () => {
  // The two shapes that have historically poisoned a session: a null content
  // that cannot be re-sent, and a missing tool-call array that reads as silence.
  assert.equal(checkCompletionShape({ text: null, toolCalls: [] }).ok, false);
  assert.equal(checkCompletionShape({ text: '', toolCalls: null }).ok, false);
  assert.equal(checkCompletionShape({ text: '', toolCalls: [] }).ok, true);
  assert.throws(() => assertCompletionShape({ text: 'hi' }), /toolCalls must be an array/);
});

test('a tool call with no id violates the contract', () => {
  // The wire format matches results back to calls by id; a call without one
  // produces an orphaned tool result that gets dropped on the next turn.
  const { ok, problems } = checkCompletionShape({ text: '', toolCalls: [{ name: 'x', input: {} }] });
  assert.equal(ok, false);
  assert.match(problems.join(' '), /no id/);
});

test('the agent reaches a model ONLY through the gateway', async () => {
  // The whole abstraction, asserted at its narrowest point: with chatTurn
  // scripted, nothing in the agent can reach a network.
  const seen = [];
  _setChatTurnForTests(async (req) => {
    seen.push(req);
    return { text: 'ok', toolCalls: [] };
  });
  const out = await chatOnce({ system: 's', user: 'u' });
  assert.equal(out, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].history[0].text, 'u');
  assertCompletionShape({ text: out, toolCalls: [] });
});

/* ── opencode, as a fifth provider in the same abstraction ────────────────── */

test('the OpenCode provider has NO default base URL and NO default model', () => {
  // Both are properties of the operator's own machine. A default here would be
  // a guess, and the guess would silently point at the Ollama default.
  assert.equal(openAiDefaults.opencode.baseUrl, '');
  assert.equal(openAiDefaults.opencode.model, '');
});

test('providerInfo does not borrow another provider\'s model for OpenCode', () => {
  bind({ provider: 'opencode', baseUrl: 'http://localhost:4096/v1', model: '' });
  assert.equal(providerInfo().model, '', 'an unconfigured OpenCode must not report gpt-4o or llama3.1');
  bind({ provider: 'opencode', baseUrl: 'http://localhost:4096/v1', model: 'my-local-model' });
  assert.equal(providerInfo().model, 'my-local-model');
});

test('a missing base URL refuses, and says why there is no default', async () => {
  bind({ provider: 'opencode', baseUrl: '', model: 'm' });
  await assert.rejects(
    () => chatTurn({ system: 's', history: [], tools: [] }),
    (e) => {
      assert.match(e.message, /No OpenCode base URL is set/);
      assert.match(e.message, /wire format/, 'the refusal must explain that there is nothing to default to');
      return true;
    },
  );
});

test('a missing model refuses too, rather than guessing one', async () => {
  bind({ provider: 'opencode', baseUrl: 'http://localhost:4096/v1', model: '' });
  await assert.rejects(
    () => chatTurn({ system: 's', history: [], tools: [] }),
    (e) => {
      assert.match(e.message, /No OpenCode model is set/);
      assert.match(e.message, /\/models/, 'the refusal must say where the list comes from');
      return true;
    },
  );
});

test('an unconfigured OpenCode NEVER falls through to the Ollama default', async () => {
  // The failure this refusal exists to prevent: the same adapter serves both,
  // and a defaulted base URL would post the system prompt, the whole
  // conversation and ~90 tool schemas to localhost:11434 under a provider name
  // the user chose specifically because they did not mean that.
  bind({ provider: 'opencode', baseUrl: '', model: '' });
  await assert.rejects(
    () => chatTurn({ system: 's', history: [{ role: 'user', text: 'hi' }], tools: [] }),
    /No OpenCode base URL is set/,
  );
});

test('the decoding statement for OpenCode claims nothing it has not measured', () => {
  assert.deepEqual(DECODING_SENT.opencode, { temperature: true, seed: true });
  assert.equal(SEED_HONOURED.opencode, null, 'there is no OpenCode gateway here to measure against');
  assert.match(decodingReality('opencode'), /has not been measured/);
});

test('the other providers are unaffected by the new branch', async () => {
  bind({ provider: 'openai', apiKey: '', model: 'gpt-4o' });
  await assert.rejects(() => chatTurn({ system: 's', history: [], tools: [] }), /OpenAI API key not set/);

  // Ollama needs neither a key nor an explicit model, and must not be caught by
  // the OpenCode checks that sit in the same credential function.
  bind({ provider: 'ollama', apiKey: '', baseUrl: '', model: '' });
  assert.equal(providerInfo().model, 'llama3.1');

  bind({ provider: 'nonsense', apiKey: 'k', model: 'm' });
  await assert.rejects(() => chatTurn({ system: 's', history: [], tools: [] }), /Unknown LLM provider/);
});

/* ── no coupling above the provider layer ─────────────────────────────────── */

test('nothing outside the provider layer branches on the OpenCode provider', () => {
  // The same guarantee the OpenRouter suite asserts, for the same reason:
  // "the planner depends only on the interface" is an ABSENCE, and an absence
  // is exactly what nobody notices being removed.
  //
  // Matched on the QUOTED LITERAL rather than the bare word, which is the one
  // way this differs from the OpenRouter version. A provider name only ever
  // appears in code as a string — a settings comparison, a defaults key, a set
  // membership — so the quoted form is precisely the coupling under test.
  // "opencode" also appears as PROSE in orchestrator.js and the README, which
  // have named the project as design inspiration since long before it was a
  // provider, and an attribution is not a dependency.
  const COUPLING = /(['"`])opencode/i;
  const SERVER_SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const rel = path.relative(SERVER_SRC, p).replace(/\\/g, '/');
      if (rel.startsWith('agent/providers/') || rel === 'agent/decoding.js') continue;
      if (COUPLING.test(fs.readFileSync(p, 'utf8'))) offenders.push(rel);
    }
  };
  walk(SERVER_SRC);
  assert.deepEqual(offenders, [],
    'switching to an OpenCode-compatible endpoint must need no code change outside agent/providers/');
});
