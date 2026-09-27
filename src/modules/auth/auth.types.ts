/* CGS auth module — TypeScript types.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
export interface LoginDTO {
  email: string;
  password: string;
}

export interface AuthResponseDTO {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    title: string;
    clinicId: string;
    clinicName: string;
    phone?: string;
    doctorId?: string;
    isPrimaryDoctor?: boolean;
    seesAllClinicData?: boolean;
  };
}

export interface AuthUserProfileDTO {
  id: string;
  name: string;
  email: string;
  role: string;
  title: string;
  clinicId: string;
  clinicName: string;
  phone?: string;
  doctorId?: string;
  isPrimaryDoctor?: boolean;
  seesAllClinicData?: boolean;
  permissions: string[];
}
