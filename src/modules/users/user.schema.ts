/* CGS users module — Zod request schemas.
 * Clinic API layer for users; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  role: z.enum(['DOCTOR', 'EMPLOYEE']),
  specialization: z.string().optional(),
  registrationNo: z.string().optional(),
  consultationFee: z.number().optional(),
});

export const updateUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']),
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  registrationNo: z.string().optional(),
  consultationFee: z.coerce.number().optional(),
  availabilityDays: z.array(z.string()).optional(),
  availabilityHours: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const createDoctorLeaveSchema = z.object({
  doctorId: z.string().optional(),
  date: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  reason: z.string().optional(),
});

