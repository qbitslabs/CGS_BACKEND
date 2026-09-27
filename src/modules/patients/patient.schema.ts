/* CGS patients module — Zod request schemas.
 * Clinic API layer for patients; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const listPatientsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  status: z.string().optional(),
  doctorId: z.string().uuid().optional(),
});

export const createPatientSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8),
  email: z.string().email().optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  age: z.number().optional(),
  dateOfBirth: z.string().optional(),
  bloodGroup: z.string().optional(),
  address: z.string().optional(),
  allergies: z.array(z.string()).default([]),
  medicalHistoryNotes: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING_FOLLOWUP']).default('ACTIVE'),
});

export const updatePatientSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  age: z.number().optional(),
  bloodGroup: z.string().optional(),
  address: z.string().optional(),
  allergies: z.array(z.string()).optional(),
  medicalHistoryNotes: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING_FOLLOWUP']).optional(),
});
