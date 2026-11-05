import { describe, expect, it } from 'vitest';
import { AppError } from '../../middleware/errorHandler.js';
import {
  assertCanAddDoctor,
  assertCanAddStaff,
  automationAllowed,
  claimConversationWindow,
  claimReply,
  effectiveEntitlement,
  outboundAllowed,
  releaseAiReply,
  reserveAiReply,
  type ClinicAddonSnapshot,
  type PlanSnapshot,
  type SubscriptionSnapshot,
} from './entitlements.js';

const periodStart = new Date('2026-11-01T00:00:00.000Z');
const periodEnd = new Date('2026-12-01T00:00:00.000Z');

function plan(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    name: 'Essential',
    tier: 'STARTER',
    doctorsIncluded: 1,
    staffIncluded: 2,
    whatsappNumbersIncluded: 1,
    aiRepliesMonthly: 300,
    modelLevel: 'NORMAL',
    conversationMemory: 'NONE',
    reportingLevel: 'BASIC',
    customAiIncluded: false,
    outboundIncluded: false,
    prioritySupportIncluded: false,
    automationKeys: ['NEW_ENQUIRY', 'INVOICE_WHATSAPP', 'APPOINTMENT_REMINDER'],
    ...overrides,
  };
}

function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    status: 'ACTIVE',
    limitsApply: true,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    plan: plan(),
    ...overrides,
  };
}

