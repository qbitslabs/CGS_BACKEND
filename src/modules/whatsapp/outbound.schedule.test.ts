import { describe, expect, it } from 'vitest';
import { dueReminderStages, outcomeLookbackMs, OUTCOME_LOOKBACK_MS } from './outbound.schedule.js';

const at = (iso: string) => new Date(iso);

describe('appointment reminder stages', () => {
  const now = at('2026-10-07T04:00:00.000Z');
  const bookedEarly = at('2026-10-06T00:00:00.000Z');

  it('sends only the 6 hour reminder while more than 2 hours remain', () => {
    expect(dueReminderStages(at('2026-10-07T10:00:00.000Z'), now, { createdAt: bookedEarly })).toEqual(['6h']);
    expect(dueReminderStages(at('2026-10-07T06:01:00.000Z'), now, { createdAt: bookedEarly })).toEqual(['6h']);
  });

  it('sends only the current reminder when the last check was on time', () => {
    expect(
      dueReminderStages(at('2026-10-07T06:00:00.000Z'), now, {
        createdAt: bookedEarly,
        previousRanAt: '2026-10-07T03:55:00.000Z',
      })
    ).toEqual(['2h']);
    expect(
      dueReminderStages(at('2026-10-07T04:20:00.000Z'), now, {
        createdAt: bookedEarly,
        previousRanAt: '2026-10-07T03:55:00.000Z',
      })
    ).toEqual(['30m']);
  });

  it('catches up reminders missed while the server was down', () => {
    expect(
      dueReminderStages(at('2026-10-07T06:00:00.000Z'), now, {
        createdAt: bookedEarly,
        previousRanAt: '2026-10-06T23:00:00.000Z',
      })
    ).toEqual(['6h', '2h']);
    expect(
      dueReminderStages(at('2026-10-07T04:20:00.000Z'), now, {
        createdAt: bookedEarly,
        previousRanAt: '2026-10-06T20:00:00.000Z',
      })
    ).toEqual(['6h', '2h', '30m']);
  });

  it('does not send earlier reminders for a visit booked inside the current window', () => {
    expect(
      dueReminderStages(at('2026-10-07T04:20:00.000Z'), now, {
        createdAt: at('2026-10-07T03:50:00.000Z'),
        previousRanAt: '2026-10-06T20:00:00.000Z',
      })
    ).toEqual(['30m']);
  });

  it('does not remind after the visit has started or more than 6 hours ahead', () => {
    expect(dueReminderStages(at('2026-10-07T04:00:00.000Z'), now)).toEqual([]);
    expect(dueReminderStages(at('2026-10-07T03:00:00.000Z'), now)).toEqual([]);
    expect(dueReminderStages(at('2026-10-07T10:01:00.000Z'), now)).toEqual([]);
  });
});

describe('missed and follow-up lookback after downtime', () => {
  const now = at('2026-10-07T12:00:00.000Z');

  it('uses the normal 36 hour window when the last run was recent', () => {
    expect(outcomeLookbackMs(now, '2026-10-07T10:00:00.000Z')).toBe(OUTCOME_LOOKBACK_MS);
    expect(outcomeLookbackMs(now, null)).toBe(OUTCOME_LOOKBACK_MS);
  });

  it('looks back across a multi-day outage and stops at 7 days', () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    expect(outcomeLookbackMs(now, '2026-10-04T12:00:00.000Z')).toBe(threeDays);
    expect(outcomeLookbackMs(now, '2026-09-01T12:00:00.000Z')).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
