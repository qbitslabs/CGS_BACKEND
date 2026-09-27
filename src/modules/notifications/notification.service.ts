/* CGS notifications module — business logic.
 * Clinic API layer for notifications; talks Prisma or callers, not the AI database. */
import { notificationRepository, NotificationRepository } from './notification.repository.js';
import { NotificationListQuery } from './notification.types.js';
import { AppError } from '../../middleware/errorHandler.js';

export class NotificationService {
  constructor(private readonly repo: NotificationRepository = notificationRepository) {}

  async listNotifications(query: NotificationListQuery) {
    const notifications = await this.repo.findMany(query);

    return notifications.map((n) => ({
      id: n.id,
      type:
        n.type === 'NEW_LEAD'
          ? 'New Lead'
          : n.type === 'NEW_CONVERSATION'
          ? 'New Conversation'
          : n.type === 'HUMAN_HANDOFF'
          ? 'Human Handoff'
          : n.type === 'APPOINTMENT_REMINDER'
          ? 'Appointment Reminder'
          : n.type === 'APPOINTMENT_CHANGE'
          ? 'Appointment Change'
          : 'System Notification',
      title: n.title,
      message: n.message,
      timestamp: n.createdAt.toISOString(),
      isRead: n.isRead,
      link: n.link || undefined,
      entityId: n.entityId || undefined,
    }));
  }

  async markAsRead(id: string, clinicId: string) {
    const notification = await this.repo.findById(id, clinicId);
    if (!notification) {
      throw new AppError('Notification not found.', 404, 'NOT_FOUND');
    }
    return this.repo.markAsRead(id, clinicId);
  }

  async markAllAsRead(clinicId: string, userId: string) {
    return this.repo.markAllAsRead(clinicId, userId);
  }

  async getUnreadCount(clinicId: string, userId: string) {
    const count = await this.repo.countUnread(clinicId, userId);
    return { unreadCount: count, count };
  }
}

export const notificationService = new NotificationService();
