import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: env.CLIENT_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(pinoHttp({
  logger,
  serializers: {
    req: (req) => ({ method: req.method, url: req.originalUrl }),
  },
}));

const healthHandler = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

app.get('/health', healthHandler);
app.get('/api/v1/health', healthHandler);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/documents', documentsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
