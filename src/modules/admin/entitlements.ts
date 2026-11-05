/* One clinic entitlement check. Later phases call this instead of copying plan limits. */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { AppError } from '../../middleware/errorHandler.js';
import { clinicMonthWindow } from '../../utils/timezone.js';
import { AI_REPLY_PACK, AUTOMATION_LABELS } from './planCatalog.js';

const APPLIED_STATUSES = new Set(['ACTIVE', 'PAST_DUE']);
const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const UNCOUNTED_REPLIES = [
  'I am having trouble reaching the AI receptionist right now. A coordinator will follow up shortly.',
  'AI service credits are temporarily exhausted. A clinic coordinator will follow up with you shortly.',
];

export type ClinicAddonSnapshot = {
  type: string;
  status: string;
  quantity: number;
  automationKey?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
};

export type PlanSnapshot = {
  name: string;
  tier: string;
  doctorsIncluded: number;
  staffIncluded: number;
  whatsappNumbersIncluded: number;
  aiRepliesMonthly: number;
  modelLevel: string;
  conversationMemory: string;
  reportingLevel: string;
  customAiIncluded: boolean;
  outboundIncluded: boolean;
  prioritySupportIncluded: boolean;
  automationKeys: string[];
};

export type SubscriptionSnapshot = {
  status: string;
  limitsApply: boolean;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  plan: PlanSnapshot;
};

export type ClinicEntitlement = {
  enforced: boolean;
  tier: string | null;
  planName: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  doctors: number;
  staff: number;
  whatsappNumbers: number;
  aiReplies: number;
  modelLevel: 'NORMAL' | 'HIGH_END';
  conversationMemory: 'NONE' | 'FULL';
  reportingLevel: 'BASIC' | 'ADVANCED';
  customAi: boolean;
  outbound: boolean;
  prioritySupport: boolean;
  automationKeys: string[];
};

const OPEN_ENTITLEMENT: ClinicEntitlement = {
  enforced: false,
  tier: null,
  planName: null,
  periodStart: null,
  periodEnd: null,
  doctors: 0,
  staff: 0,
  whatsappNumbers: 0,
  aiReplies: 0,
  modelLevel: 'NORMAL',
  conversationMemory: 'NONE',
  reportingLevel: 'BASIC',
  customAi: false,
  outbound: false,
  prioritySupport: false,
  automationKeys: [],
};

function quantity(addons: ClinicAddonSnapshot[], type: string) {
  return addons.filter((addon) => addon.type === type).reduce((sum, addon) => sum + Number(addon.quantity || 0), 0);
}

function packCoversPeriod(addon: ClinicAddonSnapshot, periodStart: Date, periodEnd: Date) {
  const start = addon.periodStart ? new Date(addon.periodStart).getTime() : periodStart.getTime();
  const end = addon.periodEnd ? new Date(addon.periodEnd).getTime() : periodEnd.getTime();
  return start < periodEnd.getTime() && end > periodStart.getTime();
}

