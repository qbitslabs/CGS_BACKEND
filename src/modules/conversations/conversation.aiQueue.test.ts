import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db.js', () => ({
  prisma: {
    entityAiConfig: { findFirst: vi.fn(async () => null) },
    whatsappAccount: { findFirst: vi.fn(async () => null) },
    message: { update: vi.fn() },
    job: { create: vi.fn(async () => ({ id: 'wa-retry' })) },
  },
}));

vi.mock('../ai/ai.client.js', () => ({
  aiClient: {
    generate: vi.fn(),
  },
}));

vi.mock('../../middleware/audit.js', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}));

vi.mock('../admin/entitlements.js', () => ({
  loadEntitlement: vi.fn(async () => ({
    enforced: false,
    modelLevel: 'NORMAL',
    conversationMemory: 'FULL',
  })),
  claimConversationWindow: vi.fn(async () => ({ counted: false, periodStart: null })),
  releaseAiReply: vi.fn(async () => undefined),
}));

import { aiClient } from '../ai/ai.client.js';
import { claimConversationWindow, loadEntitlement, releaseAiReply } from '../admin/entitlements.js';
import { AppError } from '../../middleware/errorHandler.js';
import { ConversationService } from './conversation.service.js';

const conversation = {
  id: 'conv-1',
  state: 'AI_ACTIVE',
  participantPhone: '919800000000',
  participantName: 'Ana',
  doctorId: null,
  doctor: null,
  lead: null,
  serviceInterested: null,
  internalNotes: null,
};

function storedMessage(content: string) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderType: 'AI',
    senderName: 'CGS AI Receptionist',
    content,
    createdAt: new Date('2026-10-06T00:00:00Z'),
    status: 'SENT',
    isAiGenerated: true,
  };
}

describe('AI reply queue', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('joins a short burst into one queued reply', async () => {
    vi.useFakeTimers();
    const enqueueAiReply = vi.fn(async () => ({ id: 'job-1' }));
    const service = new ConversationService({ enqueueAiReply } as any);

    service.scheduleGenerateReply('clinic-1', 'conv-1', 'hello');
    service.scheduleGenerateReply('clinic-1', 'conv-1', 'hello');
    service.scheduleGenerateReply('clinic-1', 'conv-1', 'need a slot');
    await vi.advanceTimersByTimeAsync(400);

    expect(enqueueAiReply).toHaveBeenCalledTimes(1);
    expect(enqueueAiReply).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      conversationId: 'conv-1',
      userText: 'hello\nneed a slot',
    });
  });

  it('keeps the patient message queued when the AI call fails before the last try', async () => {
    vi.mocked(aiClient.generate).mockRejectedValue(new Error('upstream timeout'));
    const persistAiOutboundMessage = vi.fn();
    const service = new ConversationService({
      findById: vi.fn(async () => conversation),
      persistAiOutboundMessage,
    } as any);

    await expect(
      service.generateAndPersistReply('clinic-1', 'conv-1', 'hello', { fallbackOnError: false })
    ).rejects.toThrow(/upstream timeout/);
    expect(persistAiOutboundMessage).not.toHaveBeenCalled();
  });

  it('sends the trouble message only when fallback is allowed', async () => {
    vi.mocked(aiClient.generate).mockRejectedValue(new Error('upstream timeout'));
    const persistAiOutboundMessage = vi.fn(async (params: { content: string }) => storedMessage(params.content));
    const service = new ConversationService({
      findById: vi.fn(async () => conversation),
      persistAiOutboundMessage,
    } as any);

    await service.generateAndPersistReply('clinic-1', 'conv-1', 'hello');

    expect(persistAiOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('trouble reaching the AI receptionist'),
      })
    );
  });

  it('sends a handoff and skips the model when the reply cap is reached', async () => {
    vi.mocked(loadEntitlement).mockResolvedValue({
      enforced: true,
      modelLevel: 'NORMAL',
      conversationMemory: 'NONE',
    } as never);
    vi.mocked(claimConversationWindow).mockRejectedValue(new AppError('cap', 403, 'AI_REPLY_LIMIT'));
    const persistAiOutboundMessage = vi.fn(async (params: { content: string }) => storedMessage(params.content));
    const service = new ConversationService({
      findById: vi.fn(async () => conversation),
      persistAiOutboundMessage,
    } as any);

    await service.generateAndPersistReply('clinic-1', 'conv-1', 'book tomorrow');

    expect(aiClient.generate).not.toHaveBeenCalled();
    expect(persistAiOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('conversations are used up'),
      })
    );
  });

  it('does not count the trouble reply when the model call fails', async () => {
    const periodStart = new Date('2026-11-01T00:00:00.000Z');
    vi.mocked(loadEntitlement).mockResolvedValue({
      enforced: true,
      modelLevel: 'HIGH_END',
      conversationMemory: 'FULL',
    } as never);
    vi.mocked(claimConversationWindow).mockResolvedValue({ counted: true, periodStart });
    vi.mocked(aiClient.generate).mockRejectedValue(new Error('upstream timeout'));
    const persistAiOutboundMessage = vi.fn(async (params: { content: string }) => storedMessage(params.content));
    const service = new ConversationService({
      findById: vi.fn(async () => conversation),
      persistAiOutboundMessage,
    } as any);

    await service.generateAndPersistReply('clinic-1', 'conv-1', 'hello');

    expect(aiClient.generate).toHaveBeenCalledWith(expect.objectContaining({
      model_level: 'HIGH_END',
      memory: 'FULL',
    }));
    expect(persistAiOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ isAiGenerated: false }));
    expect(releaseAiReply).toHaveBeenCalledWith('clinic-1', periodStart);
  });

  it('gives the conversation back when the model fails before any reply is sent', async () => {
    const periodStart = new Date('2026-11-01T00:00:00.000Z');
    vi.mocked(loadEntitlement).mockResolvedValue({
      enforced: true,
      modelLevel: 'NORMAL',
      conversationMemory: 'NONE',
    } as never);
    vi.mocked(claimConversationWindow).mockResolvedValue({ counted: true, periodStart });
    vi.mocked(aiClient.generate).mockRejectedValue(new Error('upstream timeout'));
    const service = new ConversationService({
      findById: vi.fn(async () => conversation),
      persistAiOutboundMessage: vi.fn(),
    } as any);

    await expect(
      service.generateAndPersistReply('clinic-1', 'conv-1', 'hello', { fallbackOnError: false })
    ).rejects.toThrow(/upstream timeout/);
    expect(releaseAiReply).toHaveBeenCalledWith('clinic-1', periodStart);
  });
});
