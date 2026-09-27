/* CGS internal module — HTTP handlers.
 * Clinic API layer for internal; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { internalService, InternalService } from './internal.service.js';
import {
  aiAvailabilitySchema,
  aiBookAppointmentSchema,
  aiRescheduleAppointmentSchema,
  aiContextSchema,
  aiHandoffSchema,
  aiLeadSchema,
  aiPatientSchema,
  aiRecordUsageSchema,
  syncSummarySchema,
  whatsappEventSchema,
  whatsappInboundMessageSchema,
} from './internal.schema.js';
import { AppError } from '../../middleware/errorHandler.js';

export class InternalController {
  constructor(private readonly service: InternalService = internalService) {}

  handleWhatsAppEvent = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = whatsappEventSchema.parse(req.body);
      const result = await this.service.handleWhatsAppEvent(data);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  handleWhatsAppInbound = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = whatsappInboundMessageSchema.parse(req.body);
      const result = await this.service.handleWhatsAppInbound(data);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  getAiContext = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiContextSchema.parse(req.body);
      const result = await this.service.getAiContext(data);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  getAiPatient = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiPatientSchema.parse(req.body);
      const result = await this.service.getAiPatient(data);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  getOrUpsertLead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiLeadSchema.parse(req.body);
      const result = await this.service.getOrUpsertLead(data);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  getAiDoctors = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const clinicId = req.query.clinicId as string;
      if (!clinicId) throw new AppError('clinicId is required', 400, 'BAD_REQUEST');
      const data = await this.service.getAiDoctors(clinicId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiServices = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const clinicId = req.query.clinicId as string;
      if (!clinicId) throw new AppError('clinicId is required', 400, 'BAD_REQUEST');
      const data = await this.service.getAiServices(clinicId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAvailability = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiAvailabilitySchema.parse(req.body);
      const result = await this.service.getAvailability(data.clinicId, data.doctorId, data.date);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  bookAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiBookAppointmentSchema.parse(req.body);
      const result = await this.service.bookAppointment(data);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  rescheduleAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const appointmentId = req.params.id;
      if (!appointmentId) throw new AppError('appointment id is required', 400, 'BAD_REQUEST');
      const data = aiRescheduleAppointmentSchema.parse({
        ...req.body,
        appointmentId,
      });
      const result = await this.service.rescheduleAppointment(data);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  getAiAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const clinicId = req.query.clinicId as string | undefined;
      if (!id) throw new AppError('appointment id is required', 400, 'BAD_REQUEST');
      const result = await this.service.getAiAppointment(id, clinicId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  requestHumanHandoff = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiHandoffSchema.parse(req.body);
      const result = await this.service.requestHumanHandoff(data);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  recordAiUsage = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = aiRecordUsageSchema.parse(req.body);
      const result = await this.service.recordAiUsage(data as any);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  syncSummary = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = syncSummarySchema.parse(req.body);
      const result = await this.service.syncConversationSummary(data as any);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };
}

export const internalController = new InternalController();
