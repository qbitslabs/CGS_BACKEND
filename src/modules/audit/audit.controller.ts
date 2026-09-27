/* CGS audit module — HTTP handlers.
 * Clinic API layer for audit; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { auditService, AuditService } from './audit.service.js';

export class AuditController {
  constructor(private readonly service: AuditService = auditService) {}

  getLogs = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 25;
      const action = req.query.action as string | undefined;
      const resourceType = req.query.resourceType as string | undefined;
      const actorType = req.query.actorType as string | undefined;

      const result = await this.service.listLogs({
        clinicId: req.clinicId!,
        page,
        limit,
        action,
        resourceType,
        actorType,
      });

      res.json({
        success: true,
        data: result.data,
        meta: result.meta,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const auditController = new AuditController();
