import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db.js', () => ({
  prisma: {
    job: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../../config/db.js';
import { ConversationRepository } from './conversation.repository.js';

describe('enqueueAiReply', () => {
  const repo = new ConversationRepository();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending AI reply job', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.job.create).mockResolvedValue({ id: 'job-1' } as any);

    await repo.enqueueAiReply({
      clinicId: 'clinic-1',
      conversationId: 'conv-1',
      userText: 'hello',
    });

    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clinicId: 'clinic-1',
          queue: 'AI',
          type: 'AI_GENERATE_REPLY',
          maxAttempts: 3,
          payload: {
            clinicId: 'clinic-1',
            conversationId: 'conv-1',
            userText: 'hello',
          },
        }),
      })
    );
  });

  it('folds a later message into the pending job for that conversation', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      payload: { userText: 'hello' },
    } as any);
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 });

    await repo.enqueueAiReply({
      clinicId: 'clinic-1',
      conversationId: 'conv-1',
      userText: 'need a slot',
    });

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PENDING' },
      data: {
        payload: {
          clinicId: 'clinic-1',
          conversationId: 'conv-1',
          userText: 'hello\nneed a slot',
        },
      },
    });
    expect(prisma.job.create).not.toHaveBeenCalled();
  });
});
