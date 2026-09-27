/* CGS users module — Prisma queries.
 * Clinic API layer for users; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { CreateUserDTO } from './user.types.js';
import { UserStatus } from '@prisma/client';

export class UserRepository {
  async findManyByClinic(clinicId: string) {
    return prisma.user.findMany({
      where: { clinicId },
      include: { doctor: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByEmailInClinic(clinicId: string, email: string) {
    return prisma.user.findFirst({
      where: { clinicId, email: email.toLowerCase() },
    });
  }

  async findByIdInClinic(id: string, clinicId: string) {
    return prisma.user.findFirst({
      where: {
        clinicId,
        OR: [
          { id },
          { doctor: { id } },
        ],
      },
      include: { doctor: true },
    });
  }

  async findDoctorByClinic(clinicId: string, doctorIdOrUserId: string) {
    return prisma.doctor.findFirst({
      where: {
        clinicId,
        OR: [
          { id: doctorIdOrUserId },
          { userId: doctorIdOrUserId },
        ],
      },
      include: { user: true },
    });
  }

  async createUserWithDoctorInTx(clinicId: string, data: CreateUserDTO, passwordHash: string) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          clinicId,
          email: data.email.toLowerCase(),
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          title: data.title,
          phone: data.phone,
          role: data.role,
        },
      });

      if (data.role === 'DOCTOR') {
        await tx.doctor.create({
          data: {
            clinicId,
            userId: user.id,
            specialization: data.specialization,
            registrationNo: data.registrationNo,
            consultationFee: data.consultationFee,
          },
        });
      }

      return user;
    });
  }

  async updateStatus(id: string, status: UserStatus) {
    return prisma.user.update({
      where: { id },
      data: { status },
    });
  }

  async updateProfile(id: string, clinicId: string, data: any) {
    const existing = await this.findByIdInClinic(id, clinicId);
    if (!existing) return null;
    const actualUserId = existing.id;

    return prisma.$transaction(async (tx) => {
      const userUpdate: any = {};
      if (data.firstName !== undefined) userUpdate.firstName = data.firstName;
      if (data.lastName !== undefined) userUpdate.lastName = data.lastName;
      if (data.title !== undefined) userUpdate.title = data.title;
      if (data.phone !== undefined) userUpdate.phone = data.phone;

      if (Object.keys(userUpdate).length > 0) {
        await tx.user.update({
          where: { id: actualUserId },
          data: userUpdate,
        });
      }

      const doctorUpdate: any = {};
      if (data.specialization !== undefined) doctorUpdate.specialization = data.specialization;
      if (data.registrationNo !== undefined) doctorUpdate.registrationNo = data.registrationNo;
      if (data.consultationFee !== undefined) doctorUpdate.consultationFee = data.consultationFee;
      if (data.availabilityDays !== undefined) doctorUpdate.availabilityDays = data.availabilityDays;
      if (data.availabilityHours !== undefined) doctorUpdate.availabilityHours = data.availabilityHours;
      if (data.isActive !== undefined) doctorUpdate.isActive = data.isActive;

      if (Object.keys(doctorUpdate).length > 0 && existing.doctor) {
        await tx.doctor.update({
          where: { id: existing.doctor.id },
          data: doctorUpdate,
        });
      }

      return tx.user.findFirst({
        where: { id: actualUserId, clinicId },
        include: { doctor: true },
      });
    });
  }

  async findLeavesByClinic(clinicId: string, doctorId?: string) {
    const where: any = { clinicId, isAvailable: false };
    if (doctorId) {
      const doctor = await this.findDoctorByClinic(clinicId, doctorId);
      if (doctor) {
        where.doctorId = doctor.id;
      } else {
        where.doctorId = doctorId;
      }
    }

    return prisma.doctorAvailability.findMany({
      where,
      include: {
        doctor: {
          include: { user: true },
        },
      },
      orderBy: { date: 'asc' },
    });
  }

  async createLeave(clinicId: string, doctorId: string, data: { date: Date; startTime?: string; endTime?: string; reason?: string }) {
    const doctor = await this.findDoctorByClinic(clinicId, doctorId);
    const actualDoctorId = doctor ? doctor.id : doctorId;

    return prisma.doctorAvailability.create({
      data: {
        clinicId,
        doctorId: actualDoctorId,
        date: data.date,
        startTime: data.startTime || '00:00',
        endTime: data.endTime || '23:59',
        isAvailable: false,
        reason: data.reason || 'Leave',
      },
      include: {
        doctor: {
          include: { user: true },
        },
      },
    });
  }

  async deleteLeave(clinicId: string, leaveId: string) {
    return prisma.doctorAvailability.deleteMany({
      where: {
        id: leaveId,
        clinicId,
      },
    });
  }
}

export const userRepository = new UserRepository();
