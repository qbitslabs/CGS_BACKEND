/* CGS admin module — Prisma queries.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { encryptToken } from '../../utils/crypto.js';
import {
  AdminAIUsageFilterDTO,
  AdminClinicListQuery,
  AdminDoctorListQuery,
  AdminJobListQuery,
} from './admin.types.js';

export class AdminRepository {
  async getOverviewMetrics() {
    const [
      totalClinics,
      activeDoctors,
      totalPatients,
      totalLeads,
      totalAppointments,
      totalConversations,
      totalMessages,
      whatsAppUsageAgg,
      billingAgg,
    ] = await Promise.all([
      prisma.clinic.count({ where: { status: 'ACTIVE' } }),
      prisma.doctor.count({ where: { isActive: true } }),
      prisma.patient.count(),
      prisma.lead.count(),
      prisma.appointment.count(),
      prisma.conversation.count(),
      prisma.message.count(),
      prisma.whatsAppUsage.aggregate({
        _sum: { quantity: true, totalCost: true },
      }),
      prisma.invoice.aggregate({
        _sum: { amountPaid: true, total: true },
        _count: { id: true },
      }),
    ]);

    const whatsAppConversations = whatsAppUsageAgg._sum?.quantity || totalConversations || 0;
    const whatsAppCost = Number(whatsAppUsageAgg._sum?.totalCost || (whatsAppConversations * 0.4));

    return {
      totalClinics,
      activeDoctors,
      totalPatients,
      totalLeads,
      totalAppointments,
      totalConversations,
      totalMessages,
      whatsappConversations: whatsAppConversations,
      whatsappCost: whatsAppCost,
      totalRevenue: Number(billingAgg._sum?.amountPaid || 0),
      totalInvoiced: Number(billingAgg._sum?.total || 0),
    };
  }

  async getLocalAiUsageSummary() {
    return prisma.aiUsage.aggregate({
      _count: { id: true },
      _sum: { totalTokens: true, totalCost: true },
    });
  }

  async listDoctors(query: AdminDoctorListQuery) {
    const where: any = {};
    if (query.clinicId) where.clinicId = query.clinicId;
    if (query.specialization) where.specialization = { contains: query.specialization, mode: 'insensitive' };
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      where.OR = [
        { specialization: { contains: query.search, mode: 'insensitive' } },
        { qualification: { contains: query.search, mode: 'insensitive' } },
        {
          user: {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    return prisma.doctor.findMany({
      where,
      include: {
        clinic: { select: { id: true, name: true, slug: true, city: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true, lastLoginAt: true } },
        doctorServices: { include: { service: true } },
        _count: { select: { appointments: true, conversations: true, aiUsage: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findDoctorById(id: string) {
    return prisma.doctor.findUnique({
      where: { id },
      include: {
        clinic: true,
        user: true,
        doctorServices: { include: { service: true } },
        schedules: true,
        availabilities: true,
        _count: { select: { appointments: true, conversations: true, aiUsage: true } },
      },
    });
  }

  async getDoctorAnalytics(doctorId: string) {
    const [appointmentsByStatus, aiUsageAgg, totalRevenue] = await Promise.all([
      prisma.appointment.groupBy({
        by: ['status'],
        where: { doctorId },
        _count: { id: true },
      }),
      prisma.aiUsage.aggregate({
        where: { doctorId },
        _count: { id: true },
        _sum: { totalTokens: true, totalCost: true, inputTokens: true, outputTokens: true },
        _avg: { durationMs: true },
      }),
      prisma.appointment.count({
        where: { doctorId, status: 'COMPLETED' },
      }),
    ]);

    return { appointmentsByStatus, aiUsageAgg, totalRevenue };
  }

  async upsertDoctorAiConfig(doctorId: string, clinicId: string, data: any) {
    return prisma.entityAiConfig.upsert({
      where: { entityType_entityId: { entityType: 'CLINIC', entityId: clinicId } },
      update: {
        ...data,
        updatedAt: new Date(),
      },
      create: {
        clinicId,
        entityType: 'CLINIC',
        entityId: clinicId,
        ...data,
      },
    });
  }

  async getDoctorAiConfig(doctorId: string) {
    return prisma.entityAiConfig.findFirst({
      where: { clinicId: doctorId },
    });
  }

  async listClinics(query: AdminClinicListQuery) {
    const where: any = {};
    if (query.status) where.status = query.status as any;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { city: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return prisma.clinic.findMany({
      where,
      include: {
        doctors: { include: { user: true } },
        cgsSubscriptions: { include: { plan: true }, where: { status: 'ACTIVE' }, take: 1 },
        aiConfig: true,
        _count: {
          select: {
            doctors: true,
            users: true,
            patients: true,
            leads: true,
            appointments: true,
            conversations: true,
            aiUsage: true,
            whatsappAccounts: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findClinicById(id: string) {
    return prisma.clinic.findUnique({
      where: { id },
      include: {
        users: { include: { doctor: true }, orderBy: { createdAt: 'asc' } },
        doctors: { include: { user: true } },
        services: true,
        cgsSubscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' } },
        whatsappAccounts: true,
        aiConfig: true,
        landingPage: true,
        workflowConfig: true,
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 15 },
        _count: {
          select: {
            doctors: true,
            users: true,
            patients: true,
            leads: true,
            appointments: true,
            conversations: true,
            aiUsage: true,
            whatsappAccounts: true,
          },
        },
      },
    });
  }

  async findAdminByEmail(email: string) {
    return prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async findAdminById(id: string) {
    return prisma.adminUser.findUnique({
      where: { id },
    });
  }

  async updateAdminLastLogin(id: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  async updateClinicStatus(id: string, status: 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED') {
    return prisma.clinic.update({
      where: { id },
      data: { status },
    });
  }

  async createClinic(data: {
    name: string;
    slug: string;
    landingPageId: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    gstin?: string;
    website?: string;
    description?: string;
    logoUrl?: string;
    workingDays?: string[];
    openingTime?: string;
    closingTime?: string;
  }) {
    const workingHours =
      data.openingTime && data.closingTime
        ? `${data.openingTime} - ${data.closingTime}`
        : undefined;

    return prisma.clinic.create({
      data: {
        name: data.name,
        slug: data.slug,
        landingPageId: data.landingPageId,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        state: data.state,
        gstin: data.gstin,
        website: data.website,
        description: data.description,
        logoUrl: data.logoUrl,
        workingDays: data.workingDays,
        openingTime: data.openingTime,
        closingTime: data.closingTime,
        workingHours,
        status: 'ACTIVE',
      },
    });
  }

  async findClinicByLandingPageId(landingPageId: string) {
    return prisma.clinic.findUnique({
      where: { landingPageId },
      include: {
        landingPage: true,
        services: { where: { isActive: true }, take: 50 },
        doctors: { include: { user: true }, where: { isActive: true }, take: 50 },
        aiConfig: true,
        workflowConfig: true,
        whatsappAccounts: { where: { isActive: true }, take: 1 },
      },
    });
  }

  async findPlanByTier(tier: string) {
    return prisma.subscriptionPlan.findFirst({
      where: { tier: tier as any, isActive: true },
    });
  }

  async findPlanById(id: string) {
    return prisma.subscriptionPlan.findUnique({ where: { id } });
  }

  async createClinicSubscription(clinicId: string, planId: string) {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    return prisma.cgsSubscription.create({
      data: {
        clinicId,
        planId,
        status: 'ACTIVE',
        startDate: now,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        autoRenew: true,
      },
    });
  }

  async createClinicStaffUser(data: {
    clinicId: string;
    email: string;
    passwordHash: string;
    firstName: string;
    lastName?: string;
    title?: string;
    phone?: string;
    role: 'DOCTOR' | 'EMPLOYEE';
    specialization?: string;
    registrationNo?: string;
    qualification?: string;
    experienceYears?: number;
    consultationFee?: number;
  }) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          clinicId: data.clinicId,
          email: data.email.toLowerCase(),
          passwordHash: data.passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          title: data.title,
          phone: data.phone,
          role: data.role,
          status: 'ACTIVE',
        },
      });

      if (data.role === 'DOCTOR') {
        await tx.doctor.create({
          data: {
            clinicId: data.clinicId,
            userId: user.id,
            specialization: data.specialization,
            registrationNo: data.registrationNo,
            qualification: data.qualification,
            experienceYears: data.experienceYears ?? 0,
            consultationFee: data.consultationFee,
            isActive: true,
          },
        });
      }

      return user;
    });
  }

  async createClinicLandingPage(data: {
    clinicId: string;
    landingPageId: string;
    title?: string;
    shortDescription?: string;
    primaryCta?: string;
    whatsappNumber?: string;
    enquiryFormEnabled?: boolean;
    services?: unknown;
    doctors?: unknown;
    address?: string;
    additionalInfo?: string;
  }) {
    return prisma.clinicLandingPage.create({
      data: {
        clinicId: data.clinicId,
        landingPageId: data.landingPageId,
        title: data.title,
        shortDescription: data.shortDescription,
        primaryCta: data.primaryCta,
        whatsappNumber: data.whatsappNumber,
        enquiryFormEnabled: data.enquiryFormEnabled ?? true,
        services: data.services as any,
        doctors: data.doctors as any,
        address: data.address,
        additionalInfo: data.additionalInfo,
        isPublished: true,
      },
    });
  }

  async createClinicWorkflowConfig(data: {
    clinicId: string;
    qualificationEnabled?: boolean;
    appointmentEnabled?: boolean;
    reminderEnabled?: boolean;
    followUpEnabled?: boolean;
    noResponseEnabled?: boolean;
    staffHandoffEnabled?: boolean;
    followUpHours?: number;
    reminderHoursBefore?: number;
  }) {
    return prisma.clinicWorkflowConfig.create({
      data: {
        clinicId: data.clinicId,
        qualificationEnabled: data.qualificationEnabled ?? true,
        appointmentEnabled: data.appointmentEnabled ?? true,
        reminderEnabled: data.reminderEnabled ?? true,
        followUpEnabled: data.followUpEnabled ?? true,
        noResponseEnabled: data.noResponseEnabled ?? true,
        staffHandoffEnabled: data.staffHandoffEnabled ?? true,
        followUpHours: data.followUpHours ?? 24,
        reminderHoursBefore: data.reminderHoursBefore ?? 24,
      },
    });
  }

  async createWhatsappAccount(data: {
    clinicId: string;
    phoneNumberId: string;
    businessAccountId?: string;
    displayPhoneNumber?: string;
    accessToken: string;
    apiVersion?: string;
    webhookUrl?: string;
    verifyToken?: string;
    webhookStatus?: string;
    messageTemplates?: Record<string, string>;
  }) {
    return prisma.whatsappAccount.create({
      data: {
        clinicId: data.clinicId,
        phoneNumberId: data.phoneNumberId,
        businessAccountId: data.businessAccountId,
        displayPhoneNumber: data.displayPhoneNumber,
        accessTokenEncrypted: encryptToken(data.accessToken),
        apiVersion: data.apiVersion || 'v19.0',
        webhookUrl: data.webhookUrl,
        verifyToken: data.verifyToken,
        webhookStatus: data.webhookStatus || 'PENDING',
        messageTemplates: data.messageTemplates as any,
        isActive: true,
      },
    });
  }

  async createClinicAiConfig(data: {
    clinicId: string;
    isAiEnabled?: boolean;
    tone?: string;
    systemPrompt?: string;
    customInstructions?: string;
    humanHandoffKeywords?: string[];
    metadata?: Record<string, unknown>;
  }) {
    return prisma.entityAiConfig.create({
      data: {
        entityType: 'CLINIC',
        entityId: data.clinicId,
        clinicId: data.clinicId,
        isAiEnabled: data.isAiEnabled ?? true,
        tone: data.tone || 'professional',
        systemPrompt: data.systemPrompt,
        customInstructions: data.customInstructions,
        humanHandoffKeywords: data.humanHandoffKeywords,
        metadata: data.metadata as any,
      },
    });
  }

  async createClinicServices(
    clinicId: string,
    services: Array<{ name: string; price?: number; durationMinutes?: number }>
  ) {
    if (!services.length) return [];
    return prisma.$transaction(
      services.map((s) =>
        prisma.service.create({
          data: {
            clinicId,
            name: s.name,
            price: s.price ?? 0,
            durationMinutes: s.durationMinutes ?? 30,
            isActive: true,
          },
        })
      )
    );
  }

  async listPlatformUsers() {
    return prisma.user.findMany({
      include: {
        clinic: { select: { id: true, name: true } },
        doctor: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAdminUsers() {
    return prisma.adminUser.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPlans() {
    return prisma.subscriptionPlan.findMany({
      include: { _count: { select: { subscriptions: true } } },
      orderBy: { priceMonthly: 'asc' },
    });
  }

  async listWhatsappAccounts() {
    return prisma.whatsappAccount.findMany({
      include: {
        clinic: { select: { id: true, name: true } },
        _count: { select: { messages: true, conversations: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listJobs(query: AdminJobListQuery) {
    const where: any = {};
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.queue && query.queue !== 'ALL') where.queue = query.queue;

    const page = query.page || 1;
    const pageSize = query.pageSize || 20;

    const [total, jobs] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        include: { clinic: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { total, jobs, page, pageSize };
  }

  async findJobById(id: string) {
    return prisma.job.findUnique({
      where: { id },
      include: { clinic: { select: { id: true, name: true } } },
    });
  }

  async retryJob(id: string) {
    return prisma.job.update({
      where: { id },
      data: {
        status: 'PENDING',
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        availableAt: new Date(),
      },
      include: { clinic: { select: { id: true, name: true } } },
    });
  }

  async getClinicUsageSummary(clinicId: string) {
    const [ai, wa] = await Promise.all([
      prisma.aiUsage.aggregate({
        where: { clinicId },
        _sum: { totalTokens: true, totalCost: true },
        _count: { id: true },
      }),
      prisma.whatsAppUsage.aggregate({
        where: { clinicId },
        _sum: { quantity: true, totalCost: true },
      }),
    ]);

    return { ai, wa };
  }

  async upsertClinicAiConfig(clinicId: string, data: any) {
    return prisma.entityAiConfig.upsert({
      where: { entityType_entityId: { entityType: 'CLINIC', entityId: clinicId } },
      update: {
        ...data,
        updatedAt: new Date(),
      },
      create: {
        clinicId,
        entityType: 'CLINIC',
        entityId: clinicId,
        ...data,
      },
    });
  }

  async getAiUsageSummaryFromDB(filter: AdminAIUsageFilterDTO) {
    const where = this.buildAiUsageWhere(filter);
    return prisma.aiUsage.aggregate({
      where,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, inputCost: true, outputCost: true, totalCost: true },
      _avg: { durationMs: true },
    });
  }

  async getAiUsageGroupedByClinic(filter: AdminAIUsageFilterDTO) {
    const where = this.buildAiUsageWhere(filter);
    return prisma.aiUsage.groupBy({
      by: ['clinicId'],
      where,
      _count: { id: true },
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true, totalCost: true, inputCost: true, outputCost: true },
      _avg: { durationMs: true },
      orderBy: { _sum: { totalCost: 'desc' } },
    });
  }

  async getAiUsageGroupedByDoctor(filter: AdminAIUsageFilterDTO) {
    const where = this.buildAiUsageWhere(filter);
    return prisma.aiUsage.groupBy({
      by: ['doctorId'],
      where,
      _count: { id: true },
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true, totalCost: true, inputCost: true, outputCost: true },
      _avg: { durationMs: true },
      orderBy: { _sum: { totalCost: 'desc' } },
    });
  }

  async getAiUsageGroupedByModel(filter: AdminAIUsageFilterDTO) {
    const where = this.buildAiUsageWhere(filter);
    return prisma.aiUsage.groupBy({
      by: ['model', 'provider'],
      where,
      _count: { id: true },
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true, totalCost: true },
      _avg: { durationMs: true },
      orderBy: { _sum: { totalCost: 'desc' } },
    });
  }

  async getAiUsageGroupedByEntity(filter: AdminAIUsageFilterDTO) {
    const where = this.buildAiUsageWhere(filter);
    return prisma.aiUsage.groupBy({
      by: ['entityType', 'entityId'],
      where,
      _count: { id: true },
      _sum: { totalTokens: true, totalCost: true },
      _avg: { durationMs: true },
      orderBy: { _sum: { totalCost: 'desc' } },
    });
  }

  async getAiUsageDailySeries(days: number = 7) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const rows = await prisma.$queryRaw<
      Array<{ day: Date; requests: bigint; total_tokens: bigint | null; total_cost: any }>
    >`
      SELECT DATE_TRUNC('day', created_at) AS day,
             COUNT(*)::bigint AS requests,
             COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
             COALESCE(SUM(total_cost), 0) AS total_cost
      FROM ai_usage
      WHERE created_at >= ${since}
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY day ASC
    `;

    const waRows: Array<{ day: Date; quantity: bigint | null }> = [];
    try {
      const rowsWa = await prisma.$queryRaw<Array<{ day: Date; quantity: bigint | null }>>`
        SELECT DATE_TRUNC('day', created_at) AS day,
               COALESCE(SUM(quantity), 0)::bigint AS quantity
        FROM whatsapp_usage
        WHERE created_at >= ${since}
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day ASC
      `;
      waRows.push(...rowsWa);
    } catch {
      // whatsapp_usage table may be empty / unavailable in some envs
    }

    const byDay = new Map<string, { aiTokens: number; estimatedCost: number; whatsappCount: number; requests: number }>();
    for (const r of rows) {
      const key = new Date(r.day).toISOString().slice(0, 10);
      byDay.set(key, {
        requests: Number(r.requests || 0),
        aiTokens: Number(r.total_tokens || 0),
        estimatedCost: Number(r.total_cost || 0),
        whatsappCount: 0,
      });
    }
    for (const r of waRows) {
      const key = new Date(r.day).toISOString().slice(0, 10);
      const existing = byDay.get(key) || { requests: 0, aiTokens: 0, estimatedCost: 0, whatsappCount: 0 };
      existing.whatsappCount = Number(r.quantity || 0);
      byDay.set(key, existing);
    }

    const series: Array<{ date: string; whatsappCount: number; aiTokens: number; estimatedCost: number; requests: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key) || { requests: 0, aiTokens: 0, estimatedCost: 0, whatsappCount: 0 };
      series.push({
        date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
        whatsappCount: row.whatsappCount,
        aiTokens: row.aiTokens,
        estimatedCost: Number(row.estimatedCost.toFixed?.(2) ?? row.estimatedCost),
        requests: row.requests,
      });
    }
    return series;
  }

  async listRecentConversations(limit: number = 50) {
    return prisma.conversation.findMany({
      take: Math.min(limit, 100),
      orderBy: { lastActivityAt: 'desc' },
      include: {
        clinic: { select: { id: true, name: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        _count: { select: { messages: true } },
      },
    });
  }

  async getConversationWithMessages(id: string) {
    return prisma.conversation.findUnique({
      where: { id },
      include: {
        clinic: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 200 },
        _count: { select: { messages: true } },
      },
    });
  }

  async listSubscriptions() {
    return prisma.cgsSubscription.findMany({
      include: {
        clinic: { select: { id: true, name: true, slug: true, email: true, phone: true } },
        plan: true,
        invoices: { orderBy: { periodStart: 'desc' }, take: 3 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAdminInvoices() {
    return prisma.subscriptionInvoice.findMany({
      include: {
        subscription: {
          include: {
            clinic: { select: { id: true, name: true, slug: true } },
            plan: { select: { name: true } },
          },
        },
      },
      orderBy: { periodStart: 'desc' },
    });
  }

  private buildAiUsageWhere(filter: AdminAIUsageFilterDTO) {
    const where: any = {};
    if (filter.clinicId) where.clinicId = filter.clinicId;
    if (filter.doctorId) where.doctorId = filter.doctorId;
    if (filter.model) where.model = filter.model;

    if (filter.startDate || filter.endDate) {
      where.createdAt = {};
      if (filter.startDate) where.createdAt.gte = new Date(filter.startDate);
      if (filter.endDate) where.createdAt.lte = new Date(filter.endDate);
    } else if (filter.days) {
      const since = new Date(Date.now() - filter.days * 24 * 60 * 60 * 1000);
      where.createdAt = { gte: since };
    }
    return where;
  }
}

export const adminRepository = new AdminRepository();
