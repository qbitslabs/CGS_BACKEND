/* CGS internal module — business logic.
 * Clinic API layer for internal; talks Prisma or callers, not the AI database. */
import { internalRepository, InternalRepository } from './internal.repository.js';
import {
  AIBookAppointmentDTO,
  AIRescheduleAppointmentDTO,
  AIContextQueryDTO,
  AILeadUpsertDTO,
  AIPatientQueryDTO,
  AIRecordUsageDTO,
  SyncSummaryDTO,
  WhatsAppEventDTO,
  WhatsAppInboundMessageDTO,
} from './internal.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { prisma } from '../../config/db.js';
import { conversationService } from '../conversations/conversation.service.js';

function formatDoctorName(firstName?: string | null, lastName?: string | null) {
  const full = `${firstName || ''} ${lastName || ''}`.trim();
  return /^dr\.?\s/i.test(full) ? full : `Dr. ${full}`.trim();
}

function isConsultationService(service?: { category?: string | null; name?: string | null } | null) {
  const cat = (service?.category || '').trim().toLowerCase();
  if (cat === 'consultation' || cat === 'consult') return true;
  const name = (service?.name || '').trim().toLowerCase();
  return name === 'consultation' || name === 'consult' || name.includes('normal consultation');
}

function mapAiService(s: { id: string; name: string; description?: string | null; price: any; durationMinutes: number; category?: string | null }) {
  const consultation = isConsultationService(s);
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    price: Number(s.price),
    durationMinutes: s.durationMinutes,
    category: s.category,
    serviceType: consultation ? 'consultation' : 'procedure',
  };
}

