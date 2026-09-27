/* CGS patients module — TypeScript types.
 * Clinic API layer for patients; talks Prisma or callers, not the AI database. */
import { Gender, PatientStatus } from '@prisma/client';

export interface PatientListQuery {
  clinicId: string;
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  doctorId?: string;
}

export interface CreatePatientDTO {
  name: string;
  phone: string;
  email?: string;
  gender?: Gender;
  age?: number;
  dateOfBirth?: string;
  bloodGroup?: string;
  address?: string;
  allergies?: string[];
  medicalHistoryNotes?: string;
  status?: PatientStatus;
}

export interface UpdatePatientDTO {
  name?: string;
  phone?: string;
  email?: string;
  gender?: Gender;
  age?: number;
  bloodGroup?: string;
  address?: string;
  allergies?: string[];
  medicalHistoryNotes?: string;
  status?: PatientStatus;
}
