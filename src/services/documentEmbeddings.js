import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';
import { logger } from '../config/logger.js';
import {
  createEmbeddings,
  embeddingProvider,
  embeddingDimensions,
  embeddingModel,
  EmbeddingProviderError,
} from './embeddingProvider.js';

export const embeddingBatchSize = 64;

function safeEmbeddingFailure(error) {
  const allowed = new Set(['CONFIG_MISSING', 'RATE_LIMITED', 'PROVIDER_ERROR', 'INPUT_TOO_LONG', 'EMPTY_CHUNK', 'NO_CHUNKS']);
  if (error instanceof EmbeddingProviderError && allowed.has(error.code)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'EMBEDDING_FAILED', message: 'Embedding generation failed; retry is available' };
}

export async function embedDocumentChunks(documentId, ownerId, {
  embedBatch = createEmbeddings,
  batchSize = embeddingBatchSize,
} = {}) {
  const document = await Document.findOne({ _id: documentId, owner: ownerId });
  if (!document || document.status !== 'ready') return false;

  const claim = await Document.updateOne({
    _id: documentId,
    owner: ownerId,
    status: 'ready',
    $or: [
      { embeddingStatus: { $in: ['pending', 'failed', 'ready'] } },
      { embeddingStatus: { $exists: false } },
    ],
  }, {
    $set: {
      embeddingStatus: 'processing', embeddingStartedAt: new Date(), embeddingProvider, embeddingModel, embeddingDimensions,
    },
    $unset: { embeddingError: 1 },
    $inc: { embeddingAttempts: 1 },
  });
  if (!claim.modifiedCount) return false;

  try {
    const chunks = await DocumentChunk.find({ document: documentId, owner: ownerId })
      .select('text chunkIndex pageNumber +embedding +embeddingProvider +embeddingModel +embeddingDimensions')
      .sort({ chunkIndex: 1 })
      .lean();
    if (!chunks.length) throw new EmbeddingProviderError('NO_CHUNKS', 'Document has no stored chunks to embed');
    if (chunks.some((chunk) => !chunk.text?.trim())) {
      throw new EmbeddingProviderError('EMPTY_CHUNK', 'Document contains an empty chunk');
    }

    const pending = chunks.filter((chunk) => !(
      chunk.embeddingModel === embeddingModel
      && chunk.embeddingProvider === embeddingProvider
      && chunk.embeddingDimensions === embeddingDimensions
      && Array.isArray(chunk.embedding)
      && chunk.embedding.length === embeddingDimensions
    ));

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const vectors = await embedBatch(batch.map((chunk) => chunk.text), { taskType: 'RETRIEVAL_DOCUMENT' });
      if (vectors.length !== batch.length || vectors.some((vector) =>
        !Array.isArray(vector) || vector.length !== embeddingDimensions
          || vector.some((value) => !Number.isFinite(value)))) {
        throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding provider returned invalid vectors');
      }
      const result = await DocumentChunk.bulkWrite(batch.map((chunk, index) => ({
        updateOne: {
          filter: { _id: chunk._id, document: documentId, owner: ownerId },
          update: { $set: {
            embedding: vectors[index],
            embeddingProvider,
            embeddingModel,
            embeddingDimensions,
          } },
        },
      })), { ordered: true });
      if (result.matchedCount !== batch.length) {
        throw new Error('Stored document chunks changed during embedding');
      }
    }

    const completed = await Document.updateOne({
      _id: documentId,
      owner: ownerId,
      status: 'ready',
      embeddingStatus: 'processing',
    }, {
      $set: { embeddingStatus: 'ready', embeddedAt: new Date() },
      $unset: { embeddingError: 1, embeddingStartedAt: 1 },
    });
    return completed.matchedCount > 0;
  } catch (error) {
    const failure = safeEmbeddingFailure(error);
    await Document.updateOne({
      _id: documentId,
      owner: ownerId,
      status: 'ready',
      embeddingStatus: 'processing',
    }, {
      $set: { embeddingStatus: 'failed', embeddingError: failure },
      $unset: { embeddingStartedAt: 1 },
    });
    logger.error({ documentId, ownerId, code: failure.code }, 'Document embedding failed');
    return false;
  }
}

export function queueDocumentEmbedding(documentId, ownerId) {
  setImmediate(() => {
    embedDocumentChunks(documentId, ownerId).catch(() => {
      logger.error({ documentId, ownerId }, 'Document embedding job failed');
    });
  });
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return Number.NaN;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export async function searchOwnedChunks(ownerId, queryVector, { limit = 5, documentId } = {}) {
  const ownedDocuments = await Document.find({
    owner: ownerId,
    status: 'ready',
    embeddingStatus: 'ready',
    ...(documentId ? { _id: documentId } : {}),
  }).select('_id originalName').lean();
  if (!ownedDocuments.length) return [];

  const documentsById = new Map(ownedDocuments.map((document) => [String(document._id), document]));
  const chunks = await DocumentChunk.find({
    owner: ownerId,
    document: { $in: ownedDocuments.map((document) => document._id) },
    embeddingModel,
    embeddingProvider,
    embeddingDimensions,
  }).select('document chunkIndex pageNumber text +embedding').lean();

  return chunks.map((chunk) => ({
    chunk,
    document: documentsById.get(String(chunk.document)),
    score: cosineSimilarity(queryVector, chunk.embedding),
  })).filter((result) => result.document && Number.isFinite(result.score))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ chunk, document, score }) => ({
      score,
      document: { id: String(document._id), originalName: document.originalName },
      chunk: {
        id: String(chunk._id),
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        text: chunk.text,
      },
    }));
}
