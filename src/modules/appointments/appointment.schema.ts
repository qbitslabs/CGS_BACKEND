/* CGS appointments module — Zod request schemas.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const listAppointmentsSchema = z.object({
  date: z.string().optional(),
  doctorId: z.string().optional(),
  patientId: z.string().uuid().optional(),
  status: z.string().optional(),
});

export const createAppointmentSchema = z.preprocess((val: any) => {
  if (val && typeof val === 'object') {
    const startsAt = val.startsAt || (val.appointmentDate && val.startTime ? `${val.appointmentDate}T${val.startTime}:00.000Z` : undefined) || new Date().toISOString();
    return {
      ...val,
      startsAt,
      service: val.service || val.reason || 'General Consultation',
      notes: val.notes || val.reason || '',
    };
  }
  return val;
}, z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  service: z.string().default('General Consultation'),
  serviceIds: z.array(z.string().uuid()).optional(),
  startsAt: z.string(), // ISO string
  endsAt: z.string().optional(),
  durationMinutes: z.coerce.number().default(30),
  notes: z.string().optional(),
}));

export const updateAppointmentSchema = z.preprocess((val: any) => {
  if (val && typeof val === 'object') {
    const startsAt = val.startsAt || (val.newDate && val.newTime ? `${val.newDate}T${val.newTime}:00.000Z` : undefined);
    return {
      ...val,
      ...(startsAt ? { startsAt } : {}),
      doctorId: val.doctorId || val.newDoctorId,
      notes: val.notes || val.reason,
    };
  }
  return val;
}, z.object({
  status: z.preprocess(
    (val) => typeof val === 'string' ? val.toUpperCase().replace(/\s+/g, '_') : val,
    z.enum(['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'NO_SHOW'])
  ).optional(),
  notes: z.string().optional(),
  doctorId: z.string().uuid().optional(),
  startsAt: z.string().optional(),
  durationMinutes: z.coerce.number().optional(),
}));
