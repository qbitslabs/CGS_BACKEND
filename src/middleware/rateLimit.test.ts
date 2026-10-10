import { describe, expect, it, vi } from 'vitest';
import { rateLimit, clientKey } from './rateLimit.js';
import { AppError } from './errorHandler.js';

function runLimit(max: number) {
  const guard = rateLimit({
    windowMs: 60_000,
    max,
    key: (req) => clientKey(req as any, 'login'),
  });
  return (ip: string) =>
    new Promise<number>((resolve, reject) => {
      const res = { setHeader: vi.fn() };
      guard({ ip, socket: {} } as any, res as any, (err?: unknown) => {
        if (err instanceof AppError) resolve(err.statusCode);
        else if (err) reject(err);
        else resolve(200);
      });
    });
}

describe('rateLimit', () => {
  it('blocks login attempts after the window max', async () => {
    const attempt = runLimit(2);
    expect(await attempt('10.0.0.1')).toBe(200);
    expect(await attempt('10.0.0.1')).toBe(200);
    expect(await attempt('10.0.0.1')).toBe(429);
  });

  it('does not share a bucket across clients', async () => {
    const attempt = runLimit(1);
    expect(await attempt('10.0.0.2')).toBe(200);
    expect(await attempt('10.0.0.3')).toBe(200);
    expect(await attempt('10.0.0.2')).toBe(429);
  });
});
