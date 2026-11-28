import { describe, expect, it } from 'vitest';
import {
  calendarFilename,
  escapeText,
  foldLine,
  formatIcsDate,
  generateIcs,
  type IcsEvent,
} from './ics';

// RFC 5545 unfolding: a CRLF followed by one space joins the physical lines back.
function unfold(value: string): string {
  return value.replace(/\r\n /g, '');
}

const event: IcsEvent = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Astana Tech Meetup',
  description: 'Monthly meetup for developers.',
  venueName: 'Nazarbayev University',
  venueAddress: 'Kabanbay Batyr 53, Astana',
  startsAt: new Date('2026-12-26T08:15:00Z'),
  endsAt: new Date('2026-12-26T11:15:00Z'),
  url: 'http://localhost:3001/events/33333333-3333-4333-8333-333333333333',
};

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and newlines', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });
});

describe('foldLine', () => {
  it('folds a long line at 75 octets with CRLF and a leading space', () => {
    const line = `SUMMARY:${'a'.repeat(200)}`;
    const folded = foldLine(line);
    const physical = folded.split('\r\n');

    expect(physical.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(physical[0]!, 'utf8')).toBe(75);
    for (const [index, part] of physical.entries()) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(' ')).toBe(true);
    }
    expect(unfold(folded)).toBe(line);
  });

  it('folds a long Kazakh title without breaking a character', () => {
    const title = 'Астанадағы үлкен технологиялық кездесу және әңгімелер туралы '.repeat(4);
    const line = `SUMMARY:${escapeText(title)}`;
    const folded = foldLine(line);

    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    }

    const unfolded = unfold(folded);
    expect(unfolded).toBe(line);
    expect(unfolded.slice('SUMMARY:'.length)).toBe(title);
    // No replacement character means no multi-byte character was cut in half.
    expect(unfolded).not.toContain('\uFFFD');
  });

  it('leaves a line of exactly 75 octets alone', () => {
    const line = 'a'.repeat(75);
    expect(foldLine(line)).toBe(line);
  });
});

describe('formatIcsDate', () => {
  it('writes UTC basic format', () => {
    expect(formatIcsDate(new Date('2026-12-26T08:15:00Z'))).toBe('20261226T081500Z');
  });
});

describe('calendarFilename', () => {
  it('slugifies an ASCII title and falls back for a non-ASCII one', () => {
    expect(calendarFilename('Astana Tech Meetup')).toBe('astana-tech-meetup.ics');
    expect(calendarFilename('Астана Tech Meetup')).toBe('tech-meetup.ics');
    expect(calendarFilename('Астанадағы кездесу')).toBe('event.ics');
  });
});

describe('generateIcs', () => {
  it('writes CRLF endings, the calendar header and one VEVENT', () => {
    const ics = generateIcs(event, new Date('2026-11-01T10:20:30Z'));

    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    for (const line of ics.slice(0, -2).split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }

    expect(ics).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
    expect(ics).toContain('PRODID:-//BiletFlow//Events//EN\r\n');
    expect(ics).toContain('CALSCALE:GREGORIAN\r\n');
    expect(ics).toContain('METHOD:PUBLISH\r\n');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('UID:33333333-3333-4333-8333-333333333333@biletflow\r\n');
    expect(ics).toContain('DTSTAMP:20261101T102030Z\r\n');
    expect(ics).toContain('DTSTART:20261226T081500Z\r\n');
    expect(ics).toContain('DTEND:20261226T111500Z\r\n');
    expect(ics).toContain('SUMMARY:Astana Tech Meetup\r\n');
    expect(ics).toContain('LOCATION:Nazarbayev University\\, Kabanbay Batyr 53\\, Astana\r\n');
    expect(unfold(ics)).toContain(
      `DESCRIPTION:Monthly meetup for developers.\\n\\n${event.url}\r\n`,
    );
    expect(ics).toContain(`URL:${event.url}\r\n`);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('uses only the first 500 description characters before the blank line and URL', () => {
    const ics = unfold(
      generateIcs({ ...event, description: 'x'.repeat(600) }, new Date('2026-11-01T10:20:30Z')),
    );

    expect(ics).toContain(`DESCRIPTION:${'x'.repeat(500)}\\n\\n${event.url}\r\n`);
  });

  it('escapes the title in SUMMARY', () => {
    const ics = generateIcs({ ...event, title: 'Talks, pizza; questions\\answers' });

    expect(ics).toContain('SUMMARY:Talks\\, pizza\\; questions\\\\answers\r\n');
  });
});
