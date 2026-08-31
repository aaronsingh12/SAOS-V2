import path from 'node:path';
import fsp from 'node:fs/promises';
import { WORKSPACE_DIRS } from './fluent.js';

/**
 * Editing the Fluent source that DEFINES an in-scope table.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A REST INSERT ─────────────────────────
 *
 * A custom in-scope table is SDK-managed: its real definition is the Fluent
 * source in this application, and the rows in `sys_dictionary` are that
 * definition's *output*. Adding a column by inserting into `sys_dictionary`
 * over REST would put it on the live instance while the source still did not
 * declare it — and the next `now-sdk install` would silently remove it again.
 *
 * That is the exact mirror of the E2 finding, where a column was DROPPED on the
 * instance while the source still declared it and the next install would have
 * silently re-created it. The rule holds in both directions:
 *
 *   a schema change to SDK-managed source is not finished until the source and
 *   the instance agree.
 *
 * So the column is added to the source and the application is reinstalled — the
 * same pipeline `createTable` already uses.
 *
 * ── WHY TEXT EDITING, AND WHERE IT REFUSES ───────────────────────────────────
 *
 * These files are generated deterministically by `generateTableSource`, so
 * their shape is known rather than guessed at. This module still refuses rather
 * than improvises whenever the shape is not the one it expects: a source file
 * it does not fully understand is one it must not rewrite, because a corrupted
 * source is worse than an unsupported request. Every failure below names what
 * it looked for.
 */

/** Where managed Fluent sources live. `dba/` is this module's own; `flows/` and `catalog/` are siblings' */
function sourceDirs() {
  const root = path.join(WORKSPACE_DIRS.workspace, 'src', 'fluent');
  return [path.join(root, 'dba'), path.join(root, 'flows'), path.join(root, 'catalog'), root];
}

async function listSources() {
  const out = [];
  const seen = new Set();
  for (const dir of sourceDirs()) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.now.ts')) continue;
      const file = path.join(dir, e.name);
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}

/**
 * Find the source file that DEFINES a table (not one that augments it).
 *
 * `augments:` is deliberately not a match: an augment attaches columns owned by
 * this app to somebody else's table, and editing it would be answering a
 * different question from the one asked.
 */
export async function findTableSource(tableName) {
  const files = await listSources();
  const defines = [];
  const augments = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const text = await fsp.readFile(file, 'utf8');
    if (new RegExp(`\\bname:\\s*["']${tableName}["']`).test(text)) defines.push({ file, text });
    else if (new RegExp(`\\baugments:\\s*["']${tableName}["']`).test(text)) augments.push({ file, text });
  }
  if (defines.length > 1) {
    throw Object.assign(new Error(
      `${defines.length} source files define the table "${tableName}" (${defines.map((d) => path.basename(d.file)).join(', ')}). `
      + 'Refusing to guess which one is authoritative.'
    ), { status: 409 });
  }
  return {
    definedIn: defines[0] ?? null,
    augmentedIn: augments,
    scanned: files.length,
  };
}

/* ── the schema block ─────────────────────────────────────────────────────── */

/**
 * Locate the `schema: { … }` object literal and return its inner span.
 *
 * Brace matching rather than a regex, because the block legitimately nests —
 * a choice column carries its own `choices: { … }`. String literals are skipped
 * so a brace inside a label cannot throw the count off.
 */
export function findSchemaSpan(text) {
  const key = /\bschema:\s*\{/.exec(text);
  if (!key) return null;
  const open = key.index + key[0].length - 1;   // index of the '{'
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { open, close: i, inner: text.slice(open + 1, i) };
    }
  }
  return null;
}

