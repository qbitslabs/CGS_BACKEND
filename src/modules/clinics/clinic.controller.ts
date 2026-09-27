/* CGS clinics module — HTTP handlers.
 * Clinic API layer for clinics; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { clinicService, ClinicService } from './clinic.service.js';
import { updateClinicSchema, createServiceSchema, updateServiceSchema } from './clinic.schema.js';

export class ClinicController {
  constructor(private readonly service: ClinicService = clinicService) {}

  getCurrentClinic = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getCurrentClinic(req.clinicId!);
      res.json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  updateCurrentClinic = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = updateClinicSchema.parse(req.body);
      const updated = await this.service.updateCurrentClinic(req.clinicId!, data, {
        userId: req.user!.userId,
        email: req.user!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  createService = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createServiceSchema.parse(req.body);
      const service = await this.service.createService(req.clinicId!, data);

      res.status(201).json({
        success: true,
        data: service,
      });
    } catch (error) {
      next(error);
    }
  };

  updateService = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateServiceSchema.parse(req.body);
      const updated = await this.service.updateService(id, req.clinicId!, data);
      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteService = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteService(id, req.clinicId!);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const clinicController = new ClinicController();