/** Brochure limits plus active add-ons. A clinic with no applied plan is not given Scale. */
export function effectiveEntitlement(
  subscription: SubscriptionSnapshot | null,
  addons: ClinicAddonSnapshot[],
): ClinicEntitlement {
  if (!subscription || !subscription.limitsApply || !APPLIED_STATUSES.has(subscription.status)) {
    return { ...OPEN_ENTITLEMENT };
  }

  const active = addons.filter((addon) => addon.status === 'ACTIVE');
  const plan = subscription.plan;
  const replyPacks = active.filter(
    (addon) => addon.type === 'EXTRA_AI_REPLIES' && packCoversPeriod(addon, subscription.currentPeriodStart, subscription.currentPeriodEnd),
  );
  const extraReplies = replyPacks.reduce((sum, addon) => sum + Number(addon.quantity || 0) * AI_REPLY_PACK, 0);
  const allowedExtra = plan.tier === 'STARTER'
    ? ['MISSED_APPOINTMENT', 'COMPLETED_VISIT', 'PATIENT_REACTIVATION']
    : plan.tier === 'GROWTH'
      ? ['PATIENT_REACTIVATION']
      : [];
  const extraAutomations = active
    .filter((addon) => addon.type === 'EXTRA_AUTOMATION' && addon.automationKey && allowedExtra.includes(String(addon.automationKey)))
    .map((addon) => String(addon.automationKey));

  return {
    enforced: true,
    tier: plan.tier,
    planName: plan.name,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    doctors: plan.doctorsIncluded + quantity(active, 'EXTRA_DOCTOR'),
    staff: plan.staffIncluded + quantity(active, 'EXTRA_STAFF'),
    whatsappNumbers: plan.whatsappNumbersIncluded + quantity(active, 'EXTRA_WHATSAPP_NUMBER'),
    aiReplies: plan.aiRepliesMonthly + extraReplies,
    modelLevel: plan.modelLevel === 'HIGH_END' ? 'HIGH_END' : 'NORMAL',
    conversationMemory: plan.conversationMemory === 'FULL' ? 'FULL' : 'NONE',
    reportingLevel: plan.reportingLevel === 'ADVANCED' ? 'ADVANCED' : 'BASIC',
    customAi: plan.customAiIncluded,
    outbound: plan.outboundIncluded,
    prioritySupport: plan.prioritySupportIncluded || (plan.tier !== 'ENTERPRISE' && quantity(active, 'PRIORITY_SUPPORT') > 0),
    automationKeys: [...new Set([...plan.automationKeys, ...extraAutomations])],
  };
}

export function nextSeatMessage(kind: 'doctor' | 'staff member' | 'WhatsApp number', used: number, limit: number, tier: string | null) {
  const next = tier === 'STARTER' ? 'Growth includes a higher limit.' : tier === 'GROWTH' ? 'Scale includes a higher limit.' : 'An add-on can raise this limit.';
  return `This clinic is at its ${kind} limit (${used} of ${limit}). ${next}`;
}

export function assertSeat(used: number, limit: number, kind: 'doctor' | 'staff member' | 'WhatsApp number', tier: string | null) {
  if (used >= limit) {
    throw new AppError(nextSeatMessage(kind, used, limit, tier), 403, 'PLAN_LIMIT');
  }
}

/** Returns the next reply count, or throws when the period is already full. */
export function claimReply(used: number, limit: number) {
  if (used >= limit) {
    throw new AppError(
      `This clinic has used its AI replies for this period (${used} of ${limit}). A pack of ${AI_REPLY_PACK} replies covers the rest of this period.`,
      403,
      'AI_REPLY_LIMIT',
    );
  }
  return used + 1;
}

type SubscriptionRow = SubscriptionSnapshot & { clinicId: string; createdAt?: Date };

type EntitlementDb = {
  cgsSubscription: {
    findMany: (args: unknown) => Promise<SubscriptionRow[]>;
  };
  clinicAddon: {
    findMany: (args: unknown) => Promise<ClinicAddonSnapshot[]>;
  };
  doctor: { count: (args: unknown) => Promise<number> };
  user: { count: (args: unknown) => Promise<number> };
  whatsappAccount: { count: (args: unknown) => Promise<number> };
  message?: {
    count: (args: unknown) => Promise<number>;
    findFirst?: (args: unknown) => Promise<{ createdAt: Date } | null>;
  };
  clinicAiReplyPeriod?: {
    findUnique: (args: unknown) => Promise<{ replyCount: number } | null>;
  };
  $transaction: <T>(fn: (tx: ReplyTx) => Promise<T>) => Promise<T>;
};

