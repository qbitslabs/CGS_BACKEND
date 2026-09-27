/* CGS dashboard module — HTTP handlers.
 * Clinic API layer for dashboard; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { dashboardService, DashboardService } from './dashboard.service.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class DashboardController {
  constructor(private readonly service: DashboardService = dashboardService) {}

  getSummary = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: typeof req.query.doctorId === 'string' ? req.query.doctorId : undefined,
      });
      const data = await this.service.getSummary(req.clinicId!, scope.restrictToDoctorId || undefined);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}

export const dashboardController = new DashboardController();
