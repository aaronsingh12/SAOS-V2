/**
 * Attachment storage — extracted text only, never the original bytes.
 *
 * Layout under server/data/attachments/ (gitignored with the rest of data/):
 *   <session>/<id>.json   one record per attached file, owned by a chat
 *   cache/<sha256>.json   the extraction of a given file's CONTENT
 *
 * The cache is what makes a re-attach instant: the same PDF attached to a
 * second chat (or twice to one) is hashed, found, and not parsed or OCR'd
 * again. The original file is not kept — the text is what the model reads,
 * and not holding copies of users' documents is the safer default.
 *
 * Records are filed per chat, so deleting a chat deletes its attachments, and
 * logging out of an instance removes every record filed under it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../data/attachments');

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
function assertSafe(v, what) {
  if (!SAFE_ID.test(String(v || ''))) {
    const e = new Error(`Invalid ${what}.`);
    e.status = 400;
    throw e;
  }
}

function sessionDir(session) {
  assertSafe(session, 'session id');
  return path.join(ROOT, session);
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function readCache(hash) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', `${hash}.json`), 'utf8')); } catch { return null; }
}

export function writeCache(hash, extraction) {
  const dir = path.join(ROOT, 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify(extraction));
}

export function saveAttachment(record) {
  const dir = sessionDir(record.session);
  assertSafe(record.id, 'attachment id');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
  return record;
}

export function getAttachment(session, id) {
  assertSafe(id, 'attachment id');
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir(session), `${id}.json`), 'utf8')); } catch { return null; }
}

/** Deleted means: it was there, and a re-read finds it gone. */
export function deleteAttachment(session, id) {
  assertSafe(id, 'attachment id');
  const file = path.join(sessionDir(session), `${id}.json`);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed && !fs.existsSync(file);
}

export function listAttachments(session) {
  try {
    return fs.readdirSync(sessionDir(session)).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(sessionDir(session), f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(a.created).localeCompare(String(b.created)));
  } catch { return []; }
}

export function removeSessionAttachments(session) {
  try { fs.rmSync(sessionDir(session), { recursive: true, force: true }); } catch { /* nothing filed */ }
}

/** Remove every record filed under an instance (logout). The content cache is instance-free and kept. */
export function purgeAttachmentsForInstance(instance) {
  let removed = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'cache'); } catch { return 0; }
  const key = String(instance || '').toLowerCase().replace(/\/+$/, '');
  for (const d of dirs) {
    const dir = path.join(ROOT, d.name);
    for (const f of fs.readdirSync(dir)) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (String(r.instance || '').toLowerCase().replace(/\/+$/, '') === key) { fs.rmSync(path.join(dir, f)); removed++; }
      } catch { /* unreadable record: leave it */ }
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty */ }
  }
  return removed;
}

/** What the client may see: everything except the text itself. */
export function publicView(r) {
  return {
    id: r.id, name: r.name, kind: r.kind, method: r.method, pages: r.pages,
    bytes: r.bytes, chars: r.chars, tokens: r.tokens, parts: r.chunks?.length ?? 0,
    ocr: r.ocr, warnings: r.warnings, outline: (r.outline || []).slice(0, 8),
    cached: Boolean(r.cached), ms: r.ms ?? null, created: r.created,
  };
}
