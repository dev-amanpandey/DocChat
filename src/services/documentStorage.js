import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export const maxUploadBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
export const documentResourceType = 'raw';
export const documentDeliveryType = 'authenticated';

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

export function safeOriginalName(originalName) {
  const basename = path.posix.basename(originalName.replaceAll('\\', '/'));
  return basename.slice(0, 255) || 'document';
}

export function validateUploadedFile(file) {
  const originalName = safeOriginalName(file.name ?? '');
  const extension = path.extname(originalName).toLowerCase();
  const expectedTypes = allowedTypes.get(extension);
  if (!expectedTypes || !expectedTypes.has(String(file.mimetype).toLowerCase())) {
    throw new UnsupportedFileTypeError();
  }
  if (!file.tempFilePath || file.truncated || file.size > maxUploadBytes) {
    const error = new Error(`File exceeds the ${Math.floor(maxUploadBytes / (1024 * 1024))} MB upload limit`);
    error.status = 413;
    throw error;
  }
  return originalName;
}

export async function uploadDocument(tempFilePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();
  const publicId = `docchat/${randomUUID()}${extension}`;

  try {
    const result = await cloudinary.uploader.upload(tempFilePath, {
      public_id: publicId,
      resource_type: documentResourceType,
      type: documentDeliveryType,
      overwrite: false,
      context: { original_name: originalName },
    });
    return { publicId: result.public_id, resourceType: result.resource_type, deliveryType: result.type };
  } catch (error) {
    logger.error(
      { message: error.message, http_code: error.http_code },
      'Cloudinary document upload failed'
    );
    throw new Error('Cloudinary upload failed');
  }
}

function validateStorageReference(publicId, resourceType, deliveryType) {
  if (
    typeof publicId !== 'string' ||
    !/^docchat\/[0-9a-f-]{36}\.(pdf|docx|txt|md)$/i.test(publicId) ||
    resourceType !== documentResourceType ||
    !['upload', 'authenticated'].includes(deliveryType)
  ) {
    throw new Error('Invalid Cloudinary document key');
  }
}

export async function removeStoredFile(publicId, resourceType = documentResourceType, deliveryType = 'upload') {
  validateStorageReference(publicId, resourceType, deliveryType);

  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    type: deliveryType,
    invalidate: true,
  });

  if (!['ok', 'not found'].includes(result.result)) {
    throw new Error('Cloudinary document cleanup failed');
  }
}

export async function downloadStoredFile(publicId, resourceType, deliveryType) {
  validateStorageReference(publicId, resourceType, deliveryType);
  const extension = path.extname(publicId).slice(1).toLowerCase();
  const url = cloudinary.utils.private_download_url(publicId, extension, {
    resource_type: resourceType,
    type: deliveryType,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    secure: true,
  });
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`Cloudinary document download failed (${response.status})`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
    await response.body?.cancel();
    throw new Error('Cloudinary document download exceeded the upload size limit');
  }
  const parts = [];
  let totalBytes = 0;
  if (!response.body) throw new Error('Cloudinary document download returned no body');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxUploadBytes) {
        await reader.cancel();
        throw new Error('Cloudinary document download exceeded the upload size limit');
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(parts, totalBytes);
  if (buffer.length === 0) throw new Error('Cloudinary document download returned an empty file');
  return buffer;
}
