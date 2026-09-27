/* Express middleware: tenant.
 * Auth and request guards shared across CGS routes. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { AppError } from './errorHandler.js';

export const requireTenant = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  if (!req.clinicId) {
    throw new AppError('Tenant context is missing from request.', 403, 'FORBIDDEN');
  }
  next();
};
