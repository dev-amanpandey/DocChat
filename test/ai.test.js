import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

const state = vi.hoisted(() => ({
  documents: [],
  results: [],
  retrievalCalls: [],
  embeddingError: null,
  generationError: null,
}));

vi.mock('../src/models/Document.js', () => ({
  Document: {
    async findOne(filter) {
      return state.documents.find((document) => document.id === filter._id && document.owner === filter.owner) ?? null;
    },
  },
}));
vi.mock('../src/services/documentEmbeddings.js', () => ({
  searchOwnedChunks: vi.fn(async (...args) => {
    state.retrievalCalls.push(args);
    return state.results;
  }),
}));
vi.mock('../src/services/embeddingProvider.js', async () => {
  const actual = await vi.importActual('../src/services/embeddingProvider.js');
  return {
    ...actual,
    createEmbeddings: vi.fn(async () => {
      if (state.embeddingError) throw state.embeddingError;
      return [[1, 0, 0]];
    }),
  };
});
vi.mock('../src/services/geminiGeneration.js', async () => {
  const actual = await vi.importActual('../src/services/geminiGeneration.js');
  return {
    ...actual,
    generateAnswer: vi.fn(async () => {
      if (state.generationError) throw state.generationError;
      return 'The candidate has Node.js and MongoDB skills.';
    }),
  };
});

const { app } = await import('../src/app.js');
const { EmbeddingProviderError } = await import('../src/services/embeddingProvider.js');
const { GeminiGenerationError, generateAnswer } = await import('../src/services/geminiGeneration.js');
const { logger } = await import('../src/config/logger.js');
vi.spyOn(logger, 'error');

const ownerA = '64a000000000000000000001';
const ownerB = '64a000000000000000000002';
const docA = '64b000000000000000000001';
const docB = '64b000000000000000000002';
const tokenFor = (owner) => jwt.sign({}, env.JWT_SECRET, { subject: owner, algorithm: 'HS256' });

function source(documentId, filename, text = 'Node.js and MongoDB skills.') {
  return {
    score: 0.93,
    document: { id: documentId, originalName: filename },
    chunk: { id: '64c000000000000000000001', chunkIndex: 2, pageNumber: 3, text },
  };
}

beforeEach(() => {
  state.documents = [
    { id: docA, owner: ownerA, status: 'ready', embeddingStatus: 'ready' },
    { id: docB, owner: ownerB, status: 'ready', embeddingStatus: 'ready' },
  ];
  state.results = [source(docA, 'candidate.pdf')];
  state.retrievalCalls = [];
  state.embeddingError = null;
  state.generationError = null;
  vi.mocked(generateAnswer).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('POST /api/v1/ai/ask', () => {
  it('returns a grounded answer and source metadata for only the requesting owner', async () => {
    const response = await request(app)
      .post('/api/v1/ai/ask')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .send({ question: 'What technical skills does the candidate have?', limit: 5 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      answer: 'The candidate has Node.js and MongoDB skills.',
      sources: [{
        documentId: docA,
        filename: 'candidate.pdf',
        chunkId: '64c000000000000000000001',
        chunkIndex: 2,
        pageNumber: 3,
        excerpt: 'Node.js and MongoDB skills.',
        score: 0.93,
      }],
    });
    expect(state.retrievalCalls[0][0]).toBe(ownerA);
    expect(state.results.some((result) => result.document.id === docB)).toBe(false);
    expect(generateAnswer).toHaveBeenCalledOnce();
  });

  it('returns a clear insufficient-context answer without calling generation', async () => {
    state.results = [];
    const response = await request(app)
      .post('/api/v1/ai/ask')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .send({ question: 'What certifications are listed?' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      answer: 'The documents do not contain enough information to answer this question.',
      sources: [],
    });
    expect(generateAnswer).not.toHaveBeenCalled();
  });

  it('validates request fields and requires authentication', async () => {
    const unauthorized = await request(app).post('/api/v1/ai/ask').send({ question: 'question' });
    expect(unauthorized.status).toBe(401);

    for (const body of [
      {},
      { question: '   ' },
      { question: 'q', limit: 11 },
      { question: 'q', documentId: 'invalid' },
      { question: 'x'.repeat(2001) },
    ]) {
      const response = await request(app)
        .post('/api/v1/ai/ask')
        .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it('returns 404 for missing or another owner’s document without retrieval', async () => {
    for (const documentId of [docB, '64b000000000000000000099']) {
      const response = await request(app)
        .post('/api/v1/ai/ask')
        .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
        .send({ question: 'What is in this document?', documentId });
      expect(response.status).toBe(404);
    }
    expect(state.retrievalCalls).toHaveLength(0);
  });

  it('requires the selected document to be processed and embedded', async () => {
    state.documents[0].embeddingStatus = 'processing';
    const response = await request(app)
      .post('/api/v1/ai/ask')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .send({ question: 'What is in this document?', documentId: docA });
    expect(response.status).toBe(409);
    expect(state.retrievalCalls).toHaveLength(0);
  });

  it('passes optional document filters through to the existing owner-scoped retriever', async () => {
    await request(app)
      .post('/api/v1/ai/ask')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .send({ question: 'Summarize this document', documentId: docA, limit: 3 });
    expect(state.retrievalCalls[0]).toEqual([ownerA, [1, 0, 0], { limit: 3, documentId: docA }]);
  });

  it('maps embedding and generation failures to safe client errors', async () => {
    state.embeddingError = new EmbeddingProviderError('RATE_LIMITED', 'private', { status: 429 });
    const limited = await request(app)
      .post('/api/v1/ai/ask').set('Authorization', `Bearer ${tokenFor(ownerA)}`).send({ question: 'q' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toBe('Gemini quota or rate limit reached');

    state.embeddingError = null;
    state.generationError = new GeminiGenerationError('RATE_LIMITED', 'private');
    const quota = await request(app)
      .post('/api/v1/ai/ask').set('Authorization', `Bearer ${tokenFor(ownerA)}`).send({ question: 'q' });
    expect(quota.status).toBe(429);
    expect(quota.body.error.message).toBe('Gemini quota or rate limit reached');

    state.generationError = new GeminiGenerationError('TIMEOUT', 'private');
    const timeout = await request(app)
      .post('/api/v1/ai/ask').set('Authorization', `Bearer ${tokenFor(ownerA)}`).send({ question: 'q' });
    expect(timeout.status).toBe(504);
    expect(timeout.body.error.message).toBe('Answer generation timed out');

    state.generationError = new GeminiGenerationError('MALFORMED_RESPONSE', 'private');
    const malformed = await request(app)
      .post('/api/v1/ai/ask').set('Authorization', `Bearer ${tokenFor(ownerA)}`).send({ question: 'q' });
    expect(malformed.status).toBe(502);
    expect(malformed.body.error.message).toBe('Answer generation is temporarily unavailable');
    expect(JSON.stringify(malformed.body)).not.toContain('private');

    state.generationError = new GeminiGenerationError('PROVIDER_UNAVAILABLE', 'safe', {
      status: 503,
      providerCode: 'UNAVAILABLE',
      providerMessage: 'Temporary upstream capacity issue',
    });
    const unavailable = await request(app)
      .post('/api/v1/ai/ask').set('Authorization', `Bearer ${tokenFor(ownerA)}`).send({ question: 'q' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.message).toBe('Gemini is temporarily unavailable; retry shortly');
    expect(logger.error).toHaveBeenCalledWith({
      upstreamStatus: 503,
      providerCode: 'UNAVAILABLE',
      providerMessage: 'Temporary upstream capacity issue',
    }, 'Gemini answer generation failed');
  });
});
