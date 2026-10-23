import { Router } from 'express';
import fileUpload from 'express-fileupload';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { queueDocumentProcessing } from '../services/documentProcessing.js';
import { queueDocumentEmbedding, searchOwnedChunks } from '../services/documentEmbeddings.js';
import { createEmbeddings, EmbeddingProviderError } from '../services/embeddingProvider.js';
import {
  maxUploadBytes,
  removeStoredFile,
  validateUploadedFile,
  uploadDocument,
} from '../services/documentStorage.js';

export const documentsRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const chunkPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const semanticSearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

const uploadSingleFile = fileUpload({
  useTempFiles: true,
  tempFileDir: os.tmpdir(),
  limits: { fileSize: maxUploadBytes, files: 1 },
});

function uploadedFiles(req) {
  return Object.values(req.files ?? {}).flatMap((file) => Array.isArray(file) ? file : [file]);
}

async function removeTemporaryFiles(files) {
  await Promise.all(files.map(async (file) => {
    if (!file.tempFilePath) return;
    try {
      await unlink(file.tempFilePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }));
}

function documentNotFound(res) {
  return res.status(404).json({ error: { message: 'Document not found' } });
}

function documentMetadata(document) {
  return {
    id: document.id ?? document._id.toString(),
    originalName: document.originalName,
    resourceType: document.resourceType,
    mimeType: document.mimeType,
    size: document.size,
    status: document.status,
    processingAttempts: document.processingAttempts ?? 0,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    processedAt: document.processedAt,
    ...(document.processingError ? { processingError: document.processingError } : {}),
    embeddingStatus: document.embeddingStatus
      ?? (document.mimeType === 'application/pdf' ? 'pending' : 'not_applicable'),
    embeddingAttempts: document.embeddingAttempts ?? 0,
    ...(document.embeddingError ? { embeddingError: document.embeddingError } : {}),
    embeddingModel: document.embeddingModel,
    embeddingProvider: document.embeddingProvider,
    embeddingDimensions: document.embeddingDimensions,
    embeddedAt: document.embeddedAt,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function validateId(id) {
  return /^[0-9a-f]{24}$/i.test(id) && mongoose.isValidObjectId(id);
}

documentsRouter.post('/upload', authenticate, uploadSingleFile, async (req, res, next) => {
  const files = uploadedFiles(req);
  const file = req.files?.file;
  if (files.length !== 1 || Array.isArray(file) || !file) {
    await removeTemporaryFiles(files).catch((error) => req.log?.warn({ err: error }, 'Temporary upload cleanup failed'));
    return res.status(400).json({ error: { message: 'A file is required in the file field' } });
  }

  try {
    const originalName = validateUploadedFile(file);
    const asset = await uploadDocument(file.tempFilePath, originalName);
    let document;
    try {
      document = await Document.create({
        owner: req.userId,
        originalName,
        publicId: asset.publicId,
        resourceType: asset.resourceType,
        deliveryType: asset.deliveryType ?? 'authenticated',
        mimeType: file.mimetype.toLowerCase(),
        size: file.size,
        status: 'uploaded',
      });
    } catch (error) {
      try {
        await removeStoredFile(asset.publicId, asset.resourceType, asset.deliveryType ?? 'authenticated');
      } catch (cleanupError) {
        req.log?.error({ err: cleanupError }, 'Uploaded Cloudinary asset cleanup failed');
      }
      return next(error);
    }
    if (document.mimeType === 'application/pdf') queueDocumentProcessing(document.id, req.userId);
    return res.status(201).json({ document: documentMetadata(document) });
  } catch (error) {
    return next(error);
  } finally {
    await removeTemporaryFiles(files).catch((error) => req.log?.warn({ err: error }, 'Temporary upload cleanup failed'));
  }
});

documentsRouter.post('/search', authenticate, async (req, res, next) => {
  const parsed = semanticSearchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: 'Invalid search query' } });
  try {
    const [queryVector] = await createEmbeddings([parsed.data.query], { taskType: 'RETRIEVAL_QUERY' });
    const results = await searchOwnedChunks(req.userId, queryVector, { limit: parsed.data.limit });
    return res.status(200).json({ results });
  } catch (error) {
    if (error instanceof EmbeddingProviderError) {
      const status = error.code === 'CONFIG_MISSING' ? 503 : error.status === 429 ? 429 : 502;
      return res.status(status).json({ error: { message: 'Semantic search is temporarily unavailable' } });
    }
    return next(error);
  }
});

documentsRouter.get('/:id/chunks', authenticate, async (req, res, next) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: { message: 'Invalid document ID' } });
  try {
    const parsed = chunkPaginationSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: { message: 'Invalid pagination parameters' } });
    const document = await Document.findOne({ _id: req.params.id, owner: req.userId });
    if (!document) return documentNotFound(res);
    if (document.status !== 'ready') {
      return res.status(409).json({ error: { message: 'Document chunks are not ready' } });
    }
    const { page, limit } = parsed.data;
    const filter = { document: req.params.id, owner: req.userId };
    const [chunks, total] = await Promise.all([
      DocumentChunk.find(filter).sort({ chunkIndex: 1 }).skip((page - 1) * limit).limit(limit),
      DocumentChunk.countDocuments(filter),
    ]);
    return res.status(200).json({
      chunks: chunks.map(({ chunkIndex, pageNumber, text }) => ({ chunkIndex, pageNumber, text })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

documentsRouter.post('/:id/reprocess', authenticate, async (req, res, next) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: { message: 'Invalid document ID' } });
  try {
    const document = await Document.findOne({ _id: req.params.id, owner: req.userId });
    if (!document) return documentNotFound(res);
    if (document.mimeType !== 'application/pdf') {
      return res.status(415).json({ error: { message: 'Only PDF documents can be processed' } });
    }
    const staleProcessing = document.status === 'processing'
      && (!document.processingStartedAt || Date.now() - document.processingStartedAt.getTime() > 15 * 60 * 1000);
    if ((document.status === 'processing' && !staleProcessing) || document.status === 'deleting') {
      return res.status(409).json({ error: { message: 'Document cannot be reprocessed in its current state' } });
    }
    if (staleProcessing) {
      await Document.updateOne({ _id: req.params.id, owner: req.userId, status: 'processing' }, {
        $set: { status: 'failed' },
        $unset: { processingStartedAt: 1 },
      });
    }
    queueDocumentProcessing(document.id, req.userId);
    return res.status(202).json({ message: 'Document processing queued' });
  } catch (error) {
    return next(error);
  }
});

