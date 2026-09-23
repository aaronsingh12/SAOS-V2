/*
 * Attachment display rules. Plain JS (not JSX) so the server's offline suite
 * can import and assert them, like the other helpers in this folder.
 */

export const MAX_FILE_MB = 25;
export const MAX_FILES = 10;

/* What the picker offers. The server decides by content, not by this list —
   this only keeps the dialog from suggesting files that cannot be read. */
export const ACCEPT = [
  '.pdf', '.docx', '.xlsx', '.xlsm', '.csv', '.tsv', '.pptx',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff',
  '.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.htm',
  '.js', '.ts', '.py', '.sql', '.java', '.cs', '.sh', '.ps1', '.ini', '.cfg',
].join(',');

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** One line under the chip name: what was read, and how. */
export function describeAttachment(a) {
  if (!a) return '';
  const bits = [];
  if (a.kind) bits.push(String(a.kind).toUpperCase());
  if (a.pages) bits.push(`${a.pages} page${a.pages === 1 ? '' : 's'}`);
  if (a.method === 'ocr') bits.push(a.ocr?.confidence != null ? `OCR ${a.ocr.confidence}%` : 'OCR');
  else if (a.method === 'text+ocr') bits.push('text + OCR');
  if (Number.isFinite(a.tokens)) bits.push(`~${a.tokens.toLocaleString()} tokens`);
  return bits.join(' · ');
}

/** A file refused before upload, with the reason; null when it may be sent. */
export function precheckFile(file) {
  if (!file) return 'No file.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_FILE_MB * 1048576) return `Larger than ${MAX_FILE_MB} MB.`;
  return null;
}

/**
 * A stored user message is the typed text followed by the <attachments> block
 * the server appended. For display, the block becomes chips and the text is
 * what the user actually wrote.
 */
export function splitAttachmentBlock(text) {
  const s = String(text ?? '');
  const at = s.indexOf('\n\n<attachments>');
  if (at < 0) return { text: s, files: [] };
  const block = s.slice(at);
  const files = [];
  const re = /^### (.+?) \(id: (att_[A-Za-z0-9_-]+)\) — (.*)$/gm;
  let m;
  while ((m = re.exec(block))) files.push({ name: m[1], id: m[2], summary: m[3] });
  return { text: s.slice(0, at), files };
}
