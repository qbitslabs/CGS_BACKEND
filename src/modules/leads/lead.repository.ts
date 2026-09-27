/* CGS leads module — Prisma queries.
 * Clinic API layer for leads; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { CreateLeadDTO, LeadListQuery, UpdateLeadDTO } from './lead.types.js';

export class LeadRepository {
  async count(query: LeadListQuery) {
    const where = this.buildWhere(query);
    return prisma.lead.count({ where });
  }

  async findMany(query: LeadListQuery) {
    const where = this.buildWhere(query);
    const page = query.page || 1;
    const limit = query.limit || 20;

    const sortMap: Record<string, string> = {
      name: 'name',
      createdDate: 'createdAt',
      createdAt: 'createdAt',
      score: 'score',
      lastActivity: 'updatedAt',
      updatedAt: 'updatedAt',
    };
    const sortField = sortMap[query.sortBy || ''] || 'createdAt';
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';

    return prisma.lead.findMany({
      where,
      include: {
        activities: { orderBy: { createdAt: 'desc' }, take: 10 },
        conversations: { take: 1, orderBy: { createdAt: 'desc' } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sortField]: sortOrder },
    });
  }

  async findById(id: string, clinicId: string) {
    return prisma.lead.findFirst({
      where: { id, clinicId },
      include: {
        activities: { orderBy: { createdAt: 'desc' } },
        conversations: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async delete(id: string, clinicId: string) {
    return prisma.lead.deleteMany({
      where: { id, clinicId },
    });
  }

  async createWithActivity(clinicId: string, data: CreateLeadDTO, actorName: string) {
    return prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          clinicId,
          name: data.name,
          phone: data.phone,
          email: data.email || null,
          source: data.source || 'WHATSAPP',
          interestedService: data.interestedService,
          preferredDoctor: data.preferredDoctor,
          howHeardAboutDoctor: data.howHeardAboutDoctor,
          intent: data.intent || 'MEDIUM',
          notes: data.notes,
          assignedToUserId: data.assignedToUserId,
        },
      });

      await tx.leadActivity.create({
        data: {
          leadId: created.id,
          type: 'created',
          title: 'Lead Captured',
          description: `Captured via ${data.source || 'WHATSAPP'}`,
          actor: actorName,
        },
      });

      return created;
    });
  }

  async convertToPatientInTx(params: {
    clinicId: string;
    leadId: string;
    leadName: string;
    leadPhone: string;
    leadEmail?: string | null;
    leadNotes?: string | null;
    actorName: string;
    hasConversations: boolean;
  }) {
    return prisma.$transaction(async (tx) => {
      let targetPatient = await tx.patient.findFirst({
        where: { clinicId: params.clinicId, phone: params.leadPhone },
      });

      if (!targetPatient) {
        targetPatient = await tx.patient.create({
          data: {
            clinicId: params.clinicId,
            name: params.leadName,
            phone: params.leadPhone,
            email: params.leadEmail,
            medicalHistoryNotes: params.leadNotes,
            leadId: params.leadId,
          },
        });
      } else {
        try {
          await tx.patient.update({
            where: { id: targetPatient.id },
            data: {
              leadId: params.leadId,
              medicalHistoryNotes: params.leadNotes
                ? `${targetPatient.medicalHistoryNotes || ''}\n${params.leadNotes}`.trim()
                : targetPatient.medicalHistoryNotes,
            },
          });
        } catch (err: any) {
          if (err?.code === 'P2002') {
            console.warn(
              `[LeadConvert] Patient ${targetPatient.id} already has a leadId; skipping unique lead link rather than crashing conversion.`
            );
          } else {
            throw err;
          }
        }
      }

      await tx.lead.update({
        where: { id: params.leadId },
        data: {
          status: 'CONVERTED',
          convertedPatientId: targetPatient.id,
        },
      });

      await tx.patientActivity.create({
        data: {
          patientId: targetPatient.id,
          type: 'profile_update',
          title: 'Converted from Lead',
          description: `Patient linked from prospective lead #${params.leadId.slice(0, 8)}`,
          actor: params.actorName,
        },
      });

      if (params.hasConversations) {
        await tx.conversation.updateMany({
          where: { leadId: params.leadId },
          data: { patientId: targetPatient.id },
        });
      }

      return targetPatient;
    });
  }

  async update(id: string, data: UpdateLeadDTO) {
    const updateData: any = {};
    if (data.status) updateData.status = (data.status as string).toUpperCase().replace(/[\s-]+/g, '_');
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.score !== undefined) updateData.score = data.score;
    if (data.intent) updateData.intent = data.intent;
    if (data.assignedToUserId !== undefined) updateData.assignedToUserId = data.assignedToUserId;

    return prisma.lead.update({
      where: { id },
      data: updateData,
    });
  }

  private buildWhere(query: LeadListQuery) {
    const where: any = { clinicId: query.clinicId };
    if (query.status && query.status !== 'All') {
      const normalize = (s: string) => s.trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (query.status.includes(',')) {
        where.status = { in: query.status.split(',').map(normalize) };
      } else {
        const status = normalize(query.status);
        where.status = status === 'BOOKED' ? { in: ['BOOKED', 'CONVERTED'] } : status;
      }
    }
    if (query.source && query.source !== 'All') {
      where.source = query.source.toUpperCase().replace(/[\s-]+/g, '_');
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.doctorId) {
      const doctorParts: Record<string, unknown>[] = [
        { conversations: { some: { doctorId: query.doctorId } } },
      ];
      if (query.assignedToUserId) doctorParts.push({ assignedToUserId: query.assignedToUserId });
      if (query.preferredDoctor) {
        doctorParts.push({ preferredDoctor: { contains: query.preferredDoctor, mode: 'insensitive' } });
      }
      where.AND = [...(where.AND || []), { OR: doctorParts }];
    }
    return where;
  }
}

export const leadRepository = new LeadRepository();