documentsRouter.post('/:id/embeddings/reprocess', authenticate, async (req, res, next) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: { message: 'Invalid document ID' } });
  try {
    const document = await Document.findOne({ _id: req.params.id, owner: req.userId });
    if (!document) return documentNotFound(res);
    if (document.status !== 'ready') {
      return res.status(409).json({ error: { message: 'Document processing must finish before embedding' } });
    }
    const staleProcessing = document.embeddingStatus === 'processing'
      && (!document.embeddingStartedAt || Date.now() - document.embeddingStartedAt.getTime() > 15 * 60 * 1000);
    if (document.embeddingStatus === 'processing' && !staleProcessing) {
      return res.status(409).json({ error: { message: 'Document embedding is already in progress' } });
    }
    if (staleProcessing) {
      await Document.updateOne({ _id: req.params.id, owner: req.userId, embeddingStatus: 'processing' }, {
        $set: { embeddingStatus: 'failed' },
        $unset: { embeddingStartedAt: 1 },
      });
    }
    queueDocumentEmbedding(document.id, req.userId);
    return res.status(202).json({ message: 'Document embedding queued' });
  } catch (error) {
    return next(error);
  }
});

documentsRouter.get('/', authenticate, async (req, res, next) => {
  try {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: { message: 'Invalid pagination parameters' } });
    }
    const { page, limit } = parsed.data;
    const [documents, total] = await Promise.all([
      Document.find({ owner: req.userId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Document.countDocuments({ owner: req.userId }),
    ]);
    return res.status(200).json({
      documents: documents.map(documentMetadata),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

documentsRouter.get('/:id', authenticate, async (req, res, next) => {
  if (!validateId(req.params.id)) {
    return res.status(400).json({ error: { message: 'Invalid document ID' } });
  }
  try {
    const document = await Document.findOne({ _id: req.params.id, owner: req.userId });
    if (!document) return documentNotFound(res);
    return res.status(200).json({ document: documentMetadata(document) });
  } catch (error) {
    return next(error);
  }
});

documentsRouter.delete('/:id', authenticate, async (req, res, next) => {
  if (!validateId(req.params.id)) {
    return res.status(400).json({ error: { message: 'Invalid document ID' } });
  }
  try {
    const document = await Document.findOne({ _id: req.params.id, owner: req.userId }).select('+publicId +deliveryType');
    if (!document) return documentNotFound(res);

    await Document.updateOne({ _id: req.params.id, owner: req.userId }, { $set: { status: 'deleting' } });

    try {
      await removeStoredFile(document.publicId, document.resourceType, document.deliveryType ?? 'upload');
    } catch {
      const cleanupError = new Error('Document file cleanup failed');
      cleanupError.status = 500;
      return next(cleanupError);
    }
    try {
      await DocumentChunk.deleteMany({ document: req.params.id, owner: req.userId });
      await document.deleteOne();
    } catch (error) {
      const cleanupError = new Error('Document record cleanup failed after Cloudinary deletion');
      cleanupError.status = 500;
      req.log?.error({ err: error, documentId: document.id }, 'Document record deletion failed');
      return next(cleanupError);
    }
    return res.status(200).json({ message: 'Document deleted' });
  } catch (error) {
    return next(error);
  }
});
