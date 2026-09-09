/**
 * PDI CLEANUP — remove the disposable records the validation suites created.
 *
 *   node scripts/pdi-cleanup.mjs [--dry-run]
 *
 * WHY THIS EXISTS. §59 requires zero PDI leftovers after the regression sweep,
 * and the sweep runs eight suites. The Phase 13, 14 and 15 scripts delete what
 * they create in a `finally` block; the Phase 8, 9, 11 and 12 scripts predate
 * that discipline and leave their incidents behind — so every full regression
 * run adds four more, and the requirement drifts out of reach on its own.
 *
 * Retrofitting cleanup into four passing suites late in a phase risks
 * destabilising the very tests the sweep exists to trust, so the remedy is
 * external and narrow instead.
 *
 * WHAT IT WILL AND WILL NOT DELETE. Only `incident` rows whose
 * `short_description` begins with the marker every one of those scripts writes.
 * That prefix is not something a person types by accident, and the match is
 * anchored with STARTSWITH rather than LIKE so an incident merely MENTIONING
 * the word — a real ticket about this application, say — is never touched.
 *
 * It prints what it would remove before removing anything, and `--dry-run`
 * stops there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdiclean-')), 'c.db'))));

const { table } = await import('../src/servicenow/client.js');
const { getSettings } = await import('../src/config/store.js');

/** The one marker every NowForge validation script writes into the record. */
const MARKER = 'NOWFORGE';
const dryRun = process.argv.includes('--dry-run');

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`mode     : ${dryRun ? 'DRY RUN — nothing will be deleted' : 'delete'}`);
console.log();

const rows = await table.query('incident', {
  query: `short_descriptionSTARTSWITH${MARKER}`,
  fields: 'sys_id,number,short_description,sys_created_on',
  display: 'false',
  limit: 200,
});

/*
 * `process.exit()` tears the loop down while the HTTP agent still holds
 * handles, which on Windows trips a libuv assertion on the way out. Setting
 * `exitCode` and letting the process finish naturally is the same outcome
 * without the crash.
 */
if (!rows.length) {
  console.log('No leftover validation incidents. Nothing to do.');
} else {

  console.log(`Found ${rows.length} disposable validation incident(s):`);
  for (const r of rows) {
    console.log(`   ${r.number}  ${r.sys_id}  ${String(r.short_description).slice(0, 56)}`);
  }

  if (dryRun) {
    console.log();
    console.log('Dry run — nothing was deleted.');
  } else {
    console.log();
    let removed = 0;
    const failed = [];
    for (const r of rows) {
      try {
        await table.remove('incident', r.sys_id);
        removed += 1;
      } catch (err) {
        failed.push(`${r.number} ${r.sys_id} — ${err.message}`);
      }
    }

    console.log(`removed ${removed}, failed ${failed.length}`);
    for (const f of failed) console.log(`   ${f}`);

    const after = await table.query('incident', {
      query: `short_descriptionSTARTSWITH${MARKER}`, fields: 'sys_id', display: 'false', limit: 200,
    });
    console.log(`remaining: ${after.length}`);
    if (after.length) process.exitCode = 1;
  }
}
