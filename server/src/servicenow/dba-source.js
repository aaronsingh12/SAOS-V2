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

/**
 * Locate one column entry inside the schema block.
 *
 * Returns indices INTO `span.inner`: where the `name:` starts, where its value
 * starts, and where the entry ends (just past its trailing comma). Shared by
 * `removeColumn` and `modifyColumn` so the two verbs cannot disagree about what
 * an entry is — the same reasoning that put routing in one classifier.
 */
function columnEntrySpan(inner, column) {
  const start = new RegExp(`^[ \\t]*${column}\\s*:`, 'm').exec(inner);
  if (!start) return null;
  const valueStart = start.index + start[0].length;

  let i = valueStart;
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
    else if (c === ',' && depth === 0) break;
  }
  return { keyStart: start.index, valueStart, valueEnd: i, commaEnd: Math.min(i + 1, inner.length) };
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
  const entry = columnEntrySpan(inner, column);
  if (!entry) return { text, changed: false, reason: `Could not locate "${column}" in the schema block.` };

  // Swallow the rest of the line (the newline after the comma).
  let i = entry.commaEnd;
  while (i < inner.length && inner[i] !== '\n') i += 1;
  const nextInner = inner.slice(0, entry.keyStart) + inner.slice(i + 1);
  const nextText = text.slice(0, span.open + 1) + nextInner + text.slice(span.close);
  return { text: nextText, changed: true };
}

/* ── modifying a column that is already declared ──────────────────────────── */

/**
 * The options object inside a column factory call: `StringColumn({ … })`.
 *
 * Returned as indices into `valueText` so the caller can splice rather than
 * re-emit. Re-emitting from the dictionary was the obvious alternative and is
 * wrong: `sys_dictionary` does not carry a choice map or a `dropdown` setting
 * in the shape the emitter takes, so a regenerate would quietly drop whatever
 * the source declared and this function could not see.
 */
function optionsSpan(valueText) {
  const open = valueText.indexOf('({');
  if (open === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = open + 1; i < valueText.length; i++) {
    const c = valueText[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { open: open + 1, close: i, inner: valueText.slice(open + 2, i) };
    }
  }
  return null;
}

/**
 * The span of one TOP-LEVEL `key: value` pair inside an options object, or null.
 *
 * Top-level matters: a choice column carries `choices: { new: { label: … } }`,
 * and a naive search for `label:` would find the choice's label and rewrite the
 * wrong thing. So this walks the object tracking depth and quotes, exactly as
 * `columnsInSchema` walks the schema block, and only considers a key it meets
 * at depth 0.
 */
function optionSpan(inner, key) {
  let depth = 0;
  let quote = null;
  let token = '';
  let tokenStart = -1;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; token = ''; tokenStart = -1; continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; token = ''; tokenStart = -1; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; token = ''; tokenStart = -1; continue; }
    if (depth !== 0) continue;

    if (c === ':') {
      if (token.trim() === key) {
        const valueStart = i + 1;
        let j = valueStart;
        let d2 = 0;
        let q2 = null;
        for (; j < inner.length; j++) {
          const ch = inner[j];
          if (q2) {
            if (ch === '\\') { j += 1; continue; }
            if (ch === q2) q2 = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { q2 = ch; continue; }
          if (ch === '{' || ch === '(' || ch === '[') d2 += 1;
          else if (ch === '}' || ch === ')' || ch === ']') d2 -= 1;
          else if (ch === ',' && d2 === 0) break;
        }
        return { keyStart: tokenStart, valueStart, valueEnd: j };
      }
      token = ''; tokenStart = -1; continue;
    }
    if (c === ',') { token = ''; tokenStart = -1; continue; }
    if (/\s/.test(c)) { if (!token) { tokenStart = -1; } continue; }
    if (tokenStart === -1) tokenStart = i;
    token += c;
  }
  return null;
}

/**
 * Set options on a column that the schema block already declares.
 *
 * `set` maps an option name to an ALREADY-EMITTED JS literal (`'"Age"'`, `'80'`)
 * — the caller owns the emitting, exactly as `insertColumn` takes `emitted`, so
 * the two paths cannot format a value differently.
 *
 * An option that is already present has its value replaced in place; one that is
 * absent is appended. Everything else in the call — a choice map, a
 * `referenceTable`, a `dropdown` — is left byte-for-byte alone, because this
 * function edits what it was asked to and nothing else.
 */
export function modifyColumn(text, { column, set = {} }) {
  const span = findSchemaSpan(text);
  if (!span) {
    throw Object.assign(new Error(
      'This source has no `schema: { … }` block that could be edited. It may be hand-written, or generated by a '
      + 'version of the authoring layer this one does not recognise — refusing to rewrite a file it does not '
      + 'fully understand.'
    ), { status: 422 });
  }
  if (!columnsInSchema(text).includes(column)) {
    return { text, changed: false, reason: `The source does not declare a column named "${column}".` };
  }
  const entries = Object.entries(set).filter(([, v]) => v !== undefined);
  if (!entries.length) return { text, changed: false, reason: 'No options were requested.' };

  const inner = span.inner;
  const entry = columnEntrySpan(inner, column);
  if (!entry) return { text, changed: false, reason: `Could not locate "${column}" in the schema block.` };

  let valueText = inner.slice(entry.valueStart, entry.valueEnd);
  const before = valueText.trim();
  const opts = optionsSpan(valueText);
  if (!opts) {
    throw Object.assign(new Error(
      `The declaration of "${column}" is not a \`Factory({ … })\` call this module can edit — refusing to rewrite `
      + 'a shape it does not fully understand.'
    ), { status: 422 });
  }

  let optsInner = opts.inner;
  const applied = [];
  for (const [key, literal] of entries) {
    const found = optionSpan(optsInner, key);
    if (found) {
      // Keep the value's own trailing whitespace, so `{ maxLength: 40 }` stays
      // `{ maxLength: 120 }` rather than collapsing to `{ maxLength: 120}`.
      const trail = /\s*$/.exec(optsInner.slice(found.valueStart, found.valueEnd))[0];
      optsInner = optsInner.slice(0, found.valueStart) + ` ${literal}${trail}` + optsInner.slice(found.valueEnd);
      applied.push({ option: key, action: 'replaced' });
    } else {
      // Append after the last existing option, matching the call's own style:
      // a trailing comma means the entries are one-per-line.
      const trimmed = optsInner.replace(/\s*$/, '');
      const multiline = /\n/.test(optsInner);
      const indentMatch = /\n([ \t]+)\S/.exec(optsInner);
      const indent = indentMatch ? indentMatch[1] : ' ';
      optsInner = trimmed.endsWith(',')
        ? `${trimmed}${multiline ? `\n${indent}` : ' '}${key}: ${literal},${multiline ? optsInner.slice(trimmed.length) : ' '}`
        : `${trimmed},${multiline ? `\n${indent}` : ' '}${key}: ${literal}${multiline ? `,${optsInner.slice(trimmed.length)}` : ' '}`;
      applied.push({ option: key, action: 'added' });
    }
  }

  valueText = valueText.slice(0, opts.open + 1) + optsInner + valueText.slice(opts.close);
  const nextInner = inner.slice(0, entry.valueStart) + valueText + inner.slice(entry.valueEnd);
  const nextText = text.slice(0, span.open + 1) + nextInner + text.slice(span.close);
  return { text: nextText, changed: true, applied, before, after: valueText.trim() };
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
