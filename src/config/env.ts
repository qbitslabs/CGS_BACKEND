/* CGS backend config: env.
 * Environment or database bootstrap used by every API module.
 * Security secrets have no source-code defaults. Local and production
 * both supply them through the environment. */
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/clinic_growth_db?schema=public'),
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  STAFF_ACCESS_TOKEN_EXPIRES_IN: z.string().default('15m'),
  STAFF_REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  INTERNAL_SERVICE_SECRET: z.string().min(1, 'INTERNAL_SERVICE_SECRET is required'),
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  WHATSAPP_SERVICE_URL: z.string().default('http://localhost:5000'),
  CLIENT_FRONTEND_URL: z.string().default('http://localhost:5173'),
  ADMIN_FRONTEND_URL: z.string().default('http://localhost:5174'),
  WORKER_ENABLED: z.string().default('true').transform((val) => val === 'true'),
  WORKER_CONCURRENCY: z.string().default('5').transform((val) => parseInt(val, 10)),
  WORKER_POLL_INTERVAL_MS: z.string().default('1000').transform((val) => parseInt(val, 10)),
  // How many AI replies may run at once. Stays under the AI database pool (~15).
  AI_REPLY_CONCURRENCY: z.string().default('10').transform((val) => parseInt(val, 10)),
});

export type AppEnv = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `CGS backend refused to start because required environment variables are missing or invalid.\n${details}`
    );
  }
  return parsed.data;
}

export const env = parseEnv(process.env);
