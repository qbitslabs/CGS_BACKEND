/* CGS internal module — Prisma queries.
 * Clinic API layer for internal; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import {
  AIBookAppointmentDTO,
  AILeadUpsertDTO,
  AIPatientQueryDTO,
  AIRecordUsageDTO,
  SyncSummaryDTO,
  WhatsAppInboundMessageDTO,
} from './internal.types.js';

/** Match landing (10-digit) vs WhatsApp (91…) and other common India formats. */
function phoneMatchVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return [phone];

  const variants = new Set<string>([digits]);
  if (digits.length === 10) {
    variants.add(`91${digits}`);
  }
  if (digits.startsWith('91') && digits.length === 12) {
    variants.add(digits.slice(2));
  }
  if (digits.startsWith('0') && digits.length === 11) {
    const withoutZero = digits.slice(1);
    variants.add(withoutZero);
    variants.add(`91${withoutZero}`);
  }
  return [...variants];
}

export class InternalRepository {
  async getWhatsAppAccountByPhoneId(phoneNumberId: string) {
    return prisma.whatsappAccount.findUnique({
      where: { phoneNumberId },
      include: { clinic: true },
    });
  }

  async upsertWhatsAppEvent(data: {
    clinicId?: string;
    whatsappAccountId?: string;
    providerEventId: string;
    eventType: string;
    payload: any;
  }) {
    return prisma.whatsappEvent.upsert({
      where: { providerEventId: data.providerEventId },
      update: {},
      create: {
        clinicId: data.clinicId,
        whatsappAccountId: data.whatsappAccountId,
        providerEventId: data.providerEventId,
        eventType: data.eventType,
        payload: data.payload,
        status: 'RECEIVED',
      },
    });
  }

