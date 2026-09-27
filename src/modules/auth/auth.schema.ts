/* CGS auth module — Zod request schemas.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
