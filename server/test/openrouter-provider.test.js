import test from 'node:test';
import assert from 'node:assert/strict';

import { _setSettingsForTests } from '../src/config/store.js';
import { providerInfo, chatTurn } from '../src/agent/providers/index.js';
import { openAiDefaults } from '../src/agent/providers/openaiCompat.js';
import { DECODING_SENT, SEED_HONOURED, decodingReality } from '../src/agent/decoding.js';

/*
 * OpenRouter, as a fourth provider in the SAME abstraction.
 *
 * The point of these is that there is no special-casing outside the provider
 * layer: it is an entry in the OpenAI-compatible set with its own base URL,
 * credential check and attribution headers, and nothing above it knows.
 *
 * Endpoint, auth and response shape were verified against the live API rather
 * than assumed — see the comments in openaiCompat.js.
 */

const bind = (llm) => _setSettingsForTests({ llm });
test.afterEach(() => { _setSettingsForTests(null); });

/* ── configuration ────────────────────────────────────────────────────────── */

test('the base URL is OpenRouter\'s v1 root', () => {
  assert.equal(openAiDefaults.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
});

test('there is deliberately NO default model', () => {
  // ~400 volatile vendor/model ids: a hardcoded default is trap #28, and it
  // would fail as an opaque upstream error about a model nobody chose.
  assert.equal(openAiDefaults.openrouter.model, '');
});

test('providerInfo does not borrow OpenAI\'s default model for OpenRouter', () => {
  bind({ provider: 'openrouter', apiKey: 'k', model: '' });
  assert.equal(providerInfo().model, '', 'an unconfigured OpenRouter must not report gpt-4o');
  bind({ provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude-opus-5' });
  assert.equal(providerInfo().model, 'anthropic/claude-opus-5');
});

test('the decoding statement is honest about routing to many backends', () => {
  assert.deepEqual(DECODING_SENT.openrouter, { temperature: true, seed: true });
  // Unmeasurable as one value — it differs per routed model.
  assert.equal(SEED_HONOURED.openrouter, null);
  assert.match(decodingReality('openrouter'), /has not been measured/);
});

/* ── credentials, refused loudly ──────────────────────────────────────────── */

test('a missing API key refuses, naming where the key comes from', async () => {
  bind({ provider: 'openrouter', apiKey: '', model: 'anthropic/claude-opus-5' });
  await assert.rejects(
    () => chatTurn({ system: 's', history: [], tools: [] }),
    (e) => {
      assert.match(e.message, /OpenRouter API key not set/);
      assert.match(e.message, /openrouter\.ai\/keys/);
      return true;
    },
  );
});

test('a missing MODEL refuses too, rather than guessing one', async () => {
  // The failure that would otherwise arrive as an opaque upstream 4xx about a
  // model the user never chose.
  bind({ provider: 'openrouter', apiKey: 'k', model: '' });
  await assert.rejects(
    () => chatTurn({ system: 's', history: [], tools: [] }),
    (e) => {
      assert.match(e.message, /No OpenRouter model is set/);
      assert.match(e.message, /vendor\/model/);
      assert.match(e.message, /api\/v1\/models/, 'the error must say where the list comes from');
      return true;
    },
  );
});

test('the other providers are unaffected by the new branch', async () => {
  bind({ provider: 'openai', apiKey: '', model: 'gpt-4o' });
  await assert.rejects(() => chatTurn({ system: 's', history: [], tools: [] }), /OpenAI API key not set/);

  // Ollama needs no key and no explicit model — it must not be caught by the
  // OpenRouter checks.
  bind({ provider: 'ollama', apiKey: '', model: '' });
  assert.equal(providerInfo().model, 'llama3.1');

  bind({ provider: 'nonsense', apiKey: 'k', model: 'm' });
  await assert.rejects(() => chatTurn({ system: 's', history: [], tools: [] }), /Unknown LLM provider/);
});

/* ── no special-casing above the provider layer ───────────────────────────── */

test('nothing outside the provider layer mentions OpenRouter', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const SERVER_SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');

  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const rel = path.relative(SERVER_SRC, p).replace(/\\/g, '/');
      // The provider layer may name it; so may the route that proxies its
      // public model list, which is a UI convenience rather than a code path.
      if (rel.startsWith('agent/providers/') || rel === 'agent/decoding.js' || rel === 'routes/agent.js') continue;
      if (/openrouter/i.test(fs.readFileSync(p, 'utf8'))) offenders.push(rel);
    }
  };
  walk(SERVER_SRC);
  assert.deepEqual(offenders, [],
    'switching to OpenRouter must need no code change outside the provider abstraction');
});
