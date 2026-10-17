import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().min(1).default('1h'),
  UPLOAD_DIR: z.string().min(1).default('./uploads'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().min(1).max(1024).default(20),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map(({ path, message }) => `${path.join('.')}: ${message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = Object.freeze(parsedEnv.data);
