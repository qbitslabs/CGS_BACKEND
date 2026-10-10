import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/db.js', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => []),
    job: { updateMany: vi.fn(async () => ({ count: 1 })) },
  },
}));

import { prisma } from '../config/db.js';
import { AI_GENERATE_REPLY_JOB, claimPendingJobs, recoverStaleProcessingJobs } from './jobClaim.js';

function sqlText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = '';
  strings.forEach((part, index) => {
    out += part;
    const value = values[index];
    if (value && typeof value === 'object' && 'strings' in value && 'values' in value) {
      const nested = value as { strings: TemplateStringsArray; values: unknown[] };
      out += sqlText(nested.strings, nested.values);
    }
  });
  return out;
}

function lastQueryText(): string {
  const call = (prisma.$queryRaw as any).mock.calls.at(-1);
  return sqlText(call[0] as TemplateStringsArray, call.slice(1));
}

describe('job claim', () => {
  it('claims with FOR UPDATE SKIP LOCKED and preserves pending status', async () => {
    await claimPendingJobs('worker-a', 3);
    const sql = ((prisma.$queryRaw as any).mock.calls[0][0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain("status = 'PROCESSING'");
    expect(sql).toContain('attempts = j.attempts + 1');
  });

  it('can leave AI reply jobs for the parallel queue', async () => {
    await claimPendingJobs('worker-a', 5, { excludeJobType: AI_GENERATE_REPLY_JOB });
    const sql = lastQueryText();
    expect(sql).toContain('FOR UPDATE OF j SKIP LOCKED');
    expect(sql).toContain('job_type <>');
  });

  it('claims one AI reply per conversation while another is still running', async () => {
    await claimPendingJobs('worker-a', 10, {
      jobType: AI_GENERATE_REPLY_JOB,
      onePerConversation: true,
    });
    const sql = lastQueryText();
    expect(sql).toContain('job_type =');
    expect(sql).toContain("busy.status = 'PROCESSING'");
    expect(sql).toContain("payload->>'conversationId'");
    expect(sql).toContain('FOR UPDATE OF j SKIP LOCKED');
  });

  it('returns only stale processing jobs to the queue', async () => {
    const cutoff = new Date('2026-10-06T00:00:00Z');
    await recoverStaleProcessingJobs(cutoff);
    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { status: 'PROCESSING', lockedAt: { lt: cutoff } },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    });
  });

  it('can recover one job type without touching the others', async () => {
    const cutoff = new Date('2026-10-06T00:00:00Z');
    await recoverStaleProcessingJobs(cutoff, { jobType: AI_GENERATE_REPLY_JOB });
    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { status: 'PROCESSING', lockedAt: { lt: cutoff }, type: AI_GENERATE_REPLY_JOB },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    });
  });
});
