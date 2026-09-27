/* CGS clinics module — business logic.
 * Clinic API layer for clinics; talks Prisma or callers, not the AI database. */
import { clinicRepository, ClinicRepository } from './clinic.repository.js';
import { CreateClinicServiceDTO, UpdateClinicDTO } from './clinic.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';

const KNOWLEDGE_SECTION_KEYS = [
  { heading: 'Clinic Information', key: 'clinicInformation' },
  { heading: 'Services & Treatments', key: 'servicesTreatments' },
  { heading: 'Doctors', key: 'doctorsInfo' },
  { heading: 'Consultation Details', key: 'consultationDetails' },
  { heading: 'Timings', key: 'timings' },
  { heading: 'FAQs', key: 'faqs' },
] as const;

function isConsultationService(category?: string | null, name?: string | null, serviceType?: string | null) {
  if (serviceType === 'consultation') return true;
  if (serviceType === 'procedure') return false;
  const cat = (category || '').trim().toLowerCase();
  if (cat === 'consultation' || cat === 'consult') return true;
  const n = (name || '').trim().toLowerCase();
  return n === 'consultation' || n === 'consult' || n.includes('normal consultation');
}

function formatDoctorLabel(firstName?: string | null, lastName?: string | null) {
  const first = firstName || '';
  return `${first.startsWith('Dr.') ? '' : 'Dr. '}${first} ${lastName || ''}`.trim();
}

function mapClinicService(s: any) {
  const assignments = Array.isArray(s.doctorServices) ? s.doctorServices : [];
  const consultation = isConsultationService(s.category, s.name);
  const doctors = consultation
    ? []
    : assignments
        .map((a: any) => ({
          id: a.doctorId,
          name: a.doctor?.user
            ? formatDoctorLabel(a.doctor.user.firstName, a.doctor.user.lastName)
            : '',
        }))
        .filter((d: { id?: string }) => d.id);
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    durationMinutes: s.durationMinutes,
    price: Number(s.price),
    category: s.category,
    isActive: s.isActive,
    serviceType: consultation ? 'consultation' : 'procedure',
    doctorId: doctors[0]?.id,
    doctorIds: doctors.map((d: { id: string }) => d.id),
    doctorName: doctors.map((d: { name: string }) => d.name).filter(Boolean).join(', ') || undefined,
    doctorNames: doctors.map((d: { name: string }) => d.name).filter(Boolean),
  };
}

