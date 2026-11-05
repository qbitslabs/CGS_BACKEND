import { describe, expect, it } from 'vitest';
import { addMonths, monthsToBill } from './subscriptionBill.job.js';

describe('monthsToBill', () => {
  it('bills the open period once', () => {
    const periods = monthsToBill({
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-11-01T00:00:00.000Z'),
      now: new Date('2026-10-30T00:00:00.000Z'),
      autoRenew: true,
    });
    expect(periods).toHaveLength(1);
    expect(periods[0].periodStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('catches up closed months when the subscription renews', () => {
    const periods = monthsToBill({
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      now: new Date('2026-10-30T00:00:00.000Z'),
      autoRenew: true,
    });
    expect(periods.map((period) => period.periodStart.toISOString())).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ]);
  });

  it('does not open another period when auto renew is off', () => {
    const periods = monthsToBill({
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      now: new Date('2026-10-30T00:00:00.000Z'),
      autoRenew: false,
    });
    expect(periods).toHaveLength(1);
  });

  it('keeps month ends on the last real day', () => {
    expect(addMonths(new Date('2026-07-31T18:30:00.000Z'), 1).toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(addMonths(new Date('2026-08-31T18:30:00.000Z'), 1).toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('skips a period that has not started', () => {
    const periods = monthsToBill({
      periodStart: new Date('2026-12-01T00:00:00.000Z'),
      periodEnd: new Date('2027-01-01T00:00:00.000Z'),
      now: new Date('2026-10-30T00:00:00.000Z'),
      autoRenew: true,
    });
    expect(periods).toHaveLength(0);
  });
});
