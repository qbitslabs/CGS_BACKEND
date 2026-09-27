/* CGS auth module — HTTP handlers.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { authService, AuthService } from './auth.service.js';
import { loginSchema } from './auth.schema.js';
import { logAuditEvent } from '../../middleware/audit.js';

export class AuthController {
  constructor(private readonly service: AuthService = authService) {}

  login = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = loginSchema.parse(req.body);
      const data = await this.service.login(body, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  getMe = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getCurrentUser(req.user!.userId);
      res.json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  logout = async (req: AuthenticatedRequest, res: Response) => {
    if (req.user) {
      await logAuditEvent({
        clinicId: req.user.clinicId,
        userId: req.user.userId,
        actorId: req.user.userId,
        actorEmail: req.user.email,
        action: 'LOGOUT',
        resourceType: 'USER',
        resourceId: req.user.userId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });
    }

    res.json({
      success: true,
      message: 'Logged out successfully.',
    });
  };
}

export const authController = new AuthController();