function parseKnowledgeFromSystemPrompt(systemPrompt?: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!systemPrompt?.trim()) return result;

  const headings = KNOWLEDGE_SECTION_KEYS.map((s) => s.heading);
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(${headings.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:?\\s*\\n`,
    'gi'
  );

  const matches = [...systemPrompt.matchAll(pattern)];
  if (!matches.length) {
    // Unstructured blob — put all of it in clinic information
    result.clinicInformation = systemPrompt.trim();
    return result;
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const heading = match[1];
    const start = (match.index || 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index || systemPrompt.length : systemPrompt.length;
    const body = systemPrompt.slice(start, end).trim();
    const section = KNOWLEDGE_SECTION_KEYS.find(
      (s) => s.heading.toLowerCase() === heading.toLowerCase()
    );
    if (section && body) result[section.key] = body;
  }
  return result;
}

function stripInstructionPrefixes(customInstructions?: string | null): string {
  if (!customInstructions?.trim()) return '';
  return customInstructions
    .split('\n')
    .filter((line) => {
      const t = line.trim().toLowerCase();
      return (
        t &&
        !t.startsWith('receptionist name:') &&
        !t.startsWith('greeting:') &&
        !t.startsWith('qualification questions:')
      );
    })
    .join('\n')
    .trim();
}

export class ClinicService {
  constructor(private readonly repo: ClinicRepository = clinicRepository) {}

  async getCurrentClinic(clinicId: string) {
    const clinic = await this.repo.findByIdWithDetails(clinicId);
    if (!clinic) {
      throw new AppError('Clinic not found.', 404, 'NOT_FOUND');
    }

    const whatsappData = clinic.whatsappAccounts[0]
      ? {
          status: clinic.whatsappAccounts[0].isActive ? 'Connected' : 'Disconnected',
          phoneNumber: clinic.whatsappAccounts[0].displayPhoneNumber || '',
          qualityRating: clinic.whatsappAccounts[0].qualityRating || 'High',
        }
      : { status: 'Disconnected' };

    const meta = (clinic.aiConfig?.metadata as Record<string, any>) || {};
    const parsedKnowledge = parseKnowledgeFromSystemPrompt(clinic.aiConfig?.systemPrompt);
    const servicesFallback = clinic.services.map((s) => s.name).filter(Boolean).join(', ');
    const doctorsFallback = clinic.doctors
      .map((d) => {
        const name = `${d.user.firstName} ${d.user.lastName || ''}`.trim();
        return d.specialization ? `${name} (${d.specialization})` : name;
      })
      .filter(Boolean)
      .join('\n');
    const timingsFallback =
      clinic.workingHours ||
      [
        (clinic.workingDays || []).join(', '),
        clinic.openingTime && clinic.closingTime
          ? `${clinic.openingTime} - ${clinic.closingTime}`
          : '',
      ]
        .filter(Boolean)
        .join(' • ');
    const clinicInfoFallback = [
      clinic.name,
      clinic.description,
      clinic.address,
      [clinic.city, clinic.state].filter(Boolean).join(', '),
      clinic.phone && `Phone: ${clinic.phone}`,
      clinic.email && `Email: ${clinic.email}`,
    ]
      .filter(Boolean)
      .join('\n');

    const conversationFromMeta = meta.conversationInstructions || '';
    const conversationFromCustom = stripInstructionPrefixes(clinic.aiConfig?.customInstructions);

    const aiConfigData = clinic.aiConfig
      ? {
          isAiEnabled: clinic.aiConfig.isAiEnabled,
          systemPrompt: clinic.aiConfig.systemPrompt || '',
          customInstructions: clinic.aiConfig.customInstructions || '',
          tone: clinic.aiConfig.tone || 'professional',
          primaryModel: clinic.aiConfig.primaryModel || 'google/gemma-4-31b-it',
          temperature: Number(clinic.aiConfig.temperature || 0.2),
          enabledTools: clinic.aiConfig.enabledTools,
          humanHandoffKeywords: clinic.aiConfig.humanHandoffKeywords || [],
          receptionistName: meta.receptionistName || 'Asha',
          greetingMessage:
            meta.greetingMessage ||
            'Hello! Welcome to our clinic. How can I help you today?',
          conversationInstructions: conversationFromMeta || conversationFromCustom || '',
          clinicInformation:
            meta.clinicInformation ||
            parsedKnowledge.clinicInformation ||
            clinicInfoFallback ||
            '',
          servicesTreatments:
            meta.servicesTreatments ||
            parsedKnowledge.servicesTreatments ||
            servicesFallback ||
            '',
          doctorsInfo:
            meta.doctorsInfo || parsedKnowledge.doctorsInfo || doctorsFallback || '',
          consultationDetails:
            meta.consultationDetails || parsedKnowledge.consultationDetails || '',
          timings: meta.timings || parsedKnowledge.timings || timingsFallback || '',
          faqs: meta.faqs || parsedKnowledge.faqs || '',
          metadata: meta,
        }
      : {
          isAiEnabled: true,
          systemPrompt: '',
          customInstructions: '',
          tone: 'professional',
          primaryModel: 'google/gemma-4-31b-it',
          temperature: 0.2,
          enabledTools: [],
          humanHandoffKeywords: [],
          receptionistName: 'Asha',
          greetingMessage: 'Hello! How can I assist your health appointment today?',
          conversationInstructions: '',
          clinicInformation: clinicInfoFallback,
          servicesTreatments: servicesFallback,
          doctorsInfo: doctorsFallback,
          consultationDetails: '',
          timings: timingsFallback,
          faqs: '',
          metadata: {},
        };

    return {
      id: clinic.id,
      name: clinic.name,
      slug: clinic.slug,
      phone: clinic.phone,
      email: clinic.email,
      address: clinic.address,
      city: clinic.city,
      state: clinic.state,
      postalCode: clinic.postalCode,
      gstin: clinic.gstin,
      workingHours: clinic.workingHours,
      timezone: clinic.timezone,
      currency: clinic.currency,
      aiConfig: aiConfigData,
      whatsapp: whatsappData,
      whatsappAccounts: clinic.whatsappAccounts.map((w) => ({
        id: w.id,
        status: w.isActive ? 'Connected' : 'Disconnected',
        phoneNumber: w.displayPhoneNumber || '',
        qualityRating: w.qualityRating || 'High',
      })),
      services: clinic.services.map((s) => mapClinicService(s)),
      doctors: clinic.doctors.map((d) => ({
        id: d.id,
        name: `${d.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${d.user.firstName} ${d.user.lastName || ''}`.trim(),
        specialization: d.specialization || 'Consultant',
        phone: d.user.phone || '',
        email: d.user.email,
        consultationFee: d.consultationFee ? Number(d.consultationFee) : 500,
        availabilityDays: d.availabilityDays,
        availabilityHours: d.availabilityHours || '09:00 AM - 07:00 PM',
        availability: {
          days: d.availabilityDays,
          hours: d.availabilityHours || '09:00 AM - 07:00 PM',
        },
        isActive: d.isActive,
      })),
    };
  }

  async updateCurrentClinic(
    clinicId: string,
    dto: UpdateClinicDTO & { aiConfig?: any },
    auditContext: {
      userId: string;
      email?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const previous = await this.repo.findById(clinicId);
    if (!previous) {
      throw new AppError('Clinic not found.', 404, 'NOT_FOUND');
    }

    const { aiConfig: aiConfigInput, ...clinicProfileData } = dto;
    const updated = await this.repo.update(clinicId, clinicProfileData);

    if (aiConfigInput) {
      const knowledgeParts = [
        aiConfigInput.clinicInformation && `Clinic Information:\n${aiConfigInput.clinicInformation}`,
        aiConfigInput.servicesTreatments && `Services & Treatments:\n${aiConfigInput.servicesTreatments}`,
        aiConfigInput.doctorsInfo && `Doctors:\n${aiConfigInput.doctorsInfo}`,
        aiConfigInput.consultationDetails && `Consultation Details:\n${aiConfigInput.consultationDetails}`,
        aiConfigInput.timings && `Timings:\n${aiConfigInput.timings}`,
        aiConfigInput.faqs && `FAQs:\n${aiConfigInput.faqs}`,
      ].filter(Boolean);

      const systemPrompt =
        aiConfigInput.systemPrompt !== undefined
          ? aiConfigInput.systemPrompt
          : knowledgeParts.length
            ? knowledgeParts.join('\n\n')
            : undefined;

      const conversationInstructions =
        aiConfigInput.conversationInstructions ?? aiConfigInput.customInstructions;

      const customInstructions = [
        aiConfigInput.receptionistName && `Receptionist name: ${aiConfigInput.receptionistName}`,
        aiConfigInput.greetingMessage && `Greeting: ${aiConfigInput.greetingMessage}`,
        conversationInstructions,
      ]
        .filter(Boolean)
        .join('\n');

      await this.repo.upsertAiConfig(clinicId, {
        isAiEnabled: aiConfigInput.isAiEnabled,
        systemPrompt,
        customInstructions:
          aiConfigInput.customInstructions !== undefined ||
          aiConfigInput.conversationInstructions !== undefined ||
          aiConfigInput.receptionistName !== undefined ||
          aiConfigInput.greetingMessage !== undefined
            ? customInstructions
            : undefined,
        tone: aiConfigInput.tone,
        primaryModel: aiConfigInput.primaryModel,
        humanHandoffKeywords: aiConfigInput.humanHandoffKeywords,
        metadata: Object.fromEntries(
          Object.entries({
            receptionistName: aiConfigInput.receptionistName,
            greetingMessage: aiConfigInput.greetingMessage,
            conversationInstructions,
            clinicInformation: aiConfigInput.clinicInformation,
            servicesTreatments: aiConfigInput.servicesTreatments,
            doctorsInfo: aiConfigInput.doctorsInfo,
            consultationDetails: aiConfigInput.consultationDetails,
            timings: aiConfigInput.timings,
            faqs: aiConfigInput.faqs,
            ...(aiConfigInput.metadata || {}),
          }).filter(([, v]) => v !== undefined)
        ),
      });
    }

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId,
      actorEmail: auditContext.email || 'system',
      action: 'CLINIC_UPDATED',
      resourceType: 'CLINIC',
      resourceId: updated.id,
      diffBefore: previous,
      diffAfter: updated,
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return this.getCurrentClinic(clinicId);
  }

  private resolveServiceCategory(dto: { name?: string; category?: string; serviceType?: string }) {
    if (isConsultationService(dto.category, dto.name, dto.serviceType)) {
      return 'Consultation';
    }
    return dto.category && dto.category !== 'Consultation' ? dto.category : 'General';
  }

  private resolveDoctorIds(dto: { doctorIds?: string[]; doctorId?: string | null }) {
    if (Array.isArray(dto.doctorIds)) return [...new Set(dto.doctorIds.filter(Boolean))];
    if (dto.doctorId === undefined) return undefined;
    return dto.doctorId ? [dto.doctorId] : [];
  }

  private async syncServiceDoctor(
    clinicId: string,
    serviceId: string,
    dto: {
      name?: string;
      category?: string;
      serviceType?: string;
      doctorId?: string | null;
      doctorIds?: string[];
      price?: number;
      durationMinutes?: number;
    }
  ) {
    const consultation = isConsultationService(dto.category, dto.name, dto.serviceType);
    const doctorIds = this.resolveDoctorIds(dto);
    if (consultation) {
      await this.repo.replaceServiceDoctors({ clinicId, serviceId, doctorIds: [] });
      return;
    }
    if (doctorIds === undefined) return;
    if (!doctorIds.length) {
      await this.repo.replaceServiceDoctors({ clinicId, serviceId, doctorIds: [] });
      return;
    }
    const found = await this.repo.findDoctorsInClinic(doctorIds, clinicId);
    if (found.length !== doctorIds.length) {
      throw new AppError('One or more doctors were not found in this clinic.', 404, 'NOT_FOUND');
    }
    await this.repo.replaceServiceDoctors({
      clinicId,
      serviceId,
      doctorIds,
      price: dto.price,
      durationMinutes: dto.durationMinutes,
    });
  }

  async createService(clinicId: string, dto: CreateClinicServiceDTO) {
    const category = this.resolveServiceCategory(dto);
    const payload = { ...dto, category };
    try {
      const service = await this.repo.createService(clinicId, payload);
      await this.syncServiceDoctor(clinicId, service.id, { ...payload, category });
      const fresh = await this.repo.findServiceById(service.id, clinicId);
      return mapClinicService(fresh || service);
    } catch (err: any) {
      if (err.code === 'P2002') {
        const existing =
          (await this.repo.findServiceByName?.(clinicId, dto.name)) ||
          (await this.repo.findServiceById(dto.name, clinicId));
        if (existing?.id) {
          await this.repo.updateService(existing.id, clinicId, {
            price: dto.price,
            durationMinutes: dto.durationMinutes,
            category,
            description: dto.description,
            isActive: true,
          });
          await this.syncServiceDoctor(clinicId, existing.id, { ...payload, category });
          const fresh = await this.repo.findServiceById(existing.id, clinicId);
          if (fresh) return mapClinicService(fresh);
        }
      }
      throw err;
    }
  }

  async updateService(serviceId: string, clinicId: string, dto: any) {
    const existing = await this.repo.findServiceById(serviceId, clinicId);
    if (!existing) {
      throw new AppError('Service not found in clinic.', 404, 'NOT_FOUND');
    }
    const category =
      dto.serviceType || dto.category
        ? this.resolveServiceCategory({
            name: dto.name ?? existing.name,
            category: dto.category ?? existing.category,
            serviceType: dto.serviceType,
          })
        : existing.category;
    await this.repo.updateService(serviceId, clinicId, { ...dto, category });
    await this.syncServiceDoctor(clinicId, serviceId, {
      name: dto.name ?? existing.name,
      category: category ?? undefined,
      serviceType: dto.serviceType,
      doctorId: dto.doctorId,
      doctorIds: dto.doctorIds,
      price: dto.price ?? Number(existing.price),
      durationMinutes: dto.durationMinutes ?? existing.durationMinutes,
    });
    const updated = await this.repo.findServiceById(serviceId, clinicId);
    return updated ? mapClinicService(updated) : null;
  }

  async deleteService(serviceId: string, clinicId: string) {
    const existing = await this.repo.findServiceById(serviceId, clinicId);
    if (!existing) {
      throw new AppError('Service not found in clinic.', 404, 'NOT_FOUND');
    }
    try {
      await this.repo.deleteService(serviceId, clinicId);
      return { id: serviceId, deleted: true };
    } catch (err: any) {
      // AppointmentService uses onDelete: Restrict — deactivate instead of failing.
      if (err?.code === 'P2003' || err?.code === 'P2014') {
        await this.repo.updateService(serviceId, clinicId, { isActive: false });
        return { id: serviceId, deleted: false, deactivated: true };
      }
      throw err;
    }
  }
}

export const clinicService = new ClinicService();
