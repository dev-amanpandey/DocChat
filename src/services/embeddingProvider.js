import { env } from '../config/env.js';

export const embeddingProvider = 'google';
export const embeddingModel = 'gemini-embedding-001';
export const embeddingDimensions = env.GEMINI_EMBEDDING_DIMENSIONS;
const embeddingEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:batchEmbedContents`;
const maxAttempts = 3;

export class EmbeddingProviderError extends Error {
  constructor(code, message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 5000);
  return 250 * (2 ** (attempt - 1));
}

function validateVectors(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding provider returned an invalid response');
  }
  return vectors.map((vector) => {
    if (!Array.isArray(vector) || vector.length !== embeddingDimensions
      || vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding provider returned an invalid vector');
    }
    return vector;
  });
}

export async function createEmbeddings(texts, {
  apiKey = env.GEMINI_API_KEY,
  taskType = 'RETRIEVAL_DOCUMENT',
  fetchImpl = fetch,
  sleep = delay,
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== 'string' || !text.trim())) {
    throw new EmbeddingProviderError('EMPTY_CHUNK', 'Embedding input cannot be empty');
  }
  if (texts.some((text) => Buffer.byteLength(text, 'utf8') > 2048)) {
    throw new EmbeddingProviderError('INPUT_TOO_LONG', 'Embedding input exceeds the supported size');
  }
  if (!apiKey) throw new EmbeddingProviderError('CONFIG_MISSING', 'Embedding provider is not configured');
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions < 128 || embeddingDimensions > 3072) {
    throw new EmbeddingProviderError('INVALID_DIMENSIONS', 'Embedding dimensions are not supported');
  }
  if (!['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY'].includes(taskType)) {
    throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding task type is not supported');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(embeddingEndpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: texts.map((text) => ({
          model: `models/${embeddingModel}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: embeddingDimensions,
        })) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt === maxAttempts) {
        throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding provider request failed', { retryable: true });
      }
      await sleep(250 * (2 ** (attempt - 1)));
      continue;
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await response.body?.cancel().catch(() => {});
        await sleep(retryDelay(response, attempt));
        continue;
      }
      throw new EmbeddingProviderError(
        response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
        response.status === 429 ? 'Embedding provider quota or rate limit reached' : 'Embedding provider request failed',
        { status: response.status, retryable },
      );
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding provider returned invalid JSON');
    }
    const embeddings = result?.embeddings;
    const vectors = Array.isArray(embeddings) ? embeddings.map((item) => item?.values) : embeddings;
    return validateVectors(vectors, texts.length);
  }
  throw new EmbeddingProviderError('PROVIDER_ERROR', 'Embedding provider request failed');
}
