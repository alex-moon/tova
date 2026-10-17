import type { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logService';

// One compact line per request; the logs endpoint is skipped so polling doesn't spam the buffer.
// @see #76
export const requestLog = (req: Request, res: Response, next: NextFunction) => {
  const skip = req.method === 'GET' && req.path === '/api/admin/logs';
  if (skip) return next();

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level](
      `${req.method} ${req.originalUrl.split('?')[0]} -> ${status} (${Math.round(ms)}ms)`,
    );
  });
  return next();
};