function servicesForDoctor(doctor: any, clinicServices: any[]) {
  const consults = clinicServices.filter((s) => isConsultationService(s)).map(mapAiService);
  const procedures = (doctor.doctorServices || [])
    .map((ds: any) => ds.service)
    .filter((s: any) => s && s.isActive !== false && !isConsultationService(s))
    .map(mapAiService);
  const merged: typeof consults = [];
  const seen = new Set<string>();
  for (const s of [...consults, ...procedures]) {
    const key = (s.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  if (!merged.length) {
    return clinicServices.filter((s) => s.isActive !== false).map(mapAiService);
  }
  return merged;
}

export class InternalService {
  constructor(private readonly repo: InternalRepository = internalRepository) {}

  /**
   * Resolve WhatsApp account by Meta phone_number_id.
   * If missing, auto-bind that Meta ID onto the single active account that still has a placeholder ID
   * (non-numeric / fake onboard value) so inbound works without manual DB edits.
   */
  private async resolveWhatsAppAccount(phoneNumberId: string) {
    if (!phoneNumberId || phoneNumberId === 'UNKNOWN') return null;

    let account = await this.repo.getWhatsAppAccountByPhoneId(phoneNumberId);
    if (account) return account;

    const isMetaStyleId = /^\d{10,20}$/.test(phoneNumberId);
    if (!isMetaStyleId) return null;

    const activeAccounts = await prisma.whatsappAccount.findMany({
      where: { isActive: true },
    });
    const placeholders = activeAccounts.filter((a) => !/^\d{10,20}$/.test(a.phoneNumberId));

    if (placeholders.length === 1) {
      console.warn(
        `[Internal] Auto-binding Meta phone_number_id ${phoneNumberId} onto WhatsApp account ${placeholders[0].id} (was "${placeholders[0].phoneNumberId}")`
      );
      return prisma.whatsappAccount.update({
        where: { id: placeholders[0].id },
        data: {
          phoneNumberId,
          webhookStatus: 'ACTIVE',
        },
      });
    }

    if (placeholders.length > 1) {
      console.warn(
        `[Internal] Cannot auto-bind phone_number_id ${phoneNumberId}: ${placeholders.length} placeholder WhatsApp accounts exist. Set the real Meta Phone Number ID in admin onboard.`
      );
    }

    return null;
  }

  async handleWhatsAppEvent(dto: WhatsAppEventDTO) {
    const account = await this.resolveWhatsAppAccount(dto.phoneNumberId);
    if (!account) {
      console.warn(`WhatsApp account for phone_number_id ${dto.phoneNumberId} not registered.`);
    }

    const event = await this.repo.upsertWhatsAppEvent({
      clinicId: account?.clinicId,
      whatsappAccountId: account?.id,
      providerEventId: dto.providerEventId,
      eventType: dto.eventType || 'messages',
      payload: dto.payload,
    });

    return { eventId: event.id, status: event.status };
  }

  async handleWhatsAppInbound(dto: WhatsAppInboundMessageDTO) {
    const account = await this.resolveWhatsAppAccount(dto.phoneNumberId);
    if (!account) {
      throw new AppError(
        `Unrecognized WhatsApp Account ID: ${dto.phoneNumberId}. Set Meta Phone Number ID on the clinic WhatsApp account in admin.`,
        404,
        'ACCOUNT_NOT_FOUND'
      );
    }

    const persisted = await this.repo.processInboundWhatsAppMessageInTx({
      clinicId: account.clinicId,
      accountId: account.id,
      data: dto,
    });

    // Meta / gateway retries reuse the same providerMessageId — do not run AI twice
    if (!persisted.isNew) {
      console.log(
        `[Internal] Duplicate WhatsApp inbound skipped AI providerMessageId=${dto.providerMessageId}`
      );
      return { ...persisted, aiReply: null, deduped: true };
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: persisted.conversationId },
      select: { id: true, clinicId: true, state: true },
    });

    if (conversation?.state === 'AI_ACTIVE') {
      conversationService.scheduleGenerateReply(
        conversation.clinicId,
        conversation.id,
        dto.content
      );
    }

    return persisted;
  }

  async getAiContext(dto: AIContextQueryDTO) {
    let clinic: any = null;
    let targetDoctor: any = null;

    if (dto.doctorId) {
      targetDoctor = await this.repo.getDoctorContext(dto.doctorId);
      if (targetDoctor) {
        clinic = targetDoctor.clinic;
      }
    }

    if (!clinic && dto.clinicId) {
      clinic = await this.repo.getClinicContext(dto.clinicId);
    }

    if (!clinic) {
      throw new AppError('Clinic or Doctor not found', 404, 'ENTITY_NOT_FOUND');
    }

    const services = await this.repo.getActiveServices(clinic.id);
    const doctors = await this.repo.getClinicDoctors(clinic.id);

    return {
      clinic: {
        id: clinic.id,
        name: clinic.name,
        address: clinic.address,
        city: clinic.city,
        phone: clinic.phone,
        workingHours: clinic.workingHours || '09:00 AM - 08:00 PM (Mon-Sat)',
        timezone: clinic.timezone,
        currency: clinic.currency,
      },
      doctor: targetDoctor
        ? {
            id: targetDoctor.id,
            name: formatDoctorName(targetDoctor.user.firstName, targetDoctor.user.lastName),
            specialization: targetDoctor.specialization,
            consultationFee: targetDoctor.consultationFee ? Number(targetDoctor.consultationFee) : 500,
            availabilityDays: targetDoctor.availabilityDays,
            availabilityHours: targetDoctor.availabilityHours,
          }
        : null,
      doctors: doctors.map((d) => ({
        id: d.id,
        name: formatDoctorName(d.user.firstName, d.user.lastName),
        specialization: d.specialization || 'Consultant',
        consultationFee: d.consultationFee ? Number(d.consultationFee) : 500,
        availabilityDays: d.availabilityDays,
        availabilityHours: d.availabilityHours,
        services: servicesForDoctor(d, services),
      })),
      services: services.map(mapAiService),
      aiConfig: clinic.aiConfig || null,
    };
  }

  async getAiPatient(dto: AIPatientQueryDTO) {
    if (!dto.phone && !dto.patientId) {
      throw new AppError('Either phone or patientId must be provided', 400, 'BAD_REQUEST');
    }

    const patient = await this.repo.getPatientRecord(dto);
    if (!patient) return null;

    const genderKnown = patient.gender === 'MALE' || patient.gender === 'FEMALE';
    const now = new Date();

    const formatIst = (d: Date) => {
      const date = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
      const time = d.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      return { date, time };
    };

    const recentAppointments = patient.appointments.map((a) => {
      const { date, time } = formatIst(new Date(a.startsAt));
      return {
        id: a.id,
        service: a.service,
        status: a.status,
        date,
        time,
        startsAtIso: a.startsAt.toISOString(),
        isUpcoming: new Date(a.startsAt).getTime() >= now.getTime() - 60 * 60 * 1000,
        doctor: a.doctor
          ? `Dr. ${a.doctor.user.firstName} ${a.doctor.user.lastName || ''}`.trim()
          : 'General',
      };
    });

    const upcomingAppointments = recentAppointments.filter(
      (a) => a.isUpcoming && ['CONFIRMED', 'SCHEDULED'].includes(String(a.status))
    );

    return {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      email: patient.email,
      gender: genderKnown ? patient.gender : null,
      genderKnown,
      age: patient.age ?? null,
      ageKnown: patient.age != null,
      allergies: patient.allergies,
      medicalHistoryNotes: patient.medicalHistoryNotes,
      status: patient.status,
      hasConfirmedBooking: upcomingAppointments.length > 0,
      upcomingAppointments,
      recentAppointments,
    };
  }

  async getOrUpsertLead(dto: AILeadUpsertDTO) {
    const lead = await this.repo.getOrUpsertLead(dto);
    if (lead) {
      await logAuditEvent({
        clinicId: dto.clinicId,
        actorId: 'AI_SERVICE',
        actorEmail: 'ai-service@internal',
        actorType: 'AI_SERVICE',
        action: 'AI_LEAD_CAPTURED',
        resourceType: 'LEAD',
        resourceId: lead.id,
        metadata: {
          phone: dto.phone,
          name: dto.name,
          service: dto.interestedService,
          intent: dto.intent,
        },
      });
    }
    return lead;
  }

  async getAiDoctors(clinicId: string) {
    const [doctors, clinicServices] = await Promise.all([
      this.repo.getClinicDoctors(clinicId),
      this.repo.getActiveServices(clinicId),
    ]);
    return doctors.map((d) => ({
      id: d.id,
      name: formatDoctorName(d.user.firstName, d.user.lastName),
      specialization: d.specialization || 'Consultant',
      consultationFee: d.consultationFee ? Number(d.consultationFee) : 500,
      fee: d.consultationFee ? Number(d.consultationFee) : 500,
      availabilityDays: d.availabilityDays,
      availabilityHours: d.availabilityHours,
      services: servicesForDoctor(d, clinicServices),
    }));
  }

  async getAiServices(clinicId: string) {
    const services = await this.repo.getActiveServices(clinicId);
    return services.map(mapAiService);
  }

  async getAvailability(
    clinicId: string,
    doctorId: string | undefined,
    date: string,
    excludeAppointmentId?: string
  ) {
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    let resolvedDoctorId = doctorId;
    if (!resolvedDoctorId) {
      const doctors = await this.repo.getClinicDoctors(clinicId);
      if (doctors.length === 1) {
        resolvedDoctorId = doctors[0].id;
      } else {
        return {
          date,
          doctorId: null,
          availableSlots: [],
          bookedSlotsCount: 0,
          error: 'doctorId_required',
          message:
            'Pass doctorId from get_doctors. Do not invent slots when the doctor is unknown.',
        };
      }
    }

    const doctor = await this.repo.getDoctorDetails(clinicId, resolvedDoctorId);
    if (!doctor) {
      return {
        date,
        doctorId: resolvedDoctorId,
        availableSlots: [],
        bookedSlotsCount: 0,
        error: 'doctor_not_found',
        message: 'Doctor not found for this clinic.',
      };
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeek = dayNames[parsedDate.getUTCDay()];
    const workingDays = doctor.availabilityDays || [];
    const hoursStr = doctor.availabilityHours || null;

    // Check if doctor has declared leave for this date
    const leaves = await this.repo.getDoctorLeavesForDay(clinicId, resolvedDoctorId, parsedDate);
    if (leaves.length > 0) {
      return {
        date,
        doctorId: resolvedDoctorId,
        doctorName: formatDoctorName(doctor.user?.firstName, doctor.user?.lastName),
        availabilityDays: workingDays,
        availabilityHours: hoursStr,
        availableSlots: [],
        bookedSlotsCount: 0,
        isDoctorOnLeave: true,
        leaveReason: leaves[0].reason || 'Doctor is on scheduled leave',
      };
    }

    if (workingDays.length > 0 && !workingDays.includes(dayOfWeek)) {
      return {
        date,
        doctorId: resolvedDoctorId,
        doctorName: formatDoctorName(doctor.user?.firstName, doctor.user?.lastName),
        availabilityDays: workingDays,
        availabilityHours: hoursStr,
        availableSlots: [],
        bookedSlotsCount: 0,
        isDoctorOffDuty: true,
        offDutyReason: `Doctor does not consult on ${dayOfWeek}s. Available days: ${workingDays.join(', ')}. Hours: ${hoursStr || 'not set'}`,
      };
    }

    const bookedAppointments = (
      await this.repo.getDoctorAppointmentsForDay(
        clinicId,
        resolvedDoctorId,
        startOfDay,
        endOfDay
      )
    ).filter((a) => !excludeAppointmentId || a.id !== excludeAppointmentId);

    const standardSlots = this.generateSlotsFromSchedule(hoursStr);
    const bookedTimes = bookedAppointments.map((a) => {
      const d = new Date(a.startsAt);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    });

    const availableSlots = standardSlots.filter((slot) => !bookedTimes.includes(slot));

    return {
      date,
      doctorId: resolvedDoctorId,
      doctorName: formatDoctorName(doctor.user?.firstName, doctor.user?.lastName),
      availabilityDays: workingDays,
      availabilityHours: hoursStr,
      availableSlots,
      bookedSlotsCount: bookedAppointments.length,
      isDoctorOnLeave: false,
      isDoctorOffDuty: false,
    };
  }

  private generateSlotsFromSchedule(hoursStr?: string | null): string[] {
    // Never invent afternoon/evening defaults — empty means "no known hours".
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

  async bookAppointment(dto: AIBookAppointmentDTO) {
    let doctorId = dto.doctorId;
    if (!doctorId) {
      const doctors = await this.repo.getClinicDoctors(dto.clinicId);
      if (doctors.length === 1) {
        doctorId = doctors[0].id;
      } else if (doctors.length > 1) {
        throw new AppError(
          'doctorId is required to book when the clinic has multiple doctors. Call get_doctors and pick one.',
          400,
          'DOCTOR_REQUIRED'
        );
      }
    }

    // Hard gate: never book leave / off-duty days / closed slots (AI previously skipped this).
    const availability = await this.getAvailability(dto.clinicId, doctorId, dto.date);

    if ((availability as any).isDoctorOnLeave) {
      throw new AppError(
        (availability as any).leaveReason || 'Doctor is on leave on this date.',
        400,
        'DOCTOR_ON_LEAVE'
      );
    }

    if ((availability as any).isDoctorOffDuty) {
      throw new AppError(
        (availability as any).offDutyReason || 'Doctor does not consult on this day.',
        400,
        'DOCTOR_OFF_DUTY'
      );
    }

    const normalizeSlot = (raw: string) => {
      const match = raw.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!match) return raw.trim().toUpperCase();
      let hours = parseInt(match[1], 10);
      const minutes = match[2];
      const period = (match[3] || '').toUpperCase();
      if (period === 'PM' && hours < 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      const h12 = hours % 12 || 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${h12.toString().padStart(2, '0')}:${minutes} ${ampm}`;
    };

    const requested = normalizeSlot(dto.time);
    const openSlots = (availability.availableSlots || []).map(normalizeSlot);
    if (openSlots.length === 0 || !openSlots.includes(requested)) {
      throw new AppError(
        openSlots.length === 0
          ? `No available slots on ${dto.date}. Doctor may be off-duty or fully booked.`
          : `Requested time ${dto.time} is not available on ${dto.date}. Open slots: ${availability.availableSlots.join(', ')}`,
        400,
        'SLOT_UNAVAILABLE'
      );
    }

    let formattedTime = dto.time.trim();
    if (formattedTime.includes('AM') || formattedTime.includes('PM')) {
      const parts = formattedTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (parts) {
        let hours = parseInt(parts[1], 10);
        const minutes = parts[2];
        const modifier = parts[3].toUpperCase();
        if (modifier === 'PM' && hours < 12) hours += 12;
        if (modifier === 'AM' && hours === 12) hours = 0;
        formattedTime = `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      }
    } else if (formattedTime.length === 5) {
      formattedTime = `${formattedTime}:00`;
    }

    // Store appointment in IST wall-clock so UI/AI show the same time the patient booked.
    const startsAt = new Date(`${dto.date}T${formattedTime}+05:30`);
    const endsAt = new Date(startsAt.getTime() + 30 * 60000);

    const result = await this.repo.bookAppointmentInTx({
      clinicId: dto.clinicId,
      patientPhone: dto.patientPhone,
      patientName: dto.patientName,
      doctorId,
      service: dto.service || 'General Consultation',
      startsAt,
      endsAt,
      notes: dto.notes,
      date: dto.date,
      time: dto.time,
      age: dto.age,
      gender: dto.gender,
      allergies: dto.allergies,
      medicalHistoryNotes: dto.medicalHistoryNotes,
    });

    await logAuditEvent({
      clinicId: dto.clinicId,
      actorId: 'AI_SERVICE',
      actorEmail: 'ai-service@internal',
      actorType: 'AI_SERVICE',
      action: 'AI_TOOL_BOOK_APPOINTMENT',
      resourceType: 'APPOINTMENT',
      resourceId: result.appointmentId,
      metadata: {
        doctorId,
        patientPhone: dto.patientPhone,
        patientId: result.patientId,
        service: dto.service,
        date: dto.date,
        time: dto.time,
        age: dto.age,
        gender: dto.gender,
      },
    });

    return result;
  }

  async rescheduleAppointment(dto: AIRescheduleAppointmentDTO) {
    const existing = await this.repo.findAppointmentForAi(dto.appointmentId, dto.clinicId);
    if (!existing) {
      throw new AppError('Appointment not found.', 404, 'NOT_FOUND');
    }
    const dead = new Set(['COMPLETED', 'CANCELLED', 'NO_SHOW']);
    if (dead.has(existing.status)) {
      throw new AppError(
        `Cannot reschedule a ${existing.status.toLowerCase()} appointment. Book a new one.`,
        400,
        'NOT_RESCHEDULABLE'
      );
    }

    const doctorId = dto.doctorId || existing.doctorId || undefined;
    const availability = await this.getAvailability(
      dto.clinicId,
      doctorId,
      dto.date,
      dto.appointmentId
    );

    if ((availability as any).error === 'doctorId_required') {
      throw new AppError(
        'doctorId is required to reschedule when the clinic has multiple doctors.',
        400,
        'DOCTOR_REQUIRED'
      );
    }
    if ((availability as any).isDoctorOnLeave) {
      throw new AppError(
        (availability as any).leaveReason || 'Doctor is on leave on this date.',
        400,
        'DOCTOR_ON_LEAVE'
      );
    }
    if ((availability as any).isDoctorOffDuty) {
      throw new AppError(
        (availability as any).offDutyReason || 'Doctor does not consult on this day.',
        400,
        'DOCTOR_OFF_DUTY'
      );
    }

    const normalizeSlot = (raw: string) => {
      const match = raw.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!match) return raw.trim().toUpperCase();
      let hours = parseInt(match[1], 10);
      const minutes = match[2];
      const period = (match[3] || '').toUpperCase();
      if (period === 'PM' && hours < 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      const h12 = hours % 12 || 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${h12.toString().padStart(2, '0')}:${minutes} ${ampm}`;
    };

    const requested = normalizeSlot(dto.time);
    const openSlots = (availability.availableSlots || []).map(normalizeSlot);
    if (openSlots.length === 0 || !openSlots.includes(requested)) {
      throw new AppError(
        openSlots.length === 0
          ? `No available slots on ${dto.date}. Doctor may be off-duty or fully booked.`
          : `Requested time ${dto.time} is not available on ${dto.date}. Open slots: ${availability.availableSlots.join(', ')}`,
        400,
        'SLOT_UNAVAILABLE'
      );
    }

    let formattedTime = dto.time.trim();
    if (formattedTime.includes('AM') || formattedTime.includes('PM')) {
      const parts = formattedTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (parts) {
        let hours = parseInt(parts[1], 10);
        const minutes = parts[2];
        const modifier = parts[3].toUpperCase();
        if (modifier === 'PM' && hours < 12) hours += 12;
        if (modifier === 'AM' && hours === 12) hours = 0;
        formattedTime = `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      }
    } else if (formattedTime.length === 5) {
      formattedTime = `${formattedTime}:00`;
    }

    const startsAt = new Date(`${dto.date}T${formattedTime}+05:30`);
    const duration = existing.durationMinutes || 30;
    const endsAt = new Date(startsAt.getTime() + duration * 60000);

    const previousDate = new Date(existing.startsAt).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const previousTime = new Date(existing.startsAt).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const result = await this.repo.rescheduleAppointmentInTx({
      appointmentId: dto.appointmentId,
      clinicId: dto.clinicId,
      doctorId,
      startsAt,
      endsAt,
      date: dto.date,
      time: dto.time,
      notes: dto.notes,
    });
    if (!result) {
      throw new AppError('Appointment not found.', 404, 'NOT_FOUND');
    }

    await logAuditEvent({
      clinicId: dto.clinicId,
      actorId: 'AI_SERVICE',
      actorEmail: 'ai-service@internal',
      actorType: 'AI_SERVICE',
      action: 'AI_TOOL_RESCHEDULE_APPOINTMENT',
      resourceType: 'APPOINTMENT',
      resourceId: result.appointmentId,
      metadata: {
        doctorId,
        previousDate,
        previousTime,
        date: dto.date,
        time: dto.time,
      },
    });

    return {
      ...result,
      previousDate,
      previousTime,
      doctorName: result.doctorName || (availability as any).doctorName,
    };
  }

  async getAiAppointment(appointmentId: string, clinicId?: string) {
    const row = await this.repo.findAppointmentForAi(appointmentId, clinicId);
    if (!row) {
      throw new AppError('Appointment not found.', 404, 'NOT_FOUND');
    }
    const starts = new Date(row.startsAt);
    const date = starts.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const time = starts.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const doctorName = row.doctor?.user
      ? `${row.doctor.user.firstName || ''} ${row.doctor.user.lastName || ''}`.trim()
      : null;
    return {
      appointmentId: row.id,
      status: row.status,
      service: row.service,
      date,
      time,
      doctorName: doctorName || undefined,
      patientName: row.patient?.name,
      patientAge: row.patient?.age ?? undefined,
      patientGender: row.patient?.gender || undefined,
    };
  }

  async recordAiUsage(dto: AIRecordUsageDTO) {
    let doctorId = dto.doctorId || null;
    let clinicId = dto.clinicId || (dto.entityType === 'CLINIC' ? dto.entityId : null);

    if (!doctorId && dto.conversationId) {
      const conv = await this.repo.findConversationDoctor(dto.conversationId);
      if (conv) {
        if (conv.doctorId) doctorId = conv.doctorId;
        if (!clinicId && conv.clinicId) clinicId = conv.clinicId;
      }
    }

    const usage = await this.repo.createAiUsageRecord({
      clinicId: clinicId || undefined,
      doctorId: doctorId || undefined,
      conversationId: dto.conversationId || undefined,
      messageId: dto.messageId || undefined,
      requestId: dto.requestId,
      entityType: dto.entityType,
      entityId: dto.entityId,
      operationType: dto.operationType,
      provider: dto.provider,
      model: dto.model,
      inputTokens: dto.inputTokens,
      outputTokens: dto.outputTokens,
      totalTokens: dto.totalTokens,
      inputCost: dto.inputCost,
      outputCost: dto.outputCost,
      totalCost: dto.totalCost,
      currency: dto.currency,
      durationMs: dto.durationMs,
      success: dto.success,
      errorCode: dto.errorCode || undefined,
      metadata: dto.metadata,
    });

    await logAuditEvent({
      clinicId: clinicId || undefined,
      actorId: 'AI_SERVICE',
      actorEmail: 'ai-service@internal',
      actorType: 'AI_SERVICE',
      action: `AI_${dto.operationType || 'CONVERSATION_RESPONSE'}`,
      resourceType: 'AI_USAGE',
      resourceId: usage.id,
      metadata: {
        doctorId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        provider: dto.provider,
        model: dto.model,
        totalTokens: dto.totalTokens,
        totalCost: dto.totalCost,
        conversationId: dto.conversationId,
        durationMs: dto.durationMs,
        success: dto.success,
      },
      requestId: dto.requestId,
    });

    return { id: usage.id, doctorId: usage.doctorId };
  }

  async syncConversationSummary(dto: SyncSummaryDTO) {
    try {
      const summary = await this.repo.syncConversationSummaryInTx(dto);

      const conv = await prisma.conversation.findUnique({
        where: { id: summary.conversationId },
        select: { clinicId: true, doctorId: true },
      });

      await logAuditEvent({
        clinicId: conv?.clinicId,
        actorId: 'AI_SERVICE',
        actorEmail: 'ai-service@internal',
        actorType: 'AI_SERVICE',
        action: 'AI_SUMMARY_SYNCED',
        resourceType: 'CONVERSATION_SUMMARY',
        resourceId: summary.id,
        metadata: {
          conversationId: summary.conversationId,
          requestedConversationId: dto.conversationId,
          version: dto.version,
          doctorId: conv?.doctorId,
        },
      });

      return summary;
    } catch (err: any) {
      if (err?.message === 'CONVERSATION_NOT_FOUND') {
        throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
      }
      throw err;
    }
  }

  async requestHumanHandoff(dto: {
    clinicId: string;
    conversationId: string;
    reason: string;
    severity?: 'normal' | 'critical';
  }) {
    const severity = dto.severity === 'critical' ? 'critical' : 'normal';
    try {
      const result = await this.repo.requestHandoffInTx({
        clinicId: dto.clinicId,
        conversationId: dto.conversationId,
        reason: dto.reason,
        severity,
      });

      await logAuditEvent({
        clinicId: dto.clinicId,
        actorId: 'AI_SERVICE',
        actorEmail: 'ai-service@internal',
        actorType: 'AI_SERVICE',
        action: 'AI_HUMAN_HANDOFF_REQUESTED',
        resourceType: 'CONVERSATION',
        resourceId: dto.conversationId,
        metadata: { reason: dto.reason, severity },
      });

      return result;
    } catch (err: any) {
      if (err?.message === 'CONVERSATION_NOT_FOUND') {
        throw new AppError('Conversation not found', 404, 'NOT_FOUND');
      }
      throw err;
    }
  }
}

export const internalService = new InternalService();

