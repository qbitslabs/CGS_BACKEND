/* CGS leads module — HTTP handlers.
 * Clinic API layer for leads; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { leadService, LeadService } from './lead.service.js';
import { listLeadsSchema, createLeadSchema, updateLeadSchema } from './lead.schema.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class LeadController {
  constructor(private readonly service: LeadService = leadService) {}

  getLeads = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const query = listLeadsSchema.parse(req.query);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: query.doctorId,
      });
      const result = await this.service.listLeads({
        clinicId: req.clinicId!,
        page: query.page,
        limit: query.limit,
        status: query.status,
        source: query.source,
        search: query.search,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        doctorId: scope.restrictToDoctorId || undefined,
        assignedToUserId: scope.restrictToDoctorId ? scope.userId || undefined : undefined,
        preferredDoctor: scope.restrictToDoctorId ? scope.doctorName || undefined : undefined,
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

  getLeadById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const lead = await this.service.getLeadById(id, req.clinicId!);
      res.json({
        success: true,
        data: lead,
      });
    } catch (error) {
      next(error);
    }
  };

  createLead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createLeadSchema.parse(req.body);
      const lead = await this.service.createLead(req.clinicId!, data as any, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'System',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.status(201).json({
        success: true,
        data: lead,
      });
    } catch (error) {
      next(error);
    }
  };

  convertLead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.convertLeadToPatient(id, req.clinicId!, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'System',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  updateLead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateLeadSchema.parse(req.body);
      const updated = await this.service.updateLead(id, req.clinicId!, data as any);

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteLead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteLead(id, req.clinicId!);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const leadController = new LeadController();
