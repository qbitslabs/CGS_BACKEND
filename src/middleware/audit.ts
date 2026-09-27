/* Express middleware: audit.
 * Auth and request guards shared across CGS routes. */
import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../types/index.js';
import { prisma } from '../config/db.js';

export const requestTracing = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const correlationId = (req.headers['x-request-id'] as string) || uuidv4();
  req.correlationId = correlationId;
  res.setHeader('X-Request-ID', correlationId);
  next();
};

export const logAuditEvent = async (params: {
  clinicId?: string;
  userId?: string;
  actorId: string;
  actorEmail: string;
  actorType?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: any;
  diffBefore?: any;
  diffAfter?: any;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}) => {
  try {
    await prisma.auditLog.create({
      data: {
        clinicId: params.clinicId,
        userId: params.userId,
        actorId: params.actorId,
        actorEmail: params.actorEmail,
        actorType: params.actorType || 'CLINIC_USER',
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        metadata: params.metadata ?? undefined,
        diffBefore: params.diffBefore ?? undefined,
        diffAfter: params.diffAfter ?? undefined,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        requestId: params.requestId,
      },
    });
  } catch (error) {
    console.error('Failed to log audit event:', error);
  }
};
