/**
 * OCR — local, warm, and bounded.
 *
 * tesseract.js (WASM) with the English LSTM model shipped as an npm package
 * (@tesseract.js-data/eng, the "best_int" model: the accurate network,
 * integer-quantised so it runs fast on CPU). Nothing is downloaded at run time
 * and no image leaves the machine.
 *
 * SPEED comes from three things:
 *   · a scheduler with up to two workers, created once and kept warm, so the
 *     ~1s model load is paid on the first image, not on every image;
 *   · pages of one document are recognised in parallel across the workers;
 *   · workers are released after 10 idle minutes, so a warm pool costs memory
 *     only while attachments are actually being read.
 *
 * ACCURACY comes from resolution: Tesseract is tuned for ~300 DPI text, and a
 * screenshot or phone photo is usually far below that. Images whose shorter
 * side is small are upscaled (bicubic, via @napi-rs/canvas) before
 * recognition, and every image is re-encoded as PNG so format quirks (webp,
 * palette PNGs, CMYK JPEGs) never reach the engine.
 */

import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScheduler, createWorker } from 'tesseract.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { log } from '../logging.js';

const require = createRequire(import.meta.url);
const ENG_DIR = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

const WORKERS = Math.max(1, Math.min(2, os.cpus().length - 1));
const IDLE_MS = 10 * 60_000;
const TARGET_SHORT_SIDE = 1600; // px — below this, text is usually under ~300 DPI equivalent
const MAX_SIDE = 4200;          // px — beyond this recognition slows sharply for no gain

let scheduler = null;
let starting = null;
let idleTimer = null;

async function ensureScheduler() {
  if (scheduler) return scheduler;
  if (starting) return starting;
  starting = (async () => {
    const t0 = Date.now();
    const s = createScheduler();
    const workers = await Promise.all(Array.from({ length: WORKERS }, async () => {
      const w = await createWorker('eng', 1 /* LSTM */, {
        langPath: ENG_DIR,
        gzip: true,
        cacheMethod: 'none', // the model is already local; never write a copy into the cwd
      });
      // Keep runs of spaces: table columns in a scan stay separable.
      await w.setParameters({ preserve_interword_spaces: '1' });
      return w;
    }));
    workers.forEach((w) => s.addWorker(w));
    log.info('attach', `OCR ready: ${WORKERS} worker(s), model eng best_int, ${Date.now() - t0}ms`);
    scheduler = s;
    starting = null;
    return s;
  })();
  try { return await starting; } catch (e) { starting = null; throw e; }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const s = scheduler;
    scheduler = null;
    if (s) { try { await s.terminate(); log.info('attach', 'OCR workers released after idle'); } catch { /* already gone */ } }
  }, IDLE_MS);
  idleTimer.unref?.();
}

/** Re-encode (and, if small, upscale) an image to a PNG buffer for recognition. */
export async function prepareImage(buffer) {
  const img = await loadImage(buffer);
  const short = Math.min(img.width, img.height);
  let scale = short < TARGET_SHORT_SIDE ? Math.min(3, TARGET_SHORT_SIDE / short) : 1;
  if (Math.max(img.width, img.height) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';           // transparent PNGs: text on white, not on black
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { png: await canvas.encode('png'), width: img.width, height: img.height, scale };
}

/**
 * Recognise one image (any format loadImage understands, or an already-prepared
 * PNG with `prepared: true`). Returns text plus the mean word confidence.
 */
export async function ocrImage(buffer, { prepared = false } = {}) {
  const png = prepared ? buffer : (await prepareImage(buffer)).png;
  const s = await ensureScheduler();
  touch();
  const { data } = await s.addJob('recognize', png);
  touch();
  return { text: data.text || '', confidence: Math.round(data.confidence ?? 0) };
}

/** For tests and shutdown. */
export async function shutdownOcr() {
  clearTimeout(idleTimer);
  const s = scheduler;
  scheduler = null;
  if (s) await s.terminate();
}
