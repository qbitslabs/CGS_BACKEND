/* Shared Express/request types for the CGS API.
 * Used by controllers after auth middleware attaches the user. */
import { Request } from 'express';
import { UserRole } from '@prisma/client';

export interface AuthUserPayload {
  userId: string;
  clinicId: string;
  role: UserRole;
  email: string;
  name: string;
}

export interface AdminAuthPayload {
  adminId: string;
  email: string;
  name: string;
  role: string;
  type: 'ADMIN';
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
  admin?: AdminAuthPayload;
  clinicId?: string;
  correlationId?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
