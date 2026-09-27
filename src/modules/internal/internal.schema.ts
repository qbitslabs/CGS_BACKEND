/* CGS internal module — Zod request schemas.
 * Clinic API layer for internal; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const whatsappEventSchema = z.object({
  providerEventId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  eventType: z.string().default('messages'),
  payload: z.any(),
});

export const whatsappInboundMessageSchema = z.object({
  phoneNumberId: z.string().min(1),
  senderPhone: z.string().min(5),
  senderName: z.string().default('Patient'),
  content: z.string().min(1),
  providerMessageId: z.string().min(1),
  mediaUrl: z.string().optional(),
});

// The AI service sends JSON null for unknown optional fields (e.g. patientId it
// does not have yet). Plain .optional() rejects null, so treat null/'' as absent.
const optionalUuid = z.preprocess(
  (v) => (v === null || v === '' ? undefined : v),
  z.string().uuid().optional()
);
const optionalText = z.preprocess(
  (v) => (v === null || v === '' ? undefined : v),
  z.string().optional()
);

export const aiContextSchema = z.object({
  clinicId: optionalUuid,
  doctorId: optionalUuid,
});

export const aiPatientSchema = z.object({
  clinicId: z.string().uuid(),
  phone: optionalText,
  patientId: optionalUuid,
});

export const aiLeadSchema = z.object({
  clinicId: z.string().uuid(),
  phone: optionalText,
  leadId: optionalUuid,
  name: optionalText,
  interestedService: optionalText,
  intent: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
});

export const aiAvailabilitySchema = z.object({
  clinicId: z.string().uuid(),
  doctorId: optionalUuid,
  date: z.string(), // YYYY-MM-DD
});

export const aiBookAppointmentSchema = z.object({
  clinicId: z.string().uuid(),
  patientPhone: z.string().min(5),
  patientName: z.string().min(1),
  doctorId: optionalUuid,
  service: z.string().default('General Consultation'),
  date: z.string(), // YYYY-MM-DD
  time: z.string(), // e.g. "10:30" or "10:30 AM"
  notes: optionalText,
  age: z.coerce.number().int().min(1).max(120).optional(),
  gender: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      const n = v.trim().toUpperCase();
      if (n === 'MALE' || n === 'M' || n === 'MALE.') return 'MALE' as const;
      if (n === 'FEMALE' || n === 'F' || n === 'FEMALE.') return 'FEMALE' as const;
      if (n === 'OTHER' || n === 'O') return 'OTHER' as const;
      return undefined;
    }),
  allergies: z.array(z.string()).optional(),
  medicalHistoryNotes: optionalText,
});

export const aiRescheduleAppointmentSchema = z.object({
  clinicId: z.string().uuid(),
  appointmentId: z.string().uuid(),
  date: z.string(), // YYYY-MM-DD
  time: z.string(), // e.g. "10:30" or "10:30 AM"
  doctorId: optionalUuid,
  notes: optionalText,
});

export const aiHandoffSchema = z.object({
  clinicId: z.string().uuid(),
  conversationId: z.string().uuid(),
  reason: z.string().min(3),
  severity: z.enum(['normal', 'critical']).default('normal'),
});

export const aiRecordUsageSchema = z.object({
  clinicId: z.string().uuid().optional().nullable(),
  doctorId: z.string().uuid().optional().nullable(),
  conversationId: z.string().uuid().optional().nullable(),
  messageId: z.string().uuid().optional().nullable(),
  requestId: z.string(),
  entityType: z.enum(['CLINIC', 'CHATBOT', 'ECOMMERCE', 'RESTAURANT', 'EDUCATION', 'REAL_ESTATE']).default('CLINIC'),
  entityId: z.string(),
  operationType: z.enum(['CONVERSATION_RESPONSE', 'SUMMARY_ADDON', 'SUMMARY_MERGE', 'SUMMARY_REBUILD', 'TOOL_EXECUTION']).default('CONVERSATION_RESPONSE'),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  inputCost: z.number().default(0),
  outputCost: z.number().default(0),
  totalCost: z.number().default(0),
  currency: z.string().default('INR'),
  durationMs: z.number().default(0),
  success: z.boolean().default(true),
  errorCode: z.string().optional().nullable(),
  metadata: z.any().optional(),
});

export const syncSummarySchema = z.object({
  conversationId: z.string().uuid(),
  clinicId: z.string().uuid().optional(),
  participantPhone: z.string().min(6).optional(),
  version: z.number().int().positive().default(1),
  summaryText: z.string().min(1),
  topics: z.array(z.string()).default([]),
  entities: z.record(z.any()).default({}),
  intent: z.string().optional(),
  sentiment: z.string().optional(),
  keyPoints: z.array(z.string()).default([]),
  actionItems: z.array(z.string()).default([]),
  source: z.enum(['ADDON_MERGE', 'REBUILD', 'DIRECT']).default('ADDON_MERGE'),
});
