/**
 * Plain dates in Kazakhstan time. A date parameter like 2026-10-20 means that whole
 * local day, not the server's day, so every date filter resolves it the same way.
 */
export const LOCAL_ZONE = 'Asia/Almaty';
export const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

function zoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const wallClock = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return wallClock - instant.getTime();
}

// Midnight local time of a plain date, shifted by whole days. A `to` date needs the next
// midnight because the day it names is inclusive.
export function localMidnight(date: string, addDays = 0): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day + addDays);
  return new Date(guess - zoneOffsetMs(new Date(guess)));
}

// A plain date has to be a real one: 2026-02-31 would otherwise roll over to March
// without anyone noticing.
export function isRealPlainDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
