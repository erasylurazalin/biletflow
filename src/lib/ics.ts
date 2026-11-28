/**
 * A small RFC 5545 calendar writer, kept pure so it is easy to test.
 *
 * The route reads the event from the database and calls generateIcs. This module
 * knows nothing about Express, the pool or the event status.
 */

// RFC 5545 says a content line SHOULD NOT be longer than 75 octets, excluding the
// line break. Continuation lines carry one leading space, and that space counts
// towards the 75 too.
const MAX_LINE_OCTETS = 75;

// TEXT values escape these four things. The backslash goes first, otherwise the
// backslashes added for the other characters would be escaped a second time.
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Fold one content line into physical lines of at most 75 UTF-8 octets each. The
// split is by byte while never landing inside a multi-byte character: a byte that
// looks like a UTF-8 continuation byte means the boundary is in the middle of a
// character, so the split moves back to the character's first byte.
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= MAX_LINE_OCTETS) return line;

  const parts: string[] = [];
  let offset = 0;
  let first = true;

  while (offset < bytes.length) {
    const limit = first ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    let end = Math.min(offset + limit, bytes.length);

    // 0b10xxxxxx is a continuation byte, so a character starts before this one.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
      end -= 1;
    }

    const chunk = bytes.subarray(offset, end).toString('utf8');
    parts.push(first ? chunk : ` ${chunk}`);
    offset = end;
    first = false;
  }

  return parts.join('\r\n');
}

// 2026-12-26T08:15:00.000Z -> 20261226T081500Z
export function formatIcsDate(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(
    14,
    16,
  )}${iso.slice(17, 19)}Z`;
}

// ASCII-only filename slug. A title with no usable ASCII letters or digits falls back
// to event.ics, which is what the route sends in Content-Disposition.
export function calendarFilename(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  return slug ? `${slug}.ics` : 'event.ics';
}

export interface IcsEvent {
  id: string;
  title: string;
  description: string;
  venueName: string;
  venueAddress: string;
  startsAt: Date;
  endsAt: Date;
  url: string;
}

// docs/api.md "Calendar export (.ics)": one VCALENDAR with one VEVENT. The optional
// now argument keeps DTSTAMP testable.
export function generateIcs(event: IcsEvent, now: Date = new Date()): string {
  const description = Array.from(event.description).slice(0, 500).join('');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BiletFlow//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@biletflow`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(event.startsAt)}`,
    `DTEND:${formatIcsDate(event.endsAt)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `LOCATION:${escapeText(`${event.venueName}, ${event.venueAddress}`)}`,
    // A blank line between the description and the page URL: the two escaped
    // newlines become an empty line after the client unfolds the text.
    `DESCRIPTION:${escapeText(`${description}\n\n${event.url}`)}`,
    `URL:${event.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.map((line) => foldLine(line)).join('\r\n') + '\r\n';
}
