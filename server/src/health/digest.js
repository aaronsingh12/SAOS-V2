import crypto from 'node:crypto';

/**
 * A stable hash of a value, for the manifest's `input_hash`.
 *
 * Its own module rather than a helper in `index.js` because `explain.js` needs
 * it too, and `index.js` already imports `explain.js` — putting it there would
 * close an import cycle for the sake of six lines.
 */
export function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
