import { Router } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { Document } from '../models/Document.js';
import {
  maxUploadBytes,
  removeStoredFile,
  safeOriginalName,
  upload,
} from '../services/documentStorage.js';

export const documentsRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        const tooLarge = new Error(`File exceeds the ${Math.floor(maxUploadBytes / (1024 * 1024))} MB upload limit`);
        tooLarge.status = 413;
        return next(tooLarge);
      }
      const invalidUpload = new Error(error.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Upload must contain one file in the file field'
        : 'Invalid file upload');
      invalidUpload.status = 400;
      return next(invalidUpload);
    }
    if (error.status === 415) return next(error);
    return next(new Error('File upload failed'));
  });
}

function documentNotFound(res) {
  return res.status(404).json({ error: { message: 'Document not found' } });
}

function documentMetadata(document) {
  return {
    id: document.id ?? document._id.toString(),
    originalName: document.originalName,
    mimeType: document.mimeType,
    size: document.size,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function validateId(id) {
  return /^[0-9a-f]{24}$/i.test(id) && mongoose.isValidObjectId(id);
}

documentsRouter.post('/upload', authenticate, uploadSingleFile, async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: { message: 'A file is required in the file field' } });
  }

  try {
    const document = await Document.create({
      owner: req.userId,
      originalName: safeOriginalName(req.file.originalname),
      storedName: req.file.filename,
      mimeType: req.file.mimetype.toLowerCase(),
      size: req.file.size,
      status: 'uploaded',
    });
    return res.status(201).json({ document: documentMetadata(document) });
  } catch (error) {
    try {
      await removeStoredFile(req.file.filename);
    } catch {
      // Preserve the database error response; storage errors remain path-free.
    }
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
    const document = await Document.findOne({ _id: req.params.id, owner: req.userId }).select('+storedName');
    if (!document) return documentNotFound(res);

    try {
      await removeStoredFile(document.storedName);
    } catch {
      const cleanupError = new Error('Document file cleanup failed');
      cleanupError.status = 500;
      return next(cleanupError);
    }
    await document.deleteOne();
    return res.status(200).json({ message: 'Document deleted' });
  } catch (error) {
    return next(error);
  }
});
