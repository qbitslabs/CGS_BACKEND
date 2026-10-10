/* Background job worker for CGS (reminders, sync, usage).
 * WhatsApp sends stay on the serial loop. AI replies run beside them, up to AI_REPLY_CONCURRENCY. */
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { conversationService } from '../modules/conversations/conversation.service.js';
import { decryptToken } from '../utils/crypto.js';
import { executeTemplateSendJob, markTemplateSendFailed } from '../modules/whatsapp/outbound.service.js';
import {
  ensureOutboundSchedulerJobs,
  OUTBOUND_OUTCOME_SCAN_JOB,
  OUTBOUND_REMINDER_SCAN_JOB,
  OUTCOME_SCAN_MS,
  REMINDER_SCAN_MS,
  scanDueReminders,
  scanMissedAndCompleted,
} from '../modules/whatsapp/outbound.schedule.js';
import { WHATSAPP_TEMPLATE_SEND_JOB } from '../modules/whatsapp/whatsappTemplates.js';
import { AI_GENERATE_REPLY_JOB, ClaimedJobRow, claimPendingJobs, recoverStaleProcessingJobs } from './jobClaim.js';

let isRunning = false;
let shouldStop = false;
let inFlight = 0;
let aiInFlight = 0;
let aiPollActive = false;
const stopWaiters: Array<() => void> = [];
const workerId = `worker-${process.pid}-${Math.random().toString(36).substring(7)}`;
let lastSchedulerEnsure = 0;

function isOutboundSchedulerJob(type: string) {
  return type === OUTBOUND_REMINDER_SCAN_JOB || type === OUTBOUND_OUTCOME_SCAN_JOB;
}

function schedulerDelayMs(type: string) {
  return type === OUTBOUND_REMINDER_SCAN_JOB ? REMINDER_SCAN_MS : OUTCOME_SCAN_MS;
}

function notifyIfStopped() {
  if (!shouldStop || inFlight > 0 || aiInFlight > 0) return;
  isRunning = false;
  while (stopWaiters.length) {
    stopWaiters.shift()?.();
  }
}

export const startJobWorker = async () => {
  if (isRunning) return;
  isRunning = true;
  shouldStop = false;
  const aiConcurrency = Number.isFinite(env.AI_REPLY_CONCURRENCY) && env.AI_REPLY_CONCURRENCY > 0
    ? env.AI_REPLY_CONCURRENCY
    : 10;
  console.log(`[Worker] Started background job worker [${workerId}]`);
  console.log(`[Worker] AI reply queue concurrency ${aiConcurrency}`);

  const pollInterval = env.WORKER_POLL_INTERVAL_MS || 1000;

  const loop = async () => {
    if (shouldStop) {
      console.log(`[Worker] Worker [${workerId}] gracefully stopped.`);
      notifyIfStopped();
      return;
    }

    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      await recoverStaleProcessingJobs(fiveMinutesAgo, { excludeJobType: AI_GENERATE_REPLY_JOB });

      const pendingJobs = await claimPendingJobs(workerId, env.WORKER_CONCURRENCY || 5, {
        excludeJobType: AI_GENERATE_REPLY_JOB,
      });

      for (const job of pendingJobs) {
        if (shouldStop) break;
        inFlight += 1;
        try {
          await settleJob(job);
        } finally {
          inFlight -= 1;
        }
      }
    } catch (err: any) {
      console.error('[Worker] Error in worker polling loop:', err.message);
    }

    if (Date.now() - lastSchedulerEnsure >= 30_000) {
      lastSchedulerEnsure = Date.now();
      try {
        await ensureOutboundSchedulerJobs();
      } catch (err: any) {
        console.error('[Worker] Could not ensure outbound scheduler jobs:', err.message);
      }
    }

    if (shouldStop) {
      console.log(`[Worker] Worker [${workerId}] gracefully stopped.`);
      notifyIfStopped();
      return;
    }

    setTimeout(loop, pollInterval);
  };

  const aiLoop = async () => {
    if (shouldStop) {
      notifyIfStopped();
      return;
    }
    if (aiPollActive) {
      setTimeout(aiLoop, pollInterval);
      return;
    }
    aiPollActive = true;
    try {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      await recoverStaleProcessingJobs(twoMinutesAgo, { jobType: AI_GENERATE_REPLY_JOB });

      const slots = Math.max(aiConcurrency - aiInFlight, 0);
      if (slots > 0) {
        const aiJobs = await claimPendingJobs(workerId, slots, {
          jobType: AI_GENERATE_REPLY_JOB,
          onePerConversation: true,
        });
        for (const job of aiJobs) {
          aiInFlight += 1;
          void settleJob(job).finally(() => {
            aiInFlight -= 1;
            notifyIfStopped();
          });
        }
      }
    } catch (err: any) {
      console.error('[Worker] Error in AI reply loop:', err.message);
    } finally {
      aiPollActive = false;
    }

    if (shouldStop) {
      notifyIfStopped();
      return;
    }
    setTimeout(aiLoop, pollInterval);
  };

  loop();
  aiLoop();
};

