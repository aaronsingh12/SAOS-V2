/**
 * Turn an uploaded file into text the model can read — faithfully, and with as
 * little waste as possible.
 *
 * Returns { kind, method, pages, sections:[{ text, page }], warnings[], ocr }.
 * `sections` keeps page numbers where the source has pages, so a passage the
 * model quotes can be traced back ("p. 12").
 *
 * The rule for every format: keep STRUCTURE, drop decoration. Headings stay
 * headings, list items stay list items, table cells stay in their row and
 * column (joined with " | ", the cheapest separator that a model reads as a
 * table), and everything purely visual — fonts, colours, spacing runs — goes.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { ocrImage, prepareImage } from './ocr.js';
import { normalizeText, stripPageFurniture } from './text.js';

const require = createRequire(import.meta.url);

export const LIMITS = {
  MAX_BYTES: 25 * 1024 * 1024,
  MAX_OCR_PAGES: 40,        // scanned pages OCR'd per PDF
  MAX_DOC_IMAGES: 12,       // images OCR'd inside one Word document
  MAX_SHEET_ROWS: 3000,     // rows read per spreadsheet sheet
  MAX_TEXT_CHARS: 2_000_000 // hard ceiling on stored text per file
};

const EXT = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx',
  pptx: 'pptx',
  csv: 'csv', tsv: 'csv',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', gif: 'image', tif: 'image', tiff: 'image',
  html: 'html', htm: 'html',
  json: 'json',
};
const TEXT_EXT = new Set(('txt md markdown log xml yaml yml ini cfg conf toml sql js mjs cjs ts tsx jsx py java cs go rb php '
  + 'sh ps1 bat css scss env properties gradle kt swift c h cpp hpp rs lua r').split(' '));

export function detectKind(name, buffer) {
  const ext = path.extname(name || '').slice(1).toLowerCase();
  // Magic bytes win over a misleading extension.
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (EXT[ext]) return EXT[ext];
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === 'doc' || ext === 'xls' || ext === 'ppt') return `legacy-${ext}`;
  // Unknown extension: text if it decodes cleanly, otherwise unsupported.
  const sample = buffer.subarray(0, 4096).toString('utf8');
  return /�|\u0000/.test(sample) ? 'unsupported' : 'text';
}

/* ── PDF ─────────────────────────────────────────────────────────────────── */

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
      return m;
    });
  }
  return pdfjsPromise;
}

/**
 * Rebuild reading order from positioned text runs: group runs into lines by
 * baseline, order each line left to right, and mark a wide horizontal gap as a
 * column break (" | ") so tables survive; a tall vertical gap is a paragraph.
 */
function linesFromItems(items) {
  const runs = items.filter((it) => typeof it.str === 'string' && it.str.length)
    .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || Math.abs(it.height) || 10 }));
  if (!runs.length) return '';
  runs.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) <= Math.max(2, r.h * 0.45)) last.runs.push(r);
    else lines.push({ y: r.y, h: r.h, runs: [r] });
  }
  let out = '';
  let prev = null;
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const r of line.runs) {
      if (end !== null) {
        const gap = r.x - end;
        const charW = (r.w / Math.max(1, r.s.length)) || r.h * 0.5;
        if (gap > charW * 3.5) text += ' | ';
        else if (gap > r.h * 0.12 && !text.endsWith(' ') && !r.s.startsWith(' ')) text += ' ';
      }
      text += r.s;
      end = r.x + r.w;
    }
    if (prev) out += (prev.y - line.y > Math.max(prev.h, line.h) * 1.7) ? '\n\n' : '\n';
    out += text.trim();
    prev = line;
  }
  return out;
}

