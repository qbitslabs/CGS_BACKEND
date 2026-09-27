/* CGS admin module — TypeScript types.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
export interface AdminDoctorListQuery {
  clinicId?: string;
  specialization?: string;
  isActive?: boolean;
  search?: string;
}

export interface AdminClinicListQuery {
  search?: string;
  status?: string;
  tier?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminUserListQuery {
  search?: string;
  role?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminJobListQuery {
  status?: string;
  queue?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminAIUsageFilterDTO {
  clinicId?: string;
  doctorId?: string;
  model?: string;
  startDate?: string;
  endDate?: string;
  days?: number;
}
