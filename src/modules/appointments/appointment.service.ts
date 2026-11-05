/* CGS appointments module — business logic.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { appointmentRepository, AppointmentRepository } from './appointment.repository.js';
import { AppointmentListQuery, CreateAppointmentDTO, UpdateAppointmentDTO } from './appointment.types.js';
import { patientRepository } from '../patients/patient.repository.js';
import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import { filterSlotsForBookings } from '../../utils/appointmentSlot.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { phoneMatchVariants } from '../../utils/phoneMatch.js';
import {
  clinicCalendarUtcDate,
  clinicDateString,
  clinicDayBoundsUtc,
  clinicTimeString,
  clinicWeekday,
  dropPastSlots,
  resolveClinicTimezone,
} from '../../utils/timezone.js';

export class AppointmentService {
  constructor(private readonly repo: AppointmentRepository = appointmentRepository) {}

  private async resolveTimezone(clinicId: string): Promise<string> {
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    return resolveClinicTimezone(clinic?.timezone);
  }

  private mapAppointmentToDTO(a: any, timeZone: string) {
    const startsAt = a.startsAt ? new Date(a.startsAt) : new Date();
    const isOverdue = startsAt.getTime() < Date.now() && a.status !== 'COMPLETED' && a.status !== 'CANCELLED';
    return {
      id: a.id,
      patientId: a.patientId,
      patientName: a.patient ? a.patient.name : 'Unknown Patient',
      patientPhone: a.patient ? a.patient.phone : '',
      doctorId: a.doctorId || '',
      doctorName: a.doctor?.user
        ? `${a.doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${a.doctor.user.firstName} ${a.doctor.user.lastName || ''}`.trim()
        : 'Unassigned',
      service: a.service || 'General Consultation',
      date: clinicDateString(startsAt, timeZone),
      time: clinicTimeString(startsAt, timeZone),
      durationMinutes: a.durationMinutes || 30,
      status: isOverdue && a.status !== 'NO_SHOW' && a.status !== 'RESCHEDULED'
        ? 'Not Completed'
        : a.status
        ? a.status.charAt(0) + a.status.slice(1).toLowerCase().replace(/_/g, ' ')
        : 'Scheduled',
      isOverdue,
      notes: a.notes || '',
      createdBy: a.createdBy ? `${a.createdBy.firstName} ${a.createdBy.lastName || ''}`.trim() : 'System',
      createdDate: a.createdAt ? clinicDateString(new Date(a.createdAt), timeZone) : clinicDateString(new Date(), timeZone),
    };
  }

  private async assertDoctorBookable(params: {
    clinicId: string;
    doctorId?: string | null;
    startTime: Date;
    endTime: Date;
    timeZone: string;
    excludeAppointmentId?: string;
  }) {
    const { clinicId, startTime, endTime, timeZone, excludeAppointmentId } = params;
    let resolvedDoctorId = params.doctorId || undefined;
    let doctorRecord: any = null;

    if (resolvedDoctorId) {
      doctorRecord = await prisma.doctor.findFirst({
        where: {
          OR: [{ id: resolvedDoctorId }, { userId: resolvedDoctorId }],
          clinicId,
        },
      });
      if (doctorRecord) {
        resolvedDoctorId = doctorRecord.id;
      }
    }

    if (!resolvedDoctorId) {
      return { resolvedDoctorId, doctorRecord };
    }

    const dateStr = clinicDateString(startTime, timeZone);
    const parsedDate = clinicCalendarUtcDate(dateStr);
    const leaves = await prisma.doctorAvailability.findMany({
      where: {
        clinicId,
        doctorId: resolvedDoctorId,
        date: parsedDate,
        isAvailable: false,
      },
    });

    if (leaves.length > 0) {
      throw new AppError(
        `Doctor is on scheduled leave (${leaves[0].reason || 'Leave'}) on this date.`,
        400,
        'DOCTOR_ON_LEAVE'
      );
    }

    if (doctorRecord?.availabilityDays && doctorRecord.availabilityDays.length > 0) {
      const dayOfWeek = clinicWeekday(startTime, timeZone);
      if (!doctorRecord.availabilityDays.includes(dayOfWeek)) {
        throw new AppError(
          `Doctor is not scheduled to consult on ${dayOfWeek}s.`,
          400,
          'DOCTOR_OFF_DUTY'
        );
      }
    }

    return { resolvedDoctorId, doctorRecord };
  }

  async listAppointments(query: AppointmentListQuery) {
    const [appointments, timeZone] = await Promise.all([
      this.repo.findMany(query),
      this.resolveTimezone(query.clinicId),
    ]);
    return appointments.map((a) => this.mapAppointmentToDTO(a, timeZone));
  }

  async getAppointmentById(id: string, clinicId: string) {
    const appointment = await this.repo.findById(id, clinicId);
    if (!appointment) {
      throw new AppError('Appointment not found.', 404, 'NOT_FOUND');
    }
    const timeZone = await this.resolveTimezone(clinicId);
    return this.mapAppointmentToDTO(appointment, timeZone);
  }

  async createAppointment(
    clinicId: string,
    dto: CreateAppointmentDTO,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const startTime = new Date(dto.startsAt);
    const duration = dto.durationMinutes || 30;
    const endTime = dto.endsAt ? new Date(dto.endsAt) : new Date(startTime.getTime() + duration * 60000);

    // Verify patient belongs to clinic, or resolve from lead
    let patient: any = await patientRepository.findById(dto.patientId, clinicId);
    if (!patient) {
      // Check if patientId is actually a leadId
      const lead = await prisma.lead.findFirst({
        where: { id: dto.patientId, clinicId },
      });

      if (lead) {
        let existingPatient = await prisma.patient.findFirst({
          where: { clinicId, phone: lead.phone },
        });

        if (!existingPatient) {
          existingPatient = await prisma.patient.create({
            data: {
              clinicId,
              name: lead.name,
              phone: lead.phone,
              email: lead.email,
              medicalHistoryNotes: lead.notes,
              leadId: lead.id,
              status: 'ACTIVE',
            },
          });

          await prisma.patientActivity.create({
            data: {
              patientId: existingPatient.id,
              type: 'profile_update',
              title: 'Patient Profile Initialized',
              description: `Registered for appointment from prospective lead #${lead.id.slice(0, 8)}`,
              actor: auditContext.actorName || 'System',
            },
          });
        }

        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            convertedPatientId: existingPatient.id,
            status: 'BOOKED',
          },
        });

        patient = existingPatient;
        dto.patientId = existingPatient.id;
      } else {
        throw new AppError('Patient does not belong to this clinic.', 404, 'PATIENT_NOT_FOUND');
      }
    }

    const timeZone = await this.resolveTimezone(clinicId);
    const { resolvedDoctorId } = await this.assertDoctorBookable({
      clinicId,
      doctorId: dto.doctorId,
      startTime,
      endTime,
      timeZone,
    });


    try {
      const appointment = await this.repo.createInTx({
        clinicId,
        patientId: dto.patientId,
        doctorId: resolvedDoctorId,
        service: dto.service || 'General Consultation',
        serviceIds: dto.serviceIds,
        startsAt: startTime,
        endsAt: endTime,
        durationMinutes: duration,
        notes: dto.notes,
        createdByUserId: auditContext.userId,
        actorName: auditContext.actorName || 'Staff',
      });

      await logAuditEvent({
        clinicId,
        userId: auditContext.userId,
        actorId: auditContext.userId || 'SYSTEM',
        actorEmail: auditContext.email || 'system',
        action: 'APPOINTMENT_CREATED',
        resourceType: 'APPOINTMENT',
        resourceId: appointment.id,
        metadata: { patientId: patient?.id || dto.patientId, doctorId: resolvedDoctorId, startsAt: startTime.toISOString() },
        ipAddress: auditContext.ip,
        userAgent: auditContext.userAgent,
        requestId: auditContext.requestId,
      });

      const fullAppointment = await this.repo.findById(appointment.id, clinicId);
      return fullAppointment ? this.mapAppointmentToDTO(fullAppointment, timeZone) : appointment;
    } catch (err: any) {
      if (err.message === 'SLOT_ALREADY_BOOKED') {
        throw new AppError(
          'Selected doctor already has an appointment during this time window.',
          409,
          'SLOT_ALREADY_BOOKED'
        );
      }
      if (err.message === 'DOCTOR_NOT_IN_CLINIC') {
        throw new AppError('Doctor does not belong to this clinic.', 404, 'DOCTOR_NOT_FOUND');
      }
      throw err;
    }
  }

  async updateAppointment(
    id: string,
    clinicId: string,
    dto: UpdateAppointmentDTO,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const existing = await this.repo.findById(id, clinicId);
    if (!existing) {
      throw new AppError('Appointment not found.', 404, 'NOT_FOUND');
    }

    let resolvedDoctorId = dto.doctorId;
    if (resolvedDoctorId) {
      const doctorRecord = await prisma.doctor.findFirst({
        where: {
          OR: [{ id: resolvedDoctorId }, { userId: resolvedDoctorId }],
          clinicId,
        },
      });
      if (doctorRecord) {
        resolvedDoctorId = doctorRecord.id;
      }
    }

    const updateData: any = {};
    if (dto.status) updateData.status = dto.status;
    if (dto.notes !== undefined) updateData.notes = dto.notes;
    if (resolvedDoctorId !== undefined) updateData.doctorId = resolvedDoctorId;
    if (dto.startsAt) {
      const newStart = new Date(dto.startsAt);
      const duration = dto.durationMinutes || existing.durationMinutes;
      updateData.startsAt = newStart;
      updateData.endsAt = new Date(newStart.getTime() + duration * 60000);
      updateData.durationMinutes = duration;
    }

    if (dto.startsAt || dto.doctorId) {
      const timeZone = await this.resolveTimezone(clinicId);
      const startTime = updateData.startsAt ? new Date(updateData.startsAt) : new Date(existing.startsAt);
      const duration = updateData.durationMinutes || existing.durationMinutes;
      const endTime = updateData.endsAt
        ? new Date(updateData.endsAt)
        : new Date(startTime.getTime() + duration * 60000);
      const bookable = await this.assertDoctorBookable({
        clinicId,
        doctorId: resolvedDoctorId || existing.doctorId,
        startTime,
        endTime,
        timeZone,
        excludeAppointmentId: id,
      });
      if (bookable.resolvedDoctorId) {
        updateData.doctorId = bookable.resolvedDoctorId;
      }
    }

    if (updateData.status === 'COMPLETED') {
      const linkedPatientId = await this.autoConvertLeadOnAppointmentDone(
        clinicId,
        existing.patientId,
        existing.service || 'Consultation',
        auditContext.actorName || 'System Automated Flow',
        existing.id
      );
      if (linkedPatientId && linkedPatientId !== existing.patientId) {
        updateData.patientId = linkedPatientId;
      }
    }

    const updated = await this.repo.update(id, updateData);

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'APPOINTMENT_UPDATED',
      resourceType: 'APPOINTMENT',
      resourceId: updated.id,
      metadata: { previousStatus: existing.status, newStatus: updated.status },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    const timeZone = await this.resolveTimezone(clinicId);
    const fullAppointment = await this.repo.findById(id, clinicId);
    return fullAppointment ? this.mapAppointmentToDTO(fullAppointment, timeZone) : updated;
  }

  private async autoConvertLeadOnAppointmentDone(
    clinicId: string,
    patientId: string,
    appointmentService: string,
    actorName: string,
    appointmentId?: string
  ) {
    const owned = await prisma.patient.findFirst({
      where: { id: patientId, clinicId },
    });

    let patient = owned;
    if (!patient) {
      const lead = await prisma.lead.findFirst({
        where: { id: patientId, clinicId },
      });
      if (!lead?.phone) {
        throw new AppError(
          'This appointment has no patient in this clinic. Choose the patient before completing it.',
          409,
          'PATIENT_LINK_REQUIRED'
        );
      }
      const matches = await prisma.patient.findMany({
        where: { clinicId, phone: { in: phoneMatchVariants(lead.phone) } },
        take: 3,
      });
      if (matches.length > 1) {
        throw new AppError(
          'More than one patient uses this phone number. Choose the patient before completing the visit.',
          409,
          'PATIENT_AMBIGUOUS'
        );
      }
      patient = matches[0];
      if (!patient) {
        const variants = phoneMatchVariants(lead.phone);
        patient = await prisma.patient.create({
          data: {
            clinicId,
            name: lead.name,
            phone: variants.find((p) => p.startsWith('91') && p.length === 12) || variants[0] || lead.phone,
            email: lead.email,
            medicalHistoryNotes: lead.notes,
            leadId: lead.id,
            status: 'ACTIVE',
          },
        });
      }
      await prisma.appointment.updateMany({
        where: {
          clinicId,
          OR: [{ id: appointmentId || '' }, { patientId: lead.id }],
        },
        data: { patientId: patient.id },
      });
    }

    const matchingLeads = await prisma.lead.findMany({
      where: {
        clinicId,
        status: { not: 'CONVERTED' },
        OR: [
          { convertedPatientId: patient.id },
          { phone: { in: phoneMatchVariants(patient.phone) } },
          ...(patient.leadId ? [{ id: patient.leadId }] : []),
        ],
      },
      take: 3,
    });
    const matchingLead =
      matchingLeads.find((lead) => lead.id === patient.leadId) ||
      (matchingLeads.length === 1 ? matchingLeads[0] : undefined);

    if (matchingLead) {
      await prisma.$transaction([
        prisma.lead.update({
          where: { id: matchingLead.id },
          data: {
            status: 'CONVERTED',
            convertedPatientId: patient.id,
          },
        }),
        ...(patient.leadId
          ? []
          : [
              prisma.patient.update({
                where: { id: patient.id },
                data: { leadId: matchingLead.id },
              }),
            ]),
        prisma.leadActivity.create({
          data: {
            leadId: matchingLead.id,
            type: 'status_change',
            title: 'Auto-Converted to Patient',
            description: `Lead automatically converted into permanent patient upon appointment completion (${appointmentService}).`,
            actor: actorName,
          },
        }),
        prisma.patientActivity.create({
          data: {
            patientId: patient.id,
            type: 'appointment',
            title: 'Appointment Completed',
            description: `Completed treatment / consultation for ${appointmentService}.`,
            actor: actorName,
          },
        }),
        prisma.conversation.updateMany({
          where: { clinicId, leadId: matchingLead.id },
          data: { patientId: patient.id },
        }),
      ]);
    }

    return patient.id;
  }

  async getDoctorAvailability(clinicId: string, doctorId?: string, dateStr?: string) {
    const timeZone = await this.resolveTimezone(clinicId);
    const targetDate = dateStr || clinicDateString(new Date(), timeZone);
    const cleanDateStr = targetDate.split('T')[0];
    const parsedDate = clinicCalendarUtcDate(cleanDateStr);
    const { start: startOfDay, end: endOfDay } = clinicDayBoundsUtc(cleanDateStr, timeZone);

    let resolvedDoctorId = doctorId;
    let doctor: any = null;

    if (resolvedDoctorId && resolvedDoctorId !== 'All') {
      doctor = await prisma.doctor.findFirst({
        where: {
          clinicId,
          OR: [
            { id: resolvedDoctorId },
            { userId: resolvedDoctorId },
            { user: { firstName: { contains: resolvedDoctorId, mode: 'insensitive' } } },
            { user: { lastName: { contains: resolvedDoctorId, mode: 'insensitive' } } },
          ],
        },
        include: { user: true },
      });
      if (doctor) {
        resolvedDoctorId = doctor.id;
      }
    }

    // 1. Check doctor leaves on this date
    if (resolvedDoctorId) {
      const leaves = await prisma.doctorAvailability.findMany({
        where: {
          clinicId,
          doctorId: resolvedDoctorId,
          date: parsedDate,
          isAvailable: false,
        },
      });

      if (leaves.length > 0) {
        return {
          date: cleanDateStr,
          doctorId: resolvedDoctorId,
          doctorName: doctor?.name || (doctor?.user ? `${doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${doctor.user.firstName} ${doctor.user.lastName || ''}`.trim() : 'Doctor'),
          isDoctorOnLeave: true,
          isDoctorOffDuty: false,
          leaveReason: leaves[0].reason || 'Doctor is on scheduled leave',
          availableSlots: [],
          bookedSlots: [],
          bookedSlotsCount: 0,
        };
      }

      // 2. Check if doctor operates on this day of week
      const dayOfWeek = clinicWeekday(parsedDate, timeZone);

      if (doctor && doctor.availabilityDays && doctor.availabilityDays.length > 0) {
        if (!doctor.availabilityDays.includes(dayOfWeek)) {
          return {
            date: cleanDateStr,
            doctorId: resolvedDoctorId,
            doctorName: doctor?.name || (doctor?.user ? `${doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${doctor.user.firstName} ${doctor.user.lastName || ''}`.trim() : 'Doctor'),
            isDoctorOnLeave: false,
            isDoctorOffDuty: true,
            offDutyReason: `Doctor does not consult on ${dayOfWeek}s`,
            availableSlots: [],
            bookedSlots: [],
            bookedSlotsCount: 0,
          };
        }
      }
    }

    // 3. Generate slots strictly based on doctor's availabilityHours
    const hoursStr = doctor?.availabilityHours || (resolvedDoctorId ? '09:00 AM - 01:00 PM, 04:00 PM - 07:00 PM' : '09:00 AM - 07:00 PM');
    const allSlots = this.generateSlotsFromSchedule(hoursStr);

    // 4. Query booked appointments for this doctor on this date
    const appointmentWhere: any = {
      clinicId,
      startsAt: { gte: startOfDay, lte: endOfDay },
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
    };
    if (resolvedDoctorId) {
      appointmentWhere.doctorId = resolvedDoctorId;
    }


    const bookedAppointments = await prisma.appointment.findMany({
      where: appointmentWhere,
      select: { startsAt: true, endsAt: true },
    });

    const capacity = Math.min(20, Math.max(1, doctor?.maxBookingsPerSlot || 1));
    const bookedCountBySlot = new Map<string, number>();
    for (const row of bookedAppointments) {
      const label = clinicTimeString(new Date(row.startsAt), timeZone);
      bookedCountBySlot.set(label, (bookedCountBySlot.get(label) || 0) + 1);
    }
    const bookedSlots = [...bookedCountBySlot.entries()].filter(([, count]) => count >= capacity).map(([label]) => label);
    const availableSlots = dropPastSlots(
      filterSlotsForBookings({
        slots: allSlots.filter((slot) => (bookedCountBySlot.get(slot) || 0) < capacity),
        slotMinutes: 30,
        capacity,
        booked: bookedAppointments,
        timeZone,
      }),
      cleanDateStr,
      timeZone
    );

    return {
      date: targetDate,
      doctorId: resolvedDoctorId || null,
      doctorName: doctor?.user ? `${doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${doctor.user.firstName} ${doctor.user.lastName || ''}`.trim() : 'Doctor',
      isDoctorOnLeave: false,
      isDoctorOffDuty: false,
      availableSlots,
      bookedSlots,
      bookedSlotsCount: bookedAppointments.length,
    };
  }

  private generateSlotsFromSchedule(hoursStr?: string | null): string[] {
    if (!hoursStr?.trim()) {
      return [];
    }

    const ranges = hoursStr.split(',').map((s) => s.trim()).filter(Boolean);
    if (ranges.length === 0) {
      return [];
    }

    const parseTimeToMinutes = (timeStr: string): number | null => {
      const match = timeStr.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
      if (!match) return null;
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2] || '0', 10);
      const period = match[3].toUpperCase();
      if (period === 'PM' && h < 12) h += 12;
      if (period === 'AM' && h === 12) h = 0;
      return h * 60 + m;
    };

    const formatMinutesToTime = (minutes: number): string => {
      let h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const period = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12;
      if (h === 0) h = 12;
      const hStr = h < 10 ? `0${h}` : `${h}`;
      const mStr = m < 10 ? `0${m}` : `${m}`;
      return `${hStr}:${mStr} ${period}`;
    };

    const generatedSlots: string[] = [];

    for (const range of ranges) {
      const parts = range.split(/\s*-\s*/).map((s) => s.trim());
      if (parts.length < 2) continue;
      const startMin = parseTimeToMinutes(parts[0]);
      const endMin = parseTimeToMinutes(parts[1]);

      if (startMin !== null && endMin !== null && endMin > startMin) {
        for (let curr = startMin; curr < endMin; curr += 30) {
          generatedSlots.push(formatMinutesToTime(curr));
        }
      }
    }

    return Array.from(new Set(generatedSlots));
  }
}

export const appointmentService = new AppointmentService();

