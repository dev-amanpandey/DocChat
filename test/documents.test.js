import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { env } from '../src/config/env.js';

const documentStore = vi.hoisted(() => ({ documents: new Map(), nextId: 1 }));

vi.mock('../src/models/Document.js', () => {
  class MockDocument {
    static async create(fields) {
      const id = `64b00000000000000000000${documentStore.nextId++}`;
      const document = {
        ...fields,
        id,
        _id: { toString: () => id },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        async deleteOne() {
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
  }

  return { Document: MockDocument };
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
  await rm(env.UPLOAD_DIR, { recursive: true, force: true });
  await mkdir(env.UPLOAD_DIR, { recursive: true });
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
      mimeType: 'application/pdf',
      size: pdf.length,
      status: 'uploaded',
    });
    expect(response.body.document).not.toHaveProperty('storedName');
    expect(response.body.document).not.toHaveProperty('path');
    expect((await readdir(env.UPLOAD_DIR))).toHaveLength(1);
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
    expect(await readdir(env.UPLOAD_DIR)).toHaveLength(0);
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
    expect(response.body.documents[0]).not.toHaveProperty('storedName');
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

  it('rejects malformed document IDs', async () => {
    const response = await request(app)
      .get('/api/v1/documents/not-an-object-id')
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Invalid document ID');
  });

  it('does not allow a user to delete another user document', async () => {
    const created = await uploadPdf(tokenFor(ownerB));
    const filesBefore = await readdir(env.UPLOAD_DIR);
    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(404);
    expect(documentStore.documents.size).toBe(1);
    expect(await readdir(env.UPLOAD_DIR)).toEqual(filesBefore);
  });

  it('deletes an owned document and its file', async () => {
    const created = await uploadPdf(tokenFor(ownerA));
    const fileName = (await readdir(env.UPLOAD_DIR))[0];
    expect(fileName).toMatch(/^[0-9a-f-]{36}\.pdf$/i);

    const response = await request(app)
      .delete(`/api/v1/documents/${created.body.document.id}`)
      .set('Authorization', `Bearer ${tokenFor(ownerA)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'Document deleted' });
    expect(documentStore.documents.size).toBe(0);
    expect(await readdir(env.UPLOAD_DIR)).toHaveLength(0);
  });
});
