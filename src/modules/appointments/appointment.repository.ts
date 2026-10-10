/* CGS appointments module — Prisma queries.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { AppointmentListQuery } from './appointment.types.js';
import { clinicDayBoundsUtc } from '../../utils/timezone.js';
import { assertDoctorSlotAvailable, isSlotConflictError } from '../../utils/appointmentSlot.js';

export class AppointmentRepository {
  async findMany(query: AppointmentListQuery) {
    const where: any = { clinicId: query.clinicId };
    if (query.doctorId && query.doctorId !== 'All') where.doctorId = query.doctorId;
    if (query.patientId) where.patientId = query.patientId;
    if (query.status && query.status !== 'All') {
      where.status = query.status.toUpperCase().replace(/[\s-]+/g, '_');
    }

    if (query.date) {
      const { start, end } = clinicDayBoundsUtc(query.date);
      where.startsAt = { gte: start, lte: end };
    }

    return prisma.appointment.findMany({
      where,
      include: {
        patient: true,
        doctor: { include: { user: true } },
        createdBy: true,
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  async findById(id: string, clinicId: string) {
    return prisma.appointment.findFirst({
      where: { id, clinicId },
      include: {
        patient: true,
        doctor: { include: { user: true } },
        services: { include: { service: true } },
        createdBy: true,
      },
    });
  }

  async checkDoctorCollision(
    clinicId: string,
    doctorId: string,
    startTime: Date,
    endTime: Date,
    excludeAppointmentId?: string
  ) {
    return prisma.appointment.findFirst({
      where: {
        clinicId,
        doctorId,
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
        OR: [
          { startsAt: { gte: startTime, lt: endTime } },
          { endsAt: { gt: startTime, lte: endTime } },
          { AND: [{ startsAt: { lte: startTime } }, { endsAt: { gte: endTime } }] },
        ],
      },
    });
  }

  async createInTx(params: {
    clinicId: string;
    patientId: string;
    doctorId?: string;
    service: string;
    serviceIds?: string[];
    startsAt: Date;
    endsAt: Date;
    durationMinutes: number;
    notes?: string;
    createdByUserId?: string;
    actorName: string;
  }) {
    return prisma.$transaction(async (tx) => {
      let validDoctorId = params.doctorId;
      if (validDoctorId) {
        const doc = await tx.doctor.findFirst({
          where: {
            OR: [{ id: validDoctorId }, { userId: validDoctorId }],
            clinicId: params.clinicId,
          },
        });
        validDoctorId = doc ? doc.id : undefined;
      }

      if (validDoctorId) {
        await assertDoctorSlotAvailable(tx, {
          clinicId: params.clinicId,
          doctorId: validDoctorId,
          startsAt: params.startsAt,
          endsAt: params.endsAt,
        });
      }

      const created = await tx.appointment.create({
        data: {
          clinicId: params.clinicId,
          patientId: params.patientId,
          doctorId: validDoctorId,
          service: params.service,
          startsAt: params.startsAt,
          endsAt: params.endsAt,
          durationMinutes: params.durationMinutes,
          notes: params.notes,
          createdByUserId: params.createdByUserId,
        },
      }).catch((err: unknown) => {
        if (isSlotConflictError(err)) throw new Error('SLOT_ALREADY_BOOKED');
        throw err;
      });

      if (params.serviceIds && params.serviceIds.length > 0) {
        await tx.appointmentService.createMany({
          data: params.serviceIds.map((serviceId) => ({
            appointmentId: created.id,
            serviceId,
          })),
        });
      }

      await tx.patientActivity.create({
        data: {
          patientId: params.patientId,
          type: 'appointment',
          title: 'Appointment Scheduled',
          description: `${params.service} scheduled for ${params.startsAt.toLocaleString()}`,
          actor: params.actorName,
        },
      });

      return created;
    });
  }

  async update(id: string, data: any) {
    return prisma.appointment.update({
      where: { id },
      data,
    });
  }
}

export const appointmentRepository = new AppointmentRepository();
