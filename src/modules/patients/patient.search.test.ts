import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('../../config/db.js', () => ({
  prisma: {
    patient: { findMany: mocks.findMany, count: vi.fn() },
  },
}));

import { patientRepository } from './patient.repository.js';

describe('patient search', () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.findMany.mockResolvedValue([]);
  });

  it('searches name and phone inside one clinic', async () => {
    await patientRepository.findMany({ clinicId: 'clinic-a', search: 'Ana', page: 1, limit: 20 });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.clinicId).toBe('clinic-a');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { name: { contains: 'Ana', mode: 'insensitive' } },
        { phone: { contains: 'Ana' } },
      ])
    );
  });

  it('also searches the digits of a phone number', async () => {
    await patientRepository.findMany({ clinicId: 'clinic-a', search: '98765 43210', page: 1, limit: 20 });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([{ phone: { contains: '9876543210' } }])
    );
  });

  it('returns no rows when the query matches nothing', async () => {
    const rows = await patientRepository.findMany({ clinicId: 'clinic-a', search: 'nobody', page: 1, limit: 20 });
    expect(rows).toEqual([]);
    expect(mocks.findMany.mock.calls[0][0].take).toBe(20);
  });
});
