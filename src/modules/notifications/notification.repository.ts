/* CGS notifications module — Prisma queries.
 * Clinic API layer for notifications; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { NotificationListQuery } from './notification.types.js';

export class NotificationRepository {
  async findMany(query: NotificationListQuery) {
    const where: any = {
      clinicId: query.clinicId,
      OR: [{ userId: query.userId }, { userId: null }],
    };

    if (query.isRead !== undefined) {
      where.isRead = query.isRead;
    }

    return prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async findById(id: string, clinicId: string) {
    return prisma.notification.findFirst({
      where: { id, clinicId },
    });
  }

  async markAsRead(id: string, clinicId: string) {
    return prisma.notification.updateMany({
      where: { id, clinicId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllAsRead(clinicId: string, userId: string) {
    return prisma.notification.updateMany({
      where: {
        clinicId,
        isRead: false,
        OR: [{ userId }, { userId: null }],
      },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async countUnread(clinicId: string, userId: string) {
    return prisma.notification.count({
      where: {
        clinicId,
        isRead: false,
        OR: [{ userId }, { userId: null }],
      },
    });
  }
}

export const notificationRepository = new NotificationRepository();
