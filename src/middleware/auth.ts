/* Express middleware: auth.
 * Auth and request guards shared across CGS routes. */
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AdminAuthPayload, AuthenticatedRequest, AuthUserPayload } from '../types/index.js';
import { AppError } from './errorHandler.js';
import { findActiveStaffSession } from '../modules/auth/staffSession.js';

function readBearer(req: AuthenticatedRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.split(' ')[1] || null;
}

async function attachStaffUser(req: AuthenticatedRequest, token: string) {
  let decoded: AuthUserPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as AuthUserPayload;
  } catch {
    throw new AppError('Invalid or expired authentication token.', 401, 'INVALID_TOKEN');
  }

  if (decoded.type === 'ADMIN' || decoded.tokenUse !== 'staff' || !decoded.sid) {
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_TOKEN');
  }

  const session = await findActiveStaffSession(decoded.sid);
  if (!session || session.userId !== decoded.userId) {
    throw new AppError('Session expired. Please log in again.', 401, 'SESSION_REVOKED');
  }

  req.user = decoded;
  req.clinicId = decoded.clinicId;
}

export const requireAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const token = readBearer(req);
  if (!token) {
    next(new AppError('Authentication required. Missing or malformed token.', 401, 'UNAUTHORIZED'));
    return;
  }

  void attachStaffUser(req, token)
    .then(() => next())
    .catch(next);
};

export const optionalStaffAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const token = readBearer(req);
  if (!token) {
    next();
    return;
  }

  void attachStaffUser(req, token)
    .then(() => next())
    .catch(() => next());
};

export const requireAdminAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('Admin authentication required. Missing or malformed token.', 401, 'UNAUTHORIZED');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AdminAuthPayload;
    if (decoded.type !== 'ADMIN' || !decoded.adminId) {
      throw new AppError('Admin authentication required.', 401, 'UNAUTHORIZED');
    }
    req.admin = decoded;
    next();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Invalid or expired admin authentication token.', 401, 'INVALID_TOKEN');
  }
};

export const requireInternalServiceAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const serviceKey =
    req.headers['x-internal-service-key'] || req.headers['x-service-key'];
  if (!serviceKey || serviceKey !== env.INTERNAL_SERVICE_SECRET) {
    throw new AppError('Unauthorized internal service call.', 401, 'INVALID_SERVICE_AUTH');
  }
  next();
};
