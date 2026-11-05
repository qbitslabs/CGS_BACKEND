import { describe, expect, it } from 'vitest';
import { AppError } from '../../middleware/errorHandler.js';
import { assertEarlyBirdAvailable, addonOffer, packageMonthlyAmount, seedBrochurePlans } from './planCatalog.js';

describe('brochure plan seed', () => {
  it('updates an existing tier without changing the billed monthly price', async () => {
    const updates: Record<string, unknown>[] = [];
    const creates: Record<string, unknown>[] = [];
    const db = {
      subscriptionPlan: {
        findFirst: async ({ where }: { where: { tier: string } }) =>
          where.tier === 'GROWTH' ? { id: 'growth-id', tier: 'GROWTH' } : null,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          creates.push(data);
        },
      },
    };

    await seedBrochurePlans(db as never);

    const growth = updates.find((row) => row.name === 'Growth');
    expect(growth).toBeTruthy();
    expect(growth).not.toHaveProperty('priceMonthly');
    expect(growth?.aiRepliesMonthly).toBe(900);
    expect(creates.map((row) => row.tier)).toEqual(['STARTER', 'ENTERPRISE']);
    expect(creates.find((row) => row.tier === 'STARTER')?.priceMonthly).toBe(10000);
    expect(growth?.automationKeys).toEqual([
      'NEW_ENQUIRY',
      'INVOICE_WHATSAPP',
      'APPOINTMENT_REMINDER',
      'MISSED_APPOINTMENT',
      'COMPLETED_VISIT',
    ]);
  });
});

describe('assertEarlyBirdAvailable', () => {
  function store(already: boolean, otherCount: number) {
    return {
      cgsSubscription: {
        findFirst: async () => (already ? { id: 'sub' } : null),
        groupBy: async () => Array.from({ length: otherCount }, (_, index) => ({ clinicId: `clinic-${index}` })),
      },
    };
  }

  it('allows a clinic that already has Early Bird', async () => {
    await expect(assertEarlyBirdAvailable(store(true, 5), 'clinic-a')).resolves.toBeUndefined();
  });

  it('allows a sixth clinic when only four others have Early Bird', async () => {
    await expect(assertEarlyBirdAvailable(store(false, 4), 'clinic-a')).resolves.toBeUndefined();
  });

  it('refuses a sixth new Early Bird clinic', async () => {
    await expect(assertEarlyBirdAvailable(store(false, 5), 'clinic-a')).rejects.toBeInstanceOf(AppError);
  });
});

describe('add-on offers', () => {
  it('prices an Essential extra doctor and refuses extras the plan cannot buy', () => {
    expect(addonOffer('STARTER', 'EXTRA_DOCTOR').price).toBe(1000);
    expect(addonOffer('STARTER', 'EXTRA_AUTOMATION', 'MISSED_APPOINTMENT').price).toBe(500);
    expect(addonOffer('GROWTH', 'EXTRA_AUTOMATION', 'PATIENT_REACTIVATION').price).toBe(500);
    expect(() => addonOffer('GROWTH', 'EXTRA_AUTOMATION', 'MISSED_APPOINTMENT')).toThrow(AppError);
    expect(() => addonOffer('ENTERPRISE', 'PRIORITY_SUPPORT')).toThrow(AppError);
  });
});

describe('package monthly fee', () => {
  const scale = { regularMonthlyPrice: 18000, earlyBirdMonthlyPrice: 15000, priceMonthly: 25000 };
  it('uses the tier price instead of the old billed amount', () => {
    expect(packageMonthlyAmount(scale, false)).toBe(18000);
    expect(packageMonthlyAmount(scale, true)).toBe(15000);
    expect(packageMonthlyAmount({ priceMonthly: 12000 }, false)).toBe(12000);
  });
});
