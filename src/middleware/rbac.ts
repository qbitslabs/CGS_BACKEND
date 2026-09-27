/* Express middleware: rbac.
 * Auth and request guards shared across CGS routes. */
import { Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types/index.js';
import { AppError } from './errorHandler.js';

export const requireRole = (allowedRoles: UserRole[]) => {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      throw new AppError(
        `Forbidden: Role '${req.user?.role || 'UNKNOWN'}' is not authorized for this resource.`,
        403,
        'FORBIDDEN'
      );
    }
    next();
  };
};

export const requireDoctor = requireRole([UserRole.DOCTOR]);
export const requireClinicStaff = requireRole([UserRole.DOCTOR, UserRole.EMPLOYEE]);