async function settleJob(job: ClaimedJobRow) {
  try {
    await executeJobHandler({
      id: job.id,
      type: job.job_type,
      payload: job.payload,
      clinicId: job.clinic_id,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
    });

    if (isOutboundSchedulerJob(job.job_type)) {
      const parked = await prisma.job.updateMany({
        where: { id: job.id, status: 'PROCESSING', lockedBy: workerId },
        data: {
          status: 'PENDING',
          availableAt: new Date(Date.now() + schedulerDelayMs(job.job_type)),
          completedAt: new Date(),
          attempts: 0,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
        },
      });
      if (parked.count === 0) {
        console.warn(`[Worker] Scheduler job ${job.id} was reclaimed before it could be parked.`);
      }
      return;
    }

    const completed = await prisma.job.updateMany({
      where: { id: job.id, status: 'PROCESSING', lockedBy: workerId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        lockedAt: null,
      },
    });
    if (completed.count === 0) {
      console.warn(`[Worker] Job ${job.id} was reclaimed before completion; leaving the new owner's status.`);
    }
  } catch (jobError: any) {
    console.error(`[Worker] Failed job ${job.id} (${job.job_type}):`, jobError.message);

    const isMaxAttempts = job.attempts >= job.max_attempts;
    const nextStatus = isMaxAttempts ? 'FAILED' : 'PENDING';
    const backoffSeconds = Math.min(Math.pow(2, Math.max(job.attempts - 1, 0)) * 5, 300);

    await prisma.job.updateMany({
      where: { id: job.id, status: 'PROCESSING', lockedBy: workerId },
      data: {
        status: nextStatus,
        lastError: jobError.message || 'Unknown error',
        availableAt: new Date(Date.now() + backoffSeconds * 1000),
        lockedAt: null,
        lockedBy: null,
      },
    });
  }
}

export const stopJobWorker = (timeoutMs = 7000): Promise<void> => {
  shouldStop = true;
  if (!isRunning && inFlight === 0 && aiInFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    stopWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    notifyIfStopped();
  });
};

