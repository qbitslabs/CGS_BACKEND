/* CGS appointments module — business logic.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { appointmentRepository, AppointmentRepository } from './appointment.repository.js';
import { AppointmentListQuery, CreateAppointmentDTO, UpdateAppointmentDTO } from './appointment.types.js';
import { patientRepository } from '../patients/patient.repository.js';
import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import {
  clinicCalendarUtcDate,
  clinicDateString,
  clinicDayBoundsUtc,
  clinicTimeString,
  clinicWeekday,
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

    const collision = await this.repo.checkDoctorCollision(
      clinicId,
      resolvedDoctorId,
      startTime,
      endTime,
      excludeAppointmentId
    );
    if (collision) {
      throw new AppError(
        'Selected doctor already has an appointment during this time window.',
        409,
        'SLOT_ALREADY_BOOKED'
      );
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

      // Auto-convert lead to patient if appointment is created directly as COMPLETED
      if ((dto as any).status === 'COMPLETED') {
        await this.autoConvertLeadOnAppointmentDone(
          clinicId,
          dto.patientId,
          dto.service || 'Consultation',
          auditContext.actorName || 'Staff'
        );
      }

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

    const updated = await this.repo.update(id, updateData);

    // Auto-flow: When appointment is marked COMPLETED / Done, automatically convert linked lead to patient
    if (updateData.status === 'COMPLETED') {
      await this.autoConvertLeadOnAppointmentDone(
        clinicId,
        existing.patientId,
        existing.service || 'Consultation',
        auditContext.actorName || 'System Automated Flow'
      );
    }

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
    actorName: string
  ) {
    try {
      let patient = await prisma.patient.findUnique({
        where: { id: patientId },
      });

      if (!patient) {
        const lead = await prisma.lead.findFirst({
          where: { id: patientId, clinicId },
        });
        if (lead) {
          patient = await prisma.patient.findFirst({
            where: { clinicId, phone: lead.phone },
          });
          if (!patient) {
            patient = await prisma.patient.create({
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
          }
          await prisma.appointment.updateMany({
            where: { patientId: lead.id },
            data: { patientId: patient.id },
          });
        }
      }

      if (!patient) return;

      // Find any lead belonging to clinic with matching phone or linked patient ID
      const matchingLead = await prisma.lead.findFirst({
        where: {
          clinicId,
          OR: [
            { convertedPatientId: patient.id },
            { phone: patient.phone },
            ...(patient.leadId ? [{ id: patient.leadId }] : []),
          ],
          status: { not: 'CONVERTED' },
        },
      });

      if (matchingLead) {
        await prisma.$transaction([
          prisma.lead.update({
            where: { id: matchingLead.id },
            data: {
              status: 'CONVERTED',
              convertedPatientId: patient.id,
            },
          }),
          prisma.patient.update({
            where: { id: patient.id },
            data: {
              leadId: matchingLead.id,
              status: 'ACTIVE',
            },
          }),
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
            where: { leadId: matchingLead.id },
            data: { patientId: patient.id },
          }),
        ]);
        console.log(`[Auto-Flow] Lead ${matchingLead.id} (${matchingLead.name}) automatically converted to Patient upon appointment completion.`);
      }
    } catch (err: any) {
      console.error('[Auto-Flow] Error auto-converting lead on appointment completion:', err.message);
    }
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
      status: { notIn: ['CANCELLED'] },
    };
    if (resolvedDoctorId) {
      appointmentWhere.doctorId = resolvedDoctorId;
    }


    const bookedAppointments = await prisma.appointment.findMany({
      where: appointmentWhere,
      select: { startsAt: true },
    });

    const bookedSlots = bookedAppointments.map((a) => clinicTimeString(new Date(a.startsAt), timeZone));

    // Slots where someone already booked the spot will not appear!
    const availableSlots = allSlots.filter((slot) => !bookedSlots.includes(slot));

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

