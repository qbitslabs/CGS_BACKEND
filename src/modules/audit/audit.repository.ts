/* CGS audit module — Prisma queries.
 * Clinic API layer for audit; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';

export interface AuditLogFilter {
  clinicId?: string;
  action?: string;
  resourceType?: string;
  actorType?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export class AuditRepository {
  async count(filter: AuditLogFilter) {
    const where = this.buildWhere(filter);
    return prisma.auditLog.count({ where });
  }

  async findMany(filter: AuditLogFilter) {
    const where = this.buildWhere(filter);
    const page = filter.page || 1;
    const limit = filter.limit || 25;

    return prisma.auditLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  private buildWhere(filter: AuditLogFilter) {
    const where: any = {};
    if (filter.clinicId) where.clinicId = filter.clinicId;
    if (filter.action && filter.action !== 'ALL') where.action = filter.action;
    if (filter.resourceType) where.resourceType = filter.resourceType;
    if (filter.actorType) where.actorType = filter.actorType;
    if (filter.search) {
      where.OR = [
        { actorEmail: { contains: filter.search, mode: 'insensitive' } },
        { action: { contains: filter.search, mode: 'insensitive' } },
        { resourceType: { contains: filter.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }
}

export const auditRepository = new AuditRepository();
