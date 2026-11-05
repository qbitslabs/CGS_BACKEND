/* CGS admin module — business logic.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { adminRepository, AdminRepository } from './admin.repository.js';
import {
  AdminAIUsageFilterDTO,
  AdminClinicListQuery,
  AdminDoctorListQuery,
  AdminJobListQuery,
  AdminUserListQuery,
} from './admin.types.js';
import { aiClient } from '../ai/ai.client.js';
import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import { env } from '../../config/env.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { auditService } from '../audit/audit.service.js';
import { assertClinicSeatAvailable } from '../../utils/subscriptionSeats.js';
import { assertCanAddDoctor, assertCanAddStaff, assertCanAddWhatsappNumber, clinicPackageUsage } from './entitlements.js';
import { addonOffer, assertEarlyBirdAvailable, packageMonthlyAmount } from './planCatalog.js';
import { encryptToken } from '../../utils/crypto.js';
import { queueTemplateSends } from '../whatsapp/outbound.service.js';
import { buildSubscriptionInvoicePdf, subscriptionInvoiceFilename } from './subscriptionInvoicePdf.js';
import { gstOn } from './subscriptionGst.js';

function jobText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .filter((item) => typeof item === 'string' || typeof item === 'number')
      .map(String);
    return parts.length ? parts.join(' · ') : undefined;
  }
  return undefined;
}

function pushJobDetail(rows: Array<{ label: string; value: string }>, label: string, value: unknown) {
  const text = jobText(value);
  if (!text) return;
  rows.push({ label, value: text.length > 280 ? `${text.slice(0, 277)}...` : text });
}

/** Readable lines for the admin job popup. Secrets and raw ids stay out. */
function describeJob(type: string, payload: unknown): Array<{ label: string; value: string }> {
  const source =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const rows: Array<{ label: string; value: string }> = [];

  if (type === 'OUTBOUND_REMINDER_SCAN') {
    pushJobDetail(rows, 'Summary', source.note);
    pushJobDetail(rows, 'Visits checked', source.checked);
    pushJobDetail(rows, 'Messages queued', source.queued);
    pushJobDetail(rows, 'Last check', source.previousRanAt);
  } else if (type === 'SUBSCRIPTION_BILL_SCAN') {
    pushJobDetail(rows, 'Summary', source.note);
    pushJobDetail(rows, 'Clinics', source.clinics);
    pushJobDetail(rows, 'Bills queued', source.queued);
    pushJobDetail(rows, 'Already billed', source.alreadyBilled);
    pushJobDetail(rows, 'Last check', source.previousRanAt);
  } else if (type === 'SUBSCRIPTION_BILL_CREATE') {
    pushJobDetail(rows, 'Summary', source.note);
    pushJobDetail(rows, 'Invoice', source.invoiceNumber);
    pushJobDetail(rows, 'Amount', source.total);
    pushJobDetail(rows, 'Period start', source.periodStart);
    pushJobDetail(rows, 'Period end', source.periodEnd);
  } else if (type === 'OUTBOUND_OUTCOME_SCAN') {
    pushJobDetail(rows, 'Summary', source.note);
    pushJobDetail(rows, 'Missed visits', source.missed);
    pushJobDetail(rows, 'Completed visits', source.completed);
    pushJobDetail(rows, 'Messages queued', source.queued);
    pushJobDetail(rows, 'Last check', source.previousRanAt);
  } else if (type === 'WHATSAPP_TEMPLATE_SEND') {
    pushJobDetail(rows, 'Template', source.templateName || source.templateKey);
    pushJobDetail(rows, 'Phone', source.recipientPhone);
    pushJobDetail(rows, 'Message', source.sessionText);
    pushJobDetail(rows, 'Invoice', source.invoiceId);
    pushJobDetail(rows, 'Parameters', source.parameters);
  } else if (type === 'WHATSAPP_SEND') {
    pushJobDetail(rows, 'Phone', source.recipientPhone);
    pushJobDetail(rows, 'Message', source.content);
  } else if (type === 'AI_GENERATE_REPLY') {
    pushJobDetail(rows, 'Patient message', source.userText);
    pushJobDetail(rows, 'Conversation', source.conversationId);
  } else {
    const hidden = /token|password|secret|authorization|document/i;
    for (const [key, value] of Object.entries(source)) {
      if (hidden.test(key)) continue;
      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
      pushJobDetail(rows, label, value);
    }
  }

  return rows;
}

const ADMIN_ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN: [
    'clinics.read', 'clinics.write', 'clinics.suspend', 'clinics.delete',
    'users.read', 'users.write', 'users.impersonate_view',
    'billing.read', 'billing.manage_plans', 'billing.manage_subscriptions', 'billing.refund',
    'usage.read', 'usage.manage_rates', 'whatsapp.read', 'whatsapp.manage',
    'ai.read', 'ai.manage_models', 'jobs.read', 'jobs.retry', 'jobs.cancel',
    'audit.read', 'settings.read', 'settings.write', 'support.read', 'support.diagnostics',
  ],
  PLATFORM_ADMIN: [
    'clinics.read', 'clinics.write', 'clinics.suspend', 'users.read', 'users.write',
    'usage.read', 'whatsapp.read', 'whatsapp.manage', 'ai.read', 'ai.manage_models',
    'jobs.read', 'jobs.retry', 'jobs.cancel', 'audit.read', 'support.read', 'support.diagnostics',
  ],
  SUPPORT_ADMIN: [
    'clinics.read', 'users.read', 'jobs.read', 'jobs.retry', 'audit.read',
    'support.read', 'support.diagnostics', 'whatsapp.read', 'ai.read',
  ],
  BILLING_ADMIN: [
    'clinics.read', 'billing.read', 'billing.manage_plans', 'billing.manage_subscriptions',
    'billing.refund', 'usage.read', 'usage.manage_rates', 'audit.read',
  ],
};

function resolveAdminPermissions(role: string, stored: string[] = []) {
  if (stored.includes('*')) return ADMIN_ROLE_PERMISSIONS.SUPER_ADMIN;
  if (stored.length > 0) return stored;
  return ADMIN_ROLE_PERMISSIONS[role] || ADMIN_ROLE_PERMISSIONS.PLATFORM_ADMIN;
}

function toUiClinicStatus(status: string) {
  if (status === 'PROVISIONING') return 'TRIAL';
  if (status === 'DEACTIVATED') return 'INACTIVE';
  return status;
}

function toDbClinicStatus(status: string): 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' {
  if (status === 'TRIAL') return 'PROVISIONING';
  if (status === 'INACTIVE') return 'DEACTIVATED';
  if (status === 'PROVISIONING' || status === 'ACTIVE' || status === 'SUSPENDED' || status === 'DEACTIVATED') {
    return status;
  }
  return 'ACTIVE';
}

