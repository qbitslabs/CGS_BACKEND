import { describe, expect, it, vi } from 'vitest';
import { createLeadSchema } from './lead.schema.js';

vi.mock('../../config/db.js', () => ({
  prisma: { appointment: { findMany: vi.fn() } },
}));
vi.mock('../../middleware/audit.js', () => ({ logAuditEvent: vi.fn() }));

import { LeadService } from './lead.service.js';

const base = { name: 'Ravi', phone: '9876543210' };

describe('lead source', () => {
  it('accepts a walk-in lead', () => {
    expect(createLeadSchema.parse({ ...base, source: 'Walk-in' }).source).toBe('WALK_IN');
    expect(createLeadSchema.parse({ ...base, source: 'WALK-IN' }).source).toBe('WALK_IN');
  });

  it('keeps the existing sources', () => {
    expect(createLeadSchema.parse({ ...base, source: 'WhatsApp' }).source).toBe('WHATSAPP');
    expect(createLeadSchema.parse({ ...base, source: 'Google Ad' }).source).toBe('GOOGLE_AD');
    expect(createLeadSchema.parse({ ...base }).source).toBe('WHATSAPP');
  });

  it('rejects an unknown source', () => {
    expect(() => createLeadSchema.parse({ ...base, source: 'Fax' })).toThrow();
  });

  it('stores Walk-in and returns that label', async () => {
    const repo = {
      createWithActivity: vi.fn(async (_clinicId: string, dto: { source: string }) => ({
        id: 'lead-1',
        name: 'Ravi',
        phone: '9876543210',
        source: dto.source,
        status: 'NEW',
        activities: [],
      })),
      findById: vi.fn(async () => ({
        id: 'lead-1',
        name: 'Ravi',
        phone: '9876543210',
        source: 'WALK_IN',
        status: 'NEW',
        activities: [],
      })),
    };
    const service = new LeadService(repo as any);
    const created = await service.createLead(
      'clinic-a',
      createLeadSchema.parse({ ...base, source: 'Walk-in' }),
      {}
    );
    expect(repo.createWithActivity).toHaveBeenCalledWith('clinic-a', expect.objectContaining({ source: 'WALK_IN' }), 'System');
    expect(created.source).toBe('Walk-in');

    const loaded = await service.getLeadById('lead-1', 'clinic-a');
    expect(loaded.source).toBe('Walk-in');
    expect(repo.findById).toHaveBeenCalledWith('lead-1', 'clinic-a');
  });
});
