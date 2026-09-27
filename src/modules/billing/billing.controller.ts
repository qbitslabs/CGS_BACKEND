/* CGS billing module — HTTP handlers.
 * Clinic API layer for billing; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { billingService, BillingService } from './billing.service.js';
import { listInvoicesSchema, createInvoiceSchema, collectPaymentSchema } from './billing.schema.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class BillingController {
  constructor(private readonly service: BillingService = billingService) {}

  getSummary = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: typeof req.query.doctorId === 'string' ? req.query.doctorId : undefined,
      });
      const data = await this.service.getRevenueSummary(req.clinicId!, scope.restrictToDoctorId || undefined);
      res.json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  getInvoices = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const query = listInvoicesSchema.parse(req.query);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: query.doctorId,
      });
      const result = await this.service.listInvoices({
        clinicId: req.clinicId!,
        page: query.page,
        limit: query.limit,
        status: query.status,
        search: query.search,
        paymentMethod: query.paymentMethod,
        date: query.date,
        doctorId: scope.restrictToDoctorId || undefined,
        createdByUserId: scope.restrictToDoctorId ? scope.userId || undefined : undefined,
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

  getInvoiceById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const invoice = await this.service.getInvoiceById(id, req.clinicId!);

      res.json({
        success: true,
        data: invoice,
      });
    } catch (error) {
      next(error);
    }
  };

  createInvoice = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createInvoiceSchema.parse(req.body);
      const invoice = await this.service.createInvoice(req.clinicId!, data as any, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'Staff',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.status(201).json({
        success: true,
        data: invoice,
      });
    } catch (error) {
      next(error);
    }
  };

  collectPayment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = collectPaymentSchema.parse(req.body);
      const updated = await this.service.collectPayment(id, req.clinicId!, data as any, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'Staff',
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

  sendInvoiceWhatsApp = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.sendInvoiceWhatsApp(id, req.clinicId!, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'Staff',
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

  getSubscription = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getSubscription(req.clinicId!);
      res.json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const billingController = new BillingController();