describe('effectiveEntitlement', () => {
  it('does not treat a missing, suspended, or unapplied subscription as Scale', () => {
    expect(effectiveEntitlement(null, []).enforced).toBe(false);
    expect(effectiveEntitlement(null, []).outbound).toBe(false);
    expect(effectiveEntitlement(subscription({ status: 'SUSPENDED' }), []).enforced).toBe(false);
    expect(effectiveEntitlement(subscription({ status: 'EXPIRED' }), []).enforced).toBe(false);
    expect(effectiveEntitlement(subscription({ limitsApply: false }), []).enforced).toBe(false);
  });

  it('uses Essential limits and ignores a pending add-on', () => {
    const entitlement = effectiveEntitlement(subscription(), [
      { type: 'EXTRA_DOCTOR', status: 'PENDING', quantity: 1 },
    ]);
    expect(entitlement).toMatchObject({
      enforced: true,
      doctors: 1,
      staff: 2,
      whatsappNumbers: 1,
      aiReplies: 300,
      modelLevel: 'NORMAL',
      conversationMemory: 'NONE',
      outbound: false,
      customAi: false,
    });
  });

  it('adds an active doctor add-on and an Essential automation add-on', () => {
    const addons: ClinicAddonSnapshot[] = [
      { type: 'EXTRA_DOCTOR', status: 'ACTIVE', quantity: 1 },
      { type: 'EXTRA_AUTOMATION', status: 'ACTIVE', quantity: 1, automationKey: 'MISSED_APPOINTMENT' },
    ];
    const entitlement = effectiveEntitlement(subscription(), addons);
    expect(entitlement.doctors).toBe(2);
    expect(entitlement.automationKeys).toContain('MISSED_APPOINTMENT');
  });

  it('lets Growth add patient reactivation and keeps the automations already on Growth', () => {
    const entitlement = effectiveEntitlement(
      subscription({
        plan: plan({
          name: 'Growth',
          tier: 'GROWTH',
          doctorsIncluded: 2,
          automationKeys: ['NEW_ENQUIRY', 'INVOICE_WHATSAPP', 'APPOINTMENT_REMINDER', 'MISSED_APPOINTMENT', 'COMPLETED_VISIT'],
        }),
      }),
      [
        { type: 'EXTRA_AUTOMATION', status: 'ACTIVE', quantity: 1, automationKey: 'PATIENT_REACTIVATION' },
        { type: 'EXTRA_AUTOMATION', status: 'ACTIVE', quantity: 1, automationKey: 'MISSED_APPOINTMENT' },
      ],
    );
    expect(entitlement.automationKeys).toContain('PATIENT_REACTIVATION');
    expect(entitlement.automationKeys.filter((key) => key === 'MISSED_APPOINTMENT')).toEqual(['MISSED_APPOINTMENT']);
  });

  it('adds 300 replies for a pack in this period only', () => {
    const covered = effectiveEntitlement(subscription(), [
      { type: 'EXTRA_AI_REPLIES', status: 'ACTIVE', quantity: 2, periodStart, periodEnd },
    ]);
    const expired = effectiveEntitlement(subscription(), [
      {
        type: 'EXTRA_AI_REPLIES',
        status: 'ACTIVE',
        quantity: 1,
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);
    expect(covered.aiReplies).toBe(900);
    expect(expired.aiReplies).toBe(300);
  });

  it('gives Scale outbound, custom AI, and priority support', () => {
    const entitlement = effectiveEntitlement(
      subscription({
        plan: plan({
          name: 'Scale',
          tier: 'ENTERPRISE',
          doctorsIncluded: 5,
          staffIncluded: 10,
          whatsappNumbersIncluded: 2,
          aiRepliesMonthly: 1500,
          modelLevel: 'HIGH_END',
          conversationMemory: 'FULL',
          reportingLevel: 'ADVANCED',
          customAiIncluded: true,
          outboundIncluded: true,
          prioritySupportIncluded: true,
        }),
      }),
      [],
    );
    expect(entitlement).toMatchObject({
      outbound: true,
      customAi: true,
      prioritySupport: true,
      conversationMemory: 'FULL',
      aiReplies: 1500,
    });
  });
});

describe('claimReply', () => {
  it('lets one reply through the last slot and refuses the next', () => {
    expect(claimReply(299, 300)).toBe(300);
    expect(() => claimReply(300, 300)).toThrow(AppError);
  });
});

function store(subscriptionRow: SubscriptionSnapshot | null, extras?: { replyCount?: number; doctors?: number; staff?: number; lastReplyAt?: Date | null }) {
  let replyCount = extras?.replyCount ?? 0;
  const locks: string[] = [];
  const tx = {
    $executeRaw: async () => {
      locks.push('lock');
    },
    clinicAiReplyPeriod: {
      findUnique: async () => (replyCount === 0 && extras?.replyCount === undefined ? null : { id: 'row', replyCount }),
      update: async ({ data }: { data: { replyCount: { increment?: number; decrement?: number } } }) => {
        replyCount += data.replyCount.increment || 0;
        replyCount -= data.replyCount.decrement || 0;
      },
      create: async ({ data }: { data: { replyCount: number } }) => {
        replyCount = data.replyCount;
      },
    },
  };
  const countArgs: unknown[] = [];
  const db = {
    cgsSubscription: {
      findMany: async () => (subscriptionRow ? [{ ...subscriptionRow, clinicId: 'clinic-1' }] : []),
    },
    clinicAddon: { findMany: async () => [] as ClinicAddonSnapshot[] },
    doctor: {
      count: async (args: unknown) => {
        countArgs.push(args);
        return extras?.doctors ?? 0;
      },
    },
    user: {
      count: async (args: unknown) => {
        countArgs.push(args);
        return extras?.staff ?? 0;
      },
    },
    whatsappAccount: { count: async () => 0 },
    message: {
      findFirst: async () => (extras?.lastReplyAt ? { createdAt: extras.lastReplyAt } : null),
    },
    $transaction: async <T>(fn: (inner: typeof tx) => Promise<T>) => fn(tx),
    locks,
    countArgs,
    replyCount: () => replyCount,
  };
  return db;
}

describe('entitlement guards', () => {
  it('leaves a clinic alone until a plan is applied', async () => {
    const db = store(subscription({ limitsApply: false }));
    await assertCanAddDoctor('clinic-1', db as never);
    expect(db.countArgs).toHaveLength(0);
    await expect(reserveAiReply('clinic-1', db as never)).resolves.toMatchObject({ reserved: false, enforced: false });
    expect(db.locks).toHaveLength(0);
    await expect(automationAllowed('clinic-1', 'PATIENT_REACTIVATION', db as never)).resolves.toBe(true);
    await expect(outboundAllowed('clinic-1', db as never)).resolves.toBe(true);
  });

  it('refuses a second active doctor on Essential', async () => {
    const db = store(subscription(), { doctors: 1 });
    await expect(assertCanAddDoctor('clinic-1', db as never)).rejects.toBeInstanceOf(AppError);
    expect(db.countArgs[0]).toMatchObject({ where: { clinicId: 'clinic-1', isActive: true } });
  });

  it('counts only active employees as staff', async () => {
    const db = store(subscription(), { staff: 2 });
    await expect(assertCanAddStaff('clinic-1', db as never)).rejects.toBeInstanceOf(AppError);
    expect(db.countArgs[0]).toMatchObject({ where: { clinicId: 'clinic-1', role: 'EMPLOYEE', status: 'ACTIVE' } });
  });

  it('reserves the last reply and refuses the one after it', async () => {
    const db = store(subscription(), { replyCount: 299 });
    await expect(reserveAiReply('clinic-1', db as never)).resolves.toMatchObject({ reserved: true });
    expect(db.replyCount()).toBe(300);
    await expect(reserveAiReply('clinic-1', db as never)).rejects.toBeInstanceOf(AppError);
    expect(db.locks.length).toBe(2);
    expect(db.replyCount()).toBe(300);
  });

  it('does not let a failed receptionist line keep the window open', async () => {
    let replyCount = 0;
    const db = {
      cgsSubscription: { findMany: async () => [{ ...subscription(), clinicId: 'clinic-1' }] },
      clinicAddon: { findMany: async () => [] },
      doctor: { count: async () => 0 },
      user: { count: async () => 0 },
      whatsappAccount: { count: async () => 0 },
      message: {
        findFirst: async (args: { where: { content?: { notIn?: string[] } } }) => {
          if (args.where.content?.notIn?.length) return null;
          return { createdAt: new Date() };
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        $executeRaw: async () => undefined,
        clinicAiReplyPeriod: {
          findUnique: async () => ({ id: 'row', replyCount }),
          update: async () => { replyCount += 1; },
          create: async () => undefined,
        },
      }),
    };
    await expect(claimConversationWindow('clinic-1', 'conv-1', db as never)).resolves.toMatchObject({ counted: true });
    expect(replyCount).toBe(1);
  });

  it('counts one window and ignores another reply inside 24 hours', async () => {
    const recent = store(subscription(), { replyCount: 4, lastReplyAt: new Date(Date.now() - 60 * 60 * 1000) });
    await expect(claimConversationWindow('clinic-1', 'conv-1', recent as never)).resolves.toMatchObject({ counted: false });
    expect(recent.replyCount()).toBe(4);

    const stale = store(subscription(), { replyCount: 4, lastReplyAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await expect(claimConversationWindow('clinic-1', 'conv-1', stale as never)).resolves.toMatchObject({ counted: true });
    expect(stale.replyCount()).toBe(5);
  });

  it('releases a reserved reply after a failed model call', async () => {
    const db = store(subscription(), { replyCount: 10 });
    await releaseAiReply('clinic-1', periodStart, db as never);
    expect(db.replyCount()).toBe(9);
  });

  it('blocks Scale-only outbound once Essential is applied', async () => {
    const db = store(subscription());
    await expect(outboundAllowed('clinic-1', db as never)).resolves.toBe(false);
    await expect(automationAllowed('clinic-1', 'INVOICE_WHATSAPP', db as never)).resolves.toBe(true);
    await expect(automationAllowed('clinic-1', 'PATIENT_REACTIVATION', db as never)).resolves.toBe(false);
  });
});
