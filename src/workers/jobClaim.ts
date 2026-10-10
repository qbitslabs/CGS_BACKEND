/* Atomic job claim. SKIP LOCKED lets several workers poll the same table. */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';

export const AI_GENERATE_REPLY_JOB = 'AI_GENERATE_REPLY';

export type ClaimedJobRow = {
  id: string;
  job_type: string;
  payload: Prisma.JsonValue;
  clinic_id: string | null;
  attempts: number;
  max_attempts: number;
};

export type ClaimOptions = {
  jobType?: string;
  excludeJobType?: string;
  /** Claim at most one pending job per conversation, and none while one is already running. */
  onePerConversation?: boolean;
};

export async function claimPendingJobs(
  workerId: string,
  limit: number,
  options?: ClaimOptions
): Promise<ClaimedJobRow[]> {
  if (options?.jobType || options?.excludeJobType) {
    return claimFilteredJobs(workerId, limit, options);
  }

  return prisma.$queryRaw<ClaimedJobRow[]>`
    WITH picked AS (
      SELECT id
      FROM jobs
      WHERE status = 'PENDING'::"JobStatus"
        AND available_at <= NOW()
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE jobs AS j
    SET status = 'PROCESSING'::"JobStatus",
        locked_at = NOW(),
        locked_by = ${workerId},
        attempts = j.attempts + 1,
        updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.job_type, j.payload, j.clinic_id, j.attempts, j.max_attempts
  `;
}

async function claimFilteredJobs(
  workerId: string,
  limit: number,
  options: ClaimOptions
): Promise<ClaimedJobRow[]> {
  const typeFilter = options.jobType
    ? Prisma.sql`AND j.job_type = ${options.jobType}`
    : Prisma.sql`AND j.job_type <> ${options.excludeJobType}`;

  const onePerConversation = options.onePerConversation
    ? Prisma.sql`
        AND NOT EXISTS (
          SELECT 1
          FROM jobs busy
          WHERE busy.job_type = j.job_type
            AND busy.payload->>'conversationId' = j.payload->>'conversationId'
            AND busy.id <> j.id
            AND (
              busy.status = 'PROCESSING'::"JobStatus"
              OR (
                busy.status = 'PENDING'::"JobStatus"
                AND (
                  busy.created_at < j.created_at
                  OR (busy.created_at = j.created_at AND busy.id < j.id)
                )
              )
            )
        )`
    : Prisma.empty;

  return prisma.$queryRaw<ClaimedJobRow[]>`
    WITH picked AS (
      SELECT j.id
      FROM jobs j
      WHERE j.status = 'PENDING'::"JobStatus"
        AND j.available_at <= NOW()
        ${typeFilter}
        ${onePerConversation}
      ORDER BY j.priority DESC, j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE jobs AS j
    SET status = 'PROCESSING'::"JobStatus",
        locked_at = NOW(),
        locked_by = ${workerId},
        attempts = j.attempts + 1,
        updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.job_type, j.payload, j.clinic_id, j.attempts, j.max_attempts
  `;
}

export async function recoverStaleProcessingJobs(
  staleBefore: Date,
  options?: { jobType?: string; excludeJobType?: string }
) {
  return prisma.job.updateMany({
    where: {
      status: 'PROCESSING',
      lockedAt: { lt: staleBefore },
      ...(options?.jobType ? { type: options.jobType } : {}),
      ...(options?.excludeJobType ? { type: { not: options.excludeJobType } } : {}),
    },
    data: {
      status: 'PENDING',
      lockedAt: null,
      lockedBy: null,
    },
  });
}
