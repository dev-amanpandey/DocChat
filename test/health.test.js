import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { app } from '../src/app.js';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler.js';

const errorTestApp = express();
errorTestApp.get('/api/v1/test-error', () => {
  throw new Error('sensitive internal detail');
});
errorTestApp.use(notFoundHandler, errorHandler);

describe('GET /api/v1/health', () => {
  it('returns the API health status', async () => {
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /health', () => {
  it('returns the API health status', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('centralized error handling', () => {
  it('returns a consistent 404 response for unknown routes', async () => {
    const response = await request(app).get('/api/v1/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: 'Route not found: GET /api/v1/missing' } });
  });

  it('hides internal error details from the client', async () => {
    const response = await request(errorTestApp).get('/api/v1/test-error');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { message: 'Internal server error' } });
  });
});
