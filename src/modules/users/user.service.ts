/* CGS users module — business logic.
 * Clinic API layer for users; talks Prisma or callers, not the AI database. */
import bcrypt from 'bcryptjs';
import { userRepository, UserRepository } from './user.repository.js';
import { CreateUserDTO, UserResponseDTO } from './user.types.js';
import { UserStatus } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { aiClient } from '../ai/ai.client.js';
import { assertClinicSeatAvailable } from '../../utils/subscriptionSeats.js';

export class UserService {
  constructor(private readonly repo: UserRepository = userRepository) {}

  async listUsers(clinicId: string): Promise<UserResponseDTO[]> {
    const users = await this.repo.findManyByClinic(clinicId);

    return users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName || ''}`.trim(),
      email: u.email,
      phone: u.phone,
      role: u.role.toLowerCase(),
      title: u.title,
      status: u.status,
      lastLoginAt: u.lastLoginAt,
      doctorProfile: u.doctor
        ? {
            specialization: u.doctor.specialization,
            registrationNo: u.doctor.registrationNo,
            consultationFee: u.doctor.consultationFee,
            availabilityDays: u.doctor.availabilityDays,
            availabilityHours: u.doctor.availabilityHours,
          }
        : undefined,
    }));
  }

  async createUser(
    clinicId: string,
    dto: CreateUserDTO,
    auditContext: {
      userId: string;
      email?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    await assertClinicSeatAvailable(clinicId);

    const existing = await this.repo.findByEmailInClinic(clinicId, dto.email);
    if (existing) {
      throw new AppError('User with this email already exists in your clinic.', 409, 'CONFLICT');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.repo.createUserWithDoctorInTx(clinicId, dto, passwordHash);

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId,
      actorEmail: auditContext.email || 'system',
      action: 'USER_CREATED',
      resourceType: 'USER',
      resourceId: user.id,
      metadata: { role: dto.role, email: dto.email },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return {
      id: user.id,
      name: `${user.firstName} ${user.lastName || ''}`.trim(),
      email: user.email,
      role: user.role.toLowerCase(),
    };
  }

  async updateUserStatus(
    id: string,
    clinicId: string,
    status: UserStatus,
    auditContext: {
      userId: string;
      email?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const user = await this.repo.findByIdInClinic(id, clinicId);
    if (!user) {
      throw new AppError('User not found in your clinic.', 404, 'NOT_FOUND');
    }

    const updated = await this.repo.updateStatus(id, status);

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId,
      actorEmail: auditContext.email || 'system',
      action: 'USER_STATUS_CHANGED',
      resourceType: 'USER',
      resourceId: user.id,
      metadata: { previousStatus: user.status, newStatus: status },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return { id: updated.id, status: updated.status };
  }

  async updateUserProfile(
    id: string,
    clinicId: string,
    dto: any,
    auditContext: {
      userId: string;
      email?: string;
      role?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const user = await this.repo.findByIdInClinic(id, clinicId);
    if (!user) {
      throw new AppError('User not found in your clinic.', 404, 'NOT_FOUND');
    }

    const canEditOthers = auditContext.role === 'DOCTOR' || auditContext.role === 'CLINIC_ADMIN';
    if (!canEditOthers && auditContext.userId !== user.id) {
      throw new AppError('Forbidden: you can only update your own profile.', 403, 'FORBIDDEN');
    }

    const updated = await this.repo.updateProfile(id, clinicId, dto);

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId,
      actorEmail: auditContext.email || 'system',
      action: 'USER_UPDATED',
      resourceType: 'USER',
      resourceId: id,
      diffBefore: user,
      diffAfter: updated,
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    // Roster / hours changes must not leave AI on stale clinic card
    const hoursTouched =
      dto.availabilityDays !== undefined ||
      dto.availabilityHours !== undefined ||
      dto.specialization !== undefined ||
      dto.consultationFee !== undefined;
    if (hoursTouched) {
      void aiClient.invalidateClinicCache(clinicId);
    }

    return updated ? {
      id: updated.id,
      name: `${updated.firstName} ${updated.lastName || ''}`.trim(),
      email: updated.email,
      phone: updated.phone,
      role: updated.role.toLowerCase(),
      title: updated.title,
      status: updated.status,
      doctorProfile: updated.doctor
        ? {
            specialization: updated.doctor.specialization,
            registrationNo: updated.doctor.registrationNo,
            consultationFee: updated.doctor.consultationFee,
            availabilityDays: updated.doctor.availabilityDays,
            availabilityHours: updated.doctor.availabilityHours,
          }
        : undefined,
    } : null;
  }

  async listDoctorLeaves(clinicId: string, doctorId?: string) {
    const leaves = await this.repo.findLeavesByClinic(clinicId, doctorId);
    return leaves.map((l) => ({
      id: l.id,
      doctorId: l.doctorId,
      doctorName: l.doctor?.user ? `${l.doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${l.doctor.user.firstName} ${l.doctor.user.lastName || ''}`.trim() : 'Doctor',
      date: l.date instanceof Date ? l.date.toISOString().split('T')[0] : l.date,
      startDate: l.date instanceof Date ? l.date.toISOString().split('T')[0] : l.date,
      endDate: l.date instanceof Date ? l.date.toISOString().split('T')[0] : l.date,
      startTime: l.startTime,
      endTime: l.endTime,
      isAvailable: l.isAvailable,
      reason: l.reason,
      createdAt: l.createdAt,
    }));
  }

  async createDoctorLeave(
    clinicId: string,
    dto: { doctorId?: string; date?: string; startDate?: string; endDate?: string; fromDate?: string; toDate?: string; startTime?: string; endTime?: string; reason?: string },
    auditContext: {
      userId: string;
      email?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    // If doctorId not provided, infer from logged in user's doctor record
    let targetDoctorId = dto.doctorId;
    if (!targetDoctorId) {
      const user = await this.repo.findByIdInClinic(auditContext.userId, clinicId);
      if (user?.doctor) {
        targetDoctorId = user.doctor.id;
      } else {
        const doctors = await this.repo.findDoctorByClinic(clinicId, auditContext.userId);
        if (doctors) {
          targetDoctorId = doctors.id;
        } else {
          throw new AppError('Doctor record not found for this user.', 400, 'BAD_REQUEST');
        }
      }
    }

    const startStr = dto.fromDate || dto.startDate || dto.date || new Date().toISOString().split('T')[0];
    const endStr = dto.toDate || dto.endDate || dto.date || startStr;

    const startDate = new Date(`${startStr.split('T')[0]}T00:00:00.000Z`);
    const endDate = new Date(`${endStr.split('T')[0]}T00:00:00.000Z`);

    const createdLeaves = [];
    const curr = new Date(startDate);

    while (curr <= endDate) {
      const leaveDate = new Date(curr);
      const leave = await this.repo.createLeave(clinicId, targetDoctorId, {
        date: leaveDate,
        startTime: dto.startTime || '00:00',
        endTime: dto.endTime || '23:59',
        reason: dto.reason || 'Leave',
      });
      createdLeaves.push(leave);
      curr.setUTCDate(curr.getUTCDate() + 1);
    }

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId,
      actorEmail: auditContext.email || 'system',
      action: 'DOCTOR_LEAVE_DECLARED',
      resourceType: 'DOCTOR_AVAILABILITY',
      resourceId: createdLeaves[0]?.id || 'multi-day-leave',
      metadata: { doctorId: targetDoctorId, fromDate: startStr, toDate: endStr, reason: dto.reason, totalDays: createdLeaves.length },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    void aiClient.invalidateClinicCache(clinicId);

    const first = createdLeaves[0];
    return {
      id: first.id,
      doctorId: first.doctorId,
      doctorName: first.doctor?.user ? `${first.doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${first.doctor.user.firstName} ${first.doctor.user.lastName || ''}`.trim() : 'Doctor',
      date: startStr === endStr ? startStr : `${startStr} to ${endStr}`,
      startDate: startStr,
      endDate: endStr,
      totalDays: createdLeaves.length,
      startTime: first.startTime,
      endTime: first.endTime,
      isAvailable: first.isAvailable,
      reason: first.reason,
      createdAt: first.createdAt,
    };
  }

  async deleteDoctorLeave(
    clinicId: string,
    leaveId: string,
    auditContext: {
      userId: string;
      email?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    await this.repo.deleteLeave(clinicId, leaveId);

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId,
      actorEmail: auditContext.email || 'system',
      action: 'DOCTOR_LEAVE_CANCELLED',
      resourceType: 'DOCTOR_AVAILABILITY',
      resourceId: leaveId,
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return { success: true };
  }
}

export const userService = new UserService();
