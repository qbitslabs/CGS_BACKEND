/* CGS notifications module — HTTP handlers.
 * Clinic API layer for notifications; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { notificationService, NotificationService } from './notification.service.js';

export class NotificationController {
  constructor(private readonly service: NotificationService = notificationService) {}

  getNotifications = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const isReadParam = req.query.isRead as string | undefined;
      let isRead: boolean | undefined = undefined;
      if (isReadParam !== undefined && isReadParam !== 'All') {
        isRead = isReadParam === 'true';
      }

      const data = await this.service.listNotifications({
        clinicId: req.clinicId!,
        userId: req.user!.userId,
        isRead,
      });

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  markAsRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const updated = await this.service.markAsRead(id, req.clinicId!);
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  };

  markAllAsRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await this.service.markAllAsRead(req.clinicId!, req.user!.userId);
      res.json({ success: true, message: 'All notifications marked as read.' });
    } catch (error) {
      next(error);
    }
  };

  getUnreadCount = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.getUnreadCount(req.clinicId!, req.user!.userId);
      res.json({
        success: true,
        data: result,
        unreadCount: result.unreadCount,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const notificationController = new NotificationController();