/** The column names a schema block already declares, at its top level only. */
export function columnsInSchema(text) {
  const span = findSchemaSpan(text);
  if (!span) return [];
  const names = [];
  let depth = 0;
  let quote = null;
  let lineStart = true;
  let token = '';
  for (let i = 0; i < span.inner.length; i++) {
    const c = span.inner[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{' || c === '(') { depth += 1; token = ''; continue; }
    if (c === '}' || c === ')') { depth -= 1; token = ''; continue; }
    if (depth !== 0) continue;
    if (c === ':' && token.trim()) { names.push(token.trim()); token = ''; lineStart = false; continue; }
    if (c === ',' || c === '\n') { token = ''; lineStart = true; continue; }
    if (lineStart || token) token += c;
  }
  return names.filter((n) => /^[a-z][a-z0-9_]*$/i.test(n));
}

/**
 * Insert a column into a table's schema block.
 *
 * Pure: takes source text, returns source text. Throws with the reason when the
 * file is not the shape it expects — the alternative is silently producing a
 * source file that no longer compiles, discovered at build time with a
 * diagnostic pointing at generated code nobody wrote.
 */
export function insertColumn(text, { column, emitted, importName }) {
  const span = findSchemaSpan(text);
  if (!span) {
    throw Object.assign(new Error(
      'This source has no `schema: { … }` block that could be edited. It may be hand-written, or generated by a '
      + 'version of the authoring layer this one does not recognise — refusing to rewrite a file it does not '
      + 'fully understand.'
    ), { status: 422 });
  }
  if (columnsInSchema(text).includes(column)) {
    throw Object.assign(new Error(`The source already declares a column named "${column}".`), { status: 409 });
  }

  // Match the indentation of the existing entries so the file stays readable.
  const indentMatch = /\n(\s+)\S/.exec(span.inner);
  const indent = indentMatch ? indentMatch[1] : '        ';

  const before = text.slice(0, span.close);
  const after = text.slice(span.close);
  // The block's last entry already ends with a comma (generated that way), so
  // appending a whole line is safe. Trailing whitespace before `}` is trimmed
  // to a single newline so repeated edits do not accumulate blank lines.
  const body = before.replace(/\s*$/, '\n');
  const withColumn = `${body}${indent}${column}: ${emitted},\n${' '.repeat(Math.max(indent.length - 4, 0))}`;

  return ensureImport(withColumn + after, importName);
}

/** Remove a column from a table's schema block — used to reconcile after a drop. */
export function removeColumn(text, column) {
  const span = findSchemaSpan(text);
  if (!span) throw Object.assign(new Error('This source has no `schema: { … }` block that could be edited.'), { status: 422 });
  if (!columnsInSchema(text).includes(column)) {
    return { text, changed: false, reason: `The source does not declare a column named "${column}".` };
  }

  // Find the entry's span: from the line it starts on to the matching end of
  // its value, which may itself be a multi-line object (a choice column).
  const inner = span.inner;
  const start = new RegExp(`^[ \\t]*${column}\\s*:`, 'm').exec(inner);
  if (!start) return { text, changed: false, reason: `Could not locate "${column}" in the schema block.` };

  let i = start.index + start[0].length;
  let depth = 0;
  let quote = null;
  for (; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{' || c === '(') depth += 1;
    else if (c === '}' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { i += 1; break; }
  }
  // Swallow the rest of the line (the newline after the comma).
  while (i < inner.length && inner[i] !== '\n') i += 1;
  const nextInner = inner.slice(0, start.index) + inner.slice(i + 1);
  const nextText = text.slice(0, span.open + 1) + nextInner + text.slice(span.close);
  return { text: nextText, changed: true };
}

/**
 * Add a factory to the `@servicenow/sdk/core` import when it is not already there.
 *
 * A column whose factory is not imported compiles to a reference error, which
 * the offline build catches — but catching it here means the caller never sees
 * a build diagnostic for something this module could have got right.
 */
export function ensureImport(text, importName) {
  if (!importName) return text;
  const re = /import\s*\{([^}]*)\}\s*from\s*'@servicenow\/sdk\/core'/;
  const m = re.exec(text);
  if (!m) {
    throw Object.assign(new Error(
      "This source has no `import { … } from '@servicenow/sdk/core'` line to extend, so the column's factory "
      + 'could not be imported.'
    ), { status: 422 });
  }
  const names = m[1].split(',').map((n) => n.trim()).filter(Boolean);
  if (names.includes(importName)) return text;
  const next = [...names, importName].sort((a, b) => (a === 'Table' ? -1 : b === 'Table' ? 1 : a.localeCompare(b)));
  return text.replace(re, `import { ${next.join(', ')} } from '@servicenow/sdk/core'`);
}

export { listSources };
