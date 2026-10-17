import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI);
  logger.info('Connected to MongoDB');
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
