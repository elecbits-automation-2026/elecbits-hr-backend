import createError from 'http-errors';

/** The file kinds the HRMS accepts, each with its stored content type. */
export type UploadKind = 'pdf' | 'jpg' | 'png' | 'doc' | 'docx';

const KIND: Record<UploadKind, { type: string; ext: string[]; label: string }> = {
  pdf: { type: 'application/pdf', ext: ['pdf'], label: 'PDF' },
  jpg: { type: 'image/jpeg', ext: ['jpg', 'jpeg'], label: 'JPG' },
  png: { type: 'image/png', ext: ['png'], label: 'PNG' },
  doc: { type: 'application/msword', ext: ['doc'], label: 'Word' },
  docx: {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: ['docx'],
    label: 'Word',
  },
};

const starts = (data: Buffer, bytes: number[]) => bytes.every((b, i) => data[i] === b);

/** What the bytes actually are — the browser's Content-Type is only a claim. */
const sniff = (data: Buffer): UploadKind | 'zip' | null => {
  // %PDF may follow a few bytes of junk/whitespace in some generators.
  if (data.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(data, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc';
  if (starts(data, [0x50, 0x4b, 0x03, 0x04])) return 'zip'; // docx is a zip
  return null;
};

const listLabels = (kinds: UploadKind[]) => {
  const labels = [...new Set(kinds.map((k) => KIND[k].label))];
  return labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
};

/**
 * The ONE upload check (test pass 2026-11-03: wrong files got through): the
 * size, the file-name extension AND the file's own first bytes must all agree
 * with one of `kinds`. Returns the content type to store — derived from the
 * bytes, never trusted from the browser.
 */
export const checkUpload = (
  file: { fileName: string; data: Buffer },
  kinds: UploadKind[],
  opts: { maxBytes?: number; what?: string } = {},
): string => {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const what = opts.what ?? 'The file';
  if (file.data.length === 0) {
    throw createError(422, `${what} is empty`, { code: 'BAD_FILE_SIZE' });
  }
  if (file.data.length > maxBytes) {
    throw createError(422, `${what} must be under ${Math.round(maxBytes / (1024 * 1024))} MB`, {
      code: 'BAD_FILE_SIZE',
    });
  }
  // No extension (an API caller without ?filename=) → the bytes alone decide.
  const name = file.fileName.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : null;
  const sniffed = sniff(file.data);
  const kind = kinds.find(
    (k) =>
      (ext === null || KIND[k].ext.includes(ext)) &&
      (sniffed === k || (k === 'docx' && sniffed === 'zip')),
  );
  if (!kind) {
    throw createError(422, `Upload a ${listLabels(kinds)} file`, { code: 'BAD_FILE_TYPE' });
  }
  return KIND[kind].type;
};
