import { describe, expect, it, vi } from 'vitest';

const {
  EmbeddingProviderError, createEmbeddings, embeddingDimensions, embeddingModel,
} = await import('../src/services/embeddingProvider.js');

describe('Gemini embedding provider', () => {
  it('sends the documented batch request and validates returned vectors', async () => {
    const vectors = [[...Array(embeddingDimensions)].fill(0.25), [...Array(embeddingDimensions)].fill(0.5)];
    const fetchImpl = vi.fn(async (url, options) => {
      expect(url).toContain(`${embeddingModel}:batchEmbedContents`);
      expect(options.headers['x-goog-api-key']).toBe('test-gemini-key');
      expect(options.headers.Authorization).toBeUndefined();
      return new Response(JSON.stringify({ embeddings: vectors.map((values) => ({ values })) }), { status: 200 });
    });

    await expect(createEmbeddings(['a chunk', 'another chunk'], {
      apiKey: 'test-gemini-key', fetchImpl, taskType: 'RETRIEVAL_QUERY',
    })).resolves.toEqual(vectors);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ requests: [
      { model: `models/${embeddingModel}`, content: { parts: [{ text: 'a chunk' }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: embeddingDimensions },
      { model: `models/${embeddingModel}`, content: { parts: [{ text: 'another chunk' }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: embeddingDimensions },
    ] });
  });

  it('retries rate limits a bounded number of times', async () => {
    const vector = Array(embeddingDimensions).fill(0.1);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0.1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embeddings: [{ values: vector }] }), { status: 200 }));
    const sleep = vi.fn(async () => {});

    const result = await createEmbeddings(['query'], { apiKey: 'test-key', fetchImpl, sleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result[0]).toHaveLength(embeddingDimensions);
  });

  it('returns safe errors for provider failure and malformed vectors', async () => {
    const failed = vi.fn(async () => new Response('secret provider detail', { status: 403 }));
    await expect(createEmbeddings(['query'], { apiKey: 'test-key', fetchImpl: failed }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'Embedding provider request failed' });

    const malformed = vi.fn(async () => new Response(JSON.stringify({ embeddings: [{ values: [1, 2] }] }), { status: 200 }));
    await expect(createEmbeddings(['query'], { apiKey: 'test-key', fetchImpl: malformed }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    const malformedResponse = vi.fn(async () => new Response(JSON.stringify({ embeddings: {} }), { status: 200 }));
    await expect(createEmbeddings(['query'], { apiKey: 'test-key', fetchImpl: malformedResponse }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('rejects empty inputs and missing configuration without a request', async () => {
    const fetchImpl = vi.fn();
    await expect(createEmbeddings(['  '], { apiKey: 'test-key', fetchImpl })).rejects.toMatchObject({ code: 'EMPTY_CHUNK' });
    await expect(createEmbeddings(['query'], { apiKey: '', fetchImpl })).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(createEmbeddings(['🙂'.repeat(600)], { apiKey: 'test-key', fetchImpl }))
      .rejects.toMatchObject({ code: 'INPUT_TOO_LONG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
