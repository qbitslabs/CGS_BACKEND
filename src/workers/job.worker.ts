/* Background job worker for CGS (reminders, sync, usage).
 * Runs off the request path against Prisma and queues. */
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { decryptToken } from '../utils/crypto.js';

let isRunning = false;
let shouldStop = false;
const workerId = `worker-${process.pid}-${Math.random().toString(36).substring(7)}`;

export const startJobWorker = async () => {
  if (isRunning) return;
  isRunning = true;
  console.log(`[Worker] Started background job worker [${workerId}]`);

  const pollInterval = env.WORKER_POLL_INTERVAL_MS || 1000;

  const loop = async () => {
    if (shouldStop) {
      console.log(`[Worker] Worker [${workerId}] gracefully stopped.`);
      isRunning = false;
      return;
    }

    try {
      // 1. Recover stale processing jobs if any
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      await prisma.job.updateMany({
        where: {
          status: 'PROCESSING',
          lockedAt: { lt: fiveMinutesAgo },
        },
        data: {
          status: 'PENDING',
          lockedAt: null,
          lockedBy: null,
        },
      });

      // 2. Claim pending jobs atomically
      const pendingJobs = await prisma.job.findMany({
        where: {
          status: 'PENDING',
          availableAt: { lte: new Date() },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: env.WORKER_CONCURRENCY || 5,
      });

      for (const job of pendingJobs) {
        // Attempt to claim job
        const claimed = await prisma.job.updateMany({
          where: {
            id: job.id,
            status: 'PENDING',
          },
          data: {
            status: 'PROCESSING',
            lockedAt: new Date(),
            lockedBy: workerId,
            attempts: { increment: 1 },
          },
        });

        if (claimed.count === 0) continue; // Another worker claimed it

        // Process claimed job
        try {
          await executeJobHandler(job);

          await prisma.job.update({
            where: { id: job.id },
            data: {
              status: 'COMPLETED',
              completedAt: new Date(),
            },
          });
        } catch (jobError: any) {
          console.error(`[Worker] Failed job ${job.id} (${job.type}):`, jobError.message);

          const isMaxAttempts = job.attempts + 1 >= job.maxAttempts;
          const nextStatus = isMaxAttempts ? 'FAILED' : 'PENDING';
          const backoffSeconds = Math.min(Math.pow(2, job.attempts) * 5, 300);

          await prisma.job.update({
            where: { id: job.id },
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
    } catch (err: any) {
      console.error('[Worker] Error in worker polling loop:', err.message);
    }

    setTimeout(loop, pollInterval);
  };

  loop();
};

export const stopJobWorker = () => {
  shouldStop = true;
};

async function executeJobHandler(job: { id: string; type: string; payload: any; clinicId: string | null }) {
  // Dispatch job handlers based on type
  switch (job.type) {
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
        waAccount = await prisma.whatsappAccount.findFirst({
          where: { isActive: true },
        });
      }

      const phoneNumberId = waAccount?.phoneNumberId || waAccount?.businessAccountId || '104882919284918';
      const rawStoredToken = waAccount?.accessTokenEncrypted || '';
      const accessToken = (rawStoredToken ? decryptToken(rawStoredToken) : '') || process.env.WHATSAPP_ACCESS_TOKEN || 'EAAG_PLACEHOLDER_TOKEN';

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

    case 'APPOINTMENT_REMINDER_DISPATCH': {
      // Reminder worker not productized yet — acknowledge without fake success side-effects.
      console.warn(`[Worker] APPOINTMENT_REMINDER_DISPATCH skipped (not implemented). job=${job.id}`);
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
