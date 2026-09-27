/* CGS conversations module — Prisma queries.
 * Clinic API layer for conversations; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { ConversationListQuery, UpdateConversationDTO } from './conversation.types.js';

export class ConversationRepository {
  async findUnreadForBadge(clinicId: string, doctorId?: string) {
    return prisma.conversation.findMany({
      where: {
        clinicId,
        unreadCount: { gt: 0 },
        ...(doctorId
          ? {
              OR: [
                { doctorId },
                { patient: { appointments: { some: { doctorId } } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        state: true,
        handoffReason: true,
        unreadCount: true,
        participantName: true,
        participantPhone: true,
        lastMessageText: true,
        lastMessageAt: true,
        createdAt: true,
        patientId: true,
        leadId: true,
        doctorId: true,
        assignedToUserId: true,
        serviceInterested: true,
        internalNotes: true,
      },
    });
  }

  async findMany(query: ConversationListQuery) {
    const where: any = { clinicId: query.clinicId };

    if (query.state && query.state !== 'All') {
      where.state = query.state.toUpperCase().replace(/[\s-]+/g, '_');
    }
    if (query.doctorId) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { doctorId: query.doctorId },
            { patient: { appointments: { some: { doctorId: query.doctorId } } } },
          ],
        },
      ];
    }
    if (query.search) {
      where.OR = [
        { participantName: { contains: query.search, mode: 'insensitive' } },
        { participantPhone: { contains: query.search } },
        { lastMessageText: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return prisma.conversation.findMany({
      where,
      include: {
        patient: true,
        lead: true,
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async findById(id: string, clinicId: string) {
    return prisma.conversation.findFirst({
      where: { id, clinicId },
      include: {
        patient: true,
        lead: true,
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        summary: true,
        summaryVersions: { orderBy: { version: 'desc' }, take: 5 },
      },
    });
  }

  async findMessages(conversationId: string, clinicId: string, page: number, limit: number) {
    return prisma.message.findMany({
      where: { conversationId, clinicId },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
  }

  async resetUnreadCount(conversationId: string, clinicId: string) {
    return prisma.conversation.updateMany({
      where: { id: conversationId, clinicId },
      data: { unreadCount: 0 },
    });
  }

  async sendStaffMessageInTx(params: {
    clinicId: string;
    conversationId: string;
    senderName: string;
    content: string;
    mediaUrl?: string;
    recipientPhone: string;
    document?: { filename: string; mimeType: string; base64: string };
  }) {
    return prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          clinicId: params.clinicId,
          conversationId: params.conversationId,
          direction: 'OUTBOUND',
          senderType: 'USER',
          senderName: params.senderName,
          content: params.content,
          mediaUrl: params.mediaUrl,
          status: 'SENT',
        },
      });

      await tx.conversation.update({
        where: { id: params.conversationId },
        data: {
          lastMessageText: params.content,
          lastMessageAt: new Date(),
          state: 'HUMAN_ACTIVE',
        },
      });

      await tx.job.create({
        data: {
          clinicId: params.clinicId,
          queue: 'WHATSAPP',
          type: 'WHATSAPP_SEND',
          payload: {
            messageId: message.id,
            conversationId: params.conversationId,
            recipientPhone: params.recipientPhone,
            content: params.content,
            ...(params.document ? { document: params.document } : {}),
          },
        },
      });

      return message;
    });
  }

  async persistPatientInbound(params: {
    clinicId: string;
    conversationId: string;
    senderName: string;
    content: string;
    providerMessageId?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          clinicId: params.clinicId,
          conversationId: params.conversationId,
          direction: 'INBOUND',
          senderType: 'PATIENT',
          senderName: params.senderName,
          content: params.content,
          providerMessageId: params.providerMessageId,
          status: 'DELIVERED',
        },
      });

      await tx.conversation.update({
        where: { id: params.conversationId },
        data: {
          lastMessageText: params.content,
          lastMessageAt: new Date(),
          lastActivityAt: new Date(),
          unreadCount: { increment: 1 },
        },
      });

      return message;
    });
  }

  async persistAiOutboundMessage(params: {
    clinicId: string;
    conversationId: string;
    content: string;
    recipientPhone?: string;
  }) {
    return prisma.$transaction(
      async (tx) => {
        const message = await tx.message.create({
          data: {
            clinicId: params.clinicId,
            conversationId: params.conversationId,
            direction: 'OUTBOUND',
            senderType: 'AI',
            senderName: 'CGS AI Receptionist',
            content: params.content,
            status: 'SENT',
            isAiGenerated: true,
          },
        });

        await tx.conversation.update({
          where: { id: params.conversationId },
          data: {
            lastMessageText: params.content,
            lastMessageAt: new Date(),
            lastActivityAt: new Date(),
          },
        });

        if (params.recipientPhone) {
          await tx.job.create({
            data: {
              clinicId: params.clinicId,
              queue: 'WHATSAPP',
              type: 'WHATSAPP_SEND',
              payload: {
                messageId: message.id,
                conversationId: params.conversationId,
                recipientPhone: params.recipientPhone,
                content: params.content,
              },
            },
          });
        }

        return message;
      },
      { maxWait: 10_000, timeout: 15_000 }
    );
  }

  async updateConversation(id: string, clinicId: string, data: UpdateConversationDTO) {
    return prisma.conversation.update({
      where: { id },
      data,
      include: {
        patient: true,
        lead: true,
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
  }

  async escalateHandoff(params: {
    clinicId: string;
    conversationId: string;
    reason: string;
    severity: 'normal' | 'critical';
  }) {
    const reasonPrefix = params.severity === 'critical' ? 'CRITICAL: ' : '';
    const handoffReason = `${reasonPrefix}${params.reason}`.slice(0, 500);

    const updated = await prisma.conversation.update({
      where: { id: params.conversationId },
      data: {
        state: 'HANDOFF_PENDING',
        handoffReason,
        lastActivityAt: new Date(),
        unreadCount: { increment: 1 },
      },
      include: {
        patient: true,
        lead: true,
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    await prisma.notification.create({
      data: {
        clinicId: params.clinicId,
        type: 'HUMAN_HANDOFF',
        title:
          params.severity === 'critical'
            ? `Critical Situation: ${updated.participantName}`
            : `Human Handoff Required: ${updated.participantName}`,
        message: handoffReason,
        link: `/conversations`,
        entityId: updated.id,
      },
    });

    return updated;
  }
}

export const conversationRepository = new ConversationRepository();
