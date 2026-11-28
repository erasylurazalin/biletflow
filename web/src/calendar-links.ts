// Links that add an event to a calendar. Kept in one place so the event page and My
// tickets build exactly the same URLs.

export type CalendarLinkEvent = {
  title: string;
  description?: string | null;
  starts_at: string;
  ends_at: string;
  venue_name: string;
  venue_address?: string | null;
};

// Same-origin path: next.config.ts rewrites /api to the API, so the browser needs no
// API_URL and the download gets the API's Content-Disposition filename.
export function downloadIcsHref(eventId: string): string {
  return `/api/events/${encodeURIComponent(eventId)}/calendar.ics`;
}

// 2026-12-26T08:15:00.000Z -> 20261226T081500Z, the format both the .ics file and
// Google Calendar's dates parameter use.
export function calendarDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid calendar date: ${iso}`);
  }
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function googleCalendarHref(event: CalendarLinkEvent): string {
  const location = [event.venue_name, event.venue_address]
    .filter((value): value is string => Boolean(value))
    .join(', ');
  const parts: [string, string][] = [
    ['action', 'TEMPLATE'],
    ['text', event.title],
    ['dates', `${calendarDate(event.starts_at)}/${calendarDate(event.ends_at)}`],
    ['details', event.description ?? ''],
    ['location', location],
  ];
  const query = parts.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `https://calendar.google.com/calendar/render?${query}`;
}
