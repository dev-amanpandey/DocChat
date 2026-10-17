import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/docchat-test';
process.env.JWT_SECRET ??= 'test-secret-that-is-only-used-by-the-test-suite';
process.env.MAX_UPLOAD_SIZE_MB ??= '1';
process.env.UPLOAD_DIR ??= await mkdtemp(path.join(tmpdir(), 'docchat-uploads-test-'));

afterAll(async () => {
  if (process.env.UPLOAD_DIR?.includes('docchat-uploads-test-')) {
    await rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});
