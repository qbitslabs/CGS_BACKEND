/* CGS admin module — HTTP handlers.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { adminService, AdminService } from './admin.service.js';
import { aiService } from '../ai/ai.service.js';
import { createAiEntitySchema } from '../ai/ai.schema.js';
import {
  adminLoginSchema,
  aiUsageFilterSchema,
  createClinicAdminSchema,
  createClinicUserAdminSchema,
  updateClinicAdminSchema,
  updateDoctorAiConfigSchema,
  publicLandingEnquirySchema,
  setPrimaryDoctorSchema,
} from './admin.schema.js';

export class AdminController {
  constructor(private readonly service: AdminService = adminService) {}

  login = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = adminLoginSchema.parse(req.body);
      const data = await this.service.login(body.email, body.password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getMe = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getCurrentAdmin(req.admin!.adminId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  logout = async (_req: AuthenticatedRequest, res: Response) => {
    res.json({ success: true, message: 'Logged out successfully.' });
  };

  getOverview = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getPlatformOverview();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getDoctors = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const clinicId = req.query.clinicId as string | undefined;
      const specialization = req.query.specialization as string | undefined;
      const search = req.query.search as string | undefined;
      const isActive = req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined;

      const data = await this.service.listDoctors({ clinicId, specialization, isActive, search });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getDoctorById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = await this.service.getDoctorById(id);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getDoctorAnalytics = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = await this.service.getDoctorAnalytics(id);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  updateDoctorAiConfig = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateDoctorAiConfigSchema.parse(req.body);
      const updated = await this.service.updateDoctorAiConfig(id, data);
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  };

  getClinics = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const search = req.query.search as string | undefined;
      const status = req.query.status as string | undefined;
      const tier = req.query.tier as string | undefined;
      const page = req.query.page ? Number(req.query.page) : undefined;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;

      const data = await this.service.listClinics({ search, status, tier, page, pageSize });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getClinicById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = await this.service.getClinicById(id);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  updateClinicAiConfig = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateDoctorAiConfigSchema.parse(req.body);
      const updated = await this.service.updateClinicAiConfig(id, data);
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  };

  getAiUsageSummary = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filter = aiUsageFilterSchema.parse(req.query);
      const data = await this.service.getAiUsageSummary(filter);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiUsageDaily = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
      const data = await this.service.getAiUsageDaily(days);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiConversations = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const data = await this.service.listAiConversations(limit);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiConversationById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getAiConversationById(req.params.id);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiUsageByClinics = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filter = aiUsageFilterSchema.parse(req.query);
      const data = await this.service.getAiUsageByClinics(filter);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiUsageByDoctors = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filter = aiUsageFilterSchema.parse(req.query);
      const data = await this.service.getAiUsageByDoctors(filter);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiUsageByModels = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filter = aiUsageFilterSchema.parse(req.query);
      const data = await this.service.getAiUsageByModels(filter);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiUsageByEntities = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const filter = aiUsageFilterSchema.parse(req.query);
      const data = await this.service.getAiUsageByEntities(filter);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getSubscriptions = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listSubscriptions();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getInvoices = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listInvoices();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getPlans = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listPlans();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  updateClinic = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = updateClinicAdminSchema.parse(req.body);
      const data = await this.service.updateClinicStatus(id, body.status || 'ACTIVE', body.reason, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  createClinic = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = createClinicAdminSchema.parse(req.body);
      const data = await this.service.createClinic(body, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getPublicLanding = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { landingPageId } = req.params;
      const data = await this.service.getPublicLandingById(landingPageId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  submitPublicLandingEnquiry = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { landingPageId } = req.params;
      const body = publicLandingEnquirySchema.parse(req.body);
      const data = await this.service.submitPublicLandingEnquiry(landingPageId, body);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  setPrimaryDoctor = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = setPrimaryDoctorSchema.parse(req.body);
      const data = await this.service.setPrimaryDoctor(id, body, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  addClinicUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = createClinicUserAdminSchema.parse(req.body);
      const data = await this.service.addClinicUser(id, body, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getUsers = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listPlatformUsers({
        search: req.query.search as string | undefined,
        role: req.query.role as string | undefined,
        status: req.query.status as string | undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getWhatsappHealth = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listWhatsappHealth();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getJobs = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listJobs({
        status: req.query.status as string | undefined,
        queue: req.query.queue as string | undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  retryJob = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.retryJob(req.params.id, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAuditLogs = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.listAuditLogs({
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : Number(req.query.limit) || undefined,
        action: req.query.action as string | undefined,
        search: req.query.search as string | undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getSettings = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getPlatformSettings();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  updateSettings = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.updatePlatformSettings(req.body, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  rotateSecret = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const secretKey = req.body.secretKey || req.params.key || 'metaAppSecret';
      const data = await this.service.rotatePlatformSecret(secretKey, {
        adminId: req.admin!.adminId,
        email: req.admin!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getDiagnostics = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const clinicQuery = (req.query.clinic || req.body?.clinic || req.query.search) as string | undefined;
      const data = await this.service.getSupportDiagnostics(clinicQuery);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  generateAi = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { prompt, systemInstruction, temperature } = req.body;
      const data = await this.service.generateAiAdmin(prompt, systemInstruction, temperature);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getAiEntities = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await aiService.getEntities();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  createAiEntity = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = createAiEntitySchema.parse(req.body);
      const data = await aiService.createEntity(payload);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}

export const adminController = new AdminController();
