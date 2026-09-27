/* CGS meta module — HTTP handlers.
 * Clinic API layer for meta; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { metaService, MetaService } from './meta.service.js';

export class MetaController {
  constructor(private readonly service: MetaService = metaService) {}

  getOverview = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getOverview(req.clinicId!);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getCampaigns = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getCampaigns(req.clinicId!);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getCreatives = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getCreatives(req.clinicId!);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}

export const metaController = new MetaController();
