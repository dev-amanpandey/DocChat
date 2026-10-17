import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';

export const uploadDirectory = path.resolve(env.UPLOAD_DIR);
export const maxUploadBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;

const allowedTypes = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
  ['.txt', new Set(['text/plain'])],
  ['.md', new Set(['text/markdown', 'text/x-markdown', 'text/plain'])],
]);

export class UnsupportedFileTypeError extends Error {
  constructor() {
    super('Unsupported file type');
    this.status = 415;
  }
}

export const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      mkdir(uploadDirectory, { recursive: true })
        .then(() => callback(null, uploadDirectory))
        .catch(() => callback(new Error('File upload storage is unavailable')));
    },
    filename(_req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    const expectedMimeTypes = allowedTypes.get(extension);
    if (!expectedMimeTypes || !expectedMimeTypes.has(file.mimetype.toLowerCase())) {
      return callback(new UnsupportedFileTypeError());
    }
    return callback(null, true);
  },
});

export function safeOriginalName(originalName) {
  const basename = path.posix.basename(originalName.replaceAll('\\', '/'));
  return basename.slice(0, 255) || 'document';
}

export async function removeStoredFile(storedName) {
  if (!/^[0-9a-f-]{36}\.(pdf|docx|txt|md)$/i.test(storedName)) {
    throw new Error('Invalid stored document key');
  }
  const target = path.resolve(uploadDirectory, storedName);
  if (path.dirname(target) !== uploadDirectory) throw new Error('Invalid stored document key');
  try {
    await unlink(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
