/* CGS auth module — HTTP handlers.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { authService, AuthService } from './auth.service.js';
import { changePasswordSchema, loginSchema } from './auth.schema.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { REFRESH_COOKIE, readRefreshCookie, refreshCookieOptions } from './staffSession.js';

function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
}

function clearRefreshCookie(res: Response) {
  const options = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
  });
}

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

      setRefreshCookie(res, data.refreshToken);
      res.json({
        success: true,
        data: {
          accessToken: data.accessToken,
          user: data.user,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  refresh = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.refresh(readRefreshCookie(req.headers.cookie), {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });
      setRefreshCookie(res, data.refreshToken);
      res.json({
        success: true,
        data: { accessToken: data.accessToken },
      });
    } catch (error) {
      clearRefreshCookie(res);
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

  logout = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
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

      await this.service.logout({
        sessionId: req.user?.sid,
        refreshToken: readRefreshCookie(req.headers.cookie),
      });
      clearRefreshCookie(res);
      res.json({
        success: true,
        message: 'Logged out successfully.',
      });
    } catch (error) {
      next(error);
    }
  };

  changePassword = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = changePasswordSchema.parse(req.body);
      await this.service.changePassword(req.user!.userId, body.currentPassword, body.newPassword);
      clearRefreshCookie(res);
      res.json({
        success: true,
        message: 'Password updated. Sign in again on this device.',
      });
    } catch (error) {
      next(error);
    }
  };
}

export const authController = new AuthController();