type ReplyTx = {
  $executeRaw: (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<unknown>;
  clinicAiReplyPeriod: {
    findUnique: (args: unknown) => Promise<{ id: string; replyCount: number } | null>;
    update: (args: { where: { id: string }; data: { replyCount: { increment?: number; decrement?: number } } }) => Promise<unknown>;
    create: (args: { data: { clinicId: string; periodStart: Date; replyCount: number } }) => Promise<unknown>;
  };
};

async function loadSubscription(db: EntitlementDb, clinicId: string) {
  const rows = await db.cgsSubscription.findMany({
    where: { clinicId },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });
  return rows.find((row) => row.limitsApply && APPLIED_STATUSES.has(row.status)) || null;
}

export async function clinicSeatUsage(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  const entitlement = await loadEntitlement(clinicId, db);
  const [doctors, staff, whatsappNumbers] = await Promise.all([
    db.doctor.count({ where: { clinicId, isActive: true } }),
    db.user.count({ where: { clinicId, role: 'EMPLOYEE', status: 'ACTIVE' } }),
    db.whatsappAccount.count({ where: { clinicId, isActive: true } }),
  ]);
  return {
    enforced: entitlement.enforced,
    planName: entitlement.planName,
    tier: entitlement.tier,
    doctors: { used: doctors, allowed: entitlement.enforced ? entitlement.doctors : null },
    staff: { used: staff, allowed: entitlement.enforced ? entitlement.staff : null },
    whatsappNumbers: { used: whatsappNumbers, allowed: entitlement.enforced ? entitlement.whatsappNumbers : null },
  };
}

export async function clinicPackageUsage(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  const entitlement = await loadEntitlement(clinicId, db);
  const month = clinicMonthWindow();
  const [doctors, staff, whatsappNumbers, replyRow, whatsappMessageCount] = await Promise.all([
    db.doctor.count({ where: { clinicId, isActive: true } }),
    db.user.count({ where: { clinicId, role: 'EMPLOYEE', status: 'ACTIVE' } }),
    db.whatsappAccount.count({ where: { clinicId, isActive: true } }),
    db.clinicAiReplyPeriod
      ? db.clinicAiReplyPeriod.findUnique({
          where: { clinicId_periodStart: { clinicId, periodStart: month.start } },
        })
      : Promise.resolve(null),
    db.message
      ? db.message.count({
          where: {
            clinicId,
            direction: 'OUTBOUND',
            status: { not: 'FAILED' },
            createdAt: { gte: month.start, lte: month.end },
          },
        })
      : Promise.resolve(0),
  ]);
  const seat = (used: number, limit: number, kind: 'doctor' | 'staff member' | 'WhatsApp number') => ({
    used,
    allowed: entitlement.enforced ? limit : null,
    note: entitlement.enforced && used >= limit ? nextSeatMessage(kind, used, limit, entitlement.tier) : '',
  });
  const replyUsed = replyRow?.replyCount || 0;
  return {
    enforced: entitlement.enforced,
    planName: entitlement.planName,
    tier: entitlement.tier,
    doctors: seat(doctors, entitlement.doctors, 'doctor'),
    staff: seat(staff, entitlement.staff, 'staff member'),
    whatsappNumbers: seat(whatsappNumbers, entitlement.whatsappNumbers, 'WhatsApp number'),
    aiReplies: {
      used: replyUsed,
      allowed: entitlement.enforced ? entitlement.aiReplies : null,
      note: entitlement.enforced && replyUsed >= entitlement.aiReplies
        ? `This clinic has used its AI conversations for this month (${replyUsed} of ${entitlement.aiReplies}). The count returns to 0 next month. A pack of ${AI_REPLY_PACK} conversations covers the rest of this month.`
        : '',
    },
    whatsappMessages: {
      used: whatsappMessageCount,
      fromDay: month.fromDay,
      toDay: month.toDay,
      monthLabel: month.monthLabel,
    },
    automations: entitlement.enforced
      ? Object.entries(AUTOMATION_LABELS).map(([key, label]) => ({
          key,
          label,
          running: entitlement.automationKeys.includes(key),
        }))
      : [],
  };
}

export async function loadEntitlement(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  const subscription = await loadSubscription(db, clinicId);
  if (!subscription) return effectiveEntitlement(null, []);
  const addons = await db.clinicAddon.findMany({
    where: { clinicId, status: 'ACTIVE' },
  });
  return effectiveEntitlement(subscription, addons);
}

async function assertResource(
  clinicId: string,
  kind: 'doctor' | 'staff member' | 'WhatsApp number',
  count: (db: EntitlementDb) => Promise<number>,
  limitOf: (entitlement: ClinicEntitlement) => number,
  db: EntitlementDb,
) {
  const entitlement = await loadEntitlement(clinicId, db);
  if (!entitlement.enforced) return entitlement;
  const used = await count(db);
  assertSeat(used, limitOf(entitlement), kind, entitlement.tier);
  return entitlement;
}

export function assertCanAddDoctor(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  return assertResource(
    clinicId,
    'doctor',
    (store) => store.doctor.count({ where: { clinicId, isActive: true } }),
    (entitlement) => entitlement.doctors,
    db,
  );
}

export function assertCanAddStaff(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  return assertResource(
    clinicId,
    'staff member',
    (store) => store.user.count({ where: { clinicId, role: 'EMPLOYEE', status: 'ACTIVE' } }),
    (entitlement) => entitlement.staff,
    db,
  );
}

export function assertCanAddWhatsappNumber(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  return assertResource(
    clinicId,
    'WhatsApp number',
    (store) => store.whatsappAccount.count({ where: { clinicId, isActive: true } }),
    (entitlement) => entitlement.whatsappNumbers,
    db,
  );
}

/** One WhatsApp reply window. A new window counts. Replies inside the open 24 hours do not. */
export async function claimConversationWindow(
  clinicId: string,
  conversationId: string,
  db: EntitlementDb = prisma as unknown as EntitlementDb,
) {
  const entitlement = await loadEntitlement(clinicId, db);
  if (!entitlement.enforced) return { counted: false, periodStart: null as Date | null };
  const lastReply = db.message?.findFirst
    ? await db.message.findFirst({
        where: {
          clinicId,
          conversationId,
          direction: 'OUTBOUND',
          isAiGenerated: true,
          content: { notIn: UNCOUNTED_REPLIES },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
    : null;
  const lastAt = lastReply?.createdAt ? new Date(lastReply.createdAt).getTime() : 0;
  if (lastAt && Date.now() - lastAt < CONVERSATION_WINDOW_MS) {
    return { counted: false, periodStart: null as Date | null };
  }
  const reserved = await reserveAiReply(clinicId, db);
  return { counted: reserved.reserved, periodStart: reserved.periodStart };
}

export async function reserveAiReply(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  const entitlement = await loadEntitlement(clinicId, db);
  if (!entitlement.enforced) {
    return { reserved: false, enforced: false, periodStart: null as Date | null };
  }
  const periodStart = clinicMonthWindow().start;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-reply:${clinicId}`}))`;
    const row = await tx.clinicAiReplyPeriod.findUnique({
      where: { clinicId_periodStart: { clinicId, periodStart } },
    });
    const next = claimReply(row?.replyCount || 0, entitlement.aiReplies);
    if (row) {
      await tx.clinicAiReplyPeriod.update({ where: { id: row.id }, data: { replyCount: { increment: 1 } } });
    } else {
      await tx.clinicAiReplyPeriod.create({ data: { clinicId, periodStart, replyCount: next } });
    }
  });
  return { reserved: true, enforced: true, periodStart };
}

export async function releaseAiReply(clinicId: string, periodStart: Date, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-reply:${clinicId}`}))`;
    const row = await tx.clinicAiReplyPeriod.findUnique({
      where: { clinicId_periodStart: { clinicId, periodStart } },
    });
    if (!row || row.replyCount <= 0) return;
    await tx.clinicAiReplyPeriod.update({ where: { id: row.id }, data: { replyCount: { decrement: 1 } } });
  });
}

export async function automationAllowed(clinicId: string, automationKey: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  const entitlement = await loadEntitlement(clinicId, db);
  if (!entitlement.enforced) return true;
  return entitlement.automationKeys.includes(automationKey);
}

export async function outboundAllowed(clinicId: string, db: EntitlementDb = prisma as unknown as EntitlementDb) {
  const entitlement = await loadEntitlement(clinicId, db);
  if (!entitlement.enforced) return true;
  return entitlement.outbound;
}
