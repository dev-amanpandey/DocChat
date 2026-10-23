import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

const documentStore = vi.hoisted(() => ({ documents: new Map(), nextId: 1, failCreate: false }));
const cloudStore = vi.hoisted(() => ({ assets: new Set(), failUpload: false, failDelete: false }));
const chunkStore = vi.hoisted(() => ({ chunks: [] }));
const searchStore = vi.hoisted(() => ({ queryEmbedding: [1, 0, 0], results: [] }));
vi.mock('../src/services/documentProcessing.js', () => ({ queueDocumentProcessing: vi.fn() }));
vi.mock('../src/services/documentEmbeddings.js', () => ({
  queueDocumentEmbedding: vi.fn(),
  searchOwnedChunks: vi.fn(async () => searchStore.results),
}));
vi.mock('../src/services/embeddingProvider.js', () => ({
  createEmbeddings: vi.fn(async () => [searchStore.queryEmbedding]),
  embeddingModel: 'test-embedding-model',
  embeddingDimensions: 3,
  EmbeddingProviderError: class EmbeddingProviderError extends Error {
    constructor(code, message, options = {}) { super(message); this.code = code; this.status = options.status; }
  },
}));

vi.mock('../src/services/documentStorage.js', async () => {
  const actual = await vi.importActual('../src/services/documentStorage.js');
  return {
    ...actual,
    uploadDocument: vi.fn(async (_file, _name) => {
      if (cloudStore.failUpload) throw new Error('Cloudinary upload failed');
      const publicId = `docchat/00000000-0000-4000-8000-${String(cloudStore.assets.size + 1).padStart(12, '0')}`;
      cloudStore.assets.add(publicId);
      return { publicId, resourceType: 'raw', deliveryType: 'authenticated' };
    }),
    removeStoredFile: vi.fn(async (publicId) => {
      if (cloudStore.failDelete) throw new Error('Cloudinary cleanup failed');
      cloudStore.assets.delete(publicId);
    }),
  };
});

