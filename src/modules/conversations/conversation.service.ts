/* CGS conversations module — business logic.
 * Clinic API layer for conversations; talks Prisma or callers, not the AI database. */
import { conversationRepository, ConversationRepository } from './conversation.repository.js';
import {
  ConversationListQuery,
  ConversationResponseDTO,
  MessageResponseDTO,
  SendStaffMessageDTO,
  UpdateConversationDTO,
} from './conversation.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { aiClient } from '../ai/ai.client.js';
import { prisma } from '../../config/db.js';
import { randomUUID } from 'crypto';

// Two WhatsApp bubbles in a short burst → one AI reply (join texts).
const AI_REPLY_DEBOUNCE_MS = 1600;

type PendingAi = {
  clinicId: string;
  texts: string[];
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
};

const pendingAiReplies = new Map<string, PendingAi>();

function joinInboundBurst(texts: string[]): string {
  const out: string[] = [];
  for (const raw of texts) {
    const t = (raw || '').trim();
    if (!t) continue;
    const prev = out[out.length - 1];
    if (prev && prev.toLowerCase() === t.toLowerCase()) continue;
    out.push(t);
  }
  return out.join('\n');
}

const DEFAULT_BOOKING_KEYWORDS = [
  'book',
  'booking',
  'appointment',
  'slot',
  'available',
  'availability',
  'consult',
  'timing',
  'schedule',
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectHandoffIntent(
  text: string,
  specialtyKeywords: string[] = []
): { severity: 'normal' | 'critical'; reason: string } | null {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return null;

  const bookingWords = [...DEFAULT_BOOKING_KEYWORDS, ...specialtyKeywords]
    .map((w) => w.trim())
    .filter(Boolean);
  const bookingRe = new RegExp(`\\b(${bookingWords.map(escapeRegex).join('|')})\\b`, 'i');

  // Booking / doctor preference is NOT a handoff. Specialty terms come from clinic AI config.
  const bookingContext = bookingRe.test(t) || /अपॉइंटमेंट|बुकिंग|स्लॉट|समय/.test(t);

  const criticalPatterns = [
    /\bemergency\b/,
    /\bcritical\b/,
    /\bchest pain\b/,
    /\bbleeding heavily\b/,
    /\bunconscious\b/,
    /\bsuicide\b/,
    /\bcan't breathe\b/,
    /\bcannot breathe\b/,
    /\bheart attack\b/,
    /\bstroke\b/,
    /\bambulance\b/,
    /\bईमरजेंसी\b/,
    /\bइमरजेंसी\b/,
    /बहुत दर्द/,
    /खून बह/,
    /सांस नहीं/,
  ];
  if (criticalPatterns.some((p) => p.test(t))) {
    return { severity: 'critical', reason: `Patient message indicates critical/emergency: "${text.slice(0, 180)}"` };
  }

  // Explicit live-person request only — not "I want Dr. X appointment".
  const handoffPatterns = [
    /\b(talk|speak|connect|transfer).{0,20}\b(human|receptionist|agent|staff|person)\b/,
    /\b(human|real)\s+(please|agent|receptionist|staff|person)\b/,
    /\breceptionist\b/,
    /\bcustomer\s*care\b/,
    /\bhandoff\b/,
    /इंसान से बात/,
    /रिसेप्शनिस्ट/,
    /कोई इंसान/,
    /स्टाफ से बात/,
  ];
  if (!bookingContext && handoffPatterns.some((p) => p.test(t))) {
    return { severity: 'normal', reason: `Patient requested human assistance: "${text.slice(0, 180)}"` };
  }

  // Even in booking context, clear "human/receptionist" still escalates.
  if (
    /\b(human receptionist|talk to (a )?human|speak to (a )?human|real person)\b/.test(t) ||
    /इंसान से बात|रिसेप्शनिस्ट/.test(t)
  ) {
    return { severity: 'normal', reason: `Patient explicitly requested human staff: "${text.slice(0, 180)}"` };
  }

  return null;
}

export class ConversationService {
  constructor(private readonly repo: ConversationRepository = conversationRepository) {}

  mapConversation(c: any): ConversationResponseDTO {
    const handoffReason = c.handoffReason || undefined;
    const isHandoff = c.state === 'HANDOFF_PENDING';
    const isCritical =
      Boolean(handoffReason) &&
      (/^CRITICAL\s*:/i.test(handoffReason!) ||
        /\b(emergency|critical|bleeding|unconscious|chest pain|suicide)\b/i.test(handoffReason!));

    return {
      id: c.id,
      patientId: c.patientId,
      leadId: c.leadId,
      doctorId: c.doctorId || undefined,
      doctorName: c.doctor ? `Dr. ${c.doctor.user.firstName} ${c.doctor.user.lastName || ''}`.trim() : undefined,
      participantName: c.participantName,
      participantPhone: c.participantPhone,
      state:
        c.state === 'AI_ACTIVE'
          ? 'AI Active'
          : c.state === 'HUMAN_ACTIVE'
          ? 'Human Active'
          : c.state === 'HANDOFF_PENDING'
          ? 'Handoff Pending'
          : 'Closed',
      lastMessage: c.lastMessageText || '',
      lastMessageTime: c.lastMessageAt ? c.lastMessageAt.toISOString() : c.createdAt.toISOString(),
      unreadCount: c.unreadCount,
      assignedTo: c.assignedToUserId || undefined,
      serviceInterested: c.serviceInterested || undefined,
      handoffReason,
      isCritical: isHandoff && isCritical,
      needsHumanHandoff: isHandoff,
      internalNotes: c.internalNotes || undefined,
    };
  }

  async getSidebarBadge(clinicId: string, doctorId?: string) {
    const rows = await this.repo.findUnreadForBadge(clinicId, doctorId);
    let critical = 0;
    let handoff = 0;
    for (const row of rows) {
      const mapped = this.mapConversation(row);
      if (mapped.isCritical) critical += 1;
      else if (mapped.needsHumanHandoff) handoff += 1;
    }
    const tone = critical > 0 ? 'critical' : handoff > 0 ? 'handoff' : 'normal';
    return { count: rows.length, tone };
  }

  async listConversations(query: ConversationListQuery): Promise<ConversationResponseDTO[]> {
    const conversations = await this.repo.findMany(query);
    return conversations.map((c) => this.mapConversation(c));
  }

  async getConversationById(id: string, clinicId: string) {
    const conversation = await this.repo.findById(id, clinicId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'NOT_FOUND');
    }
    return this.mapConversation(conversation);
  }

  async markAsRead(id: string, clinicId: string) {
    const conversation = await this.repo.findById(id, clinicId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'NOT_FOUND');
    }
    await this.repo.resetUnreadCount(id, clinicId);
  }

  async getMessages(
    conversationId: string,
    clinicId: string,
    page: number,
    limit: number
  ): Promise<MessageResponseDTO[]> {
    const messages = await this.repo.findMessages(conversationId, clinicId, page, limit);

    // Mark unread as 0 when conversation is opened
    await this.repo.resetUnreadCount(conversationId, clinicId);

    return messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      sender: m.senderType === 'PATIENT' ? 'patient' : m.senderType === 'AI' ? 'ai' : 'human',
      senderName: m.senderName,
      text: m.content || '',
      timestamp: m.createdAt.toISOString(),
      status: m.status.toLowerCase(),
      isAiGenerated: m.isAiGenerated,
    }));
  }

  async sendStaffMessage(dto: SendStaffMessageDTO) {
    const conversation = await this.repo.findById(dto.conversationId, dto.clinicId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'NOT_FOUND');
    }

    const message = await this.repo.sendStaffMessageInTx({
      clinicId: dto.clinicId,
      conversationId: dto.conversationId,
      senderName: dto.senderName,
      content: dto.content,
      mediaUrl: dto.mediaUrl,
      recipientPhone: conversation.participantPhone,
    });

    return {
      id: message.id,
      conversationId: message.conversationId,
      sender: 'human' as const,
      senderName: message.senderName,
      text: message.content,
      timestamp: message.createdAt.toISOString(),
      status: 'sent',
    };
  }

  async updateConversation(
    id: string,
    clinicId: string,
    data: UpdateConversationDTO,
    auditContext: {
      userId?: string;
      email?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const conversation = await this.repo.findById(id, clinicId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'NOT_FOUND');
    }

    const updated = await this.repo.updateConversation(id, clinicId, data);

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'CONVERSATION_STATE_CHANGED',
      resourceType: 'CONVERSATION',
      resourceId: id,
      metadata: { state: data.state, doctorId: data.doctorId },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return this.mapConversation(updated);
  }

  mapMessage(m: any): MessageResponseDTO {
    return {
      id: m.id,
      conversationId: m.conversationId,
      sender: m.senderType === 'PATIENT' ? 'patient' : m.senderType === 'AI' ? 'ai' : 'human',
      senderName: m.senderName,
      text: m.content || '',
      timestamp: m.createdAt.toISOString(),
      status: (m.status || 'SENT').toLowerCase(),
      isAiGenerated: !!m.isAiGenerated,
    };
  }

  // Queue inbound text; flush once after a short quiet period so double-sends get one reply.
  scheduleGenerateReply(clinicId: string, conversationId: string, userText: string) {
    let slot = pendingAiReplies.get(conversationId);
    if (!slot) {
      slot = { clinicId, texts: [], running: false };
      pendingAiReplies.set(conversationId, slot);
    }
    slot.clinicId = clinicId;
    slot.texts.push(userText);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      void this.flushPendingAiReply(conversationId);
    }, AI_REPLY_DEBOUNCE_MS);
  }

  private async flushPendingAiReply(conversationId: string) {
    const slot = pendingAiReplies.get(conversationId);
    if (!slot || slot.running) return;
    if (!slot.texts.length) {
      pendingAiReplies.delete(conversationId);
      return;
    }
    slot.running = true;
    const combined = joinInboundBurst(slot.texts.splice(0));
    try {
      if (combined) {
        await this.generateAndPersistReply(slot.clinicId, conversationId, combined);
      }
    } catch (err: any) {
      console.error('[AI Receptionist] debounced generate failed:', err?.message || err);
    } finally {
      slot.running = false;
      if (slot.texts.length) {
        slot.timer = setTimeout(() => {
          void this.flushPendingAiReply(conversationId);
        }, 400);
      } else {
        pendingAiReplies.delete(conversationId);
      }
    }
  }

  async generateAndPersistReply(clinicId: string, conversationId: string, userText: string) {
    const conversation = await this.repo.findById(conversationId, clinicId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'NOT_FOUND');
    }
    if (conversation.state !== 'AI_ACTIVE') {
      return null;
    }

    const aiConfig = await prisma.entityAiConfig.findFirst({
      where: { clinicId },
      select: { metadata: true },
    });
    const specialtyKeywords = Array.isArray((aiConfig?.metadata as any)?.specialtyKeywords)
      ? ((aiConfig?.metadata as any).specialtyKeywords as string[])
      : [];

    // Keyword fast-path: escalate before/without waiting for the LLM tool call.
    const handoff = detectHandoffIntent(userText, specialtyKeywords);
    if (handoff) {
      await this.repo.escalateHandoff({
        clinicId,
        conversationId,
        reason: handoff.reason,
        severity: handoff.severity,
      });

      const replyText =
        handoff.severity === 'critical'
          ? `Samajh gaya — yeh urgent lag raha hai. Main abhi clinic staff ko alert kar rahi hoon. Emergency me 112/ambulance bhi consider karein. Staff jaldi join karega.`
          : `Theek hai, main aapko human staff se connect kar rahi hoon. Koi coordinator jaldi reply karega.`;

      const message = await this.repo.persistAiOutboundMessage({
        clinicId,
        conversationId,
        content: replyText,
        recipientPhone: conversation.participantPhone,
      });

      return {
        message: this.mapMessage(message),
        toolCalls: [{ tool_name: 'keyword_handoff', arguments: handoff, result: { ok: true } }],
      };
    }

    let replyText =
      'I am having trouble reaching the AI receptionist right now. A coordinator will follow up shortly.';
    let raw: any = null;

    try {
      raw = await aiClient.generate({
        entity_id: clinicId,
        entity_type: 'CLINIC',
        participant_id: conversation.participantPhone,
        message: userText,
        channel: 'WHATSAPP',
        doctor_id: conversation.doctorId || undefined,
        conversation_id: conversation.id,
        metadata: {
          conversationId: conversation.id,
          clinicId,
          doctorId: conversation.doctorId,
          participantName: conversation.lead?.name || conversation.participantName,
          serviceInterested: conversation.serviceInterested || conversation.lead?.interestedService,
          preferredDoctor:
            conversation.lead?.preferredDoctor ||
            (conversation.doctor
              ? `${conversation.doctor.user?.firstName || ''} ${conversation.doctor.user?.lastName || ''}`.trim()
              : undefined),
          howHeardAboutDoctor: conversation.lead?.howHeardAboutDoctor,
          leadNotes: conversation.lead?.notes || conversation.internalNotes,
          landingContext: conversation.internalNotes,
        },
      });
      replyText = raw?.response || raw?.data?.response || replyText;

      // Record usage from generate response (do not rely only on AI→CGS reverse POST)
      const usage = raw?.usage || raw?.data?.usage;
      if (usage) {
        try {
          const requestId = raw?.request_id || raw?.data?.request_id || `cgs_${randomUUID()}`;
          const existing = await prisma.aiUsage.findFirst({
            where: { requestId },
            select: { id: true },
          });
          if (!existing) {
            const inputTokens = Number(usage.prompt_tokens || usage.inputTokens || 0);
            const outputTokens = Number(usage.completion_tokens || usage.outputTokens || 0);
            const totalTokens = Number(
              usage.total_tokens || usage.totalTokens || inputTokens + outputTokens
            );
            const totalCost = Number(usage.estimated_cost || usage.totalCost || 0);
            await prisma.aiUsage.create({
              data: {
                clinicId,
                doctorId: conversation.doctorId || undefined,
                conversationId,
                requestId,
                entityType: 'CLINIC',
                entityId: clinicId,
                operationType: 'CONVERSATION_RESPONSE',
                provider: 'openrouter',
                model: raw?.model || raw?.data?.model || 'unknown',
                inputTokens,
                outputTokens,
                totalTokens,
                inputCost: totalCost * 0.5,
                outputCost: totalCost * 0.5,
                totalCost,
                currency: 'INR',
                durationMs: Number(raw?.duration_ms || raw?.data?.duration_ms || 0) || 0,
                success: true,
              },
            });
          }
        } catch (usageErr: any) {
          console.warn('[AI Receptionist] usage record failed:', usageErr?.message || usageErr);
        }
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      console.error(
        '[AI Receptionist] generate failed:',
        msg,
        '| conversation=',
        conversationId,
        '| phone=',
        conversation.participantPhone,
        '| status=',
        err?.statusCode || err?.status || 'n/a'
      );
      if (msg.includes('402') || msg.toLowerCase().includes('credits')) {
        replyText =
          'AI service credits are temporarily exhausted. A clinic coordinator will follow up with you shortly.';
      }
    }

    // If AI tool requested handoff during generation, state may already be HANDOFF_PENDING.
    const message = await this.repo.persistAiOutboundMessage({
      clinicId,
      conversationId,
      content: replyText,
      recipientPhone: conversation.participantPhone,
    });

    return {
      message: this.mapMessage(message),
      toolCalls: raw?.tool_calls || raw?.data?.tool_calls || [],
    };
  }

  async simulatePatientMessage(clinicId: string, conversationId: string, content: string) {
    const conversation = await this.repo.findById(conversationId, clinicId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'NOT_FOUND');
    }

    const patientMessage = await this.repo.persistPatientInbound({
      clinicId,
      conversationId,
      senderName: conversation.participantName,
      content,
      providerMessageId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });

    const ai = conversation.state === 'AI_ACTIVE'
      ? await this.generateAndPersistReply(clinicId, conversationId, content)
      : null;

    return {
      patientMessage: this.mapMessage(patientMessage),
      aiMessage: ai?.message || null,
      toolCalls: ai?.toolCalls || [],
    };
  }
}

export const conversationService = new ConversationService();
