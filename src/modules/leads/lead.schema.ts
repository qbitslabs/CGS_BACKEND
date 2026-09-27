/* CGS leads module — Zod request schemas.
 * Clinic API layer for leads; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const listLeadsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  source: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  doctorId: z.string().uuid().optional(),
});

export const createLeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8),
  email: z.string().email().optional().or(z.literal('')),
  source: z.enum(['WHATSAPP', 'WEBSITE', 'GOOGLE_AD', 'INSTAGRAM', 'WALK_IN', 'REFERRAL']).default('WHATSAPP'),
  interestedService: z.string().optional(),
  preferredDoctor: z.string().optional(),
  howHeardAboutDoctor: z.string().optional(),
  intent: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  notes: z.string().optional(),
  assignedToUserId: z.string().uuid().optional(),
});

export const updateLeadSchema = z.object({
  status: z.string().optional(),
  notes: z.string().optional(),
  score: z.number().optional(),
  intent: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  assignedToUserId: z.string().uuid().optional(),
});