vi.mock('../src/models/Document.js', () => {
  class MockDocument {
    static async create(fields) {
      if (documentStore.failCreate) throw new Error('database write failed');
      const id = `64b00000000000000000000${documentStore.nextId++}`;
      const document = {
        ...fields,
        id,
        _id: { toString: () => id },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        async deleteOne() {
          if (documentStore.failDeleteRecord) throw new Error('database delete failed');
          documentStore.documents.delete(id);
        },
      };
      documentStore.documents.set(id, document);
      return document;
    }

    static find(filter) {
      const matching = [...documentStore.documents.values()]
        .filter((document) => document.owner === filter.owner);
      let skip = 0;
      let limit = matching.length;
      const query = {
        sort() { return this; },
        skip(value) { skip = value; return this; },
        limit(value) { limit = value; return this; },
        then(resolve, reject) {
          return Promise.resolve(matching.slice(skip, skip + limit)).then(resolve, reject);
        },
      };
      return query;
    }

    static async countDocuments(filter) {
      return [...documentStore.documents.values()]
        .filter((document) => document.owner === filter.owner).length;
    }

    static findOne(filter) {
      const document = documentStore.documents.get(filter._id) ?? null;
      const ownedDocument = document?.owner === filter.owner ? document : null;
      return {
        select: async () => ownedDocument,
        then: (resolve, reject) => Promise.resolve(ownedDocument).then(resolve, reject),
      };
    }

    static async updateOne(filter, update) {
      const document = documentStore.documents.get(filter._id);
      if (!document || document.owner !== filter.owner) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.status?.$in && !filter.status.$in.includes(document.status)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(document, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete document[key];
      for (const [key, amount] of Object.entries(update.$inc ?? {})) document[key] = (document[key] ?? 0) + amount;
      return { matchedCount: 1, modifiedCount: 1 };
    }
  }

  return { Document: MockDocument };
});

vi.mock('../src/models/DocumentChunk.js', () => {
  class MockDocumentChunk {
    static async deleteMany(filter) {
      chunkStore.chunks = chunkStore.chunks.filter((chunk) =>
        chunk.document !== filter.document || chunk.owner !== filter.owner);
      return { deletedCount: 0 };
    }
    static async insertMany(chunks) {
      chunkStore.chunks.push(...chunks);
      return chunks;
    }
    static find(filter) {
      const matching = chunkStore.chunks.filter((chunk) =>
        chunk.document === filter.document && chunk.owner === filter.owner);
      let skip = 0;
      let limit = matching.length;
      return {
        sort() { return this; },
        skip(value) { skip = value; return this; },
        limit(value) { limit = value; return this; },
        then(resolve, reject) { return Promise.resolve(matching.slice(skip, skip + limit)).then(resolve, reject); },
      };
    }
    static async countDocuments(filter) {
      return chunkStore.chunks.filter((chunk) =>
        chunk.document === filter.document && chunk.owner === filter.owner).length;
    }
  }
  return { DocumentChunk: MockDocumentChunk };
});

const { app } = await import('../src/app.js');

const ownerA = '64a000000000000000000001';
const ownerB = '64a000000000000000000002';
const tokenFor = (owner) => jwt.sign({}, env.JWT_SECRET, {
  subject: owner,
  algorithm: 'HS256',
});
const pdf = Buffer.from('%PDF-1.7 test document');

async function uploadPdf(token, filename = 'sample.pdf') {
  return request(app)
    .post('/api/v1/documents/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', pdf, { filename, contentType: 'application/pdf' });
}

beforeEach(async () => {
  documentStore.documents.clear();
  documentStore.nextId = 1;
  documentStore.failCreate = false;
  documentStore.failDeleteRecord = false;
  cloudStore.assets.clear();
  cloudStore.failUpload = false;
  cloudStore.failDelete = false;
  chunkStore.chunks = [];
  searchStore.queryEmbedding = [1, 0, 0];
  searchStore.results = [];
});

describe('document API', () => {
  it('rejects unauthenticated uploads', async () => {
    const response = await request(app)
      .post('/api/v1/documents/upload')
      .attach('file', pdf, { filename: 'sample.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(401);
    expect(documentStore.documents.size).toBe(0);
  });

  it('accepts a valid upload and returns metadata without its storage key', async () => {
    const response = await uploadPdf(tokenFor(ownerA), '../../report.pdf');

    expect(response.status).toBe(201);
    expect(response.body.document).toMatchObject({
      id: expect.any(String),
      originalName: 'report.pdf',
      resourceType: 'raw',
      mimeType: 'application/pdf',
      size: pdf.length,
      status: 'uploaded',
    });
    expect(response.body.document).not.toHaveProperty('publicId');
    expect(response.body.document).not.toHaveProperty('path');
    expect(cloudStore.assets.size).toBe(1);
  });

  it('rejects a missing file', async () => {
    const response = await request(app)
      .post('/api/v1/documents/upload')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .field('note', 'no file attached');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/file is required/i);
  });

  it('rejects unsupported or mismatched file types', async () => {
    const response = await request(app)
      .post('/api/v1/documents/upload')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .attach('file', Buffer.from('not a pdf'), { filename: 'script.exe', contentType: 'application/pdf' });

    expect(response.status).toBe(415);
    expect(response.body.error.message).toBe('Unsupported file type');
    expect(cloudStore.assets.size).toBe(0);
  });

  it('rejects files that exceed the configured size limit', async () => {
    const response = await request(app)
      .post('/api/v1/documents/upload')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .attach('file', Buffer.alloc(1024 * 1024 + 1, 65), {
        filename: 'large.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(413);
    expect(response.body.error.message).toMatch(/upload limit/i);
    expect(documentStore.documents.size).toBe(0);
  });

  it('lists only the authenticated user documents', async () => {
    await uploadPdf(tokenFor(ownerA), 'owned.pdf');
    await uploadPdf(tokenFor(ownerB), 'other.pdf');

    const response = await request(app)
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(200);
    expect(response.body.documents).toHaveLength(1);
    expect(response.body.documents[0].originalName).toBe('owned.pdf');
    expect(response.body.documents[0]).not.toHaveProperty('publicId');
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1, pages: 1 });
  });

  it('does not allow a user to retrieve another user document', async () => {
    const created = await uploadPdf(tokenFor(ownerB));
    const response = await request(app)
      .get(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Document not found');
  });

  it('returns metadata for an owned document', async () => {
    const created = await uploadPdf(tokenFor(ownerA), 'owned.pdf');
    const response = await request(app)
      .get(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(200);
    expect(response.body.document).toMatchObject({
      id: created.body.document.id,
      originalName: 'owned.pdf',
      mimeType: 'application/pdf',
      size: pdf.length,
    });
    expect(response.body.document).not.toHaveProperty('publicId');
  });

  it('returns 404 for a nonexistent document', async () => {
    const response = await request(app)
      .get('/api/v1/documents/64b000000000000000000099')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Document not found');
  });

  it('rejects malformed document IDs', async () => {
    const response = await request(app)
      .get('/api/v1/documents/not-an-object-id')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Invalid document ID');
  });

  it('does not allow a user to delete another user document', async () => {
    const created = await uploadPdf(tokenFor(ownerB));
    const assetsBefore = new Set(cloudStore.assets);
    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(404);
    expect(documentStore.documents.size).toBe(1);
    expect(cloudStore.assets).toEqual(assetsBefore);
  });

  it('deletes an owned document and its Cloudinary asset', async () => {
    const created = await uploadPdf(tokenFor(ownerA));
    expect(cloudStore.assets.size).toBe(1);

    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'Document deleted' });
    expect(documentStore.documents.size).toBe(0);
    expect(cloudStore.assets.size).toBe(0);
  });

  it('does not save a record when Cloudinary upload fails', async () => {
    cloudStore.failUpload = true;
    const response = await uploadPdf(tokenFor(ownerA));
    expect(response.status).toBe(500);
    expect(documentStore.documents.size).toBe(0);
  });

  it('cleans up a Cloudinary asset when MongoDB persistence fails', async () => {
    documentStore.failCreate = true;
    const response = await uploadPdf(tokenFor(ownerA));
    expect(response.status).toBe(500);
    expect(cloudStore.assets.size).toBe(0);
  });

  it('keeps deletion safe and reports Cloudinary cleanup failure', async () => {
    const created = await uploadPdf(tokenFor(ownerA));
    cloudStore.failDelete = true;
    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);
    expect(response.status).toBe(500);
    expect(documentStore.documents.size).toBe(1);
    expect(cloudStore.assets.size).toBe(1);
  });

  it('reports a database deletion failure after Cloudinary removal', async () => {
    const created = await uploadPdf(tokenFor(ownerA));
    documentStore.failDeleteRecord = true;
    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);
    expect(response.status).toBe(500);
    expect(documentStore.documents.size).toBe(1);
    expect(cloudStore.assets.size).toBe(0);
  });

  it('returns only chunks for the authenticated owner', async () => {
    const createdA = await uploadPdf(tokenFor(ownerA), 'a.pdf');
    const createdB = await uploadPdf(tokenFor(ownerB), 'b.pdf');
    const documentA = documentStore.documents.get(createdA.body.document.id);
    const documentB = documentStore.documents.get(createdB.body.document.id);
    documentA.status = 'ready';
    documentB.status = 'ready';
    chunkStore.chunks.push(
      { document: documentA.id, owner: ownerA, chunkIndex: 0, pageNumber: 1, text: 'owner A text' },
      { document: documentB.id, owner: ownerB, chunkIndex: 0, pageNumber: 1, text: 'owner B secret' },
    );

    const response = await request(app)
      .get(`/api/v1/documents/${documentA.id}/chunks`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(200);
    expect(response.body.chunks).toEqual([{ chunkIndex: 0, pageNumber: 1, text: 'owner A text' }]);
  });

  it('removes document chunks when the document is deleted', async () => {
    const created = await uploadPdf(tokenFor(ownerA));
    chunkStore.chunks.push({
      document: created.body.document.id,
      owner: ownerA,
      chunkIndex: 0,
      pageNumber: 1,
      text: 'text',
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
    });

    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(200);
    expect(chunkStore.chunks).toHaveLength(0);
  });

  it('rejects empty semantic search queries before embedding', async () => {
    const response = await request(app)
      .post('/api/v1/documents/search')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .send({ query: '   ' });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Invalid search query');
  });

  it('requires authentication for semantic search and returns ranked owned sources', async () => {
    searchStore.results = [{
      score: 0.98,
      document: { id: '64b000000000000000000001', originalName: 'owned.pdf' },
      chunk: { id: '64c000000000000000000001', chunkIndex: 0, pageNumber: 3, text: 'owned content' },
    }];
    const unauthorized = await request(app).post('/api/v1/documents/search').send({ query: 'find this' });
    expect(unauthorized.status).toBe(401);

    const response = await request(app)
      .post('/api/v1/documents/search')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`)
      .send({ query: 'find this', limit: 4 });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual(searchStore.results);
    const { createEmbeddings } = await import('../src/services/embeddingProvider.js');
    expect(createEmbeddings).toHaveBeenLastCalledWith(['find this'], { taskType: 'RETRIEVAL_QUERY' });
  });
});
