/* CGS backend helper: timezone.
 * Shared timezone, seats, or formatting used by services. */
export const DEFAULT_CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || 'Asia/Kolkata';

export function resolveClinicTimezone(timezone?: string | null): string {
  return timezone || DEFAULT_CLINIC_TIMEZONE;
}

export function clinicDateString(date: Date, timeZone: string = DEFAULT_CLINIC_TIMEZONE): string {
  return date.toLocaleDateString('en-CA', { timeZone });
}

export function clinicTimeString(date: Date, timeZone: string = DEFAULT_CLINIC_TIMEZONE): string {
  return date.toLocaleTimeString('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function clinicWeekday(date: Date, timeZone: string = DEFAULT_CLINIC_TIMEZONE): string {
  return date.toLocaleDateString('en-US', { timeZone, weekday: 'long' });
}

function timezoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour') % 24, read('minute'), read('second'));
  return asUtc - date.getTime();
}

/** Inclusive UTC bounds for a YYYY-MM-DD calendar day in the clinic timezone. */
export function clinicDayBoundsUtc(
  dateStr: string,
  timeZone: string = DEFAULT_CLINIC_TIMEZONE
): { start: Date; end: Date } {
  const [year, month, day] = dateStr.split('-').map((s) => parseInt(s, 10));
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const start = new Date(utcGuess - timezoneOffsetMs(new Date(utcGuess), timeZone));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** UTC midnight used to store all-day leave rows keyed by calendar date. */
export function clinicCalendarUtcDate(dateStr: string): Date {
  return new Date(`${dateStr.split('T')[0]}T00:00:00.000Z`);
}
