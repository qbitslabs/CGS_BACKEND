import { describe, expect, it, vi } from 'vitest';

vi.mock('../admin/entitlements.js', () => ({
  outboundAllowed: vi.fn(),
}));

vi.mock('./outbound.service.js', () => ({
  previewTemplateSends: vi.fn(),
  queueTemplateSends: vi.fn(),
  publicTemplate: (template: { key: string }) => template,
}));

import { outboundAllowed } from '../admin/entitlements.js';
import { queueTemplateSends } from './outbound.service.js';
import { sendOutbound } from './outbound.controller.js';

const invoiceId = '11111111-1111-4111-8111-111111111111';

describe('staff outbound campaign', () => {
  it('refuses Essential and Growth outbound campaign sends', async () => {
    vi.mocked(outboundAllowed).mockResolvedValue(false);
    const res = { status: vi.fn(), json: vi.fn() };

    for (const clinicId of ['clinic-essential', 'clinic-growth']) {
      const next = vi.fn();
      await sendOutbound(
        { clinicId, body: { templateKey: 'BILL', invoiceIds: [invoiceId] } } as never,
        res as never,
        next
      );
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'OUTBOUND_PLAN' }));
    }

    expect(queueTemplateSends).not.toHaveBeenCalled();
  });

  it('queues the send when outbound campaigns are allowed', async () => {
    vi.mocked(outboundAllowed).mockResolvedValue(true);
    vi.mocked(queueTemplateSends).mockResolvedValue({ queued: [], skipped: [] } as never);
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await sendOutbound(
      { clinicId: 'clinic-scale', body: { templateKey: 'BILL', invoiceIds: [invoiceId] } } as never,
      res as never,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(queueTemplateSends).toHaveBeenCalledWith('clinic-scale', 'BILL', expect.objectContaining({ invoiceIds: [invoiceId] }));
    expect(res.status).toHaveBeenCalledWith(202);
  });
});