function slugify(value: string) {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'clinic'}-${Date.now().toString(36)}`;
}

function splitName(fullName: string) {
  const parts = fullName.replace(/^dr\.?\s+/i, '').trim().split(/\s+/);
  return {
    firstName: parts[0] || 'Clinic',
    lastName: parts.slice(1).join(' ') || undefined,
  };
}

export class AdminService {
  constructor(private readonly repo: AdminRepository = adminRepository) {}

  async login(
    email: string,
    password: string,
    auditContext: { ip?: string; userAgent?: string; requestId?: string }
  ) {
    const admin = await this.repo.findAdminByEmail(email);
    if (!admin) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }
    if (admin.status !== 'ACTIVE') {
      throw new AppError('Admin account is not active.', 403, 'ACCOUNT_DISABLED');
    }

    const isValid = await bcrypt.compare(password, admin.passwordHash);
    if (!isValid) {
      await logAuditEvent({
        actorId: admin.id,
        actorEmail: admin.email,
        actorType: 'ADMIN',
        action: 'ADMIN_LOGIN_FAILURE',
        resourceType: 'ADMIN_USER',
        resourceId: admin.id,
        ipAddress: auditContext.ip,
        userAgent: auditContext.userAgent,
        requestId: auditContext.requestId,
      });
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    await this.repo.updateAdminLastLogin(admin.id);

    const permissions = resolveAdminPermissions(admin.role, admin.permissions);
    const accessToken = jwt.sign(
      {
        adminId: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        type: 'ADMIN',
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as any }
    );

    await logAuditEvent({
      actorId: admin.id,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'ADMIN_LOGIN_SUCCESS',
      resourceType: 'ADMIN_USER',
      resourceId: admin.id,
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return {
      accessToken,
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        permissions,
        status: admin.status,
        lastLoginAt: new Date().toISOString(),
        createdAt: admin.createdAt.toISOString(),
      },
    };
  }

  async getCurrentAdmin(adminId: string) {
    const admin = await this.repo.findAdminById(adminId);
    if (!admin) {
      throw new AppError('Admin user not found', 404, 'NOT_FOUND');
    }
    if (admin.status !== 'ACTIVE') {
      throw new AppError('Admin account is not active.', 403, 'ACCOUNT_DISABLED');
    }

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      permissions: resolveAdminPermissions(admin.role, admin.permissions),
      status: admin.status,
      lastLoginAt: admin.lastLoginAt?.toISOString() || new Date().toISOString(),
      createdAt: admin.createdAt.toISOString(),
    };
  }

  async getPlatformOverview() {
    const platform = await this.repo.getOverviewMetrics();

    let aiUsageOverview = {
      total_requests: 0,
      total_tokens: 0,
      estimated_cost: 0.0,
      today_cost: 0.0,
      month_cost: 0.0,
      avg_cost_per_request: 0.0,
    };

    try {
      const aiData = await aiClient.request('/ai/v1/usage/summary?days=30');
      if (aiData) {
        aiUsageOverview = aiData;
      }
    } catch {
      const localAiUsage = await this.repo.getLocalAiUsageSummary();
      aiUsageOverview.total_requests = localAiUsage._count.id;
      aiUsageOverview.total_tokens = localAiUsage._sum.totalTokens || 0;
      aiUsageOverview.estimated_cost = Number(localAiUsage._sum.totalCost || 0);
    }

    return { platform, ai: aiUsageOverview };
  }

  private formatDoctorName(firstName?: string | null, lastName?: string | null) {
    const full = `${firstName || ''} ${lastName || ''}`.trim();
    return /^dr\.?\s/i.test(full) ? full : `Dr. ${full}`.trim();
  }

  async listDoctors(query: AdminDoctorListQuery) {
    const doctors = await this.repo.listDoctors(query);

    return doctors.map((d: any) => ({
      id: d.id,
      name: this.formatDoctorName(d.user.firstName, d.user.lastName),
      firstName: d.user.firstName,
      lastName: d.user.lastName,
      email: d.user.email,
      phone: d.user.phone,
      clinicId: d.clinicId,
      clinicName: d.clinic.name,
      clinicCity: d.clinic.city,
      specialization: d.specialization,
      registrationNo: d.registrationNo,
      consultationFee: d.consultationFee ? Number(d.consultationFee) : 500,
      experienceYears: d.experienceYears,
      qualification: d.qualification,
      availabilityDays: d.availabilityDays,
      availabilityHours: d.availabilityHours,
      isActive: d.isActive,
      userStatus: d.user.status,
      services: (d.doctorServices || [])
        .filter((s: any) => {
          const cat = (s.service?.category || '').toLowerCase();
          const name = (s.service?.name || '').toLowerCase();
          return cat !== 'consultation' && cat !== 'consult' && name !== 'consultation' && !name.includes('normal consultation');
        })
        .map((s: any) => ({
        id: s.service.id,
        name: s.service.name,
        price: s.customPrice !== null && s.customPrice !== undefined ? Number(s.customPrice) : Number(s.service.price),
        duration: s.customDurationMinutes || s.service.durationMinutes,
      })),
      servicesCount: (d.doctorServices || []).filter((s: any) => {
        const cat = (s.service?.category || '').toLowerCase();
        const name = (s.service?.name || '').toLowerCase();
        return cat !== 'consultation' && cat !== 'consult' && name !== 'consultation' && !name.includes('normal consultation');
      }).length,
      appointmentsCount: d._count?.appointments || 0,
      hasAiConfig: !!d.aiConfig,
      aiSystemPrompt: d.aiConfig?.systemPrompt || null,
      aiModelOverride: d.aiConfig?.modelOverride || null,
      stats: {
        totalAppointments: d._count?.appointments || 0,
        totalConversations: d._count?.conversations || 0,
        totalAiRequests: d._count?.aiUsage || 0,
      },
      createdAt: d.createdAt,
    }));
  }

  async getDoctorById(id: string) {
    const doctor = await this.repo.findDoctorById(id);
    if (!doctor) {
      throw new AppError('Doctor not found', 404, 'NOT_FOUND');
    }
    return {
      id: doctor.id,
      name: this.formatDoctorName(doctor.user.firstName, doctor.user.lastName),
      firstName: doctor.user.firstName,
      lastName: doctor.user.lastName,
      email: doctor.user.email,
      phone: doctor.user.phone,
      clinicId: doctor.clinicId,
      clinicName: doctor.clinic.name,
      clinicCity: doctor.clinic.city,
      specialization: doctor.specialization,
      registrationNo: doctor.registrationNo,
      consultationFee: doctor.consultationFee ? Number(doctor.consultationFee) : 500,
      experienceYears: doctor.experienceYears,
      qualification: doctor.qualification,
      availabilityDays: doctor.availabilityDays,
      availabilityHours: doctor.availabilityHours,
      isActive: doctor.isActive,
      userStatus: doctor.user.status,
      schedules: doctor.schedules || [],
      availabilities: doctor.availabilities || [],
      services: (doctor.doctorServices || [])
        .filter((s: any) => {
          const cat = (s.service?.category || '').toLowerCase();
          const name = (s.service?.name || '').toLowerCase();
          return cat !== 'consultation' && cat !== 'consult' && name !== 'consultation' && !name.includes('normal consultation');
        })
        .map((s: any) => ({
        id: s.service.id,
        name: s.service.name,
        price: s.customPrice !== null && s.customPrice !== undefined ? Number(s.customPrice) : Number(s.service.price),
        duration: s.customDurationMinutes || s.service.durationMinutes,
      })),
      servicesCount: (doctor.doctorServices || []).filter((s: any) => {
        const cat = (s.service?.category || '').toLowerCase();
        const name = (s.service?.name || '').toLowerCase();
        return cat !== 'consultation' && cat !== 'consult' && name !== 'consultation' && !name.includes('normal consultation');
      }).length,
      stats: {
        totalAppointments: doctor._count?.appointments || 0,
        totalConversations: doctor._count?.conversations || 0,
        totalAiRequests: doctor._count?.aiUsage || 0,
      },
    };
  }

  async getDoctorAnalytics(id: string) {
    const doctor = await this.repo.findDoctorById(id);
    if (!doctor) {
      throw new AppError('Doctor not found', 404, 'NOT_FOUND');
    }

    const { appointmentsByStatus, aiUsageAgg, totalRevenue } = await this.repo.getDoctorAnalytics(id);

    return {
      doctor: {
        id: doctor.id,
        name: this.formatDoctorName(doctor.user.firstName, doctor.user.lastName),
        specialization: doctor.specialization,
        clinicName: doctor.clinic.name,
        fee: doctor.consultationFee ? Number(doctor.consultationFee) : 500,
      },
      appointments: {
        byStatus: appointmentsByStatus.map((s) => ({ status: s.status, count: s._count.id })),
        completedCount: totalRevenue,
        estimatedRevenue: totalRevenue * (doctor.consultationFee ? Number(doctor.consultationFee) : 500),
      },
      aiUsage: {
        totalRequests: aiUsageAgg._count.id,
        totalTokens: aiUsageAgg._sum.totalTokens || 0,
        inputTokens: aiUsageAgg._sum.inputTokens || 0,
        outputTokens: aiUsageAgg._sum.outputTokens || 0,
        totalCost: Number(aiUsageAgg._sum.totalCost || 0),
        avgDurationMs: Math.round(aiUsageAgg._avg.durationMs || 0),
      },
    };
  }

  async updateDoctorAiConfig(doctorId: string, data: any) {
    const doctor = await this.repo.findDoctorById(doctorId);
    if (!doctor) {
      throw new AppError('Doctor not found', 404, 'NOT_FOUND');
    }

    const updated = await this.repo.upsertDoctorAiConfig(doctorId, doctor.clinicId, data);
    void aiClient.invalidateClinicCache(doctor.clinicId);
    return updated;
  }

  async listClinics(query: AdminClinicListQuery) {
    const dbStatus =
      query.status && query.status !== 'ALL' ? toDbClinicStatus(query.status) : undefined;
    const clinics = await this.repo.listClinics({ ...query, status: dbStatus });

    let mapped = clinics.map((c: any) => this.mapClinicListItem(c));
    if (query.tier && query.tier !== 'ALL') {
      mapped = mapped.filter((c) => c.tier === query.tier);
    }

    const page = query.page || 1;
    const pageSize = query.pageSize || 20;
    const total = mapped.length;
    const data = mapped.slice((page - 1) * pageSize, page * pageSize);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async getClinicById(id: string) {
    const clinic = await this.repo.findClinicById(id);
    if (!clinic) {
      throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    }
    const usage = await this.repo.getClinicUsageSummary(id);
    const runtime = await this.fetchAiRuntime();
    const packageUsage = await clinicPackageUsage(id);
    const seats = {
      enforced: packageUsage.enforced,
      planName: packageUsage.planName,
      tier: packageUsage.tier,
      doctors: { used: packageUsage.doctors.used, allowed: packageUsage.doctors.allowed },
      staff: { used: packageUsage.staff.used, allowed: packageUsage.staff.allowed },
      whatsappNumbers: { used: packageUsage.whatsappNumbers.used, allowed: packageUsage.whatsappNumbers.allowed },
    };
    return { ...this.mapClinicDetail(clinic, usage, runtime), seats, packageUsage };
  }

  async assignClinicPlan(
    clinicId: string,
    input: { planId: string; status: string; earlyBird: boolean },
    admin: { adminId: string; email: string }
  ) {
    const clinic = await this.repo.findClinicById(clinicId);
    if (!clinic) throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    const plan = await prisma.subscriptionPlan.findFirst({ where: { id: input.planId, isActive: true } });
    if (!plan) throw new AppError('Choose Essential, Growth, or Scale.', 400, 'PLAN_NOT_FOUND');
    const existing = await prisma.cgsSubscription.findFirst({
      where: { clinicId },
      orderBy: { createdAt: 'desc' },
    });
    if (input.earlyBird) await assertEarlyBirdAvailable(prisma as never, clinicId);
    const before = existing
      ? { planId: existing.planId, status: existing.status, earlyBird: existing.earlyBird, limitsApply: existing.limitsApply }
      : null;
    const after = { planId: plan.id, status: input.status, earlyBird: input.earlyBird, limitsApply: true };
    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    const saved = existing
      ? await prisma.cgsSubscription.update({
          where: { id: existing.id },
          data: { planId: plan.id, status: input.status as never, earlyBird: input.earlyBird, limitsApply: true },
        })
      : await prisma.cgsSubscription.create({
          data: {
            clinicId,
            planId: plan.id,
            status: input.status as never,
            startDate: start,
            currentPeriodStart: start,
            currentPeriodEnd: end,
            earlyBird: input.earlyBird,
            limitsApply: true,
          },
        });
    await logAuditEvent({
      clinicId,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'SUBSCRIPTION_ASSIGNED',
      resourceType: 'SUBSCRIPTION',
      resourceId: saved.id,
      diffBefore: before,
      diffAfter: after,
    });
    return this.getClinicById(clinicId);
  }

  async recordClinicAddon(
    clinicId: string,
    input: { type: string; quantity?: number; automationKey?: string },
    admin: { adminId: string; email: string }
  ) {
    const subscription = await prisma.cgsSubscription.findFirst({
      where: { clinicId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    if (!subscription) throw new AppError('Assign a plan before recording an extra.', 400, 'SUBSCRIPTION_REQUIRED');
    const offer = addonOffer(subscription.plan.tier, input.type, input.automationKey);
    const quantity = input.quantity || 1;
    const created = await prisma.clinicAddon.create({
      data: {
        clinicId,
        subscriptionId: subscription.id,
        type: input.type as never,
        price: offer.price,
        quantity,
        billing: offer.billing,
        status: 'PENDING',
        automationKey: input.type === 'EXTRA_AUTOMATION' ? input.automationKey || null : null,
        periodStart: input.type === 'EXTRA_AI_REPLIES' ? subscription.currentPeriodStart : null,
        periodEnd: input.type === 'EXTRA_AI_REPLIES' ? subscription.currentPeriodEnd : null,
      },
    });
    await logAuditEvent({
      clinicId,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'ADDON_RECORDED',
      resourceType: 'ADDON',
      resourceId: created.id,
      diffBefore: null,
      diffAfter: { type: created.type, status: 'PENDING', quantity, price: offer.price, automationKey: created.automationKey },
    });
    return this.getClinicById(clinicId);
  }

  async confirmClinicAddon(clinicId: string, addonId: string, admin: { adminId: string; email: string }) {
    const addon = await prisma.clinicAddon.findFirst({ where: { id: addonId, clinicId } });
    if (!addon) throw new AppError('Add-on not found', 404, 'NOT_FOUND');
    if (addon.status !== 'ACTIVE') {
      await prisma.clinicAddon.update({ where: { id: addon.id }, data: { status: 'ACTIVE' } });
      await logAuditEvent({
        clinicId,
        actorId: admin.adminId,
        actorEmail: admin.email,
        actorType: 'ADMIN',
        action: 'ADDON_CONFIRMED',
        resourceType: 'ADDON',
        resourceId: addon.id,
        diffBefore: { status: addon.status, type: addon.type },
        diffAfter: { status: 'ACTIVE', type: addon.type, quantity: addon.quantity },
      });
    }
    return this.getClinicById(clinicId);
  }

  async removeClinicAddon(clinicId: string, addonId: string, admin: { adminId: string; email: string }) {
    const addon = await prisma.clinicAddon.findFirst({ where: { id: addonId, clinicId } });
    if (!addon) throw new AppError('Add-on not found', 404, 'NOT_FOUND');
    await prisma.clinicAddon.delete({ where: { id: addon.id } });
    await logAuditEvent({
      clinicId,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'ADDON_REMOVED',
      resourceType: 'ADDON',
      resourceId: addon.id,
      diffBefore: { type: addon.type, status: addon.status, quantity: addon.quantity, automationKey: addon.automationKey },
      diffAfter: null,
    });
    return this.getClinicById(clinicId);
  }

  async updateClinicStatus(
    id: string,
    status: string,
    reason: string | undefined,
    admin: { adminId: string; email: string }
  ) {
    const clinic = await this.repo.findClinicById(id);
    if (!clinic) {
      throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    }

    const nextStatus = toDbClinicStatus(status);
    await this.repo.updateClinicStatus(id, nextStatus);

    await logAuditEvent({
      clinicId: id,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: nextStatus === 'SUSPENDED' ? 'CLINIC_SUSPENDED' : 'CLINIC_STATUS_CHANGED',
      resourceType: 'CLINIC',
      resourceId: id,
      metadata: { previousStatus: clinic.status, newStatus: nextStatus, reason },
    });

    return this.getClinicById(id);
  }

  async replaceWhatsAppToken(id: string, accessToken: string, admin: { adminId: string; email: string }) {
    const clinic = await this.repo.findClinicById(id);
    if (!clinic) {
      throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    }
    const updated = await this.repo.replaceWhatsAppAccessToken(id, encryptToken(accessToken.trim()));
    if (!updated) {
      throw new AppError('WhatsApp account is not configured for this clinic', 409, 'WHATSAPP_NOT_CONFIGURED');
    }
    await logAuditEvent({
      clinicId: id,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'WHATSAPP_TOKEN_REPLACED',
      resourceType: 'WHATSAPP_ACCOUNT',
      resourceId: updated.id,
      metadata: { tokenReplaced: true },
    });
    return { saved: true };
  }

  async createClinic(
    payload: {
      name: string;
      slug?: string;
      doctorName?: string;
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
      tier?: string;
      planId?: string;
      earlyBird?: boolean;
      addons?: Array<{ type: string; quantity?: number; automationKey?: string }>;
      landingPage?: {
        title?: string;
        shortDescription?: string;
        primaryCta?: string;
        whatsappNumber?: string;
        enquiryFormEnabled?: boolean;
      };
      whatsapp?: {
        businessAccountId?: string;
        phoneNumberId?: string;
        displayPhoneNumber?: string;
        accessToken?: string;
        apiVersion?: string;
        webhookUrl?: string;
        verifyToken?: string;
        webhookStatus?: string;
      };
      ai?: {
        receptionistName?: string;
        tone?: string;
        greetingMessage?: string;
        conversationInstructions?: string;
        clinicInformation?: string;
        faqs?: string;
        isAiEnabled?: boolean;
      };
    },
    admin: { adminId: string; email: string }
  ) {
    const slug = payload.slug || slugify(payload.name);
    const landingPageId = `lp_${slug.replace(/[^a-z0-9-]/gi, '').slice(0, 24)}_${Date.now().toString(36)}`;

    const clinic = await this.repo.createClinic({
      name: payload.name,
      slug,
      landingPageId,
      email: payload.email,
      phone: payload.phone,
      address: payload.address,
      city: payload.city,
      state: payload.state,
      gstin: payload.gstin,
      website: payload.website,
      description: payload.description,
      logoUrl: payload.logoUrl,
      workingDays: payload.workingDays,
      openingTime: payload.openingTime,
      closingTime: payload.closingTime,
    });

    const plan = payload.planId
      ? await this.repo.findPlanById(payload.planId)
      : payload.tier
        ? await this.repo.findPlanByTier(payload.tier)
        : null;

    if (plan) {
      const earlyBird = Boolean(payload.earlyBird);
      if (earlyBird) await assertEarlyBirdAvailable(prisma as never, clinic.id);
      const subscription = await this.repo.createClinicSubscription(clinic.id, plan.id, earlyBird);
      for (const input of payload.addons || []) {
        const offer = addonOffer(plan.tier, input.type, input.automationKey);
        const quantity = Math.min(20, Math.max(1, input.quantity || 1));
        const created = await prisma.clinicAddon.create({
          data: {
            clinicId: clinic.id,
            subscriptionId: subscription.id,
            type: input.type as never,
            price: offer.price,
            quantity,
            billing: offer.billing,
            status: 'PENDING',
            automationKey: input.type === 'EXTRA_AUTOMATION' ? input.automationKey || null : null,
            periodStart: input.type === 'EXTRA_AI_REPLIES' ? subscription.currentPeriodStart : null,
            periodEnd: input.type === 'EXTRA_AI_REPLIES' ? subscription.currentPeriodEnd : null,
          },
        });
        await logAuditEvent({
          clinicId: clinic.id,
          actorId: admin.adminId,
          actorEmail: admin.email,
          actorType: 'ADMIN',
          action: 'ADDON_RECORDED',
          resourceType: 'ADDON',
          resourceId: created.id,
          diffBefore: null,
          diffAfter: { type: created.type, status: 'PENDING', quantity, price: offer.price, automationKey: created.automationKey },
        });
      }
    }

    const lp = payload.landingPage || {};
    await this.repo.createClinicLandingPage({
      clinicId: clinic.id,
      landingPageId,
      title: lp.title || payload.name,
      shortDescription: lp.shortDescription || payload.description,
      primaryCta: lp.primaryCta || 'Book Appointment',
      whatsappNumber: lp.whatsappNumber || payload.whatsapp?.displayPhoneNumber || payload.phone,
      enquiryFormEnabled: lp.enquiryFormEnabled ?? true,
    });

    const ai = payload.ai || {};
    const knowledgeParts = [
      ai.clinicInformation && `Clinic Information:\n${ai.clinicInformation}`,
      ai.faqs && `FAQs:\n${ai.faqs}`,
    ].filter(Boolean);

    await this.repo.createClinicAiConfig({
      clinicId: clinic.id,
      isAiEnabled: ai.isAiEnabled ?? true,
      tone: ai.tone || 'professional',
      systemPrompt: knowledgeParts.join('\n\n') || undefined,
      customInstructions: [
        ai.receptionistName && `Receptionist name: ${ai.receptionistName}`,
        ai.greetingMessage && `Greeting: ${ai.greetingMessage}`,
        ai.conversationInstructions,
      ]
        .filter(Boolean)
        .join('\n'),
      humanHandoffKeywords: [
        'human',
        'doctor',
        'receptionist',
        'speak to someone',
        'agent',
        'emergency',
      ],
      metadata: {
        receptionistName: ai.receptionistName || 'Asha',
        greetingMessage: ai.greetingMessage,
        conversationInstructions: ai.conversationInstructions,
        clinicInformation: ai.clinicInformation || '',
        faqs: ai.faqs || '',
      },
    });

    if (
      payload.whatsapp?.phoneNumberId &&
      payload.whatsapp?.accessToken
    ) {
      await assertCanAddWhatsappNumber(clinic.id);
      await this.repo.createWhatsappAccount({
        clinicId: clinic.id,
        phoneNumberId: payload.whatsapp.phoneNumberId,
        businessAccountId: payload.whatsapp.businessAccountId,
        displayPhoneNumber: payload.whatsapp.displayPhoneNumber || payload.phone,
        accessToken: payload.whatsapp.accessToken,
        apiVersion: payload.whatsapp.apiVersion,
        webhookUrl: payload.whatsapp.webhookUrl,
        verifyToken: payload.whatsapp.verifyToken,
        webhookStatus: payload.whatsapp.webhookStatus || 'PENDING',
      });
    }

    await logAuditEvent({
      clinicId: clinic.id,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'CLINIC_ONBOARDED',
      resourceType: 'CLINIC',
      resourceId: clinic.id,
      metadata: { name: clinic.name, tier: payload.tier, landingPageId },
    });

    return this.getClinicById(clinic.id);
  }

  async getPublicLandingById(landingPageId: string) {
    const clinic = await this.repo.findClinicByLandingPageId(landingPageId);
    if (!clinic || !clinic.landingPage) {
      throw new AppError('Landing page not found', 404, 'NOT_FOUND');
    }
    const lp = clinic.landingPage;
    return {
      landingPageId: lp.landingPageId,
      clinicId: clinic.id,
      clinicName: clinic.name,
      title: lp.title || clinic.name,
      shortDescription: lp.shortDescription || clinic.description || '',
      primaryCta: lp.primaryCta || 'Book Appointment',
      whatsappNumber: lp.whatsappNumber || clinic.phone || '',
      enquiryFormEnabled: lp.enquiryFormEnabled,
      services: lp.services || clinic.services.map((s) => ({ id: s.id, name: s.name, price: Number(s.price) })),
      doctors: lp.doctors ||
        clinic.doctors.map((d) => ({
          id: d.id,
          name: `${d.user.firstName} ${d.user.lastName || ''}`.trim(),
          specialization: d.specialization,
        })),
      address: lp.address || clinic.address || '',
      city: clinic.city || '',
      additionalInfo: lp.additionalInfo || '',
      workingDays: clinic.workingDays,
      openingTime: clinic.openingTime,
      closingTime: clinic.closingTime,
      website: clinic.website,
      logoUrl: clinic.logoUrl,
      isPublished: lp.isPublished,
    };
  }

  /**
   * Public landing form → resolve clinic by landingPageId → create/update lead,
   * match preferred doctor, open the conversation, and queue the landing enquiry template.
   */
  async submitPublicLandingEnquiry(
    landingPageId: string,
    payload: {
      name: string;
      phone: string;
      email?: string;
      howYouFindUs: string;
      preferredDoctor: string;
      service: string;
    }
  ) {
    const clinic = await this.repo.findClinicByLandingPageId(landingPageId);
    if (!clinic || !clinic.landingPage) {
      throw new AppError('Landing page not found', 404, 'NOT_FOUND');
    }
    if (clinic.landingPage.enquiryFormEnabled === false) {
      throw new AppError('Enquiry form is disabled for this landing page', 403, 'FORBIDDEN');
    }

    let phone = payload.phone.replace(/[\s\-()+/]/g, '');
    if (phone.length < 8) {
      throw new AppError('Valid phone / WhatsApp number is required', 400, 'VALIDATION_ERROR');
    }
    // Align with WhatsApp `from` (E.164 without +) so inbound replies match the same lead.
    if (/^\d{10}$/.test(phone)) {
      phone = `91${phone}`;
    }

    const preferredDoctor = payload.preferredDoctor.trim();
    const service = payload.service.trim();
    const howYouFindUs = payload.howYouFindUs.trim();

    const matchedDoctor = (clinic.doctors || []).find((d) => {
      const full = `${d.user.firstName} ${d.user.lastName || ''}`.trim().toLowerCase();
      const needle = preferredDoctor.toLowerCase().replace(/^dr\.?\s*/, '');
      return full.includes(needle) || needle.includes(full);
    });

    const notes = [
      `Landing enquiry (${landingPageId})`,
      `Preferred doctor: ${preferredDoctor}`,
      matchedDoctor ? `Matched doctorId: ${matchedDoctor.id}` : 'Doctor match: not found in clinic roster',
      `Service: ${service}`,
      `How they found us: ${howYouFindUs}`,
    ].join('\n');

    const patientName = payload.name.trim();
    const landingContext = [
      `Lead from landing page ${landingPageId}`,
      `Patient name: ${patientName}`,
      `Phone: ${phone}`,
      payload.email?.trim() ? `Email: ${payload.email.trim()}` : null,
      `Interested service: ${service}`,
      `Preferred doctor: ${preferredDoctor}`,
      `How they found us: ${howYouFindUs}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Always personalize — do not let generic clinic greeting override name/service.
    const greeting =
      `Namaste ${patientName}! ${service} ke liye interest ke liye thanks` +
      (preferredDoctor ? ` — Dr. ${preferredDoctor.replace(/^Dr\.?\s*/i, '')}` : '') +
      ` at ${clinic.name}. Maine aapki request note kar li hai.` +
      ` Hinglish mein baat karein ya English? Preferred date/time bhi bata dena — main booking me help karti hoon.`;

    const result = await prisma.$transaction(async (tx) => {
      let lead = await tx.lead.findFirst({
        where: { clinicId: clinic.id, phone },
        orderBy: { createdAt: 'desc' },
      });

      if (!lead) {
        lead = await tx.lead.create({
          data: {
            clinicId: clinic.id,
            name: patientName,
            phone,
            email: payload.email?.trim() || null,
            source: 'WEBSITE',
            status: 'NEW',
            intent: 'HIGH',
            score: 85,
            interestedService: service,
            preferredDoctor,
            howHeardAboutDoctor: howYouFindUs,
            notes,
          },
        });

        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            type: 'created',
            title: 'Lead Captured',
            description: `Captured via landing page ${landingPageId} — ${service} / ${preferredDoctor}`,
            actor: 'Landing Page',
          },
        });
      } else {
        lead = await tx.lead.update({
          where: { id: lead.id },
          data: {
            name: patientName,
            email: payload.email?.trim() || lead.email,
            source: 'WEBSITE',
            intent: 'HIGH',
            score: Math.max(lead.score ?? 50, 85),
            interestedService: service,
            preferredDoctor,
            howHeardAboutDoctor: howYouFindUs,
            notes: [lead.notes, notes].filter(Boolean).join('\n\n'),
          },
        });

        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            type: 'note',
            title: 'Landing Enquiry Updated',
            description: `New enquiry for ${service} with ${preferredDoctor}`,
            actor: 'Landing Page',
          },
        });
      }

      const waAccount = clinic.whatsappAccounts?.[0];
      let conversation = await tx.conversation.findFirst({
        where: { clinicId: clinic.id, participantPhone: phone },
        orderBy: { createdAt: 'desc' },
      });

      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            clinicId: clinic.id,
            leadId: lead.id,
            doctorId: matchedDoctor?.id,
            whatsappAccountId: waAccount?.id,
            participantName: patientName,
            participantPhone: phone,
            state: 'AI_ACTIVE',
            serviceInterested: service,
            internalNotes: landingContext,
            unreadCount: 0,
            lastActivityAt: new Date(),
          },
        });
      } else {
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            leadId: lead.id,
            doctorId: matchedDoctor?.id || conversation.doctorId,
            participantName: patientName,
            whatsappAccountId: waAccount?.id || conversation.whatsappAccountId,
            serviceInterested: service,
            internalNotes: [conversation.internalNotes, landingContext].filter(Boolean).join('\n\n'),
            state: conversation.state === 'CLOSED' ? 'AI_ACTIVE' : conversation.state,
            lastActivityAt: new Date(),
          },
        });
      }

      await tx.notification.create({
        data: {
          clinicId: clinic.id,
          type: 'NEW_LEAD',
          title: `New enquiry from ${patientName}`,
          message: `${service}${preferredDoctor ? ` with ${preferredDoctor}` : ''}`,
          link: `/leads/${lead.id}`,
          entityId: lead.id,
        },
      });

      return {
        leadId: lead.id,
        conversationId: conversation.id,
        doctorId: matchedDoctor?.id || null,
      };
    });

    let whatsappQueued = false;
    try {
      const queued = await queueTemplateSends(clinic.id, 'LANDING_ENQUIRY', {
        leadIds: [result.leadId],
      });
      whatsappQueued = queued.queued.length > 0;
    } catch (err: any) {
      console.warn('[Landing] enquiry WhatsApp was not queued:', err?.message || err);
    }

    await logAuditEvent({
      clinicId: clinic.id,
      actorId: 'LANDING_PAGE',
      actorEmail: 'landing@public',
      actorType: 'SYSTEM',
      action: 'LEAD_CREATED',
      resourceType: 'LEAD',
      resourceId: result.leadId,
      metadata: {
        landingPageId,
        preferredDoctor,
        service,
        howYouFindUs,
        doctorId: result.doctorId,
      },
    });

    return {
      ...result,
      clinicId: clinic.id,
      clinicName: clinic.name,
      preferredDoctor,
      service,
      greeting,
      whatsappQueued,
    };
  }

  async addClinicUser(
    clinicId: string,
    payload: {
      name: string;
      email: string;
      phone?: string;
      role: 'DOCTOR' | 'EMPLOYEE';
      designation?: string;
      specialization?: string;
      registrationNumber?: string;
      qualification?: string;
      experienceYears?: number;
      consultationFee?: number;
      password: string;
    },
    admin: { adminId: string; email: string }
  ) {
    const clinic = await this.repo.findClinicById(clinicId);
    if (!clinic) {
      throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    }

    const seat = payload.role === 'DOCTOR'
      ? await assertCanAddDoctor(clinicId)
      : await assertCanAddStaff(clinicId);
    if (!seat.enforced) {
      await assertClinicSeatAvailable(clinicId);
    }

    const { firstName, lastName } = splitName(payload.name);
    if (!payload.password || payload.password.length < 6) {
      throw new AppError('Password is required (min 6 characters).', 400, 'VALIDATION_ERROR');
    }
    const passwordHash = await bcrypt.hash(payload.password, 10);

    const user = await this.repo.createClinicStaffUser({
      clinicId,
      email: payload.email,
      passwordHash,
      firstName,
      lastName,
      title: payload.designation || (payload.role === 'DOCTOR' ? 'Dr.' : 'Staff'),
      phone: payload.phone,
      role: payload.role,
      specialization: payload.specialization,
      registrationNo: payload.registrationNumber,
      qualification: payload.qualification,
      experienceYears: payload.experienceYears,
      consultationFee: payload.consultationFee,
    });

    await logAuditEvent({
      clinicId,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'CLINIC_USER_CREATED',
      resourceType: 'USER',
      resourceId: user.id,
      metadata: { role: payload.role, email: payload.email },
    });

    return {
      id: user.id,
      clinicId,
      clinicName: clinic.name,
      name: `${user.firstName} ${user.lastName || ''}`.trim(),
      email: user.email,
      phone: user.phone || '',
      role: user.role,
      status: user.status,
      designation: payload.designation || user.title,
      specialization: payload.specialization,
      registrationNumber: payload.registrationNumber,
      qualification: payload.qualification,
      experienceYears: payload.experienceYears,
      consultationFee: payload.consultationFee,
      lastActiveAt: new Date().toISOString(),
      createdAt: user.createdAt.toISOString(),
    };
  }

  async setPrimaryDoctor(
    clinicId: string,
    payload: { userId?: string; doctorId?: string },
    admin: { adminId: string; email: string }
  ) {
    const clinic = await this.repo.findClinicById(clinicId);
    if (!clinic) {
      throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    }

    const doctor = await prisma.doctor.findFirst({
      where: {
        clinicId,
        ...(payload.doctorId ? { id: payload.doctorId } : {}),
        ...(payload.userId ? { userId: payload.userId } : {}),
      },
      include: { user: true },
    });
    if (!doctor) {
      throw new AppError('Doctor profile not found for this clinic.', 404, 'NOT_FOUND');
    }

    await prisma.$transaction([
      prisma.doctor.updateMany({
        where: { clinicId, isPrimary: true },
        data: { isPrimary: false },
      }),
      prisma.doctor.update({
        where: { id: doctor.id },
        data: { isPrimary: true },
      }),
    ]);

    await logAuditEvent({
      clinicId,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'PRIMARY_DOCTOR_SET',
      resourceType: 'DOCTOR',
      resourceId: doctor.id,
      metadata: { userId: doctor.userId, name: `${doctor.user.firstName} ${doctor.user.lastName || ''}`.trim() },
    });

    return this.getClinicById(clinicId);
  }

  async updateClinicAiConfig(clinicId: string, data: any) {
    const clinic = await this.repo.findClinicById(clinicId);
    if (!clinic) {
      throw new AppError('Clinic not found', 404, 'NOT_FOUND');
    }

    const updated = await this.repo.upsertClinicAiConfig(clinicId, data);
    void aiClient.invalidateClinicCache(clinicId);
    return updated;
  }

  async getAiUsageSummary(filter: AdminAIUsageFilterDTO) {
    const summary = await this.repo.getAiUsageSummaryFromDB(filter);

    return {
      totalRequests: summary._count.id,
      totalTokens: summary._sum.totalTokens || 0,
      inputTokens: summary._sum.inputTokens || 0,
      outputTokens: summary._sum.outputTokens || 0,
      totalCost: Number(summary._sum.totalCost || 0),
      inputCost: Number(summary._sum.inputCost || 0),
      outputCost: Number(summary._sum.outputCost || 0),
      avgLatencyMs: Math.round(summary._avg.durationMs || 0),
    };
  }

  async getAiUsageDaily(days: number = 7) {
    return this.repo.getAiUsageDailySeries(days);
  }

  async listAiConversations(limit: number = 50) {
    const rows = await this.repo.listRecentConversations(limit);
    return rows.map((c) => ({
      id: c.id,
      entity_id: c.clinicId,
      entity_name: c.clinic?.name || 'Clinic',
      entity_type: 'CLINIC',
      participant_id: c.participantPhone,
      participant_name: c.participantName,
      channel: 'WHATSAPP',
      state: c.state,
      message_count: c._count?.messages || 0,
      summary: c.lastMessageText || '',
      last_activity: c.lastActivityAt || c.updatedAt,
      clinic_id: c.clinicId,
      doctor_name: c.doctor
        ? this.formatDoctorName(c.doctor.user.firstName, c.doctor.user.lastName)
        : null,
    }));
  }

  async getAiConversationById(id: string) {
    const c = await this.repo.getConversationWithMessages(id);
    if (!c) {
      throw new AppError('Conversation not found', 404, 'NOT_FOUND');
    }
    return {
      id: c.id,
      entity_id: c.clinicId,
      entity_name: c.clinic?.name || 'Clinic',
      entity_type: 'CLINIC',
      participant_id: c.participantPhone,
      participant_name: c.participantName,
      channel: 'WHATSAPP',
      state: c.state,
      message_count: c._count?.messages || c.messages?.length || 0,
      summary: c.lastMessageText || '',
      messages: (c.messages || []).map((m: any) => ({
        id: m.id,
        role: m.direction === 'INBOUND' ? 'user' : m.senderType === 'AI' ? 'assistant' : 'staff',
        content: m.content,
        created_at: m.createdAt,
      })),
    };
  }

  async getAiUsageByClinics(filter: AdminAIUsageFilterDTO) {
    const groups = await this.repo.getAiUsageGroupedByClinic(filter);
    const clinicIds = groups.map((g) => g.clinicId).filter(Boolean) as string[];
    const clinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: {
        id: true,
        name: true,
        city: true,
        cgsSubscriptions: {
          where: { status: 'ACTIVE' },
          take: 1,
          include: { plan: true },
        },
      },
    });
    const clinicMap = new Map(clinics.map((c) => [c.id, c]));

    const waGroups = clinicIds.length
      ? await prisma.whatsAppUsage.groupBy({
          by: ['clinicId'],
          where: { clinicId: { in: clinicIds } },
          _sum: { quantity: true, totalCost: true },
        })
      : [];
    const waMap = new Map(waGroups.map((w) => [w.clinicId, w]));

    return groups.map((g) => {
      const c = g.clinicId ? clinicMap.get(g.clinicId) : null;
      const plan = c?.cgsSubscriptions?.[0]?.plan;
      const wa = g.clinicId ? waMap.get(g.clinicId) : null;
      return {
        clinicId: g.clinicId || 'unknown',
        clinicName: c ? c.name : 'Unassigned Clinic',
        city: c ? c.city : undefined,
        requests: g._count.id,
        totalTokens: g._sum.totalTokens || 0,
        inputTokens: g._sum.inputTokens || 0,
        outputTokens: g._sum.outputTokens || 0,
        totalCost: Number(g._sum.totalCost || 0),
        avgDurationMs: Math.round(g._avg.durationMs || 0),
        whatsappConsumed: wa?._sum.quantity || 0,
        whatsappCost: Number(wa?._sum.totalCost || 0),
        whatsappIncluded: plan?.whatsappIncluded ?? null,
        aiTokensIncluded: plan?.aiTokensIncluded ?? null,
      };
    });
  }

  async getAiUsageByDoctors(filter: AdminAIUsageFilterDTO) {
    const groups = await this.repo.getAiUsageGroupedByDoctor(filter);
    const doctorIds = groups.map((g) => g.doctorId).filter(Boolean) as string[];
    const doctors = await prisma.doctor.findMany({
      where: { id: { in: doctorIds } },
      include: {
        user: { select: { firstName: true, lastName: true } },
        clinic: { select: { id: true, name: true } },
      },
    });
    const doctorMap = new Map(doctors.map((d) => [d.id, d]));

    return groups.map((g) => {
      const d = g.doctorId ? doctorMap.get(g.doctorId) : null;
      return {
        doctorId: g.doctorId || 'unassigned',
        doctorName: d ? this.formatDoctorName(d.user.firstName, d.user.lastName) : 'Clinic AI (No Doctor Assigned)',
        clinicId: d ? d.clinic.id : undefined,
        clinicName: d ? d.clinic.name : undefined,
        specialization: d ? d.specialization : undefined,
        requests: g._count.id,
        totalTokens: g._sum.totalTokens || 0,
        inputTokens: g._sum.inputTokens || 0,
        outputTokens: g._sum.outputTokens || 0,
        totalCost: Number(g._sum.totalCost || 0),
        avgDurationMs: Math.round(g._avg.durationMs || 0),
      };
    });
  }

  async getAiUsageByModels(filter: AdminAIUsageFilterDTO) {
    const groups = await this.repo.getAiUsageGroupedByModel(filter);
    const totalTokens = groups.reduce((sum, g) => sum + (g._sum.totalTokens || 0), 0) || 1;
    return groups.map((g) => ({
      model: g.model,
      provider: g.provider,
      requests: g._count.id,
      totalTokens: g._sum.totalTokens || 0,
      inputTokens: g._sum.inputTokens || 0,
      outputTokens: g._sum.outputTokens || 0,
      totalCost: Number(g._sum.totalCost || 0),
      avgDurationMs: Math.round(g._avg.durationMs || 0),
      percentage: Math.round(((g._sum.totalTokens || 0) / totalTokens) * 1000) / 10,
    }));
  }

  async getAiUsageByEntities(filter: AdminAIUsageFilterDTO) {
    const groups = await this.repo.getAiUsageGroupedByEntity(filter);
    return groups.map((g) => ({
      entityType: g.entityType,
      entityId: g.entityId,
      requests: g._count.id,
      totalTokens: g._sum.totalTokens || 0,
      totalCost: Number(g._sum.totalCost || 0),
      avgDurationMs: Math.round(g._avg.durationMs || 0),
    }));
  }

  async listSubscriptions() {
    const rows = await this.repo.listSubscriptions();
    return rows.map((s: any) => ({
      id: s.id,
      clinicId: s.clinicId,
      clinicName: s.clinic?.name || 'Clinic',
      planId: s.planId,
      planName: s.plan?.name || 'Plan',
      tier: s.plan?.tier || 'ENTERPRISE',
      status: s.status,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      autoRenew: s.autoRenew,
      amount: packageMonthlyAmount(s.plan, Boolean(s.earlyBird)),
      currency: s.plan?.currency || 'INR',
      paymentMethodLast4: '0000',
      paymentMethodBrand: 'UPI',
    }));
  }

  async listInvoices() {
    const rows = await this.repo.listAdminInvoices();
    return rows.map((inv: any) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      clinicId: inv.clinicId,
      clinicName: inv.subscription?.clinic?.name || 'Clinic',
      planName: inv.subscription?.plan?.name || 'Plan',
      description: inv.notes || '',
      amount: Number(inv.subtotal || 0),
      taxAmount: Number(inv.adjustments || 0),
      totalAmount: Number(inv.total || 0),
      currency: 'INR',
      status: inv.status === 'PAID' ? 'PAID' : inv.status === 'VOID' ? 'REFUNDED' : inv.status === 'OVERDUE' ? 'OVERDUE' : inv.status === 'ISSUED' ? 'ISSUED' : 'PENDING',
      billingPeriodStart: inv.periodStart,
      billingPeriodEnd: inv.periodEnd,
      dueDate: inv.dueAt || inv.periodEnd,
      paidAt: inv.status === 'PAID' ? inv.issuedAt : undefined,
    }));
  }

  async subscriptionInvoicePdf(id: string) {
    const invoice = await this.repo.findSubscriptionInvoice(id);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'NOT_FOUND');
    }
    const address = [invoice.clinic.address, invoice.clinic.city].filter(Boolean).join(', ');
    const priced = gstOn(Number(invoice.subtotal || 0));
    const taxAmount = Number(invoice.adjustments || 0) > 0 ? Number(invoice.adjustments) : priced.taxAmount;
    const total = Number(invoice.adjustments || 0) > 0 ? Number(invoice.total || 0) : priced.total;
    const buffer = await buildSubscriptionInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      description: invoice.notes || `${invoice.subscription?.plan?.name || 'Plan'} monthly subscription`,
      subtotal: Number(invoice.subtotal || 0),
      taxAmount,
      total,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      dueAt: invoice.dueAt,
      clinicName: invoice.clinic.name,
      clinicEmail: invoice.clinic.email,
      clinicPhone: invoice.clinic.phone,
      clinicAddress: address,
      planName: invoice.subscription?.plan?.name || 'Plan',
    });
    return { buffer, filename: subscriptionInvoiceFilename(invoice.invoiceNumber) };
  }

  async createOneTimeInvoice(body: { clinicId?: string; description?: string; amount?: number; dueDate?: string }) {
    const clinicId = String(body.clinicId || '').trim();
    const description = String(body.description || '').trim();
    const amount = Number(body.amount);
    if (!clinicId) throw new AppError('Choose a clinic.', 400, 'VALIDATION_ERROR');
    if (description.length < 3) throw new AppError('Describe the one-time payment.', 400, 'VALIDATION_ERROR');
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Enter an amount greater than zero.', 400, 'VALIDATION_ERROR');

    const dueAt = body.dueDate ? new Date(body.dueDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(dueAt.getTime())) throw new AppError('The due date is not valid.', 400, 'VALIDATION_ERROR');

    const priced = gstOn(amount);
    const issuedAt = new Date();

    const invoice = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subbill-clinic:${clinicId}`}))`;
      const subscription = await tx.cgsSubscription.findFirst({
        where: { clinicId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!subscription) {
        throw new AppError('This clinic has no active subscription.', 400, 'SUBSCRIPTION_REQUIRED');
      }
      const count = await tx.subscriptionInvoice.count({ where: { clinicId } });
      const invoiceNumber = `CGS-${issuedAt.getUTCFullYear()}-${String(count + 1).padStart(4, '0')}`;
      return tx.subscriptionInvoice.create({
        data: {
          clinicId,
          subscriptionId: subscription.id,
          invoiceNumber,
          subtotal: priced.subtotal,
          usageCharges: 0,
          adjustments: priced.taxAmount,
          total: priced.total,
          notes: description,
          status: 'ISSUED',
          periodStart: issuedAt,
          periodEnd: dueAt,
          issuedAt,
          dueAt,
        },
        include: {
          subscription: { include: { plan: { select: { name: true } }, clinic: { select: { name: true } } } },
        },
      });
    });

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      clinicId: invoice.clinicId,
      clinicName: invoice.subscription?.clinic?.name || 'Clinic',
      planName: invoice.subscription?.plan?.name || 'Plan',
      description,
      amount: priced.subtotal,
      taxAmount: priced.taxAmount,
      totalAmount: priced.total,
      currency: 'INR',
      status: 'ISSUED',
      billingPeriodStart: invoice.periodStart,
      billingPeriodEnd: invoice.periodEnd,
      dueDate: invoice.dueAt,
    };
  }

  async listPlans() {
    // priceMonthly stays the amount already billed. Brochure prices are the regular* fields.
    const plans = await this.repo.listPlans();
    return plans.map((p: any) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      priceMonthly: Number(p.priceMonthly),
      regularMonthlyPrice: Number(p.regularMonthlyPrice || 0),
      earlyBirdMonthlyPrice: Number(p.earlyBirdMonthlyPrice || 0),
      regularSetupFee: Number(p.regularSetupFee || 0),
      earlyBirdSetupFee: Number(p.earlyBirdSetupFee || 0),
      doctorsIncluded: p.doctorsIncluded,
      staffIncluded: p.staffIncluded,
      whatsappNumbersIncluded: p.whatsappNumbersIncluded,
      aiRepliesMonthly: p.aiRepliesMonthly,
      modelLevel: p.modelLevel,
      conversationMemory: p.conversationMemory,
      reportingLevel: p.reportingLevel,
      customAiIncluded: p.customAiIncluded,
      outboundIncluded: p.outboundIncluded,
      prioritySupportIncluded: p.prioritySupportIncluded,
      automationKeys: p.automationKeys || [],
      billingCycle: p.billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY',
      features: p.features || [],
      whatsappConversationsIncluded: p.whatsappIncluded,
      aiTokensIncluded: p.aiTokensIncluded,
      activeSubscriptionsCount: p._count?.subscriptions || 0,
      isPublic: p.isActive,
      overageRateWhatsApp: Number(p.overageRateWhatsApp),
      overageRateAi1kTokens: Number(p.overageRateAi1k),
    }));
  }

  async listPlatformUsers(query: AdminUserListQuery) {
    const [clinicUsers, adminUsers] = await Promise.all([
      this.repo.listPlatformUsers(),
      this.repo.listAdminUsers(),
    ]);

    const mapped = [
      ...adminUsers.map((a: any) => ({
        id: a.id,
        clinicName: undefined as string | undefined,
        name: a.name,
        email: a.email,
        phone: '',
        role: a.role,
        status: a.status,
        designation: a.role.replace(/_/g, ' '),
        lastActiveAt: (a.lastLoginAt || a.updatedAt).toISOString(),
        createdAt: a.createdAt.toISOString(),
      })),
      ...clinicUsers.map((u: any) => ({
        id: u.id,
        clinicId: u.clinicId,
        clinicName: u.clinic?.name,
        name: `${u.firstName} ${u.lastName || ''}`.trim(),
        email: u.email,
        phone: u.phone || '',
        role: u.role,
        status: u.status,
        designation: u.title || (u.role === 'DOCTOR' ? u.doctor?.specialization : 'Clinic Staff'),
        specialization: u.doctor?.specialization,
        registrationNumber: u.doctor?.registrationNo,
        qualification: u.doctor?.qualification,
        experienceYears: u.doctor?.experienceYears,
        consultationFee: u.doctor?.consultationFee ? Number(u.doctor.consultationFee) : undefined,
        lastActiveAt: (u.lastLoginAt || u.updatedAt).toISOString(),
        createdAt: u.createdAt.toISOString(),
      })),
    ];

    const filtered = mapped.filter((u) => {
      if (query.role && query.role !== 'ALL' && u.role !== query.role) return false;
      if (query.status && query.status !== 'ALL' && u.status !== query.status) return false;
      if (query.search) {
        const q = query.search.toLowerCase();
        return (
          u.name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          (u.clinicName || '').toLowerCase().includes(q)
        );
      }
      return true;
    });

    const page = query.page || 1;
    const pageSize = query.pageSize || 20;
    return {
      data: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  async listWhatsappHealth() {
    const accounts = await this.repo.listWhatsappAccounts();
    return accounts.map((a: any) => ({
      id: a.id,
      clinicId: a.clinicId,
      clinicName: a.clinic?.name || 'Clinic',
      phoneNumber: a.displayPhoneNumber || a.phoneNumberId,
      wabaId: a.businessAccountId || a.phoneNumberId,
      connectionState: a.isActive ? 'CONNECTED' : 'DISCONNECTED',
      webhookState: a.isActive ? 'HEALTHY' : 'FAILING',
      latencyMs: 120,
      qualityRating:
        a.qualityRating === 'GREEN' || a.qualityRating === 'High'
          ? 'GREEN'
          : a.qualityRating === 'YELLOW'
            ? 'YELLOW'
            : a.qualityRating === 'RED'
              ? 'RED'
              : 'GREEN',
      dailyMessagesSent: a._count?.messages || 0,
      dailyMessagesReceived: a._count?.conversations || 0,
      lastVerifiedAt: a.updatedAt,
    }));
  }

  async listJobs(query: AdminJobListQuery) {
    const result = await this.repo.listJobs(query);
    return {
      data: result.jobs.map((j: any) => this.mapJob(j)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
    };
  }

  async retryJob(id: string, admin: { adminId: string; email: string }) {
    const job = await this.repo.findJobById(id);
    if (!job) {
      throw new AppError('Job not found', 404, 'NOT_FOUND');
    }
    if (job.status !== 'FAILED') {
      throw new AppError('Only a failed job can be retried.', 409, 'JOB_NOT_RETRYABLE');
    }
    const updated = await this.repo.retryJob(id);
    await logAuditEvent({
      clinicId: job.clinicId || undefined,
      actorId: admin.adminId,
      actorEmail: admin.email,
      actorType: 'ADMIN',
      action: 'JOB_RETRIED',
      resourceType: 'JOB',
      resourceId: id,
    });
    return this.mapJob(updated);
  }

  async listAuditLogs(query: { page?: number; pageSize?: number; action?: string; search?: string }) {
    const result = await auditService.listLogs({
      page: query.page,
      limit: query.pageSize,
      action: query.action,
      search: query.search,
    });

    return {
      data: result.data.map((log: any) => ({
        id: log.id,
        timestamp: log.createdAt,
        actorId: log.actorId,
        actorEmail: log.actorEmail,
        actorType: log.actorType === 'ADMIN' ? 'ADMIN' : log.actorType === 'SYSTEM' ? 'SYSTEM' : 'CLINIC_USER',
        action: log.action,
        resource: log.resourceType,
        resourceId: log.resourceId || '',
        clinicId: log.clinicId || undefined,
        ipAddress: log.ipAddress || '',
        userAgent: log.userAgent || '',
        result: 'SUCCESS',
        diffBefore: log.diffBefore || undefined,
        diffAfter: log.diffAfter || undefined,
        metadata: log.metadata || undefined,
      })),
      total: result.meta.total,
      page: result.meta.page,
      pageSize: result.meta.limit,
      totalPages: result.meta.totalPages,
    };
  }

  private mapClinicListItem(c: any) {
    const plan = c.cgsSubscriptions?.[0]?.plan;
    const leadDoctor = c.doctors?.[0];
    const doctorsCount = c._count?.doctors || 0;
    const usersCount = c._count?.users || 0;

    return {
      id: c.id,
      name: c.name,
      slug: c.slug || c.id.slice(0, 8),
      landingPageId: c.landingPageId || c.landingPage?.landingPageId || null,
      status: toUiClinicStatus(c.status),
      doctorName: leadDoctor
        ? this.formatDoctorName(leadDoctor.user.firstName, leadDoctor.user.lastName)
        : 'Unassigned',
      email: c.email || '',
      phone: c.phone || '',
      city: c.city || '',
      state: c.state || '',
      address: c.address || '',
      gstin: c.gstin || '',
      website: c.website || '',
      description: c.description || '',
      logoUrl: c.logoUrl || '',
      workingDays: c.workingDays || [],
      openingTime: c.openingTime || '',
      closingTime: c.closingTime || '',
      tier: plan?.tier || 'STARTER',
      packageAssigned: Boolean(plan),
      mrr: packageMonthlyAmount(plan, Boolean(c.cgsSubscriptions?.[0]?.earlyBird)),
      createdAt: c.createdAt,
      doctorsCount,
      staffCount: Math.max(0, usersCount - doctorsCount),
      leadsCount: c._count?.leads || 0,
      patientsCount: c._count?.patients || 0,
      appointmentsCount: c._count?.appointments || 0,
      whatsappConnected: (c._count?.whatsappAccounts || 0) > 0 || (c.whatsappAccounts?.length || 0) > 0,
      aiEnabled: !!c.aiConfig?.isAiEnabled,
    };
  }

  private ratesForModel(model: string, provider: string) {
    if (model.includes(':free')) return { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    if (provider === 'groq') return { inputUsdPerMillion: 0.59, outputUsdPerMillion: 0.79 };
    return { inputUsdPerMillion: 0.08, outputUsdPerMillion: 0.35 };
  }

  private async fetchAiRuntime() {
    try {
      const data = await aiClient.request<any>('/internal/diagnostics');
      const provider = data?.provider || 'unknown';
      const models = [data?.default_model, data?.fallback_model, data?.fallback_model_2].filter(
        (name: unknown): name is string => typeof name === 'string' && name.length > 0
      );
      const reported = Array.isArray(data?.model_rates) ? data.model_rates : [];
      const modelRates = models.map((name) => {
        const row = reported.find((item: any) => item?.name === name);
        if (row && row.input_usd_per_million != null && row.output_usd_per_million != null) {
          return {
            name,
            inputUsdPerMillion: Number(row.input_usd_per_million),
            outputUsdPerMillion: Number(row.output_usd_per_million),
          };
        }
        return { name, ...this.ratesForModel(name, provider) };
      });
      const defaultRates = modelRates[0] || this.ratesForModel(String(data?.default_model || ''), provider);
      return {
        provider,
        model: data?.default_model || '',
        fallbackModel: data?.fallback_model || '',
        fallbackModel2: data?.fallback_model_2 || '',
        llmConfigured: Boolean(data?.llm_configured),
        inputUsdPerMillion: data?.input_usd_per_million != null
          ? Number(data.input_usd_per_million)
          : defaultRates.inputUsdPerMillion,
        outputUsdPerMillion: data?.output_usd_per_million != null
          ? Number(data.output_usd_per_million)
          : defaultRates.outputUsdPerMillion,
        models,
        modelRates,
      };
    } catch {
      return null;
    }
  }

  private mapClinicDetail(c: any, usage: { ai: any; wa: any }, runtime?: { provider: string; model: string } | null) {
    const base = this.mapClinicListItem(c);
    const plan = c.cgsSubscriptions?.[0]?.plan;
    const subscription = c.cgsSubscriptions?.[0];
    const wa = c.whatsappAccounts?.[0];
    const quality = wa?.qualityRating;

    return {
      ...base,
      users: (c.users || []).map((u: any) => ({
        id: u.id,
        clinicId: c.id,
        clinicName: c.name,
        name: `${u.firstName} ${u.lastName || ''}`.trim(),
        email: u.email,
        phone: u.phone || '',
        role: u.role,
        status: u.status,
        designation: u.title || (u.role === 'DOCTOR' ? u.doctor?.specialization : 'Clinic Staff'),
        specialization: u.doctor?.specialization,
        registrationNumber: u.doctor?.registrationNo,
        qualification: u.doctor?.qualification,
        experienceYears: u.doctor?.experienceYears,
        consultationFee: u.doctor?.consultationFee ? Number(u.doctor.consultationFee) : undefined,
        doctorId: u.doctor?.id,
        isPrimary: !!u.doctor?.isPrimary,
        lastActiveAt: (u.lastLoginAt || u.updatedAt).toISOString(),
        createdAt: u.createdAt.toISOString(),
      })),
      subscription: subscription
        ? {
            id: subscription.id,
            clinicId: c.id,
            clinicName: c.name,
            planId: subscription.planId,
            planName: plan?.name || 'Plan',
            tier: plan?.tier || 'STARTER',
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            autoRenew: subscription.autoRenew,
            earlyBird: subscription.earlyBird,
            limitsApply: subscription.limitsApply,
            packageMonthly: packageMonthlyAmount(plan, Boolean(subscription.earlyBird)),
            assigned: true,
            amount: packageMonthlyAmount(plan, Boolean(subscription.earlyBird)),
            currency: plan?.currency || 'INR',
            paymentMethodLast4: '',
            paymentMethodBrand: '',
          }
        : {
            id: `sub-${c.id}`,
            clinicId: c.id,
            clinicName: c.name,
            planId: '',
            planName: 'Unassigned',
            tier: 'STARTER',
            status: 'TRIALING',
            currentPeriodStart: c.createdAt,
            currentPeriodEnd: c.createdAt,
            autoRenew: false,
            amount: 0,
            currency: 'INR',
            paymentMethodLast4: '',
            paymentMethodBrand: '',
            earlyBird: false,
            limitsApply: false,
            packageMonthly: 0,
            assigned: false,
          },
      addons: (c.addons || []).map((addon: any) => ({
        id: addon.id,
        type: addon.type,
        price: Number(addon.price),
        quantity: addon.quantity,
        billing: addon.billing,
        status: addon.status,
        automationKey: addon.automationKey,
        periodStart: addon.periodStart,
        periodEnd: addon.periodEnd,
      })),
      subscriptionInvoices: (c.cgsSubscriptions || [])
        .flatMap((row: any) => row.invoices || [])
        .sort((a: any, b: any) => new Date(b.periodStart).getTime() - new Date(a.periodStart).getTime())
        .slice(0, 12)
        .map((invoice: any) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          subtotal: Number(invoice.subtotal || 0),
          taxAmount: Number(invoice.adjustments || 0),
          total: Number(invoice.total || 0),
          description: invoice.notes || '',
          status: invoice.status,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          dueAt: invoice.dueAt,
        })),
      whatsappConfig: {
        phoneNumber: wa?.displayPhoneNumber || c.phone || '',
        wabaId: wa?.businessAccountId || wa?.phoneNumberId || '',
        phoneNumberId: wa?.phoneNumberId || '',
        apiVersion: wa?.apiVersion || 'v19.0',
        webhookUrl: wa?.webhookUrl || '',
        verifyToken: wa?.verifyToken || '',
        connectionState: wa?.isActive ? 'CONNECTED' : 'DISCONNECTED',
        webhookStatus: wa?.webhookStatus === 'HEALTHY' || wa?.isActive ? 'HEALTHY' : wa?.webhookStatus === 'SLOW' ? 'SLOW' : 'FAILING',
        qualityRating: quality === 'YELLOW' ? 'YELLOW' : quality === 'RED' ? 'RED' : 'GREEN',
        dailyLimit: 1000,
        lastVerifiedAt: wa?.updatedAt || c.updatedAt,
        messageTemplates: wa?.messageTemplates || {},
      },
      aiConfig: {
        enabled: c.aiConfig?.isAiEnabled ?? true,
        provider: runtime?.provider || '',
        model: runtime?.model || '',
        systemPromptVersion: c.aiConfig?.systemPrompt ? 'custom' : 'default',
        monthlyTokenQuota: plan?.aiTokensIncluded ?? null,
        tokensConsumedThisMonth: usage.ai._sum.totalTokens || 0,
        customKnowledgeDocsCount: 0,
        tone: c.aiConfig?.tone || 'professional',
        receptionistName: c.aiConfig?.metadata?.receptionistName || 'Asha',
        greetingMessage: c.aiConfig?.metadata?.greetingMessage || '',
        customInstructions: c.aiConfig?.customInstructions || '',
      },
      landingPage: c.landingPage
        ? {
            landingPageId: c.landingPage.landingPageId,
            title: c.landingPage.title,
            shortDescription: c.landingPage.shortDescription,
            primaryCta: c.landingPage.primaryCta,
            whatsappNumber: c.landingPage.whatsappNumber,
            enquiryFormEnabled: c.landingPage.enquiryFormEnabled,
            services: c.landingPage.services,
            doctors: c.landingPage.doctors,
            address: c.landingPage.address,
            additionalInfo: c.landingPage.additionalInfo,
            isPublished: c.landingPage.isPublished,
          }
        : null,
      workflowConfig: c.workflowConfig
        ? {
            qualificationEnabled: c.workflowConfig.qualificationEnabled,
            appointmentEnabled: c.workflowConfig.appointmentEnabled,
            reminderEnabled: c.workflowConfig.reminderEnabled,
            followUpEnabled: c.workflowConfig.followUpEnabled,
            noResponseEnabled: c.workflowConfig.noResponseEnabled,
            staffHandoffEnabled: c.workflowConfig.staffHandoffEnabled,
            followUpHours: c.workflowConfig.followUpHours,
            reminderHoursBefore: c.workflowConfig.reminderHoursBefore,
          }
        : null,
      usageSummary: {
        whatsappConversations: usage.wa._sum.quantity || 0,
        whatsappCost: Number(usage.wa._sum.totalCost || 0),
        aiTokens: usage.ai._sum.totalTokens || 0,
        aiCost: Number(usage.ai._sum.totalCost || 0),
        totalOverageCost: 0,
      },
      recentAuditLogs: (c.auditLogs || []).map((log: any) => ({
        id: log.id,
        timestamp: log.createdAt,
        actorId: log.actorId,
        actorEmail: log.actorEmail,
        actorType: log.actorType === 'ADMIN' ? 'ADMIN' : 'CLINIC_USER',
        action: log.action,
        resource: log.resourceType,
        resourceId: log.resourceId || '',
        clinicId: log.clinicId || undefined,
        ipAddress: log.ipAddress || '',
        userAgent: log.userAgent || '',
        result: 'SUCCESS',
      })),
    };
  }

  private mapJob(j: any) {
    const details = describeJob(j.type, j.payload);
    return {
      id: j.id,
      queue: j.queue || 'DEFAULT',
      jobType: j.type,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      createdAt: j.createdAt,
      startedAt: j.lockedAt || undefined,
      completedAt: j.completedAt || undefined,
      failedAt: j.status === 'FAILED' ? j.updatedAt : undefined,
      failureReason: j.lastError || undefined,
      clinicId: j.clinicId || undefined,
      clinicName: j.clinic?.name,
      availableAt: j.availableAt,
      note: typeof j.payload?.note === 'string' ? j.payload.note : undefined,
      details,
    };
  }

  // Platform Settings State
  private platformSettingsState = {
    platformName: 'Clinic Growth System (CGS)',
    maintenanceMode: false,
    defaultCurrency: 'INR',
    whatsappRatePerConversation: 0.4,
    aiRatePer1kTokens: 0.00015,
    bullMqConcurrency: 5,
    dunningGracePeriodDays: 3,
    featureFlags: {
      enableAiVoiceAgents: true,
      enableMultiLocationChains: true,
      enableAutomatedDunningSuspension: true,
      enableRealtimeWebhookInspection: true,
    },
    secretsMetadata: {
      metaAppSecret: { lastRotated: '2026-08-01', keyFingerprint: 'sha256_meta_98a7' },
      whatsappAccessToken: { lastRotated: '2026-08-01', keyFingerprint: 'sha256_waba_44b2' },
      openaiApiKey: { lastRotated: '2026-08-01', keyFingerprint: 'sha256_oai_11c3' },
      databaseUrl: { lastRotated: '2026-08-01', keyFingerprint: 'sha256_pg_88d4' },
      jwtSecret: { lastRotated: '2026-08-01', keyFingerprint: 'sha256_jwt_77e5' },
    },
  };

  async getPlatformSettings() {
    return this.platformSettingsState;
  }

  async updatePlatformSettings(
    updates: any,
    auditContext: { adminId: string; email: string; ip?: string; userAgent?: string; requestId?: string }
  ) {
    const previous = { ...this.platformSettingsState };
    this.platformSettingsState = {
      ...this.platformSettingsState,
      ...updates,
      featureFlags: {
        ...this.platformSettingsState.featureFlags,
        ...(updates.featureFlags || {}),
      },
    };

    await logAuditEvent({
      actorId: auditContext.adminId,
      actorEmail: auditContext.email,
      actorType: 'ADMIN',
      action: 'SETTINGS_UPDATE',
      resourceType: 'PLATFORM_SETTINGS',
      diffBefore: previous,
      diffAfter: this.platformSettingsState,
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return this.platformSettingsState;
  }

  async rotatePlatformSecret(
    secretKey: string,
    auditContext: { adminId: string; email: string; ip?: string; userAgent?: string; requestId?: string }
  ) {
    const newFingerprint = `sha256_${secretKey.slice(0, 4)}_${Date.now().toString(16).slice(-4)}`;
    if (this.platformSettingsState.secretsMetadata && (this.platformSettingsState.secretsMetadata as any)[secretKey]) {
      (this.platformSettingsState.secretsMetadata as any)[secretKey] = {
        lastRotated: new Date().toISOString().split('T')[0],
        keyFingerprint: newFingerprint,
      };
    }

    await logAuditEvent({
      actorId: auditContext.adminId,
      actorEmail: auditContext.email,
      actorType: 'ADMIN',
      action: 'SECRET_ROTATED',
      resourceType: 'PLATFORM_SECRET',
      resourceId: secretKey,
      metadata: { secretKey, newFingerprint },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return { success: true, newFingerprint };
  }

  async getSupportDiagnostics(clinicQuery?: string) {
    const startDb = Date.now();
    let dbStatus = 'HEALTHY';
    let dbLatencyMs = 0;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - startDb;
    } catch (err) {
      dbStatus = 'DEGRADED';
    }

    let aiStatus = 'HEALTHY';
    let aiLatencyMs = 0;
    const startAi = Date.now();
    try {
      const res = await fetch(`${env.AI_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      aiLatencyMs = Date.now() - startAi;
      if (!res.ok) aiStatus = 'UNHEALTHY';
    } catch (err) {
      aiStatus = 'DISCONNECTED';
    }

    let waStatus = 'HEALTHY';
    let waLatencyMs = 0;
    const startWa = Date.now();
    try {
      const res = await fetch(`${env.WHATSAPP_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      waLatencyMs = Date.now() - startWa;
      if (!res.ok) waStatus = 'UNHEALTHY';
    } catch (err) {
      waStatus = 'DISCONNECTED';
    }

    const runtime = await this.fetchAiRuntime();
    if (!runtime) aiStatus = 'DISCONNECTED';

    let targetClinicData: any = null;
    if (clinicQuery) {
      const clinic = await prisma.clinic.findFirst({
        where: {
          OR: [
            { name: { contains: clinicQuery, mode: 'insensitive' } },
            { slug: { contains: clinicQuery, mode: 'insensitive' } },
            ...(clinicQuery.length === 36 ? [{ id: clinicQuery }] : []),
          ],
        },
        include: {
          whatsappAccounts: { take: 1 },
          aiConfig: true,
          _count: { select: { leads: true, appointments: true, conversations: true } },
        },
      });

      if (clinic) {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const [tokenUse, failedJobs] = await Promise.all([
          prisma.aiUsage.aggregate({
            where: { clinicId: clinic.id, createdAt: { gte: monthStart } },
            _sum: { totalTokens: true },
          }),
          prisma.job.count({ where: { clinicId: clinic.id, status: 'FAILED' } }),
        ]);
        const account = clinic.whatsappAccounts[0];
        targetClinicData = {
          clinicId: clinic.id,
          clinicName: clinic.name,
          slug: clinic.slug,
          wabaHealth: account?.isActive ? 'HEALTHY' : 'DISCONNECTED',
          wabaLatency: `${waLatencyMs}ms`,
          aiQuotaState: clinic.aiConfig?.isAiEnabled ? 'ENABLED' : 'PAUSED',
          aiTokensUsedThisMonth: tokenUse._sum.totalTokens || 0,
          aiModel: runtime?.model || '',
          webhookStatus: account?.webhookStatus || (account?.isActive ? 'ACTIVE' : 'INACTIVE'),
          lastPing: new Date().toISOString(),
          unresolvedErrors: failedJobs,
          stats: clinic._count,
        };
      }
    }

    return {
      system: {
        database: { status: dbStatus, latency: `${dbLatencyMs}ms` },
        aiService: {
          status: runtime ? aiStatus : 'DISCONNECTED',
          latency: `${aiLatencyMs}ms`,
          provider: runtime?.provider || '',
          model: runtime?.model || '',
          fallbackModel: runtime?.fallbackModel || '',
          fallbackModel2: runtime?.fallbackModel2 || '',
          models: runtime?.models || [],
          modelRates: runtime?.modelRates || [],
          llmConfigured: runtime?.llmConfigured || false,
          inputUsdPerMillion: runtime?.inputUsdPerMillion ?? 0,
          outputUsdPerMillion: runtime?.outputUsdPerMillion ?? 0,
          url: env.AI_SERVICE_URL,
        },
        whatsappService: { status: waStatus, latency: `${waLatencyMs}ms`, url: env.WHATSAPP_SERVICE_URL },
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
      clinicResult: targetClinicData,
    };
  }

  async generateAiAdmin(body: {
    prompt?: string;
    message?: string;
    systemInstruction?: string;
    temperature?: number;
    entity_id?: string;
    entity_type?: string;
    participant_id?: string;
    channel?: string;
  }) {
    const message = (body.message || body.prompt || '').trim();
    if (!message) {
      throw new AppError('A message is required.', 400, 'VALIDATION_ERROR');
    }
    return aiClient.generate({
      entity_id: body.entity_id || 'admin-platform',
      entity_type: body.entity_type || 'CLINIC',
      participant_id: body.participant_id || 'admin-tester',
      message,
      channel: body.channel || 'WHATSAPP',
      temperature: body.temperature ?? 0.3,
      metadata: body.systemInstruction
        ? { system_instruction: body.systemInstruction, source: 'admin_control_plane' }
        : { source: 'admin_control_plane' },
    });
  }
}

export const adminService = new AdminService();
