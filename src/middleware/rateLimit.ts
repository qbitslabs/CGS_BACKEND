/* In-process rate limit for public edges. One Render instance is the current scale. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { AppError } from './errorHandler.js';

type Bucket = { count: number; resetAt: number };

export function rateLimit(options: {
  windowMs: number;
  max: number;
  key: (req: AuthenticatedRequest) => string;
}) {
  const buckets = new Map<string, Bucket>();

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const key = options.key(req);
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > options.max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      next(new AppError('Too many requests. Try again shortly.', 429, 'RATE_LIMITED'));
      return;
    }

    next();
  };
}

export function clientKey(req: AuthenticatedRequest, extra?: string) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return extra ? `${ip}:${extra}` : ip;
}