async function extractPdf(buffer, warnings) {
  const lib = await pdfjs();
  const loading = lib.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true,
    isEvalSupported: false, verbosity: 0,
  });
  const doc = await loading.promise;
  const pages = [];
  const scanned = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const text = linesFromItems(tc.items);
    pages.push(text);
    // A page with (almost) no text layer is an image of text: a scan.
    if (text.replace(/\s/g, '').length < 25) scanned.push(n);
    page.cleanup();
  }
  const ocr = { pages: 0, confidence: null };
  if (scanned.length) {
    const todo = scanned.slice(0, LIMITS.MAX_OCR_PAGES);
    if (scanned.length > todo.length) warnings.push(`${scanned.length} pages are scanned images; the first ${todo.length} were OCR'd.`);
    const confs = [];
    await Promise.all(todo.map(async (n) => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // ~2000px on the short side is roughly 250–300 DPI for a normal page.
      const scale = Math.min(3.5, Math.max(1.5, 2000 / Math.min(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const png = await canvas.encode('png');
      page.cleanup();
      const r = await ocrImage(png, { prepared: true });
      pages[n - 1] = r.text;
      confs.push(r.confidence);
    }));
    ocr.pages = todo.length;
    ocr.confidence = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
  }
  await loading.destroy();
  const cleaned = stripPageFurniture(pages);
  return {
    method: scanned.length ? (scanned.length === pages.length ? 'ocr' : 'text+ocr') : 'text',
    pages: pages.length,
    sections: cleaned.map((text, i) => ({ text, page: i + 1 })),
    ocr,
  };
}

/* ── HTML (also the path for Word) ───────────────────────────────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  let s = String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n');
  // Tables: one line per row, cells joined by " | ".
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (t) => '\n\n' + t
    .replace(/<\/t[dh]>\s*/gi, '\u0001')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((row) => row.split('\u0001').map((c) => c.replace(/\s+/g, ' ').trim()).filter((c, i, a) => c || i < a.length - 1).join(' | '))
    .filter((r) => r.replace(/[|\s]/g, ''))
    .join('\n') + '\n\n');
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Math.min(4, Number(n)))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|ul|ol|blockquote|pre)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return normalizeText(decodeEntities(s));
}

async function extractDocx(buffer, warnings) {
  const mammoth = (await import('mammoth')).default;
  const images = [];
  const { value: html } = await mammoth.convertToHtml({ buffer }, {
    // Embedded images are collected and OCR'd; the HTML keeps a marker where
    // each one sat so its text lands in the right place.
    convertImage: mammoth.images.imgElement(async (image) => {
      const idx = images.length;
      images.push(image.read());
      return { src: `nha-img-${idx}` };
    }),
  });
  let text = htmlToText(html.replace(/<img[^>]*src="nha-img-(\d+)"[^>]*>/g, (_, i) => `\n[[IMAGE ${i}]]\n`));
  const ocr = { pages: 0, confidence: null };
  if (images.length) {
    const todo = images.slice(0, LIMITS.MAX_DOC_IMAGES);
    if (images.length > todo.length) warnings.push(`${images.length} embedded images; the first ${todo.length} were OCR'd.`);
    const confs = [];
    const results = await Promise.all(todo.map(async (p) => {
      try {
        const r = await ocrImage(await p);
        confs.push(r.confidence);
        return normalizeText(r.text);
      } catch { return ''; }
    }));
    text = text.replace(/\[\[IMAGE (\d+)\]\]/g, (_, i) => {
      const t = results[Number(i)];
      return t && t.replace(/\s/g, '').length > 3 ? `[Image text]\n${t}\n[/Image text]` : '';
    });
    ocr.pages = todo.length;
    ocr.confidence = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
  }
  return { method: images.length ? 'text+ocr' : 'text', pages: null, sections: [{ text, page: null }], ocr };
}

/* ── Spreadsheets ────────────────────────────────────────────────────────── */

/**
 * A cell as the sheet means it. Dates are the trap: ExcelJS hands back a JS
 * Date whose default string is ~60 characters of weekday, zone and offset, and
 * rendered in the SERVER's timezone — so 5 Jan could read as 4 Jan. Excel
 * stores the calendar value in UTC, so it is printed from UTC: a date is
 * YYYY-MM-DD, a date-time adds HH:MM.
 */