  async processInboundWhatsAppMessageInTx(params: {
    clinicId: string;
    accountId: string;
    data: WhatsAppInboundMessageDTO;
  }) {
    // Keep this transaction short — long txs die on Supabase pooler (P2028).
    const result = await prisma.$transaction(
      async (tx) => {
      const phoneVariants = phoneMatchVariants(params.data.senderPhone);
      const metaProfileName = params.data.senderName?.trim() || null;
      const canonicalPhone = phoneVariants.find((p) => p.startsWith('91') && p.length === 12)
        || params.data.senderPhone.replace(/\D/g, '')
        || params.data.senderPhone;

      // Prefer landing/website thread if duplicates already exist for the same number.
      const conversations = await tx.conversation.findMany({
        where: {
          clinicId: params.clinicId,
          participantPhone: { in: phoneVariants },
        },
        orderBy: { createdAt: 'desc' },
        include: { lead: true },
        take: 10,
      });

      let conversation =
        conversations.find((c) => c.lead?.source === 'WEBSITE') ||
        conversations.find((c) => c.internalNotes?.includes('Lead from landing page')) ||
        conversations.find((c) => Boolean(c.leadId)) ||
        conversations[0] ||
        null;

      let patient = await tx.patient.findFirst({
        where: {
          clinicId: params.clinicId,
          phone: { in: phoneVariants },
        },
        orderBy: { createdAt: 'asc' },
      });

      // Always resolve lead by phone variants (not only when patient is missing).
      const leads = await tx.lead.findMany({
        where: {
          clinicId: params.clinicId,
          phone: { in: phoneVariants },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      let lead: any =
        conversation?.lead ||
        leads.find((l) => l.source === 'WEBSITE') ||
        leads[0] ||
        null;

      // Meta contact name ONLY for brand-new direct WhatsApp (no prior lead/thread).
      if (!patient && !lead) {
        lead = await tx.lead.create({
          data: {
            clinicId: params.clinicId,
            name: metaProfileName || 'Patient',
            phone: canonicalPhone,
            source: 'WHATSAPP',
            status: 'NEW',
          },
        });
      } else if (lead && lead.phone !== canonicalPhone) {
        // Keep one canonical phone so later messages always match this lead.
        lead = await tx.lead.update({
          where: { id: lead.id },
          data: { phone: canonicalPhone },
        });
      }

      // Landing/existing lead name always wins — never Meta profile name.
      const displayName = lead?.name || conversation?.participantName || metaProfileName || 'Patient';

      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            clinicId: params.clinicId,
            patientId: patient?.id,
            leadId: lead?.id,
            whatsappAccountId: params.accountId,
            participantName: displayName,
            participantPhone: canonicalPhone,
            state: 'AI_ACTIVE',
            unreadCount: 1,
            lastMessageText: params.data.content,
            lastMessageAt: new Date(),
            lastActivityAt: new Date(),
          },
          include: { lead: true },
        });
      } else {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            unreadCount: { increment: 1 },
            lastMessageText: params.data.content,
            lastMessageAt: new Date(),
            lastActivityAt: new Date(),
            patientId: patient?.id || conversation.patientId,
            leadId: lead?.id || conversation.leadId,
            participantPhone: canonicalPhone,
            // Force landing lead name onto the thread (fixes prior Meta-name duplicates).
            participantName: displayName,
          },
        });
      }

      const existingMessage = await tx.message.findUnique({
        where: { providerMessageId: params.data.providerMessageId },
      });

      if (existingMessage) {
        return {
          message: existingMessage,
          conversationId: conversation.id,
          displayName,
          isNew: false,
        };
      }

      const message = await tx.message.create({
        data: {
          clinicId: params.clinicId,
          conversationId: conversation.id,
          whatsappAccountId: params.accountId,
          direction: 'INBOUND',
          senderType: 'PATIENT',
          senderName: displayName,
          content: params.data.content,
          providerMessageId: params.data.providerMessageId,
          mediaUrl: params.data.mediaUrl,
          status: 'DELIVERED',
        },
      });

      return {
        message,
        conversationId: conversation.id,
        displayName,
        isNew: true,
      };
    },
      {
        maxWait: 10_000,
        timeout: 20_000,
      }
    );

    // Side effects outside the transaction — must not risk P2028 on the inbound commit
    if (result.isNew) {
      try {
        await prisma.notification.create({
          data: {
            clinicId: params.clinicId,
            type: 'NEW_CONVERSATION',
            title: `New WhatsApp Message from ${result.displayName}`,
            message: params.data.content.slice(0, 100),
            link: `/conversations`,
            entityId: result.conversationId,
          },
        });
      } catch (err: any) {
        console.warn('[Inbound] notification create failed:', err?.message || err);
      }

      try {
        await prisma.whatsAppUsage.create({
          data: {
            clinicId: params.clinicId,
            whatsappAccountId: params.accountId,
            type: 'MESSAGE',
            quantity: 1,
            unitCost: 0.005,
            totalCost: 0.005,
            providerReference: params.data.providerMessageId,
          },
        });
      } catch (err: any) {
        console.warn('[Inbound] whatsapp usage create failed:', err?.message || err);
      }
    }

    return { message: result.message, conversationId: result.conversationId, isNew: result.isNew };
  }

  async getDoctorContext(doctorId: string) {
    return prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { clinic: true, user: true },
    });
  }

  async getClinicContext(clinicId: string) {
    return prisma.clinic.findUnique({
      where: { id: clinicId },
      include: {
        services: { where: { isActive: true } },
        doctors: { include: { user: true } },
        aiConfig: true,
      },
    });
  }

  async getActiveServices(clinicId: string) {
    return prisma.service.findMany({
      where: { clinicId, isActive: true },
    });
  }

  async getClinicDoctors(clinicId: string) {
    return prisma.doctor.findMany({
      where: { clinicId },
      include: {
        user: true,
        doctorServices: { include: { service: true } },
      },
    });
  }

  async getPatientRecord(query: AIPatientQueryDTO) {
    const where: any = { clinicId: query.clinicId };
    if (query.patientId) where.id = query.patientId;
    else if (query.phone) where.phone = { in: phoneMatchVariants(query.phone) };

    return prisma.patient.findFirst({
      where,
      include: {
        appointments: {
          where: { status: { notIn: ['CANCELLED'] } },
          orderBy: { startsAt: 'desc' },
          take: 10,
          include: { doctor: { include: { user: true } } },
        },
      },
    });
  }

  async getOrUpsertLead(dto: AILeadUpsertDTO) {
    let lead: any = null;
    if (dto.leadId) {
      lead = await prisma.lead.findUnique({ where: { id: dto.leadId } });
    } else if (dto.phone) {
      const variants = phoneMatchVariants(dto.phone);
      const leads = await prisma.lead.findMany({
        where: { clinicId: dto.clinicId, phone: { in: variants } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      lead = leads.find((l) => l.source === 'WEBSITE') || leads[0] || null;
    }

    if (lead) {
      // Never overwrite a landing/website lead name with WhatsApp/AI guess.
      const keepLandingName = lead.source === 'WEBSITE' || Boolean(lead.name);
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: {
          name: keepLandingName ? lead.name : dto.name || lead.name,
          interestedService: dto.interestedService || lead.interestedService,
          intent: dto.intent || lead.intent,
          phone: dto.phone
            ? phoneMatchVariants(dto.phone).find((p) => p.startsWith('91') && p.length === 12) || lead.phone
            : lead.phone,
        },
      });
      return lead;
    }

    if (dto.phone) {
      const canonical =
        phoneMatchVariants(dto.phone).find((p) => p.startsWith('91') && p.length === 12) || dto.phone;
      lead = await prisma.lead.create({
        data: {
          clinicId: dto.clinicId,
          phone: canonical,
          name: dto.name || 'WhatsApp Lead',
          source: 'WHATSAPP',
          interestedService: dto.interestedService || 'General Consultation',
          intent: dto.intent || 'MEDIUM',
          status: 'NEW',
        },
      });
    }

    return lead;
  }

  async getDoctorLeavesForDay(clinicId: string, doctorId: string | undefined, date: Date) {
    const where: any = {
      clinicId,
      date,
      isAvailable: false,
    };
    if (doctorId) where.doctorId = doctorId;

    return prisma.doctorAvailability.findMany({
      where,
    });
  }

  async getDoctorDetails(clinicId: string, doctorId: string) {
    return prisma.doctor.findFirst({
      where: {
        clinicId,
        OR: [
          { id: doctorId },
          { userId: doctorId },
        ],
      },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
  }

  async getDoctorAppointmentsForDay(clinicId: string, doctorId: string | undefined, startOfDay: Date, endOfDay: Date) {
    const where: any = {
      clinicId,
      startsAt: { gte: startOfDay, lte: endOfDay },
      status: { notIn: ['CANCELLED'] },
    };
    if (doctorId) where.doctorId = doctorId;

    return prisma.appointment.findMany({
      where,
      select: { id: true, startsAt: true, endsAt: true, doctorId: true },
    });
  }

  async rescheduleAppointmentInTx(params: {
    appointmentId: string;
    clinicId: string;
    doctorId?: string;
    startsAt: Date;
    endsAt: Date;
    date: string;
    time: string;
    notes?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findFirst({
        where: { id: params.appointmentId, clinicId: params.clinicId },
        include: {
          patient: { select: { id: true, name: true, age: true, gender: true } },
          doctor: {
            include: { user: { select: { firstName: true, lastName: true } } },
          },
        },
      });
      if (!existing) return null;

      const appointment = await tx.appointment.update({
        where: { id: existing.id },
        data: {
          doctorId: params.doctorId ?? existing.doctorId,
          startsAt: params.startsAt,
          endsAt: params.endsAt,
          durationMinutes: existing.durationMinutes || 30,
          status: 'CONFIRMED',
          notes: params.notes
            ? `[Rescheduled by AI Assistant] ${params.notes}`
            : existing.notes,
        },
      });

      const patientName = existing.patient?.name || 'Patient';
      await tx.notification.create({
        data: {
          clinicId: params.clinicId,
          type: 'APPOINTMENT_CHANGE',
          title: `Appointment rescheduled: ${patientName}`,
          message: `${existing.service || 'Consultation'} moved to ${params.date} at ${params.time}`,
          link: `/appointments`,
          entityId: appointment.id,
        },
      });

      const doctorUser = existing.doctor?.user;
      const doctorName = doctorUser
        ? `${doctorUser.firstName || ''} ${doctorUser.lastName || ''}`.trim()
        : undefined;

      return {
        appointmentId: appointment.id,
        patientId: existing.patientId,
        patientName,
        patientAge: existing.patient?.age ?? undefined,
        patientGender: existing.patient?.gender || undefined,
        service: appointment.service,
        date: params.date,
        time: params.time,
        status: appointment.status,
        doctorName: doctorName || undefined,
      };
    });
  }

  async bookAppointmentInTx(params: {
    clinicId: string;
    patientPhone: string;
    patientName: string;
    doctorId?: string;
    service: string;
    startsAt: Date;
    endsAt: Date;
    notes?: string;
    date: string;
    time: string;
    age?: number;
    gender?: 'MALE' | 'FEMALE' | 'OTHER';
    allergies?: string[];
    medicalHistoryNotes?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const phoneVariants = phoneMatchVariants(params.patientPhone);
      const canonicalPhone =
        phoneVariants.find((p) => p.startsWith('91') && p.length === 12) ||
        params.patientPhone.replace(/\D/g, '') ||
        params.patientPhone;

      const matchingLeads = await tx.lead.findMany({
        where: { clinicId: params.clinicId, phone: { in: phoneVariants } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      const matchingLead =
        matchingLeads.find((l) => l.source === 'WEBSITE') || matchingLeads[0] || null;

      // Prefer landing lead name over whatever the AI/Meta guessed.
      const resolvedName = matchingLead?.name || params.patientName || 'Patient';

      const clinicalNoteParts = [
        params.medicalHistoryNotes?.trim(),
        params.notes?.trim() && !params.medicalHistoryNotes?.includes(params.notes.trim())
          ? `Visit notes: ${params.notes.trim()}`
          : null,
      ].filter(Boolean);
      const clinicalNotes = clinicalNoteParts.length ? clinicalNoteParts.join('\n') : undefined;
      const allergies =
        params.allergies?.map((a) => a.trim()).filter(Boolean) || undefined;

      let patient = await tx.patient.findFirst({
        where: { clinicId: params.clinicId, phone: { in: phoneVariants } },
        orderBy: { createdAt: 'asc' },
      });

      if (!patient) {
        patient = await tx.patient.create({
          data: {
            clinicId: params.clinicId,
            name: resolvedName,
            phone: canonicalPhone,
            status: 'ACTIVE',
            age: params.age ?? null,
            gender: params.gender || 'OTHER',
            allergies: allergies || [],
            medicalHistoryNotes: clinicalNotes || null,
          },
        });

        await tx.patientActivity.create({
          data: {
            patientId: patient.id,
            type: 'profile_update',
            title: 'Patient created by AI',
            description: [
              `Name: ${resolvedName}`,
              params.age != null ? `Age: ${params.age}` : null,
              params.gender ? `Gender: ${params.gender}` : null,
              clinicalNotes ? `Clinical: ${clinicalNotes}` : null,
              allergies?.length ? `Allergies: ${allergies.join(', ')}` : null,
            ]
              .filter(Boolean)
              .join(' | '),
            actor: 'CGS AI Receptionist',
          },
        });
      } else {
        const mergedNotes = [patient.medicalHistoryNotes, clinicalNotes]
          .filter(Boolean)
          .join('\n\n');
        const mergedAllergies =
          allergies && allergies.length
            ? Array.from(new Set([...(patient.allergies || []), ...allergies]))
            : patient.allergies;

        patient = await tx.patient.update({
          where: { id: patient.id },
          data: {
            name: matchingLead?.name || patient.name || resolvedName,
            phone: canonicalPhone,
            age: params.age ?? patient.age,
            gender:
              params.gender && params.gender !== 'OTHER'
                ? params.gender
                : patient.gender === 'OTHER' && params.gender
                  ? params.gender
                  : patient.gender,
            allergies: mergedAllergies,
            medicalHistoryNotes: mergedNotes || patient.medicalHistoryNotes,
          },
        });

        if (params.age != null || params.gender || clinicalNotes || allergies?.length) {
          await tx.patientActivity.create({
            data: {
              patientId: patient.id,
              type: 'note',
              title: 'Clinical details updated by AI',
              description: [
                params.age != null ? `Age: ${params.age}` : null,
                params.gender ? `Gender: ${params.gender}` : null,
                clinicalNotes ? `Clinical: ${clinicalNotes}` : null,
                allergies?.length ? `Allergies: ${allergies.join(', ')}` : null,
              ]
                .filter(Boolean)
                .join(' | '),
              actor: 'CGS AI Receptionist',
            },
          });
        }
      }

      const appointment = await tx.appointment.create({
        data: {
          clinicId: params.clinicId,
          patientId: patient.id,
          doctorId: params.doctorId,
          service: params.service,
          status: 'CONFIRMED',
          startsAt: params.startsAt,
          endsAt: params.endsAt,
          durationMinutes: 30,
          notes: params.notes ? `[Booked by AI Assistant] ${params.notes}` : '[Booked by AI Assistant]',
        },
      });

      if (matchingLead) {
        await tx.lead.update({
          where: { id: matchingLead.id },
          data: {
            status: 'BOOKED',
            phone: canonicalPhone,
            interestedService: params.service || matchingLead.interestedService,
          },
        });
        await tx.leadActivity.create({
          data: {
            leadId: matchingLead.id,
            type: 'appointment',
            title: 'Appointment booked by AI',
            description: `${params.service} on ${params.date} at ${params.time}`,
            actor: 'CGS AI Receptionist',
          },
        });
      }

      // Attach patient to open WhatsApp conversation for this phone.
      await tx.conversation.updateMany({
        where: {
          clinicId: params.clinicId,
          participantPhone: { in: phoneVariants },
        },
        data: {
          patientId: patient.id,
          leadId: matchingLead?.id,
        },
      });

      await tx.notification.create({
        data: {
          clinicId: params.clinicId,
          type: 'APPOINTMENT_CHANGE',
          title: `New Appointment: ${patient.name}`,
          message: `${params.service} scheduled for ${params.date} at ${params.time}`,
          link: `/appointments`,
          entityId: appointment.id,
        },
      });

      let doctorName: string | undefined;
      if (params.doctorId) {
        const bookedDoctor = await tx.doctor.findFirst({
          where: { id: params.doctorId, clinicId: params.clinicId },
          include: { user: { select: { firstName: true, lastName: true } } },
        });
        if (bookedDoctor?.user) {
          doctorName = `${bookedDoctor.user.firstName || ''} ${bookedDoctor.user.lastName || ''}`.trim();
        }
      }

      return {
        appointmentId: appointment.id,
        patientId: patient.id,
        patientName: patient.name,
        patientAge: patient.age,
        patientGender: patient.gender,
        service: appointment.service,
        date: params.date,
        time: params.time,
        status: appointment.status,
        doctorName: doctorName || undefined,
      };
    });
  }

  async findAppointmentForAi(appointmentId: string, clinicId?: string) {
    return prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        ...(clinicId ? { clinicId } : {}),
      },
      include: {
        patient: { select: { name: true, age: true, gender: true } },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
  }

  async findConversationDoctor(conversationId: string) {
    return prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { doctorId: true, clinicId: true },
    });
  }

  async createAiUsageRecord(data: any) {
    if (data?.requestId) {
      const existing = await prisma.aiUsage.findFirst({
        where: { requestId: data.requestId },
        select: { id: true, doctorId: true },
      });
      if (existing) return existing;
    }
    return prisma.aiUsage.create({ data });
  }

  async findConversationForSummary(dto: SyncSummaryDTO) {
    const byId = await prisma.conversation.findUnique({
      where: { id: dto.conversationId },
      select: { id: true, clinicId: true },
    });
    if (byId) return byId;

    const clinicId = dto.clinicId;
    const digits = (dto.participantPhone || '').replace(/\D/g, '');
    if (!clinicId || !digits) return null;

    const last10 = digits.slice(-10);
    const phones = new Set<string>([digits, last10]);
    if (digits.length === 10) phones.add(`91${digits}`);
    if (digits.startsWith('91') && digits.length === 12) phones.add(digits.slice(2));

    return prisma.conversation.findFirst({
      where: {
        clinicId,
        OR: [
          { participantPhone: { in: [...phones] } },
          { participantPhone: { endsWith: last10 } },
        ],
      },
      orderBy: { lastActivityAt: 'desc' },
      select: { id: true, clinicId: true },
    });
  }

  async syncConversationSummaryInTx(dto: SyncSummaryDTO) {
    const resolved = await this.findConversationForSummary(dto);
    if (!resolved) throw new Error('CONVERSATION_NOT_FOUND');

    return prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.findUnique({
        where: { id: resolved.id },
        select: { id: true, clinicId: true },
      });
      if (!conv) throw new Error('CONVERSATION_NOT_FOUND');

      const summaryJson = {
        topics: dto.topics || [],
        entities: dto.entities || {},
        intent: dto.intent || '',
        sentiment: dto.sentiment || '',
        keyPoints: dto.keyPoints || [],
        actionItems: dto.actionItems || [],
      };

      const summary = await tx.conversationSummary.upsert({
        where: { conversationId: conv.id },
        update: {
          summaryText: dto.summaryText,
          summaryJson,
          version: dto.version,
          status: 'READY',
          updatedAt: new Date(),
        },
        create: {
          clinicId: conv.clinicId,
          conversationId: conv.id,
          summaryText: dto.summaryText,
          summaryJson,
          version: dto.version,
          status: 'READY',
        },
      });

      await tx.conversationSummaryVersion.upsert({
        where: {
          conversationSummaryId_version: {
            conversationSummaryId: summary.id,
            version: dto.version,
          },
        },
        update: {
          summaryText: dto.summaryText,
          summaryJson,
        },
        create: {
          conversationSummaryId: summary.id,
          conversationId: conv.id,
          version: dto.version,
          summaryText: dto.summaryText,
          summaryJson,
        },
      });

      return summary;
    });
  }

  async requestHandoffInTx(params: {
    clinicId: string;
    conversationId: string;
    reason: string;
    severity: 'normal' | 'critical';
  }) {
    return prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { id: params.conversationId, clinicId: params.clinicId },
      });
      if (!conversation) {
        throw new Error('CONVERSATION_NOT_FOUND');
      }

      const reasonPrefix = params.severity === 'critical' ? 'CRITICAL: ' : '';
      const handoffReason = `${reasonPrefix}${params.reason}`.slice(0, 500);

      const updated = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          state: 'HANDOFF_PENDING',
          handoffReason,
          lastActivityAt: new Date(),
        },
      });

      await tx.notification.create({
        data: {
          clinicId: params.clinicId,
          type: 'HUMAN_HANDOFF',
          title:
            params.severity === 'critical'
              ? `Critical Situation: ${conversation.participantName}`
              : `Human Handoff Required: ${conversation.participantName}`,
          message: handoffReason,
          link: `/conversations`,
          entityId: conversation.id,
        },
      });

      return {
        conversationId: updated.id,
        state: updated.state,
        handoffReason: updated.handoffReason,
        severity: params.severity,
        participantName: conversation.participantName,
      };
    });
  }
}

export const internalRepository = new InternalRepository();
