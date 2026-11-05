import { describe, expect, it } from 'vitest';
import { AI_REPLY_PACK, BROCHURE_PLANS } from './planCatalog.js';
import {
  assertCanAddDoctor,
  assertCanAddStaff,
  assertCanAddWhatsappNumber,
  automationAllowed,
  clinicPackageUsage,
  outboundAllowed,
  releaseAiReply,
  reserveAiReply,
  type ClinicAddonSnapshot,
  type PlanSnapshot,
  type SubscriptionSnapshot,
} from './entitlements.js';

const periodStart = new Date('2026-11-01T00:00:00.000Z');
const periodEnd = new Date('2026-12-01T00:00:00.000Z');
const nextPeriodStart = new Date('2026-12-01T00:00:00.000Z');
const nextPeriodEnd = new Date('2027-01-01T00:00:00.000Z');

type Tier = 'STARTER' | 'GROWTH' | 'ENTERPRISE';

type ClinicFixture = {
  subscription: SubscriptionSnapshot | null;
  addons: ClinicAddonSnapshot[];
  doctors: number;
  staff: number;
  whatsapp: number;
  whatsappMessages: number;
  replyCount: number;
};

function brochure(tier: Tier) {
  const plan = BROCHURE_PLANS.find((item) => item.tier === tier);
  if (!plan) throw new Error(`Missing brochure plan ${tier}`);
  return plan;
}

function subscriptionFor(tier: Tier, period = { start: periodStart, end: periodEnd }): SubscriptionSnapshot {
  const plan = brochure(tier);
  const snapshot: PlanSnapshot = {
    name: plan.name,
    tier: plan.tier,
    doctorsIncluded: plan.doctorsIncluded,
    staffIncluded: plan.staffIncluded,
    whatsappNumbersIncluded: plan.whatsappNumbersIncluded,
    aiRepliesMonthly: plan.aiRepliesMonthly,
    modelLevel: plan.modelLevel,
    conversationMemory: plan.conversationMemory,
    reportingLevel: plan.reportingLevel,
    customAiIncluded: plan.customAiIncluded,
    outboundIncluded: plan.outboundIncluded,
    prioritySupportIncluded: plan.prioritySupportIncluded,
    automationKeys: [...plan.automationKeys],
  };
  return {
    status: 'ACTIVE',
    limitsApply: true,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    plan: snapshot,
  };
}

function clinic(tier: Tier, overrides: Partial<ClinicFixture> = {}): ClinicFixture {
  return {
    subscription: subscriptionFor(tier),
    addons: [],
    doctors: 0,
    staff: 0,
    whatsapp: 0,
    whatsappMessages: 0,
    replyCount: 0,
    ...overrides,
  };
}

