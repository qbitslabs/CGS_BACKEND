/* CGS audit module — business logic.
 * Clinic API layer for audit; talks Prisma or callers, not the AI database. */
import { auditRepository, AuditRepository, AuditLogFilter } from './audit.repository.js';

export class AuditService {
  constructor(private readonly repo: AuditRepository = auditRepository) {}

  async listLogs(filter: AuditLogFilter) {
    const [total, logs] = await Promise.all([
      this.repo.count(filter),
      this.repo.findMany(filter),
    ]);

    const page = filter.page || 1;
    const limit = filter.limit || 25;

    return {
      data: logs,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}

export const auditService = new AuditService();