async function executeJobHandler(job: {
  id: string;
  type: string;
  payload: any;
  clinicId: string | null;
  attempts: number;
  maxAttempts: number;
}) {
  // Dispatch job handlers based on type
  switch (job.type) {
    case AI_GENERATE_REPLY_JOB: {
      const payload = job.payload as { conversationId?: string; userText?: string; clinicId?: string };
      const clinicId = job.clinicId || payload?.clinicId;
      const conversationId = payload?.conversationId;
      const userText = String(payload?.userText || '').trim();
      if (!clinicId || !conversationId || !userText) {
        throw new Error('Invalid AI_GENERATE_REPLY payload: clinicId, conversationId, and userText required');
      }
      const lastAttempt = job.attempts >= job.maxAttempts;
      console.log(
        `[Worker] AI reply job ${job.id} conversation=${conversationId} attempt=${job.attempts}/${job.maxAttempts}`
      );
      await conversationService.generateAndPersistReply(clinicId, conversationId, userText, {
        fallbackOnError: lastAttempt,
      });
      break;
    }

    case WHATSAPP_TEMPLATE_SEND_JOB: {
      try {
        await executeTemplateSendJob({
          clinicId: job.clinicId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          payload: job.payload,
        });
        const messageId = job.payload?.messageId;
        if (job.clinicId && messageId) {
          const saved = await prisma.message.findFirst({
            where: { id: messageId, clinicId: job.clinicId },
            select: { providerMessageId: true },
          });
          if (!saved?.providerMessageId || saved.providerMessageId.startsWith('pending:')) {
            throw new Error('WhatsApp send finished without a Meta message id');
          }
        }
      } catch (err) {
        if (job.attempts >= job.maxAttempts && job.clinicId && job.payload?.messageId) {
          await markTemplateSendFailed(job.payload.messageId, job.clinicId);
        }
        throw err;
      }
      break;
    }

    case 'WHATSAPP_SEND': {
      const payload = job.payload as {
        messageId?: string;
        conversationId?: string;
        recipientPhone: string;
        content: string;
        document?: { filename: string; mimeType: string; base64: string };
      };

      if (!payload || !payload.recipientPhone || !payload.content) {
        throw new Error('Invalid WHATSAPP_SEND payload: recipientPhone and content required');
      }

      // 1. Fetch clinic's active WhatsApp account
      let waAccount = null;
      if (job.clinicId) {
        waAccount = await prisma.whatsappAccount.findFirst({
          where: { clinicId: job.clinicId, isActive: true },
        });
      }
      if (!waAccount) {
        throw new Error('WhatsApp account is not configured for this clinic');
      }

      const phoneNumberId = waAccount.phoneNumberId;
      const rawStoredToken = waAccount.accessTokenEncrypted || '';
      const accessToken = rawStoredToken ? decryptToken(rawStoredToken) : '';
      if (!phoneNumberId || !accessToken) {
        throw new Error('WhatsApp account is not configured for this clinic');
      }

      console.log(`[Worker] Dispatching WHATSAPP_SEND via WhatsApp Gateway at ${env.WHATSAPP_SERVICE_URL} for recipient ${payload.recipientPhone}`);

      try {
        const response = await fetch(`${env.WHATSAPP_SERVICE_URL}/w_api/v1/whatsapp/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': env.INTERNAL_SERVICE_SECRET,
          },
          body: JSON.stringify({
            phoneNumberId,
            recipientPhone: payload.recipientPhone,
            accessToken,
            text: payload.content,
            ...(payload.document?.base64
              ? {
                  document: {
                    filename: payload.document.filename,
                    mimeType: payload.document.mimeType || 'application/pdf',
                    base64: payload.document.base64,
                  },
                }
              : {}),
          }),
        });

        const resData = (await response.json().catch(() => ({}))) as any;

        if (!response.ok) {
          console.warn(`[Worker] WhatsApp gateway returned ${response.status}:`, resData);
          if (payload.messageId) {
            await prisma.message.updateMany({
              where: { id: payload.messageId },
              data: { status: 'FAILED' },
            });
          }
          throw new Error(resData?.error || `WhatsApp Gateway Error: ${response.statusText}`);
        }

        if (payload.messageId) {
          await prisma.message.updateMany({
            where: { id: payload.messageId },
            data: {
              status: 'DELIVERED',
              providerMessageId: resData?.data?.messages?.[0]?.id || undefined,
            },
          });
        }
        console.log(`[Worker] Successfully dispatched WhatsApp message for job ${job.id}`);
      } catch (err: any) {
        console.error(`[Worker] Failed dispatching WhatsApp message:`, err.message);
        throw err;
      }
      break;
    }

    case OUTBOUND_REMINDER_SCAN_JOB: {
      const payload = (job.payload || {}) as { previousRanAt?: string };
      const summary = await scanDueReminders(new Date(), payload.previousRanAt);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          payload: {
            note: `Reminder check finished. Queued ${summary.queued} message${summary.queued === 1 ? '' : 's'} across ${summary.checked} upcoming visits.`,
            previousRanAt: new Date().toISOString(),
            checked: summary.checked,
            queued: summary.queued,
          },
        },
      });
      break;
    }

    case OUTBOUND_OUTCOME_SCAN_JOB: {
      const payload = (job.payload || {}) as { previousRanAt?: string };
      const now = new Date();
      const summary = await scanMissedAndCompleted(now, payload.previousRanAt);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          payload: {
            note: `Missed and follow-up check finished. Queued ${summary.queued}. Reviewed ${summary.missed} missed and ${summary.completed} completed visits.`,
            previousRanAt: now.toISOString(),
            missed: summary.missed,
            completed: summary.completed,
            queued: summary.queued,
          },
        },
      });
      break;
    }

    case 'APPOINTMENT_REMINDER_DISPATCH': {
      await scanDueReminders(new Date());
      break;
    }

    case 'META_ADS_SYNC': {
      console.warn(`[Worker] META_ADS_SYNC skipped (not implemented). clinic=${job.clinicId}`);
      break;
    }

    default:
      console.log(`[Worker] No explicit handler for job type '${job.type}'. Marked as COMPLETED.`);
  }
}
