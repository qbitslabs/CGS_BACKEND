import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

describe('parseEnv', () => {
  const base = {
    NODE_ENV: 'test',
    JWT_SECRET: 'configured-jwt-secret',
    INTERNAL_SERVICE_SECRET: 'configured-internal-secret',
  };

  it('accepts secrets supplied by the environment', () => {
    const env = parseEnv(base as NodeJS.ProcessEnv);
    expect(env.JWT_SECRET).toBe('configured-jwt-secret');
    expect(env.INTERNAL_SERVICE_SECRET).toBe('configured-internal-secret');
    expect(env.STAFF_ACCESS_TOKEN_EXPIRES_IN).toBe('15m');
    expect(env.AI_REPLY_CONCURRENCY).toBe(10);
  });

  it('refuses to start when JWT_SECRET is missing', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: '' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ NODE_ENV: 'production', INTERNAL_SERVICE_SECRET: 'set' } as NodeJS.ProcessEnv)).toThrow(
      /JWT_SECRET/
    );
  });

  it('refuses to start when INTERNAL_SERVICE_SECRET is missing', () => {
    expect(() => parseEnv({ ...base, INTERNAL_SERVICE_SECRET: '' } as NodeJS.ProcessEnv)).toThrow(
      /INTERNAL_SERVICE_SECRET/
    );
  });
});
