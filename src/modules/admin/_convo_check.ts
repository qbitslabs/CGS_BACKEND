import { prisma } from '../../config/db.js';
import { clinicMonthWindow } from '../../utils/timezone.js';

const TROUBLE = 'I am having trouble reaching the AI receptionist';

async function main() {
  const month = clinicMonthWindow();
  const conversations = await prisma.conversation.findMany({
    where: { participantPhone: { contains: '9352890191' } },
    select: {
      id: true,
      clinicId: true,
      state: true,
      lastMessageAt: true,
      clinic: { select: { name: true } },
    },
  });
  const clinicIds = [...new Set(conversations.map((row) => row.clinicId))];
  const subs = await prisma.cgsSubscription.findMany({
    where: { clinicId: { in: clinicIds } },
    orderBy: { createdAt: 'desc' },
    select: {
      clinicId: true,
      status: true,
      limitsApply: true,
      currentPeriodStart: true,
      plan: { select: { name: true, tier: true, aiRepliesMonthly: true } },
    },
  });
  const periods = await prisma.clinicAiReplyPeriod.findMany({
    where: { clinicId: { in: clinicIds } },
    select: { clinicId: true, periodStart: true, replyCount: true },
  });
  const messages = await prisma.message.findMany({
    where: { conversationId: { in: conversations.map((row) => row.id) } },
    orderBy: { createdAt: 'asc' },
    select: {
      conversationId: true,
      direction: true,
      senderType: true,
      isAiGenerated: true,
      status: true,
      content: true,
      createdAt: true,
    },
  });
  const jobs = await prisma.job.findMany({
    where: {
      clinicId: { in: clinicIds },
      createdAt: { gte: new Date('2026-11-05T19:40:00.000Z') },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, status: true, createdAt: true, attempts: true, lastError: true, lockedBy: true, payload: true },
  });
  const usage = await prisma.aiUsage.findMany({
    where: {
      conversationId: { in: conversations.map((row) => row.id) },
      createdAt: { gte: new Date('2026-11-05T19:40:00.000Z') },
    },
    select: { createdAt: true, success: true, model: true, totalTokens: true },
  });
  const clinicId = conversations[0]?.clinicId;
  const conversationId = conversations[0]?.id;
  if (clinicId && conversationId) {
    const cleared = await prisma.message.updateMany({
      where: { conversationId, isAiGenerated: true, content: { contains: TROUBLE } },
      data: { isAiGenerated: false },
    });
    const existing = await prisma.clinicAiReplyPeriod.findUnique({
      where: { clinicId_periodStart: { clinicId, periodStart: month.start } },
    });
    if (!existing) {
      await prisma.clinicAiReplyPeriod.create({
        data: { clinicId, periodStart: month.start, replyCount: 1 },
      });
    }
    const saved = await prisma.clinicAiReplyPeriod.findUnique({
      where: { clinicId_periodStart: { clinicId, periodStart: month.start } },
      select: { replyCount: true, periodStart: true },
    });
    console.log(JSON.stringify({ clearedTrouble: cleared.count, saved }));
  }
  console.log(JSON.stringify({
    jobs: jobs.map((row) => ({
      type: row.type,
      status: row.status,
      at: row.createdAt.toISOString(),
      attempts: row.attempts,
      lockedBy: row.lockedBy,
      error: row.lastError ? String(row.lastError).slice(0, 120) : null,
      conversationId: (row.payload as { conversationId?: string } | null)?.conversationId || null,
    })),
    usage: usage.map((row) => ({
      at: row.createdAt.toISOString(),
      success: row.success,
      model: row.model,
      tokens: row.totalTokens,
    })),
    recent: messages.filter((row) => row.createdAt >= new Date('2026-11-05T19:40:00.000Z')).map((row) => ({
      at: row.createdAt.toISOString(),
      senderType: row.senderType,
      isAiGenerated: row.isAiGenerated,
      trouble: Boolean(row.content?.includes(TROUBLE)),
      preview: (row.content || '').replace(/\s+/g, ' ').slice(0, 80),
    })),
    monthStart: month.start.toISOString(),
    conversations: conversations.map((row) => ({
      id: row.id,
      clinic: row.clinic.name,
      clinicId: row.clinicId,
      state: row.state,
      lastMessageAt: row.lastMessageAt,
    })),
    subs: subs.map((row) => ({
      clinicId: row.clinicId,
      status: row.status,
      limitsApply: row.limitsApply,
      periodStart: row.currentPeriodStart,
      plan: row.plan?.name,
      tier: row.plan?.tier,
      aiRepliesMonthly: row.plan?.aiRepliesMonthly,
    })),
    periods: periods.map((row) => ({
      clinicId: row.clinicId,
      periodStart: row.periodStart.toISOString(),
      replyCount: row.replyCount,
      matchesMonth: row.periodStart.getTime() === month.start.getTime(),
    })),
    messages: messages.map((row) => ({
      conversationId: row.conversationId,
      at: row.createdAt.toISOString(),
      direction: row.direction,
      senderType: row.senderType,
      isAiGenerated: row.isAiGenerated,
      status: row.status,
      trouble: Boolean(row.content?.includes(TROUBLE)),
      hasText: Boolean(row.content),
    })),
  }, null, 2));
  await prisma.$disconnect();
}

main();
