/**
 * LOG OUT PURGES THE INSTANCE — and only that instance.
 *
 *   node --test server/test/instance-purge.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-purge-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { purgeInstanceData } = await import('../src/memory/instance-purge.js');

const GONE = { url: 'https://gone.service-now.com', key: 'gone.service-now.com' };
const KEPT = { url: 'https://kept.service-now.com', key: 'kept.service-now.com' };
const ts = new Date().toISOString();

function seed({ url, key }, tag) {
  const db = getDb();
  const sid = `s-${tag}`;
  db.prepare('INSERT INTO sessions (id, title, created, updated, instance) VALUES (?, ?, ?, ?, ?)').run(sid, tag, ts, ts, url);
  db.prepare('INSERT INTO messages (session, seq, role, json, ts) VALUES (?, 0, ?, ?, ?)').run(sid, 'user', '{}', ts);
  db.prepare("INSERT INTO chunks (kind, session, ref, instance, text, ts) VALUES ('message', ?, '0', ?, ?, ?)").run(sid, url, `text ${tag}`, ts);
  db.prepare('INSERT INTO tool_events (session, seq, kind, name, instance, ts) VALUES (?, 0, ?, ?, ?, ?)').run(sid, 'tool_call', 'get_record', url, ts);
  db.prepare('INSERT INTO mutation_ledger (session, turn_seq, ts, tool, instance, status) VALUES (?, 0, ?, ?, ?, ?)').run(sid, ts, 'update_record', url, 'applied');
  db.prepare('INSERT INTO sysid_provenance (session, sys_id, source, ts) VALUES (?, ?, ?, ?)').run(sid, 'a'.repeat(32), 'tool_result', ts);
  db.prepare("INSERT INTO agent_tasks (id, session_id, state, created_at, updated_at, instance) VALUES (?, ?, 'completed', ?, ?, ?)").run(`t-${tag}`, sid, ts, ts, url);
  db.prepare("INSERT INTO agent_task_steps (id, task_id, sequence, state, kind, created_at, updated_at) VALUES (?, ?, 1, 'completed', 'turn', ?, ?)").run(`st-${tag}`, `t-${tag}`, ts, ts);
  db.prepare("INSERT INTO build_runs (id, kind, instance, status, started) VALUES (?, 'health_check', ?, 'done', ?)").run(`b-${tag}`, url, ts);
  db.prepare("INSERT INTO build_events (run, seq, type, payload, ts) VALUES (?, 0, 'progress', '{}', ?)").run(`b-${tag}`, ts);
  db.prepare("INSERT INTO facts (instance, kind, key, value, ts) VALUES (?, 'k', ?, 'v', ?)").run(url, `f-${tag}`, ts);
  db.prepare("INSERT INTO health_runs (id, instance_key, instance_url, status, started_at) VALUES (?, ?, ?, 'completed', ?)").run(`r-${tag}`, key, url, ts);
  db.prepare("INSERT INTO health_findings (run_id, fingerprint, rule_id, agent_id, domain, source_table, severity, priority, priority_score, confidence, title) VALUES (?, ?, 'CMDB-001', 'cmdb', 'cmdb', 'cmdb_ci', 'high', 'P2', 50, 'high', 'x')").run(`r-${tag}`, `fp-${tag}`);
  db.prepare("INSERT INTO health_proposals (id, run_id, finding_fingerprint, rule_id, instance_key, status, draft_json, created_at) VALUES (?, ?, ?, 'CMDB-001', ?, 'draft', '{}', ?)").run(`p-${tag}`, `r-${tag}`, `fp-${tag}`, key, ts);
  db.prepare('INSERT INTO health_module_state (instance_key, module, updated_at) VALUES (?, ?, ?)').run(key, 'cmdb', ts);
  db.prepare('INSERT INTO health_table_scan_state (instance_key, table_name, updated_at) VALUES (?, ?, ?)').run(key, 'cmdb_ci', ts);
  db.prepare('INSERT INTO health_itsm_parameters (instance_key, rule_id, param_key, value_json, set_at) VALUES (?, ?, ?, ?, ?)').run(key, 'ITSM-001', 'days', '5', ts);
}

const count = (table, where = '1=1', ...p) => getDb().prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...p).n;

seed(GONE, 'gone');
seed(KEPT, 'kept');
getDb().prepare("INSERT INTO facts (instance, kind, key, value, ts) VALUES ('*', 'k', 'global', 'v', ?)").run(ts);
getDb().prepare("INSERT INTO kb_documents (id, source, product, topic, version, document_type, url, updated_at, title, ingested_at, content_hash) VALUES ('doc1', 'docs', 'platform', 't', 'v', 'guide', 'https://docs.servicenow.com/x', ?, 'ServiceNow docs', ?, 'h')").run(ts, ts);

const TABLES = ['sessions', 'messages', 'chunks', 'tool_events', 'mutation_ledger', 'sysid_provenance', 'agent_tasks',
  'agent_task_steps', 'build_runs', 'build_events', 'health_runs', 'health_findings', 'health_proposals',
  'health_module_state', 'health_table_scan_state', 'health_itsm_parameters'];

test('every row filed under the logged-out instance is deleted', () => {
  const r = purgeInstanceData(GONE);
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.total > 0);
  assert.equal(count('sessions', 'id = ?', 's-gone'), 0);
  assert.equal(count('messages', 'session = ?', 's-gone'), 0);
  assert.equal(count('chunks', 'session = ?', 's-gone'), 0);
  assert.equal(count('tool_events', 'instance = ?', GONE.url), 0);
  assert.equal(count('mutation_ledger', 'instance = ?', GONE.url), 0);
  assert.equal(count('sysid_provenance', 'session = ?', 's-gone'), 0);
  assert.equal(count('agent_tasks', 'instance = ?', GONE.url), 0);
  assert.equal(count('agent_task_steps', 'task_id = ?', 't-gone'), 0);
  assert.equal(count('build_runs', 'instance = ?', GONE.url), 0);
  assert.equal(count('build_events', 'run = ?', 'b-gone'), 0);
  assert.equal(count('facts', 'instance = ?', GONE.url), 0);
  for (const t of ['health_runs', 'health_proposals', 'health_module_state', 'health_table_scan_state', 'health_itsm_parameters']) {
    assert.equal(count(t, 'instance_key = ?', GONE.key), 0, t);
  }
  assert.equal(count('health_findings', 'run_id = ?', 'r-gone'), 0);
});

test('another instance keeps every row, and platform documentation is not instance data', () => {
  for (const t of TABLES) assert.ok(count(t) >= 1, `${t} lost the other instance's rows`);
  assert.equal(count('sessions', 'id = ?', 's-kept'), 1);
  assert.equal(count('health_findings', 'run_id = ?', 'r-kept'), 1);
  assert.equal(count('mutation_ledger', 'instance = ?', KEPT.url), 1);
  assert.equal(count('facts', "instance = '*'"), 1);
  assert.equal(count('kb_documents'), 1);
});

test('the URL is matched however it was saved — case and scheme do not hide rows', () => {
  const odd = { url: 'HTTP://Odd.Service-Now.com/', key: 'odd.service-now.com' };
  seed({ url: 'HTTP://Odd.Service-Now.com/', key: odd.key }, 'odd');
  const r = purgeInstanceData(odd);
  assert.equal(r.ok, true);
  assert.equal(count('sessions', 'id = ?', 's-odd'), 0);
  assert.equal(count('mutation_ledger', "instance = 'HTTP://Odd.Service-Now.com/'"), 0);
});

test('no instance means no purge, not a purge of everything', () => {
  const before = count('sessions');
  const r = purgeInstanceData({});
  assert.equal(r.ok, false);
  assert.equal(count('sessions'), before);
});
