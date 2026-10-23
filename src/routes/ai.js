import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { logger } from '../config/logger.js';
import { Document } from '../models/Document.js';
import { searchOwnedChunks } from '../services/documentEmbeddings.js';
import { createEmbeddings, EmbeddingProviderError } from '../services/embeddingProvider.js';
import { generateAnswer, GeminiGenerationError } from '../services/geminiGeneration.js';

export const aiRouter = Router();

const askSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  documentId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

const insufficientContextAnswer = 'The documents do not contain enough information to answer this question.';

function sourceReference(result) {
  const { document, chunk } = result;
  const text = chunk.text ?? '';
  const excerpt = text.length > 400 ? `${text.slice(0, 397).trimEnd()}...` : text;
  return {
    documentId: document.id,
    filename: document.originalName,
    chunkId: chunk.id,
    chunkIndex: chunk.chunkIndex,
    ...(Number.isInteger(chunk.pageNumber) ? { pageNumber: chunk.pageNumber } : {}),
    excerpt,
    score: result.score,
  };
}

function providerErrorResponse(res, error) {
  if (error instanceof EmbeddingProviderError) {
    const status = error.code === 'CONFIG_MISSING' ? 503 : error.status === 429 ? 429 : 502;
    const message = error.code === 'CONFIG_MISSING' ? 'Gemini API is not configured'
      : error.code === 'RATE_LIMITED' ? 'Gemini quota or rate limit reached'
        : 'Document retrieval is temporarily unavailable';
    return res.status(status).json({ error: { message } });
  }
  if (error instanceof GeminiGenerationError) {
    logger.error({
      upstreamStatus: error.status ?? null,
      providerCode: error.providerCode ?? error.code,
      providerMessage: error.providerMessage ?? error.message,
    }, 'Gemini answer generation failed');
    const status = ['CONFIG_MISSING', 'CONFIG_ERROR'].includes(error.code) ? 503
      : error.code === 'RATE_LIMITED' ? 429
        : error.code === 'TIMEOUT' ? 504
          : error.code === 'PROVIDER_UNAVAILABLE' ? 503 : 502;
    const message = ['CONFIG_MISSING', 'CONFIG_ERROR'].includes(error.code) ? 'Gemini API configuration is invalid or unavailable'
      : error.code === 'RATE_LIMITED' ? 'Gemini quota or rate limit reached'
        : error.code === 'TIMEOUT' ? 'Answer generation timed out'
          : error.code === 'PROVIDER_UNAVAILABLE' ? 'Gemini is temporarily unavailable; retry shortly'
            : 'Answer generation is temporarily unavailable';
    return res.status(status).json({ error: { message } });
  }
  return null;
}

aiRouter.post('/ask', authenticate, async (req, res, next) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: 'Invalid question request' } });

  const { question, documentId, limit } = parsed.data;
  try {
    if (documentId) {
      if (!mongoose.isValidObjectId(documentId)) {
        return res.status(400).json({ error: { message: 'Invalid question request' } });
      }
      const document = await Document.findOne({ _id: documentId, owner: req.userId });
      if (!document) return res.status(404).json({ error: { message: 'Document not found' } });
      if (document.status !== 'ready' || document.embeddingStatus !== 'ready') {
        return res.status(409).json({ error: { message: 'Document is not ready for question answering' } });
      }
    }

    const [queryVector] = await createEmbeddings([question], { taskType: 'RETRIEVAL_QUERY' });
    const results = await searchOwnedChunks(req.userId, queryVector, { limit, ...(documentId ? { documentId } : {}) });
    if (!results.length) {
      return res.status(200).json({ answer: insufficientContextAnswer, sources: [] });
    }

    const answer = await generateAnswer(question, results);
    return res.status(200).json({ answer, sources: results.map(sourceReference) });
  } catch (error) {
    const providerResponse = providerErrorResponse(res, error);
    if (providerResponse) return providerResponse;
    return next(error);
  }
});
