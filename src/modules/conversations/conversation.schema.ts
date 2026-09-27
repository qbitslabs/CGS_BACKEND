/* CGS conversations module — Zod request schemas.
 * Clinic API layer for conversations; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const listConversationsSchema = z.object({
  state: z.string().optional(),
  search: z.string().optional(),
  doctorId: z.string().uuid().optional(),
});

export const getMessagesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const sendStaffMessageSchema = z.object({
  content: z.string().min(1, 'Message content cannot be empty'),
  mediaUrl: z.string().url().optional(),
});

export const simulateInboundSchema = z.object({
  content: z.string().min(1, 'Message content cannot be empty'),
});

export const updateConversationSchema = z.object({
  state: z.preprocess(
    (val) => (typeof val === 'string' ? val.toUpperCase().replace(/\s+/g, '_') : val),
    z.enum(['AI_ACTIVE', 'HUMAN_ACTIVE', 'HANDOFF_PENDING', 'CLOSED']).optional()
  ),
  handoffReason: z.string().optional().nullable(),
  internalNotes: z.string().optional(),
  assignedToUserId: z.string().uuid().optional().nullable(),
  doctorId: z.string().uuid().optional().nullable(),
});
