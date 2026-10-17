import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './db/mongoose.js';

let server;

async function start() {
  try {
    await connectDatabase();
    server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, 'DocChat API listening');
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start DocChat API');
    process.exitCode = 1;
  }
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await disconnectDatabase();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      logger.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    });
  });
}

await start();
