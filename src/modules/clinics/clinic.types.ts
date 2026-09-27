/* CGS clinics module — TypeScript types.
 * Clinic API layer for clinics; talks Prisma or callers, not the AI database. */
export interface UpdateClinicDTO {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  gstin?: string;
  workingHours?: string;
}

export interface CreateClinicServiceDTO {
  name: string;
  description?: string;
  durationMinutes?: number;
  price?: number;
  category?: string;
  serviceType?: 'consultation' | 'procedure';
  doctorId?: string | null;
  doctorIds?: string[];
}
