/* CGS backend config: env.
 * Environment or database bootstrap used by every API module. */
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/clinic_growth_db?schema=public'),
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().default('super-secret-cgs-jwt-token-key-change-in-production-2026'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  INTERNAL_SERVICE_SECRET: z.string().default('cgs-internal-service-secret-key-998877'),
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  WHATSAPP_SERVICE_URL: z.string().default('http://localhost:5000'),
  CLIENT_FRONTEND_URL: z.string().default('http://localhost:5173'),
  ADMIN_FRONTEND_URL: z.string().default('http://localhost:5174'),
  WORKER_ENABLED: z.string().default('true').transform((val) => val === 'true'),
  WORKER_CONCURRENCY: z.string().default('5').transform((val) => parseInt(val, 10)),
  WORKER_POLL_INTERVAL_MS: z.string().default('1000').transform((val) => parseInt(val, 10)),
});

export const env = envSchema.parse(process.env);
