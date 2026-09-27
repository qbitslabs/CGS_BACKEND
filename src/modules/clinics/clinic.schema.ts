/* CGS clinics module — Zod request schemas.
 * Clinic API layer for clinics; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const updateClinicSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  gstin: z.string().optional(),
  workingHours: z.string().optional(),
  aiConfig: z
    .object({
      isAiEnabled: z.boolean().optional(),
      systemPrompt: z.string().optional(),
      customInstructions: z.string().optional(),
      greetingMessage: z.string().optional(),
      receptionistName: z.string().optional(),
      tone: z.string().optional(),
      primaryModel: z.string().optional(),
      humanHandoffKeywords: z.array(z.string()).optional(),
      conversationInstructions: z.string().optional(),
      clinicInformation: z.string().optional(),
      servicesTreatments: z.string().optional(),
      doctorsInfo: z.string().optional(),
      consultationDetails: z.string().optional(),
      timings: z.string().optional(),
      faqs: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    })
    .optional(),
});

export const createServiceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  durationMinutes: z.coerce.number().default(30),
  price: z.coerce.number().min(0).optional().default(0),
  category: z.string().default('General'),
  serviceType: z.enum(['consultation', 'procedure']).optional(),
  doctorId: z.string().uuid().optional().nullable(),
  doctorIds: z.array(z.string().uuid()).optional(),
});

export const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  durationMinutes: z.coerce.number().optional(),
  price: z.coerce.number().min(0).optional(),
  category: z.string().optional(),
  isActive: z.boolean().optional(),
  serviceType: z.enum(['consultation', 'procedure']).optional(),
  doctorId: z.string().uuid().optional().nullable(),
  doctorIds: z.array(z.string().uuid()).optional(),
});
