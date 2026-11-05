/* Admin subscription bills.
 * A daily scan queues one billing job per clinic period. Each job writes a SubscriptionInvoice. */
import { prisma } from '../../config/db.js';
import { packageMonthlyAmount } from './planCatalog.js';
import { gstOn } from './subscriptionGst.js';

export const SUBSCRIPTION_BILL_SCAN_JOB = 'SUBSCRIPTION_BILL_SCAN';
export const SUBSCRIPTION_BILL_CREATE_JOB = 'SUBSCRIPTION_BILL_CREATE';
export const BILL_SCAN_MS = 24 * 60 * 60 * 1000;
const MAX_PERIODS = 6;

export function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

/** Periods that should have a subscription bill, including the open month and up to six catch-up months. */
export function monthsToBill(input: {
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  autoRenew: boolean;
  maxPeriods?: number;
}) {
  const max = input.maxPeriods ?? MAX_PERIODS;
  const periods: Array<{ periodStart: Date; periodEnd: Date }> = [];
  let start = new Date(input.periodStart);
  let end = new Date(input.periodEnd);
  if (!(start.getTime() < end.getTime())) return periods;

  for (let i = 0; i < max; i += 1) {
    if (start.getTime() > input.now.getTime()) break;
    periods.push({ periodStart: new Date(start), periodEnd: new Date(end) });
    if (end.getTime() > input.now.getTime() || !input.autoRenew) break;
    start = new Date(end);
    end = addMonths(end, 1);
    if (!(start.getTime() < end.getTime())) break;
  }
  return periods;
}

export async function ensureSubscriptionBillJob() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduler:${SUBSCRIPTION_BILL_SCAN_JOB}`}))`;
    const latest = await tx.job.findFirst({
      where: { type: SUBSCRIPTION_BILL_SCAN_JOB },
      orderBy: { createdAt: 'desc' },
      select: { status: true, createdAt: true },
    });
    if (latest && (latest.status === 'PENDING' || latest.status === 'PROCESSING')) return;
    if (latest && Date.now() - latest.createdAt.getTime() < 60 * 60 * 1000) return;
    await tx.job.create({
      data: {
        queue: 'SCHEDULER',
        type: SUBSCRIPTION_BILL_SCAN_JOB,
        status: 'PENDING',
        availableAt: new Date(),
        maxAttempts: 5,
        payload: { note: 'Waiting to create subscription bills for active clinics.' },
      },
    });
  });
}

export async function scanSubscriptionBills(now = new Date()) {
  const subscriptions = await prisma.cgsSubscription.findMany({
    where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
    include: {
      plan: { select: { name: true } },
      invoices: { select: { periodStart: true } },
    },
  });

  let queued = 0;
  let alreadyBilled = 0;
  for (const subscription of subscriptions) {
    const periods = monthsToBill({
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      now,
      autoRenew: subscription.autoRenew,
    });
    for (const period of periods) {
      const periodStart = period.periodStart.toISOString();
      const billed = subscription.invoices.some((invoice) => invoice.periodStart.getTime() === period.periodStart.getTime());
      if (billed) {
        alreadyBilled += 1;
        continue;
      }
      const pending = await prisma.job.findFirst({
        where: {
          type: SUBSCRIPTION_BILL_CREATE_JOB,
          clinicId: subscription.clinicId,
          status: { in: ['PENDING', 'PROCESSING'] },
          payload: { path: ['periodStart'], equals: periodStart },
        },
        select: { id: true },
      });
      if (pending) continue;
      await prisma.job.create({
        data: {
          clinicId: subscription.clinicId,
          queue: 'BILLING',
          type: SUBSCRIPTION_BILL_CREATE_JOB,
          maxAttempts: 3,
          payload: {
            subscriptionId: subscription.id,
            periodStart,
            periodEnd: period.periodEnd.toISOString(),
            note: `Package bill for ${subscription.plan?.name || 'the clinic package'}`,
          },
        },
      });
      queued += 1;
    }
  }

  return { clinics: subscriptions.length, queued, alreadyBilled };
}

export async function createSubscriptionBill(payload: {
  subscriptionId?: string;
  periodStart?: string;
  periodEnd?: string;
}) {
  const periodStart = payload.periodStart ? new Date(payload.periodStart) : new Date(NaN);
  const periodEnd = payload.periodEnd ? new Date(payload.periodEnd) : new Date(NaN);
  if (!payload.subscriptionId || Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    throw new Error('Invalid subscription bill payload');
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subbill:${payload.subscriptionId}`}))`;
    const existing = await tx.subscriptionInvoice.findFirst({
      where: { subscriptionId: payload.subscriptionId, periodStart },
    });
    if (existing) {
      return { created: false, invoiceNumber: existing.invoiceNumber, total: Number(existing.total) };
    }

    const subscription = await tx.cgsSubscription.findUnique({
      where: { id: payload.subscriptionId },
      include: { plan: true },
    });
    if (!subscription) throw new Error('Subscription not found');
    if (subscription.status !== 'ACTIVE' && subscription.status !== 'PAST_DUE') {
      return { created: false, invoiceNumber: '', total: 0 };
    }

    const priced = gstOn(packageMonthlyAmount(subscription.plan, subscription.earlyBird));
    const count = await tx.subscriptionInvoice.count({ where: { clinicId: subscription.clinicId } });
    const invoiceNumber = `CGS-${periodStart.getUTCFullYear()}-${String(count + 1).padStart(4, '0')}`;
    const closed = periodEnd.getTime() < Date.now();
    const invoice = await tx.subscriptionInvoice.create({
      data: {
        clinicId: subscription.clinicId,
        subscriptionId: subscription.id,
        invoiceNumber,
        subtotal: priced.subtotal,
        usageCharges: 0,
        adjustments: priced.taxAmount,
        total: priced.total,
        status: closed ? 'OVERDUE' : 'ISSUED',
        periodStart,
        periodEnd,
        issuedAt: periodStart,
        dueAt: periodEnd,
      },
    });

    if (periodEnd.getTime() >= subscription.currentPeriodEnd.getTime()) {
      await tx.cgsSubscription.update({
        where: { id: subscription.id },
        data: { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
      });
    }

    return { created: true, invoiceNumber: invoice.invoiceNumber, total: priced.total };
  });
}
