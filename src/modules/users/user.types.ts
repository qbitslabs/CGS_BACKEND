/* CGS users module — TypeScript types.
 * Clinic API layer for users; talks Prisma or callers, not the AI database. */
import { UserRole, UserStatus } from '@prisma/client';

export interface CreateUserDTO {
  email: string;
  password: string;
  firstName: string;
  lastName?: string;
  title?: string;
  phone?: string;
  role: UserRole;
  specialization?: string;
  registrationNo?: string;
  consultationFee?: number;
}

export interface UserResponseDTO {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: string;
  title?: string | null;
  status: UserStatus;
  lastLoginAt?: Date | null;
  doctorProfile?: {
    specialization?: string | null;
    registrationNo?: string | null;
    consultationFee?: any;
    availabilityDays?: string[];
    availabilityHours?: string | null;
  };
}
