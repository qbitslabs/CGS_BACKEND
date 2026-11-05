import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db.js', () => ({
  prisma: {
    appointment: { findMany: vi.fn() },
    message: { findFirst: vi.fn(), updateMany: vi.fn() },
    whatsappAccount: { findFirst: vi.fn() },
  },
}));

vi.mock('../admin/entitlements.js', () => ({
  automationAllowed: vi.fn(),
}));

vi.mock('./outbound.service.js', async () => {
  const actual = await vi.importActual<typeof import('./outbound.service.js')>('./outbound.service.js');
  return {
    ...actual,
    queueTemplateSends: vi.fn(async () => ({ queued: [], skipped: [] })),
  };
});

import { prisma } from '../../config/db.js';
import { automationAllowed } from '../admin/entitlements.js';
import { scanMissedAndCompleted } from './outbound.schedule.js';
import { executeTemplateSendJob } from './outbound.service.js';

const reactivation = (messageId: string) => ({
  clinicId: '',
  attempts: 1,
  maxAttempts: 3,
  payload: {
    messageId,
    recipientPhone: '919876543210',
    templateKey: 'OLD_PATIENT_REACTIVATION',
    templateName: 'cgs_patient_reactivation',
    languageCode: 'en',
    parameters: ['Ana', 'City Clinic', '01 Oct 2026'],
  },
});

describe('phase 8 workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.whatsappAccount.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.message.findFirst).mockImplementation(async (args: any) => ({
      id: args.where.id,
      providerMessageId: null,
    }));
  });

  it('queues missed and completed sends for the clinic that owns each visit', async () => {
    vi.mocked(prisma.appointment.findMany)
      .mockResolvedValueOnce([
        { id: 'miss-a', clinicId: 'clinic-a' },
        { id: 'miss-b', clinicId: 'clinic-b' },
      ] as never)
      .mockResolvedValueOnce([
        { id: 'done-a', clinicId: 'clinic-a' },
        { id: 'done-b', clinicId: 'clinic-b' },
      ] as never);

    const { queueTemplateSends } = await import('./outbound.service.js');
    await scanMissedAndCompleted(new Date('2026-11-06T12:00:00.000Z'));

    expect(queueTemplateSends).toHaveBeenCalledWith('clinic-a', 'MISSED_APPOINTMENT', {
      appointmentIds: ['miss-a'],
      stage: 'once',
    });
    expect(queueTemplateSends).toHaveBeenCalledWith('clinic-b', 'MISSED_APPOINTMENT', {
      appointmentIds: ['miss-b'],
      stage: 'once',
    });
    expect(queueTemplateSends).toHaveBeenCalledWith('clinic-a', 'FOLLOWUP', {
      appointmentIds: ['done-a'],
      stage: 'once',
    });
    expect(queueTemplateSends).toHaveBeenCalledWith('clinic-b', 'FOLLOWUP', {
      appointmentIds: ['done-b'],
      stage: 'once',
    });
  });

  it('checks the entitlement of the clinic that owns the send job', async () => {
    vi.mocked(automationAllowed).mockImplementation(async (clinicId: string) => clinicId === 'clinic-scale');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const growthJob = reactivation('msg-growth');
    growthJob.clinicId = 'clinic-growth';
    const scaleJob = reactivation('msg-scale');
    scaleJob.clinicId = 'clinic-scale';

    await expect(executeTemplateSendJob(growthJob)).resolves.toBe('skipped');
    await expect(executeTemplateSendJob(scaleJob)).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONFIGURED' });

    expect(automationAllowed).toHaveBeenNthCalledWith(1, 'clinic-growth', 'PATIENT_REACTIVATION');
    expect(automationAllowed).toHaveBeenNthCalledWith(2, 'clinic-scale', 'PATIENT_REACTIVATION');
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'msg-growth', clinicId: 'clinic-growth' }) }),
    );
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'msg-scale', clinicId: 'clinic-scale' }) }),
    );
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'msg-growth', clinicId: 'clinic-growth' }),
        data: { status: 'FAILED' },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