function cellText(cell) {
  const v = cell.value;
  const d = v instanceof Date ? v : (v && v.result instanceof Date ? v.result : null);
  if (d && !Number.isNaN(d.getTime())) {
    const iso = d.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return String(cell.text ?? '').replace(/\s+/g, ' ').trim();
}

async function extractXlsx(buffer, warnings) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sections = [];
  wb.eachSheet((ws) => {
    const rows = [];
    let count = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      count++;
      if (rows.length >= LIMITS.MAX_SHEET_ROWS) return;
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell); });
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.some(Boolean)) rows.push(cells.map((c) => c ?? '').join(' | '));
    });
    if (count > LIMITS.MAX_SHEET_ROWS) warnings.push(`Sheet "${ws.name}": ${count} rows, the first ${LIMITS.MAX_SHEET_ROWS} were read.`);
    sections.push({ text: `## Sheet: ${ws.name} (${count} rows × ${ws.actualColumnCount} columns)\n${rows.join('\n')}`, page: null });
  });
  return { method: 'text', pages: null, sections, ocr: null };
}

/* ── Slides ──────────────────────────────────────────────────────────────── */

async function extractPptx(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  const sections = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f).async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => decodeEntities((p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join(''))).filter((t) => t.trim());
    sections.push({ text: `## Slide ${i + 1}\n${paras.join('\n')}`, page: i + 1 });
  }
  return { method: 'text', pages: slides.length, sections, ocr: null };
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

export async function extractFile(name, buffer) {
  const warnings = [];
  const kind = detectKind(name, buffer);
  let r;
  switch (kind) {
    case 'pdf': r = await extractPdf(buffer, warnings); break;
    case 'docx': r = await extractDocx(buffer, warnings); break;
    case 'xlsx': r = await extractXlsx(buffer, warnings); break;
    case 'pptx': r = await extractPptx(buffer); break;
    case 'image': {
      let o;
      try { o = await ocrImage(buffer); } catch { o = await ocrImage(buffer, { prepared: true }); } // e.g. TIFF: let Tesseract decode it
      r = { method: 'ocr', pages: 1, sections: [{ text: o.text, page: null }], ocr: { pages: 1, confidence: o.confidence } };
      break;
    }
    case 'html': r = { method: 'text', pages: null, sections: [{ text: htmlToText(buffer.toString('utf8')), page: null }], ocr: null }; break;
    case 'json': {
      let text = buffer.toString('utf8').replace(/^﻿/, '');
      // Pretty-printed JSON spends a large share of its tokens on indentation.
      try { text = JSON.stringify(JSON.parse(text)); } catch { warnings.push('Not valid JSON; read as text.'); }
      r = { method: 'text', pages: null, sections: [{ text, page: null }], ocr: null };
      break;
    }
    case 'csv':
    case 'text':
      r = { method: 'text', pages: null, sections: [{ text: buffer.toString('utf8').replace(/^﻿/, ''), page: null }], ocr: null };
      break;
    case 'legacy-doc': case 'legacy-xls': case 'legacy-ppt': {
      const e = new Error(`.${kind.slice(7)} is the pre-2007 binary format. Save it as .${kind.slice(7)}x (or PDF) and attach that.`);
      e.status = 415; throw e;
    }
    default: {
      const e = new Error('This file type cannot be read. Supported: PDF, Word (.docx), Excel (.xlsx), CSV, PowerPoint (.pptx), images (PNG, JPG, WebP, BMP, GIF, TIFF), and text/code files.');
      e.status = 415; throw e;
    }
  }
  const sections = r.sections.map((s) => ({ ...s, text: kind === 'json' ? s.text.trim() : normalizeText(s.text) }));
  let total = sections.reduce((n, s) => n + s.text.length, 0);
  if (total > LIMITS.MAX_TEXT_CHARS) {
    warnings.push(`Text truncated at ${LIMITS.MAX_TEXT_CHARS.toLocaleString()} characters.`);
    let left = LIMITS.MAX_TEXT_CHARS;
    for (const s of sections) { s.text = s.text.slice(0, Math.max(0, left)); left -= s.text.length; }
    total = LIMITS.MAX_TEXT_CHARS;
  }
  if (!total) warnings.push(r.method.includes('ocr') ? 'No readable text was found in the image.' : 'The file contains no extractable text.');
  if (r.ocr?.confidence != null && r.ocr.confidence < 60) warnings.push(`OCR confidence is low (${r.ocr.confidence}%); check key values against the original.`);
  return { kind, method: r.method, pages: r.pages, sections, warnings, ocr: r.ocr };
}

export { prepareImage };
