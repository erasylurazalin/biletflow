/**
 * Tests for the printable ticket. No database and no app: the renderer takes a ticket
 * record and answers bytes, so these are plain functions, like qr.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, type PDFObject } from 'pdf-lib';
import {
  embedTicketFont,
  layoutTicket,
  renderTicketPdf,
  PAGE,
  QR_SIZE,
  type TicketPdfInput,
} from './ticket-pdf';

const TICKET: TicketPdfInput = {
  code: 'BF-7K2M-9XQP',
  status: 'valid',
  attendee_name: 'Aidos K.',
  ticket_type_name: 'Early Bird',
  event: {
    title: 'Astana Tech Meetup',
    starts_at: new Date('2026-11-14T18:00:00Z'),
    venue_name: 'Nazarbayev University',
    venue_address: 'Kabanbay Batyr 53, Astana',
  },
  qr_payload:
    'BF1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:3aCMMhEA4oqbvzq1cElUe_EbD_aItVWk7NSjPnZSHIw',
};

// Every field at the longest value the API accepts (events.ts: title, venue name and
// address; orders.ts: attendee; ticket-types.ts: type), filled with the widest glyph in
// DejaVu Sans, which wraps to the most lines possible. This is the layout that used to
// push the QR off the page.
const WIDEST: TicketPdfInput = {
  ...TICKET,
  code: 'BF-WX9K-3QZP',
  status: 'refunded',
  attendee_name: 'W'.repeat(100),
  ticket_type_name: 'W'.repeat(100),
  event: {
    title: 'W'.repeat(200),
    starts_at: TICKET.event.starts_at,
    venue_name: 'W'.repeat(200),
    venue_address: 'M'.repeat(300),
  },
};

function startsWithPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Counts the embedded images the page's resources can reach, which is how the QR code
// shows up in the file. Anything else the page draws is text or a vector line.
async function embeddedImages(buffer: Buffer): Promise<number> {
  const pdf = await PDFDocument.load(buffer);
  let images = 0;
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const subtype: PDFObject | undefined = object.dict.get(PDFName.of('Subtype'));
    if (String(subtype) === '/Image') images += 1;
  }
  return images;
}

async function ticketFont() {
  const pdf = await PDFDocument.create();
  return embedTicketFont(pdf);
}

describe('renderTicketPdf', () => {
  it('renders a one-page A4 PDF', async () => {
    const buffer = await renderTicketPdf(TICKET);

    expect(startsWithPdf(buffer)).toBe(true);

    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.abs(width - 595.28)).toBeLessThan(1);
    expect(Math.abs(height - 841.89)).toBeLessThan(1);
  });

  it('renders Kazakh and Russian names, which the standard PDF fonts cannot encode', async () => {
    const buffer = await renderTicketPdf({
      ...TICKET,
      attendee_name: 'Айдана Қасымова',
      event: { ...TICKET.event, title: 'Астана Тех Митап' },
    });

    expect(startsWithPdf(buffer)).toBe(true);
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('renders a refunded ticket and still carries its QR code', async () => {
    const buffer = await renderTicketPdf({ ...TICKET, status: 'refunded' });

    expect(startsWithPdf(buffer)).toBe(true);
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(1);
    expect(await embeddedImages(buffer)).toBe(1);
  });

  it("draws the ticket's own qr_payload, so changing it changes the bytes", async () => {
    const first = await renderTicketPdf(TICKET);
    const second = await renderTicketPdf({
      ...TICKET,
      qr_payload:
        'BF1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:4bDNNiFB5prcw0r2dFmVf_FcE_bJuWXl8OTkQoAaTIJx',
    });

    expect(first.equals(second)).toBe(false);
  });

  it('renders the longest possible text with the QR code still on the page', async () => {
    const buffer = await renderTicketPdf(WIDEST);

    expect(startsWithPdf(buffer)).toBe(true);
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(1);
    expect(await embeddedImages(buffer)).toBe(1);
  });
});

describe('layoutTicket', () => {
  it('keeps the QR fixed on the page at the API maxima, shortening only the text', async () => {
    const font = await ticketFont();
    const layout = layoutTicket(WIDEST, font);

    // 170 points (60 mm), centred, and fully on the page however long the text is.
    expect(layout.qr.width).toBe(QR_SIZE);
    expect(layout.qr.height).toBe(QR_SIZE);
    expect(layout.qr.x).toBeGreaterThanOrEqual(0);
    expect(layout.qr.x + layout.qr.width).toBeLessThanOrEqual(PAGE.width);
    expect(layout.qr.y).toBeGreaterThanOrEqual(0);
    expect(layout.qr.y + layout.qr.height).toBeLessThanOrEqual(PAGE.height);

    // Above the footer band, never through it.
    expect(layout.qr.y).toBeGreaterThan(layout.footer.y + layout.footer.size);

    // All the text stays above the code, and inside the margins.
    const lowest = Math.min(...layout.lines.map((line) => line.y));
    expect(lowest).toBeGreaterThan(layout.qr.y + layout.qr.height + 20);
    for (const line of layout.lines) {
      expect(line.x).toBeGreaterThanOrEqual(PAGE.margin);
      expect(line.x + font.widthOfTextAtSize(line.text, line.size)).toBeLessThanOrEqual(
        PAGE.width - PAGE.margin,
      );
    }

    // What the door needs is complete; the descriptive fields are what gives way.
    const texts = layout.lines.map((line) => line.text);
    expect(texts).toContain(WIDEST.code);
    expect(texts).toContain('REFUNDED');
    expect(texts.some((text) => text.endsWith('…'))).toBe(true);
  });

  it('leaves a ticket that fits alone, and puts its QR in the same place', async () => {
    const font = await ticketFont();
    const layout = layoutTicket(TICKET, font);
    const widest = layoutTicket(WIDEST, font);

    expect(layout.qr).toEqual(widest.qr);
    const texts = layout.lines.map((line) => line.text);
    expect(texts).toContain('Ticket type: Early Bird');
    expect(texts).toContain('Attendee: Aidos K.');
    expect(texts).toContain(TICKET.code);
    expect(texts).toContain('Valid for entry');
    expect(texts.some((text) => text.endsWith('…'))).toBe(false);
    expect(layout.statusBox).toBeNull();
  });
});