function world(clinics: Record<string, ClinicFixture>) {
  const queries: Array<{ where: Record<string, unknown> }> = [];
  let held = false;
  const waiters: Array<() => void> = [];

  const acquire = () => {
    if (!held) {
      held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  };

  const releaseLock = () => {
    const next = waiters.shift();
    if (next) next();
    else held = false;
  };

  const requireClinic = (id: string) => {
    const row = clinics[id];
    if (!row) throw new Error(`Query used an unknown clinic: ${id}`);
    return row;
  };

  const db = {
    queries,
    cgsSubscription: {
      findMany: async (args: { where: { clinicId: string } }) => {
        queries.push({ where: args.where });
        const row = requireClinic(args.where.clinicId);
        return row.subscription ? [{ ...row.subscription, clinicId: args.where.clinicId }] : [];
      },
    },
    clinicAddon: {
      findMany: async (args: { where: { clinicId: string; status?: string } }) => {
        queries.push({ where: args.where });
        return requireClinic(args.where.clinicId).addons.filter(
          (addon) => !args.where.status || addon.status === args.where.status,
        );
      },
    },
    doctor: {
      count: async (args: { where: { clinicId: string } }) => {
        queries.push({ where: args.where });
        return requireClinic(args.where.clinicId).doctors;
      },
    },
    user: {
      count: async (args: { where: { clinicId: string } }) => {
        queries.push({ where: args.where });
        return requireClinic(args.where.clinicId).staff;
      },
    },
    whatsappAccount: {
      count: async (args: { where: { clinicId: string } }) => {
        queries.push({ where: args.where });
        return requireClinic(args.where.clinicId).whatsapp;
      },
    },
    message: {
      count: async (args: { where: { clinicId: string } }) => {
        queries.push({ where: args.where });
        return requireClinic(args.where.clinicId).whatsappMessages;
      },
    },
    clinicAiReplyPeriod: {
      findUnique: async (args: { where: { clinicId_periodStart: { clinicId: string } } }) => {
        queries.push({ where: args.where });
        const id = args.where.clinicId_periodStart.clinicId;
        return { replyCount: requireClinic(id).replyCount };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      let unlock = () => {};
      const tx = {
        $executeRaw: async () => {
          await acquire();
          unlock = releaseLock;
        },
        clinicAiReplyPeriod: {
          findUnique: async (args: { where: { clinicId_periodStart: { clinicId: string } } }) => {
            await Promise.resolve();
            const id = args.where.clinicId_periodStart.clinicId;
            return { id: `row-${id}`, replyCount: requireClinic(id).replyCount };
          },
          update: async (args: {
            where: { id: string };
            data: { replyCount: { increment?: number; decrement?: number } };
          }) => {
            await Promise.resolve();
            const id = args.where.id.replace(/^row-/, '');
            const row = requireClinic(id);
            row.replyCount += args.data.replyCount.increment || 0;
            row.replyCount -= args.data.replyCount.decrement || 0;
          },
          create: async () => {
            throw new Error('reply row should already exist in this test');
          },
        },
      };
      try {
        return await fn(tx);
      } finally {
        unlock();
      }
    },
  };

  return db;
}

describe('phase 8 seat caps', () => {
  it('refuses one more active doctor than Essential, Growth, or Scale includes', async () => {
    for (const tier of ['STARTER', 'GROWTH', 'ENTERPRISE'] as const) {
      const plan = brochure(tier);
      const open = world({ clinic: clinic(tier, { doctors: plan.doctorsIncluded - 1 }) });
      await expect(assertCanAddDoctor('clinic', open as never)).resolves.toMatchObject({ tier });

      const full = world({ clinic: clinic(tier, { doctors: plan.doctorsIncluded }) });
      await expect(assertCanAddDoctor('clinic', full as never)).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
      expect(full.queries.at(-1)?.where).toMatchObject({ clinicId: 'clinic', isActive: true });
    }
  });

  it('refuses one more active staff member than Essential, Growth, or Scale includes', async () => {
    for (const tier of ['STARTER', 'GROWTH', 'ENTERPRISE'] as const) {
      const plan = brochure(tier);
      const open = world({ clinic: clinic(tier, { staff: plan.staffIncluded - 1 }) });
      await expect(assertCanAddStaff('clinic', open as never)).resolves.toMatchObject({ tier });

      const full = world({ clinic: clinic(tier, { staff: plan.staffIncluded }) });
      await expect(assertCanAddStaff('clinic', full as never)).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
      expect(full.queries.at(-1)?.where).toMatchObject({
        clinicId: 'clinic',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
      });
    }
  });

  it('refuses one more active WhatsApp number than Essential, Growth, or Scale includes', async () => {
    for (const tier of ['STARTER', 'GROWTH', 'ENTERPRISE'] as const) {
      const plan = brochure(tier);
      const open = world({ clinic: clinic(tier, { whatsapp: plan.whatsappNumbersIncluded - 1 }) });
      await expect(assertCanAddWhatsappNumber('clinic', open as never)).resolves.toMatchObject({ tier });

      const full = world({ clinic: clinic(tier, { whatsapp: plan.whatsappNumbersIncluded }) });
      await expect(assertCanAddWhatsappNumber('clinic', full as never)).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
      expect(full.queries.at(-1)?.where).toMatchObject({ clinicId: 'clinic', isActive: true });
    }
  });
});

describe('phase 8 AI replies', () => {
  it('lets only one of two simultaneous replies take the last slot', async () => {
    const essential = brochure('STARTER');
    const growth = brochure('GROWTH');
    const clinics = {
      'clinic-essential': clinic('STARTER', { replyCount: essential.aiRepliesMonthly - 1 }),
      'clinic-growth': clinic('GROWTH', { replyCount: growth.aiRepliesMonthly - 1 }),
    };
    const db = world(clinics);

    const [first, second, otherClinic] = await Promise.allSettled([
      reserveAiReply('clinic-essential', db as never),
      reserveAiReply('clinic-essential', db as never),
      reserveAiReply('clinic-growth', db as never),
    ]);

    const essentialResults = [first, second];
    expect(essentialResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(essentialResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(clinics['clinic-essential'].replyCount).toBe(essential.aiRepliesMonthly);
    expect(otherClinic.status).toBe('fulfilled');
    expect(clinics['clinic-growth'].replyCount).toBe(growth.aiRepliesMonthly);
  });

  it('returns the reply when the model call fails, including the last slot', async () => {
    const plan = brochure('STARTER');
    const row = clinic('STARTER', { replyCount: plan.aiRepliesMonthly - 1 });
    const db = world({ clinic: row });

    await reserveAiReply('clinic', db as never);
    expect(row.replyCount).toBe(plan.aiRepliesMonthly);

    await releaseAiReply('clinic', periodStart, db as never);
    expect(row.replyCount).toBe(plan.aiRepliesMonthly - 1);

    await expect(reserveAiReply('clinic', db as never)).resolves.toMatchObject({ reserved: true });
    expect(row.replyCount).toBe(plan.aiRepliesMonthly);
  });

  it('adds a confirmed pack of replies for this period only', async () => {
    const plan = brochure('STARTER');
    const row = clinic('STARTER', {
      replyCount: plan.aiRepliesMonthly,
      addons: [
        {
          type: 'EXTRA_AI_REPLIES',
          status: 'ACTIVE',
          quantity: 1,
          periodStart,
          periodEnd,
        },
      ],
    });
    const db = world({ clinic: row });

    await expect(reserveAiReply('clinic', db as never)).resolves.toMatchObject({ reserved: true });
    expect(row.replyCount).toBe(plan.aiRepliesMonthly + 1);

    row.subscription = subscriptionFor('STARTER', { start: nextPeriodStart, end: nextPeriodEnd });
    row.replyCount = plan.aiRepliesMonthly;
    await expect(reserveAiReply('clinic', db as never)).rejects.toMatchObject({ code: 'AI_REPLY_LIMIT' });
    expect(row.replyCount).toBe(plan.aiRepliesMonthly);
    expect(AI_REPLY_PACK).toBe(300);
  });
});

describe('phase 8 plan behaviour', () => {
  it('blocks Essential and Growth from outbound and leaves it on Scale', async () => {
    const db = world({
      essential: clinic('STARTER'),
      growth: clinic('GROWTH'),
      scale: clinic('ENTERPRISE'),
    });

    await expect(outboundAllowed('essential', db as never)).resolves.toBe(false);
    await expect(outboundAllowed('growth', db as never)).resolves.toBe(false);
    await expect(outboundAllowed('scale', db as never)).resolves.toBe(true);
  });

  it('skips automations a downgrade no longer includes and keeps the ones every plan has', async () => {
    const row = clinic('ENTERPRISE');
    const db = world({ clinic: row });

    await expect(automationAllowed('clinic', 'PATIENT_REACTIVATION', db as never)).resolves.toBe(true);
    await expect(automationAllowed('clinic', 'MISSED_APPOINTMENT', db as never)).resolves.toBe(true);

    row.subscription = subscriptionFor('GROWTH');
    await expect(automationAllowed('clinic', 'PATIENT_REACTIVATION', db as never)).resolves.toBe(false);
    await expect(automationAllowed('clinic', 'MISSED_APPOINTMENT', db as never)).resolves.toBe(true);
    await expect(automationAllowed('clinic', 'COMPLETED_VISIT', db as never)).resolves.toBe(true);

    row.subscription = subscriptionFor('STARTER');
    await expect(automationAllowed('clinic', 'MISSED_APPOINTMENT', db as never)).resolves.toBe(false);
    await expect(automationAllowed('clinic', 'COMPLETED_VISIT', db as never)).resolves.toBe(false);
    await expect(automationAllowed('clinic', 'INVOICE_WHATSAPP', db as never)).resolves.toBe(true);
    await expect(automationAllowed('clinic', 'APPOINTMENT_REMINDER', db as never)).resolves.toBe(true);
    await expect(automationAllowed('clinic', 'NEW_ENQUIRY', db as never)).resolves.toBe(true);
  });

  it('does not let clinic A read clinic B plan, usage, or add-ons', async () => {
    const essential = brochure('STARTER');
    const scale = brochure('ENTERPRISE');
    const db = world({
      'clinic-a': clinic('STARTER', {
        doctors: 0,
        staff: 1,
        whatsapp: 0,
        whatsappMessages: 12,
        replyCount: 4,
        addons: [{ type: 'EXTRA_DOCTOR', status: 'ACTIVE', quantity: 1 }],
      }),
      'clinic-b': clinic('ENTERPRISE', {
        doctors: scale.doctorsIncluded,
        staff: scale.staffIncluded,
        whatsapp: scale.whatsappNumbersIncluded,
        whatsappMessages: 400,
        replyCount: 1400,
        addons: [{ type: 'EXTRA_DOCTOR', status: 'ACTIVE', quantity: 3 }],
      }),
    });

    const before = db.queries.length;
    const usageA = await clinicPackageUsage('clinic-a', db as never);
    const asked = db.queries.slice(before);

    expect(usageA).toMatchObject({
      planName: 'Essential',
      doctors: { used: 0, allowed: essential.doctorsIncluded + 1 },
      staff: { used: 1, allowed: essential.staffIncluded },
      whatsappNumbers: { used: 0, allowed: essential.whatsappNumbersIncluded },
      aiReplies: { used: 4, allowed: essential.aiRepliesMonthly },
    });
    expect(
      asked.every((query) => {
        const where = query.where;
        const period = where.clinicId_periodStart as { clinicId?: string } | undefined;
        return where.clinicId === 'clinic-a' || period?.clinicId === 'clinic-a';
      }),
    ).toBe(true);

    const usageB = await clinicPackageUsage('clinic-b', db as never);
    expect(usageA.whatsappMessages).toMatchObject({ used: 12, fromDay: 1 });
    expect(usageA.whatsappMessages.toDay).toBeGreaterThanOrEqual(28);
    expect(usageB.planName).toBe('Scale');
    expect(usageB.whatsappMessages.used).toBe(400);
    expect(usageB.doctors).toMatchObject({ used: scale.doctorsIncluded, allowed: scale.doctorsIncluded + 3 });
    expect(usageB.aiReplies.used).toBe(1400);
  });
});
