/* Automatic WhatsApp sends.
 * Reminders: 6 hours, 2 hours, and 30 minutes before a visit.
 * Missed visits and completed follow-ups: once, found by an hourly scan.
 * Bills and reactivation stay on the staff outbound page.
 * Landing enquiries are queued when the patient submits the form. */
import { prisma } from '../../config/db.js';
import { queueTemplateSends } from './outbound.service.js';

const HOUR_MS = 60 * 60 * 1000;
const REMINDER_STAGES = [
  { id: '1d', leadMs: 1 * 24 * HOUR_MS },
  { id: '6h', leadMs: 6 * HOUR_MS },
  { id: '2h', leadMs: 2 * HOUR_MS },
  { id: '30m', leadMs: 30 * 60 * 1000 },
] as const;

export const OUTCOME_LOOKBACK_MS = 36 * HOUR_MS;
export const OUTCOME_LOOKBACK_CAP_MS = 7 * 24 * HOUR_MS;
export const REMINDER_SCAN_MS = 5 * 60 * 1000;
export const OUTCOME_SCAN_MS = 60 * 60 * 1000;
export const OUTBOUND_REMINDER_SCAN_JOB = 'OUTBOUND_REMINDER_SCAN';
export const OUTBOUND_OUTCOME_SCAN_JOB = 'OUTBOUND_OUTCOME_SCAN';
export const SCHEDULER_QUEUE = 'SCHEDULER';

export type ReminderStage = (typeof REMINDER_STAGES)[number]['id'];

/** The reminder for the window the visit is in now, plus any earlier ones missed while the server was down. */
export function dueReminderStages(
  startsAt: Date,
  now: Date,
  opts?: { previousRanAt?: string | null; createdAt?: Date }
): ReminderStage[] {
  const remaining = startsAt.getTime() - now.getTime();
  if (remaining <= 0 || remaining > 6 * HOUR_MS) return [];

  const current: ReminderStage = remaining <= 30 * 60 * 1000 ? '30m' : remaining <= 2 * HOUR_MS ? '2h' : '6h';
  const createdMs = opts?.createdAt?.getTime() ?? 0;
  const prev = opts?.previousRanAt ? new Date(opts.previousRanAt).getTime() : NaN;
  const catchingUp = Number.isFinite(prev) && now.getTime() - prev > REMINDER_SCAN_MS * 2;

  return REMINDER_STAGES.filter((stage) => {
    if (remaining > stage.leadMs) return false;
    if (stage.id === current) return true;
    if (!catchingUp || !Number.isFinite(createdMs)) return false;
    const sendAt = startsAt.getTime() - stage.leadMs;
    return sendAt >= createdMs && sendAt > prev;
  }).map((stage) => stage.id);
}

/** How far back to look for missed and completed visits. Extends after a gap, capped at 7 days. */
export function outcomeLookbackMs(now: Date, previousRanAt?: string | null): number {
  if (!previousRanAt) return OUTCOME_LOOKBACK_MS;
  const prev = new Date(previousRanAt).getTime();
  if (!Number.isFinite(prev)) return OUTCOME_LOOKBACK_MS;
  const gap = now.getTime() - prev;
  if (gap <= OUTCOME_LOOKBACK_MS) return OUTCOME_LOOKBACK_MS;
  return Math.min(gap, OUTCOME_LOOKBACK_CAP_MS);
}

async function queueEach(
  rows: Array<{ id: string; clinicId: string }>,
  templateKey: 'REMINDER' | 'FOLLOWUP' | 'MISSED_APPOINTMENT',
  stageFor: (row: { id: string; clinicId: string }) => string | null
) {
  let queued = 0;
  for (const row of rows) {
    const stage = stageFor(row);
    if (!stage) continue;
    try {
      const result = await queueTemplateSends(row.clinicId, templateKey, {
        appointmentIds: [row.id],
        stage,
      });
      queued += result.queued.length;
    } catch (err: any) {
      console.warn(
        `[Outbound schedule] ${templateKey} ${stage} for ${row.id} was not queued:`,
        err?.message || err
      );
    }
  }
  return queued;
}

export async function scanDueReminders(now = new Date(), previousRanAt?: string | null) {
  const until = new Date(now.getTime() + 6 * HOUR_MS);
  const rows = await prisma.appointment.findMany({
    where: {
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startsAt: { gt: now, lte: until },
    },
    select: { id: true, clinicId: true, startsAt: true, createdAt: true },
  });
  let queued = 0;
  for (const row of rows) {
    for (const stage of dueReminderStages(row.startsAt, now, { previousRanAt, createdAt: row.createdAt })) {
      try {
        const result = await queueTemplateSends(row.clinicId, 'REMINDER', {
          appointmentIds: [row.id],
          stage,
        });
        queued += result.queued.length;
      } catch (err: any) {
        console.warn(`[Outbound schedule] REMINDER ${stage} for ${row.id} was not queued:`, err?.message || err);
      }
    }
  }
  return { checked: rows.length, queued };
}

export async function scanMissedAndCompleted(now = new Date(), previousRanAt?: string | null) {
  const since = new Date(now.getTime() - outcomeLookbackMs(now, previousRanAt));
  const missed = await prisma.appointment.findMany({
    where: {
      OR: [
        { status: 'NO_SHOW', startsAt: { gte: since, lte: now } },
        {
          status: { in: ['SCHEDULED', 'CONFIRMED'] },
          endsAt: { gte: since, lte: now },
        },
      ],
    },
    select: { id: true, clinicId: true },
  });
  const completed = await prisma.appointment.findMany({
    where: {
      status: 'COMPLETED',
      endsAt: { gte: since, lte: now },
    },
    select: { id: true, clinicId: true },
  });
  let queued = 0;
  const missedResult = await queueEach(missed, 'MISSED_APPOINTMENT', () => 'once');
  const followResult = await queueEach(completed, 'FOLLOWUP', () => 'once');
  queued += missedResult + followResult;
  return { missed: missed.length, completed: completed.length, queued };
}

export async function ensureOutboundSchedulerJobs() {
  await ensureSchedulerJob(OUTBOUND_REMINDER_SCAN_JOB);
  await ensureSchedulerJob(OUTBOUND_OUTCOME_SCAN_JOB);
}

async function ensureSchedulerJob(type: string) {
  const live = await prisma.job.findFirst({
    where: { type, status: { in: ['PENDING', 'PROCESSING'] } },
    select: { id: true },
  });
  if (live) return;
  const previous = await prisma.job.findFirst({
    where: { type },
    orderBy: { updatedAt: 'desc' },
    select: { payload: true },
  });
  const previousRanAt =
    previous?.payload &&
    typeof previous.payload === 'object' &&
    !Array.isArray(previous.payload) &&
    typeof previous.payload.previousRanAt === 'string'
      ? previous.payload.previousRanAt
      : undefined;
  await prisma.job.create({
    data: {
      queue: SCHEDULER_QUEUE,
      type,
      status: 'PENDING',
      availableAt: new Date(),
      maxAttempts: 5,
      payload: {
        note: previousRanAt
          ? 'Restarted after the last run failed. This run catches up from that time.'
          : 'Waiting for the first run. If the server was down, this run catches up.',
        ...(previousRanAt ? { previousRanAt } : {}),
      },
    },
  });
}
