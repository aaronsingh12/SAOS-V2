#!/usr/bin/env node
/**
 * Populate the knowledge corpus from OFFICIAL ServiceNow documentation URLs.
 *
 *   node scripts/ingest-servicenow-docs.mjs <url> [url...]
 *   node scripts/ingest-servicenow-docs.mjs --file urls.txt
 *   node scripts/ingest-servicenow-docs.mjs --dry-run <url>
 *
 * WHAT IT DOES, in order:
 *
 *   1. refuses any URL `classifySourceUrl` does not recognise as official,
 *      BEFORE requesting it;
 *   2. renders each page in a headless Chrome it launches itself, because the
 *      documentation is a JavaScript application and a plain fetch returns a
 *      loading shell (measured: 12,623 bytes, no article text);
 *   3. reads the topic out of the Fluid Topics shadow roots — verbatim, no
 *      summarising, no completion, no model in the loop;
 *   4. writes one .json per page into the corpus directory;
 *   5. hands the directory to the EXISTING ingestCorpus(), which validates the
 *      seven required fields, chunks, embeds and stores.
 *
 * A page that does not render, or renders without its release or updated date,
 * is REFUSED and named. Nothing partial reaches the corpus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchDocs } from '../src/knowledge/fetch-docs.js';
import { ingestCorpus, corpusDir } from '../src/knowledge/ingest.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error(
    'no Chrome found. Set CHROME_PATH to a Chrome/Chromium binary — the documentation is a '
    + 'JavaScript application and cannot be read without rendering it.',
  );
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileIdx = args.indexOf('--file');
let urls = args.filter((a) => a.startsWith('http'));
if (fileIdx !== -1 && args[fileIdx + 1]) {
  urls = fs.readFileSync(args[fileIdx + 1], 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}
if (!urls.length) {
  console.error('usage: node scripts/ingest-servicenow-docs.mjs <official servicenow.com doc url> [...]');
  process.exit(2);
}

const port = 9333 + Math.floor(Math.random() * 400);
const profile = path.join(process.env.TEMP || '/tmp', `nha-docs-${port}`);
const chrome = spawn(findChrome(), [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-gl=angle', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore', detached: false });

const stop = () => { try { chrome.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

try {
  console.log(`rendering ${urls.length} page(s)…`);
  const { documents, refused } = await fetchDocs(urls, { port });

  for (const r of refused) console.error(`  REFUSED  ${r.url}\n           ${r.reason}`);
  if (!documents.length) { console.error('nothing was fetched; the corpus is unchanged.'); stop(); process.exit(1); }

  const dir = corpusDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const doc of documents) {
    const name = `${doc.url.split('/').pop().replace(/\.html?$/, '') || 'topic'}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(doc, null, 1));
    console.log(`  wrote    ${name}  "${doc.title}" (${doc.version}, updated ${doc.updated_at}, ${doc.text.length} chars)`);
  }

  console.log(`\ningesting ${dir}…`);
  const result = await ingestCorpus({ dir, embed: !dryRun, dryRun });
  console.log(JSON.stringify({
    ok: result.ok,
    files: result.files,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    admitted: result.admitted,
    rejected: result.rejected,
    embeddings: result.embeddings,
  }, null, 1));
  if (result.rejected?.length) {
    for (const r of result.rejected) console.error('  REJECTED', JSON.stringify(r));
  }
} finally {
  stop();
}
