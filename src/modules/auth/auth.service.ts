/* CGS auth module — business logic.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authRepository, AuthRepository } from './auth.repository.js';
import { AuthResponseDTO, AuthUserProfileDTO, LoginDTO } from './auth.types.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class AuthService {
  constructor(private readonly repo: AuthRepository = authRepository) {}

  async login(
    dto: LoginDTO,
    auditContext: {
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ): Promise<AuthResponseDTO> {
    const candidates = await this.repo.findAllByEmail(dto.email);

    if (!candidates.length) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    let user =
      candidates.find((u) => u.passwordHash) ||
      null;

    // Prefer the account whose password matches (handles same email across clinics)
    let matched: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      if (!candidate.passwordHash) continue;
      const ok = await bcrypt.compare(dto.password, candidate.passwordHash);
      if (ok) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      const fallback = user || candidates[0];
      if (fallback.status === 'DISABLED') {
        throw new AppError('Account is disabled. Please contact clinic administrator.', 403, 'ACCOUNT_DISABLED');
      }
      await logAuditEvent({
        clinicId: fallback.clinicId,
        userId: fallback.id,
        actorId: fallback.id,
        actorEmail: fallback.email,
        action: 'LOGIN_FAILURE',
        resourceType: 'USER',
        resourceId: fallback.id,
        ipAddress: auditContext.ip,
        userAgent: auditContext.userAgent,
        requestId: auditContext.requestId,
      });
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    user = matched;

    if (user.status === 'DISABLED') {
      throw new AppError('Account is disabled. Please contact clinic administrator.', 403, 'ACCOUNT_DISABLED');
    }

    if (user.clinic.status === 'SUSPENDED' || user.clinic.status === 'DEACTIVATED') {
      throw new AppError(`Clinic access is currently ${user.clinic.status.toLowerCase()}.`, 403, 'CLINIC_SUSPENDED');
    }

    await this.repo.updateLastLogin(user.id);

    const tokenPayload = {
      userId: user.id,
      clinicId: user.clinicId,
      role: user.role,
      email: user.email,
      name: `${user.firstName} ${user.lastName || ''}`.trim(),
    };

    const accessToken = jwt.sign(tokenPayload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    await logAuditEvent({
      clinicId: user.clinicId,
      userId: user.id,
      actorId: user.id,
      actorEmail: user.email,
      action: 'LOGIN_SUCCESS',
      resourceType: 'USER',
      resourceId: user.id,
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    const scope = await resolveDoctorScope({
      clinicId: user.clinicId,
      userId: user.id,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        name: `${user.firstName} ${user.lastName || ''}`.trim(),
        email: user.email,
        role: user.role.toLowerCase(),
        title: user.title || (user.role === 'DOCTOR' ? 'Lead Clinician' : 'Front Desk Coordinator'),
        clinicId: user.clinicId,
        clinicName: user.clinic.name,
        phone: user.phone || undefined,
        doctorId: scope.doctorId || undefined,
        isPrimaryDoctor: scope.isPrimary,
        seesAllClinicData: scope.seesAllClinicData,
      },
    };
  }

  async getCurrentUser(userId: string): Promise<AuthUserProfileDTO> {
    const user = await this.repo.findById(userId);
    if (!user) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    const permissions =
      user.role === 'DOCTOR'
        ? [
            'dashboard.view',
            'leads.view',
            'leads.create',
            'leads.edit',
            'leads.delete',
            'patients.view',
            'patients.create',
            'patients.edit',
            'conversations.view',
            'conversations.manage',
            'appointments.view',
            'appointments.create',
            'appointments.edit',
            'appointments.cancel',
            'notifications.view',
            'settings.view',
            'settings.edit',
            'billing.view',
            'billing.manage',
            'billing.crm_view',
            'billing.crm_manage',
            'billing.meta_ads_view',
          ]
        : [
            'dashboard.view',
            'leads.view',
            'leads.create',
            'leads.edit',
            'patients.view',
            'patients.create',
            'patients.edit',
            'conversations.view',
            'conversations.manage',
            'appointments.view',
            'appointments.create',
            'appointments.edit',
            'notifications.view',
            'settings.view',
            'billing.view',
            'billing.manage',
          ];

    const scope = await resolveDoctorScope({
      clinicId: user.clinicId,
      userId: user.id,
      role: user.role,
    });

    return {
      id: user.id,
      name: `${user.firstName} ${user.lastName || ''}`.trim(),
      email: user.email,
      role: user.role.toLowerCase(),
      title: user.title || (user.role === 'DOCTOR' ? 'Lead Clinician' : 'Front Desk Coordinator'),
      clinicId: user.clinicId,
      clinicName: user.clinic.name,
      phone: user.phone || undefined,
      doctorId: scope.doctorId || undefined,
      isPrimaryDoctor: scope.isPrimary,
      seesAllClinicData: scope.seesAllClinicData,
      permissions,
    };
  }
}

export const authService = new AuthService();
