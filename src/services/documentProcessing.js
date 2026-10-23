import { PDFParse } from 'pdf-parse';
import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { downloadStoredFile } from './documentStorage.js';
import { queueDocumentEmbedding } from './documentEmbeddings.js';
import { logger } from '../config/logger.js';

export const defaultChunkSize = 1000;
export const defaultChunkOverlap = 150;

export class DocumentProcessingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentProcessingError';
    this.code = code;
  }
}

export function splitTextIntoChunks(text, { chunkSize = defaultChunkSize, overlap = defaultChunkOverlap } = {}) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new TypeError('Chunk size must be positive and overlap must be smaller than chunk size');
  }
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(chunkSize * 0.6)) end = boundary;
    }
    const value = normalized.slice(start, end).trim();
    if (value) chunks.push(value);
    if (end >= normalized.length) break;
    const nextStart = Math.max(start + 1, end - overlap);
    start = nextStart;
  }
  return chunks;
}

export function splitPagesIntoChunks(pages, options) {
  let chunkIndex = 0;
  const chunks = [];
  for (const page of pages) {
    for (const text of splitTextIntoChunks(page.text, options)) {
      chunks.push({ chunkIndex: chunkIndex++, pageNumber: page.pageNumber, text });
    }
  }
  return chunks;
}

export async function extractPdfPages(buffer) {
  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    if (!result.total) throw new DocumentProcessingError('EMPTY_PDF', 'PDF contains no pages');
    const pages = result.pages.map(({ num, text }) => ({ pageNumber: num, text: text.trim() }));
    if (!pages.some((page) => page.text)) {
      throw new DocumentProcessingError(
        'NO_EXTRACTABLE_TEXT',
        'No selectable text was found; scanned or image-only PDFs require OCR, which is not enabled',
      );
    }
    return { pages, pageCount: result.total };
  } catch (error) {
    if (error instanceof DocumentProcessingError) throw error;
    throw new DocumentProcessingError('PDF_EXTRACTION_FAILED', 'The PDF could not be parsed');
  } finally {
    await parser?.destroy().catch(() => {});
  }
}

function processingFailure(error) {
  const allowedCodes = new Set([
    'EMPTY_PDF', 'NO_EXTRACTABLE_TEXT', 'PDF_EXTRACTION_FAILED', 'STORAGE_UNAVAILABLE', 'PROCESSING_FAILED',
  ]);
  if (error instanceof DocumentProcessingError && allowedCodes.has(error.code)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'PROCESSING_FAILED', message: 'Document processing failed; retry is available' };
}

export async function processDocument(documentId, ownerId, {
  download = downloadStoredFile,
  extract = extractPdfPages,
  chunkOptions,
} = {}) {
  const document = await Document.findOne({ _id: documentId, owner: ownerId }).select('+publicId +deliveryType');
  if (!document || document.status === 'deleting') return false;

  const claim = await Document.updateOne({
    _id: documentId,
    owner: ownerId,
    status: { $in: ['uploaded', 'failed', 'ready'] },
  }, {
    $set: { status: 'processing', processingStartedAt: new Date() },
    $unset: { processingError: 1 },
    $inc: { processingAttempts: 1 },
  });
  if (!claim.modifiedCount) return false;

  try {
    await DocumentChunk.deleteMany({ document: documentId, owner: ownerId });
    let buffer;
    try {
      buffer = await download(document.publicId, document.resourceType, document.deliveryType ?? 'upload');
    } catch {
      throw new DocumentProcessingError('STORAGE_UNAVAILABLE', 'The stored PDF could not be retrieved; retry is available');
    }
    const { pages, pageCount } = await extract(buffer);
    const chunks = splitPagesIntoChunks(pages, chunkOptions);
    if (!chunks.length) throw new DocumentProcessingError('NO_EXTRACTABLE_TEXT', 'PDF contains no extractable text');

    await DocumentChunk.insertMany(chunks.map((chunk) => ({
      ...chunk,
      document: documentId,
      owner: ownerId,
    })));
    const updated = await Document.updateOne({ _id: documentId, owner: ownerId, status: 'processing' }, {
      $set: {
        status: 'ready', pageCount, chunkCount: chunks.length, processedAt: new Date(), embeddingStatus: 'pending',
      },
      $unset: { processingError: 1, processingStartedAt: 1, embeddingError: 1, embeddedAt: 1 },
    });
    if (!updated.matchedCount) {
      await DocumentChunk.deleteMany({ document: documentId, owner: ownerId });
      return false;
    }
    queueDocumentEmbedding(documentId, ownerId);
    return true;
  } catch (error) {
    await DocumentChunk.deleteMany({ document: documentId, owner: ownerId }).catch((cleanupError) => {
      logger.error({ err: cleanupError, documentId }, 'Failed to clean partial document chunks');
    });
    const failure = processingFailure(error);
    await Document.updateOne({ _id: documentId, owner: ownerId, status: 'processing' }, {
      $set: { status: 'failed', processingError: failure },
      $unset: { processingStartedAt: 1 },
    });
    logger.error({ err: error, documentId, ownerId, code: failure.code }, 'Document processing failed');
    return false;
  }
}

export function queueDocumentProcessing(documentId, ownerId) {
  setImmediate(() => {
    processDocument(documentId, ownerId).catch((error) => {
      logger.error({ err: error, documentId, ownerId }, 'Document processing job failed');
    });
  });
}
