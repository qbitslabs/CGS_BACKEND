/* CGS appointments module — TypeScript types.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { AppointmentStatus } from '@prisma/client';

export interface AppointmentListQuery {
  clinicId: string;
  date?: string;
  doctorId?: string;
  patientId?: string;
  status?: string;
}

export interface CreateAppointmentDTO {
  patientId: string;
  doctorId?: string;
  service?: string;
  serviceIds?: string[];
  startsAt: string;
  endsAt?: string;
  durationMinutes?: number;
  notes?: string;
}

export interface UpdateAppointmentDTO {
  status?: AppointmentStatus;
  notes?: string;
  doctorId?: string;
  startsAt?: string;
  durationMinutes?: number;
}
