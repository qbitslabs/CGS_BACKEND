/* CGS clinics module — Prisma queries.
 * Clinic API layer for clinics; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { CreateClinicServiceDTO, UpdateClinicDTO } from './clinic.types.js';

export class ClinicRepository {
  async findByIdWithDetails(clinicId: string) {
    return prisma.clinic.findUnique({
      where: { id: clinicId },
      include: {
        services: {
          orderBy: { name: 'asc' },
          include: {
            doctorServices: {
              include: {
                doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
              },
            },
          },
        },
        doctors: { include: { user: true } },
        whatsappAccounts: { where: { isActive: true }, take: 1 },
        aiConfig: true,
      },
    });
  }

  async findById(clinicId: string) {
    return prisma.clinic.findUnique({
      where: { id: clinicId },
      include: { aiConfig: true },
    });
  }

  async update(clinicId: string, data: UpdateClinicDTO) {
    return prisma.clinic.update({
      where: { id: clinicId },
      data,
    });
  }

  async upsertAiConfig(
    clinicId: string,
    data: {
      isAiEnabled?: boolean;
      systemPrompt?: string;
      customInstructions?: string;
      tone?: string;
      primaryModel?: string;
      humanHandoffKeywords?: string[];
      metadata?: Record<string, unknown>;
    }
  ) {
    const existing = await prisma.entityAiConfig.findUnique({ where: { clinicId } });
    const mergedMetadata = {
      ...((existing?.metadata as Record<string, unknown>) || {}),
      ...(data.metadata || {}),
    };

    return prisma.entityAiConfig.upsert({
      where: { clinicId },
      update: {
        ...(data.isAiEnabled !== undefined ? { isAiEnabled: data.isAiEnabled } : {}),
        ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
        ...(data.customInstructions !== undefined ? { customInstructions: data.customInstructions } : {}),
        ...(data.tone !== undefined ? { tone: data.tone } : {}),
        ...(data.primaryModel !== undefined ? { primaryModel: data.primaryModel } : {}),
        ...(data.humanHandoffKeywords !== undefined
          ? { humanHandoffKeywords: data.humanHandoffKeywords }
          : {}),
        ...(data.metadata !== undefined ? { metadata: mergedMetadata as any } : {}),
      },
      create: {
        clinicId,
        entityType: 'CLINIC',
        entityId: clinicId,
        isAiEnabled: data.isAiEnabled ?? true,
        systemPrompt: data.systemPrompt,
        customInstructions: data.customInstructions || '',
        tone: data.tone || 'professional',
        primaryModel: data.primaryModel || 'google/gemma-4-31b-it',
        humanHandoffKeywords: data.humanHandoffKeywords || [
          'human',
          'doctor',
          'receptionist',
          'speak to someone',
          'agent',
          'emergency',
        ],
        metadata: (data.metadata || {}) as any,
      },
    });
  }

  async createService(clinicId: string, data: CreateClinicServiceDTO) {
    return prisma.service.create({
      data: {
        clinicId,
        name: data.name,
        description: data.description,
        durationMinutes: data.durationMinutes ?? 30,
        price: data.price ?? 0,
        category: data.category ?? 'General',
      },
    });
  }

  async updateService(id: string, clinicId: string, data: any) {
    const allowed: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'durationMinutes', 'price', 'category', 'isActive']) {
      if (data[key] !== undefined) allowed[key] = data[key];
    }
    return prisma.service.updateMany({
      where: { id, clinicId },
      data: allowed,
    });
  }

  async findServiceById(id: string, clinicId: string) {
    return prisma.service.findFirst({
      where: { id, clinicId },
      include: {
        doctorServices: {
          include: {
            doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });
  }

  async findDoctorsInClinic(doctorIds: string[], clinicId: string) {
    if (!doctorIds.length) return [];
    return prisma.doctor.findMany({
      where: { clinicId, id: { in: doctorIds } },
      select: { id: true },
    });
  }

  async replaceServiceDoctors(params: {
    clinicId: string;
    serviceId: string;
    doctorIds: string[];
    price?: number;
    durationMinutes?: number;
  }) {
    await prisma.doctorService.deleteMany({
      where: { clinicId: params.clinicId, serviceId: params.serviceId },
    });
    if (!params.doctorIds.length) return;
    await prisma.doctorService.createMany({
      data: params.doctorIds.map((doctorId) => ({
        clinicId: params.clinicId,
        doctorId,
        serviceId: params.serviceId,
        customPrice: params.price ?? 0,
        customDurationMinutes: params.durationMinutes ?? 30,
        isActive: true,
      })),
      skipDuplicates: true,
    });
  }

  async findServiceByName(clinicId: string, name: string) {
    return prisma.service.findFirst({
      where: { clinicId, name },
    });
  }

  async deleteService(id: string, clinicId: string) {
    return prisma.service.deleteMany({
      where: { id, clinicId },
    });
  }
}

export const clinicRepository = new ClinicRepository();
