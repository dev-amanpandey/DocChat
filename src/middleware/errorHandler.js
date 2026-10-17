import { logger } from '../config/logger.js';

export function notFoundHandler(req, res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.status = 404;
  next(error);
}

export function errorHandler(error, req, res, _next) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;

  if (status >= 500) logger.error({ err: error, path: req.originalUrl }, 'Request failed');
  else logger.warn({ status, path: req.originalUrl }, error.message);

  res.status(status).json({
    error: {
      message: status === 500 ? 'Internal server error' : error.message,
      ...(status < 500 && error.details ? { details: error.details } : {}),
      ...(envIsDevelopment() && status === 500 ? { details: error.message } : {}),
    },
  });
}

function envIsDevelopment() {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === undefined;
}
