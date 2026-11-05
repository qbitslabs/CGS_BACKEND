import { describe, expect, it } from 'vitest';
import { clinicMonthWindow } from './timezone.js';

describe('clinic month window', () => {
  it('uses day 1 through the last day of a 30-day, 31-day, and February month', () => {
    const november = clinicMonthWindow(new Date('2026-11-06T00:30:00.000Z'));
    const december = clinicMonthWindow(new Date('2026-12-15T12:00:00.000Z'));
    const february = clinicMonthWindow(new Date('2026-02-10T12:00:00.000Z'));
    const leap = clinicMonthWindow(new Date('2024-02-29T12:00:00.000Z'));

    expect(november).toMatchObject({ fromDay: 1, toDay: 30, monthLabel: 'November 2026' });
    expect(december).toMatchObject({ fromDay: 1, toDay: 31, monthLabel: 'December 2026' });
    expect(february).toMatchObject({ fromDay: 1, toDay: 28, monthLabel: 'February 2026' });
    expect(leap).toMatchObject({ fromDay: 1, toDay: 29, monthLabel: 'February 2024' });
    expect(november.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(november.end.toISOString()).toBe('2026-11-30T18:29:59.999Z');
  });
});
