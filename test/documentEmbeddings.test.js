import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ documents: [], chunks: [] }));

vi.mock('../src/models/Document.js', () => ({
  Document: {
    async findOne(filter) {
      const found = state.documents.find((document) =>
        document.id === filter._id && document.owner === filter.owner) ?? null;
      return found;
    },
    find(filter) {
      const found = state.documents.filter((document) => document.owner === filter.owner
        && document.status === filter.status && document.embeddingStatus === filter.embeddingStatus);
      return { select() { return this; }, lean: async () => found.map(({ id, ...document }) => ({ _id: id, ...document })) };
    },
    async updateOne(filter, update) {
      const document = state.documents.find((item) => item.id === filter._id && item.owner === filter.owner);
      if (!document) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.status && document.status !== filter.status) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.$or && !filter.$or.some((clause) => {
        const condition = clause.embeddingStatus;
        return condition.$exists === false ? document.embeddingStatus === undefined
          : condition.$in.includes(document.embeddingStatus);
      })) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.embeddingStatus?.$in && !filter.embeddingStatus.$in.includes(document.embeddingStatus)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (filter.embeddingStatus && typeof filter.embeddingStatus === 'string'
        && document.embeddingStatus !== filter.embeddingStatus) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(document, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete document[key];
      for (const [key, amount] of Object.entries(update.$inc ?? {})) document[key] = (document[key] ?? 0) + amount;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

vi.mock('../src/models/DocumentChunk.js', () => ({
  DocumentChunk: {
    find(filter) {
      let found = state.chunks.filter((chunk) => chunk.owner === filter.owner);
      if (filter.document?.$in) {
        const ids = new Set(filter.document.$in.map(String));
        found = found.filter((chunk) => ids.has(String(chunk.document)));
      } else if (filter.document) {
        found = found.filter((chunk) => String(chunk.document) === String(filter.document));
      }
      if (filter.embeddingModel) found = found.filter((chunk) => chunk.embeddingModel === filter.embeddingModel);
      if (filter.embeddingProvider) found = found.filter((chunk) => chunk.embeddingProvider === filter.embeddingProvider);
      if (filter.embeddingDimensions) found = found.filter((chunk) => chunk.embeddingDimensions === filter.embeddingDimensions);
      let sorted = [...found];
      const query = {
        select() { return this; },
        sort() { sorted.sort((a, b) => a.chunkIndex - b.chunkIndex); return this; },
        lean: async () => sorted,
      };
      return query;
    },
    async bulkWrite(operations) {
      let matchedCount = 0;
      for (const { updateOne } of operations) {
        const chunk = state.chunks.find((item) => item._id === updateOne.filter._id
          && item.document === updateOne.filter.document && item.owner === updateOne.filter.owner);
        if (!chunk) continue;
        Object.assign(chunk, updateOne.update.$set);
        matchedCount += 1;
      }
      return { matchedCount };
    },
  },
}));

vi.mock('../src/services/embeddingProvider.js', () => ({
  createEmbeddings: vi.fn(),
  embeddingProvider: 'google',
  embeddingModel: 'test-embedding-model',
  embeddingDimensions: 3,
  EmbeddingProviderError: class EmbeddingProviderError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  },
}));

const { embedDocumentChunks, searchOwnedChunks } = await import('../src/services/documentEmbeddings.js');
const ownerA = 'owner-a';
const ownerB = 'owner-b';
const docA = 'doc-a';
const docB = 'doc-b';
const vector = [1, 0, 0];

function chunk(_id, document, owner, text, embedding) {
  return {
    _id, document, owner, text, chunkIndex: 0, pageNumber: 2,
    ...(embedding ? { embedding, embeddingProvider: 'google', embeddingModel: 'test-embedding-model', embeddingDimensions: 3 } : {}),
  };
}

beforeEach(() => {
  state.documents = [
    { id: docA, owner: ownerA, status: 'ready', embeddingStatus: 'pending', originalName: 'a.pdf' },
    { id: docB, owner: ownerB, status: 'ready', embeddingStatus: 'ready', originalName: 'b.pdf' },
  ];
  state.chunks = [chunk('chunk-a', docA, ownerA, 'alpha chunk'), chunk('chunk-b', docB, ownerB, 'private beta')];
});

describe('document embedding and semantic search', () => {
  it('embeds saved chunks and skips them on an idempotent retry', async () => {
    const embedBatch = vi.fn(async (texts) => texts.map(() => vector));
    expect(await embedDocumentChunks(docA, ownerA, { embedBatch })).toBe(true);
    expect(state.chunks[0]).toMatchObject({ embedding: vector, embeddingProvider: 'google', embeddingModel: 'test-embedding-model' });
    expect(state.documents[0]).toMatchObject({ embeddingStatus: 'ready', embeddingAttempts: 1 });

    expect(await embedDocumentChunks(docA, ownerA, { embedBatch })).toBe(true);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(state.documents[0].embeddingAttempts).toBe(2);
  });

  it('keeps successful batches and retries only missing embeddings', async () => {
    state.chunks.push(chunk('chunk-a2', docA, ownerA, 'second chunk'));
    const embedBatch = vi.fn()
      .mockResolvedValueOnce([vector])
      .mockRejectedValueOnce(new Error('temporary network issue'));
    expect(await embedDocumentChunks(docA, ownerA, { embedBatch, batchSize: 1 })).toBe(false);
    expect(state.chunks[0].embedding).toEqual(vector);
    expect(state.documents[0].embeddingStatus).toBe('failed');

    const retry = vi.fn(async (texts) => texts.map(() => [0, 1, 0]));
    expect(await embedDocumentChunks(docA, ownerA, { embedBatch: retry, batchSize: 1 })).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0]).toEqual(['second chunk']);
  });

  it('replaces incompatible legacy OpenAI vectors from saved chunks only', async () => {
    state.documents[0].embeddingStatus = 'ready';
    state.chunks[0] = {
      ...chunk('chunk-a', docA, ownerA, 'saved chunk text', [0.1, 0.2, 0.3]),
      embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536,
    };
    const embedBatch = vi.fn(async () => [vector]);
    expect(await embedDocumentChunks(docA, ownerA, { embedBatch })).toBe(true);
    expect(embedBatch).toHaveBeenCalledWith(['saved chunk text'], { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(state.chunks[0]).toMatchObject({ embedding: vector, embeddingProvider: 'google' });
  });

  it('can embed chunks from existing ready documents with no embedding status field', async () => {
    delete state.documents[0].embeddingStatus;
    const embedBatch = vi.fn(async () => [vector]);
    expect(await embedDocumentChunks(docA, ownerA, { embedBatch })).toBe(true);
    expect(embedBatch).toHaveBeenCalledWith(['alpha chunk'], { taskType: 'RETRIEVAL_DOCUMENT' });
    expect(state.documents[0].embeddingStatus).toBe('ready');
  });

  it('marks empty chunks as failed without calling the provider', async () => {
    state.chunks[0].text = '  ';
    const embedBatch = vi.fn();
    expect(await embedDocumentChunks(docA, ownerA, { embedBatch })).toBe(false);
    expect(embedBatch).not.toHaveBeenCalled();
    expect(state.documents[0].embeddingError.code).toBe('EMPTY_CHUNK');
  });

  it('does not embed a document belonging to another owner', async () => {
    const embedBatch = vi.fn();
    expect(await embedDocumentChunks(docA, ownerB, { embedBatch })).toBe(false);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('ranks semantically and excludes another owner’s chunks', async () => {
    state.documents[0].embeddingStatus = 'ready';
    state.chunks[0] = chunk('chunk-a', docA, ownerA, 'authorized answer', [0.9, 0.1, 0]);
    state.chunks[1] = chunk('chunk-b', docB, ownerB, 'cross-owner secret', [1, 0, 0]);
    const results = await searchOwnedChunks(ownerA, vector, { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      document: { id: docA, originalName: 'a.pdf' },
      chunk: { id: 'chunk-a', pageNumber: 2, text: 'authorized answer' },
    });
    expect(results[0].score).toBeGreaterThan(0.9);
  });
});
