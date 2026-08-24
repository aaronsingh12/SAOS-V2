import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  connection: {
    instanceUrl: '',      // e.g. https://dev12345.service-now.com
    authType: 'basic',    // 'basic' | 'oauth'
    username: '',
    password: '',
    clientId: '',
    clientSecret: '',
  },
  llm: {
    provider: 'anthropic',            // 'anthropic' | 'openai' | 'ollama'
    apiKey: '',
    baseUrl: '',                      // optional override; ollama default http://localhost:11434/v1
    model: '',                        // blank = provider default
    // Local embedding model for semantic recall (A-5), reached through the same
    // baseUrl. Blank = nomic-embed-text. If it is not pulled, recall degrades to
    // keyword search and says so — it never pretends to be semantic.
    embedModel: '',
  },
  agent: {
    autoApprove: false,               // when false, every mutating tool call requires user approval
    // WI-8. When a completion contains BOTH a question for the user and
    // mutation-flagged tool calls, hold the calls and surface the question.
    // Default on: the model asking and acting in the same breath means the
    // user is answering a question that was already decided for them.
    holdMutationsOnQuestion: true,
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      connection: { ...DEFAULTS.connection, ...(parsed.connection || {}) },
      llm: { ...DEFAULTS.llm, ...(parsed.llm || {}) },
      agent: { ...DEFAULTS.agent, ...(parsed.agent || {}) },
    };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

export function getSettings() {
  return load();
}

/**
 * Test seam, mirroring `_setDbForTests` in memory/db.js.
 *
 * The offline suite has to pin `agent.autoApprove` and `agent.holdMutations-
 * OnQuestion` to assert what the gate does, and pin `llm.model` to '' so the
 * context-window probe returns its fallback instead of reaching for a daemon.
 * Reading the developer's real `settings.json` would make those tests pass or
 * fail on whatever that file happens to hold, and writing to it to fix that
 * would be worse.
 *
 * Merged over the defaults, never over what is on disk, so a test states its
 * whole world rather than inheriting half of one.
 */
export function _setSettingsForTests(patch) {
  if (!patch) { cache = null; return null; }
  cache = {
    connection: { ...DEFAULTS.connection, ...(patch.connection || {}) },
    llm: { ...DEFAULTS.llm, ...(patch.llm || {}) },
    agent: { ...DEFAULTS.agent, ...(patch.agent || {}) },
  };
  return cache;
}

/**
 * Credentials arrive by paste, and pastes bring passengers. A stored password
 * once carried four embedded spaces — a password plus trailing text copied from
 * the same line — which produced nothing but "User is not authenticated" with
 * no clue why. Trim the obvious damage, and report what we cannot safely fix.
 */
const TRIMMED_FIELDS = ['instanceUrl', 'username', 'password', 'clientId', 'clientSecret'];

function sanitizeConnection(conn) {
  const out = { ...conn };
  for (const f of TRIMMED_FIELDS) {
    if (typeof out[f] === 'string') out[f] = out[f].trim();
  }
  if (typeof out.instanceUrl === 'string') out.instanceUrl = out.instanceUrl.replace(/\/+$/, '');
  return out;
}

/** Non-fatal problems worth showing the user rather than silently storing. */
export function credentialWarnings(conn) {
  const warnings = [];
  const check = (label, value) => {
    if (typeof value !== 'string' || !value) return;
    if (/\s/.test(value)) {
      warnings.push(`${label} contains a space. Passwords rarely do — check you didn't paste extra text along with it.`);
    } else if (/[^\x21-\x7e]/.test(value)) {
      warnings.push(`${label} contains a non-standard character (a smart quote or non-breaking space often sneaks in when copying from a web page).`);
    }
  };
  check('The password', conn.password);
  check('The client secret', conn.clientSecret);
  if (conn.username && /\s/.test(conn.username)) warnings.push('The username contains a space.');
  if (conn.instanceUrl && !/^https?:\/\//i.test(conn.instanceUrl)) {
    warnings.push('The instance URL should start with https://');
  }
  return warnings;
}

export function saveSettings(patch) {
  const cur = load();
  const next = {
    connection: sanitizeConnection({ ...cur.connection, ...(patch.connection || {}) }),
    llm: { ...cur.llm, ...(patch.llm || {}) },
    agent: { ...cur.agent, ...(patch.agent || {}) },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** Clears the bound instance and its secrets. The LLM settings are unrelated and stay. */
export function clearConnection() {
  const cur = load();
  const next = { ...cur, connection: { ...DEFAULTS.connection } };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** Redacts secrets for sending to the client. */
export function publicSettings() {
  const s = load();
  return {
    connection: {
      instanceUrl: s.connection.instanceUrl,
      authType: s.connection.authType,
      username: s.connection.username,
      hasPassword: Boolean(s.connection.password),
      clientId: s.connection.clientId,
      hasClientSecret: Boolean(s.connection.clientSecret),
      // Surfaced so an already-saved bad credential is visible without a probe.
      warnings: credentialWarnings(s.connection),
    },
    llm: {
      provider: s.llm.provider,
      hasApiKey: Boolean(s.llm.apiKey),
      baseUrl: s.llm.baseUrl,
      model: s.llm.model,
      embedModel: s.llm.embedModel,
    },
    agent: { autoApprove: s.agent.autoApprove, holdMutationsOnQuestion: s.agent.holdMutationsOnQuestion !== false },
  };
}
