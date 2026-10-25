/**
 * The printable ticket: a one-page A4 PDF drawn from the canonical ticket record on
 * every request, never stored (docs/decisions.md, decision 13; SRS 4.11, UC7 and
 * section 11 criterion 4).
 *
 * routes/tickets.ts reads the row and this module draws the page. Nothing about money
 * belongs on an admission document, so no price, currency, payment detail or email
 * address is even passed in here.
 *
 * pdf-lib plus an embedded DejaVu Sans keeps this pure JavaScript: no headless browser
 * in CI, no native build step, and Kazakh and Russian names print in their own letters.
 * The standard PDF fonts cannot encode Cyrillic at all, which is why the font travels
 * with the repo in assets/fonts/.
 *
 * The page is built as a layout first (layoutTicket, a pure function of the text and the
 * font metrics) and drawn afterwards, so the position of the QR code can be tested
 * without rendering: the code is admission-critical and never moves, and the text above
 * it is shortened until it fits.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

// `src/lib` in development and `dist/lib` after the build both sit two levels below the
// repo root (tsconfig.json has rootDir "src" and outDir "dist"), so this one path works
// from source and from the compiled file alike.
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf');

// A4 portrait in points, with a 56 point (about 20 mm) margin.
export const PAGE = { width: 595.28, height: 841.89, margin: 56 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;

// 60 mm is 170 points: the printed code has to stay large enough to scan from paper.
export const QR_SIZE = 170;

const FOOTER_SIZE = 9;
const FOOTER_Y = PAGE.margin;

// The QR is anchored to the foot of the page, never to the text above it, so a long
// event name cannot push the code towards the edge or over the footer. 28 points above
// the margin leaves clear white space between the code and the footer line.
const QR_BOTTOM = PAGE.margin + 28;
const QR_TOP = QR_BOTTOM + QR_SIZE;

// The lowest a text line may reach: a comfortable gap above the QR code.
const QR_GAP = 28;
const TEXT_BOTTOM = QR_TOP + QR_GAP;

// One block of text above the code. `priority` decides who gives up a line first when
// the page is full: the higher the number, the sooner the block is shortened.
interface TextBlock {
  lines: string[];
  size: number;
  lineHeight: number;
  gap: number;
  shorten: boolean;
  priority: number;
}

const RULE_GAP = 12;
const CODE_GAP = 18;
const CODE_SIZE = 18;
const CODE_LINE = 22;
const STATUS_SIZE = 13;
const STATUS_GAP = 16;
const STATUS_HEIGHT = STATUS_SIZE + 5;

// What sits under the text and never gives up space: the rule, the ticket code and the
// status line.
const TAIL_HEIGHT = RULE_GAP + CODE_GAP + CODE_LINE + STATUS_GAP + STATUS_HEIGHT;

const TEXT_SPACE = PAGE.height - PAGE.margin - TEXT_BOTTOM;

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);

const FOOTER = 'BiletFlow demonstration ticket. No real payment was taken.';

export interface TicketPdfInput {
  code: string;
  status: string;
  attendee_name: string;
  ticket_type_name: string;
  event: { title: string; starts_at: Date; venue_name: string; venue_address: string };
  qr_payload: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TicketPdfLine {
  text: string;
  x: number;
  y: number;
  size: number;
}

export interface TicketPdfLayout {
  lines: TicketPdfLine[];
  rules: number[];
  statusBox: Rect | null;
  qr: Rect;
  footer: { text: string; x: number; y: number; size: number };
}

/**
 * Greedy word wrap measured with the embedded font, so a long event title or venue
 * name folds onto the next line instead of running off the page. A single word wider
 * than the whole line is broken by characters rather than allowed to overflow.
 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';

    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);

      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let end = 1;
        while (
          end < rest.length &&
          font.widthOfTextAtSize(rest.slice(0, end + 1), size) <= maxWidth
        ) {
          end += 1;
        }
        lines.push(rest.slice(0, end));
        rest = rest.slice(end);
      }
      line = rest;
    }

    if (line !== '') lines.push(line);
  }

  return lines.length > 0 ? lines : [''];
}

/** Cuts a line short with a trailing ellipsis, and never past maxWidth afterwards. */
function shortenLine(line: string, font: PDFFont, size: number, maxWidth: number): string {
  const trimmed = line.trimEnd();
  let cut = trimmed;
  while (cut.length > 0 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** Where a line of text sits when its top edge is `top` and the font size is `size`. */
function baselineOf(top: number, size: number): number {
  return top - size;
}

function blocksHeight(blocks: TextBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.gap + block.lines.length * block.lineHeight, 0);
}

/**
 * The whole page, in points, from the ticket text and the font metrics alone.
 *
 * The QR code is fixed: 170 points (60 mm), centred, a fixed distance above the footer.
 * The text fills the space above it, and when the text does not fit, the descriptive
 * blocks are shortened with a trailing ellipsis, always the block with the most lines
 * left, so no single field disappears. The ticket code, the status and the QR are never
 * shortened, because they are what the door needs.
 */
export function layoutTicket(ticket: TicketPdfInput, font: PDFFont): TicketPdfLayout {
  const when = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Almaty',
  }).format(ticket.event.starts_at);

  const blocks: TextBlock[] = [
    {
      lines: wrap(ticket.event.title, font, 22, CONTENT_WIDTH),
      size: 22,
      lineHeight: 27,
      gap: 0,
      shorten: true,
      priority: 0,
    },
    {
      lines: [when],
      size: 12,
      lineHeight: 16,
      gap: 12,
      shorten: false,
      priority: 0,
    },
    {
      lines: [
        ...wrap(ticket.event.venue_name, font, 12, CONTENT_WIDTH),
        ...wrap(ticket.event.venue_address, font, 12, CONTENT_WIDTH),
      ],
      size: 12,
      lineHeight: 16,
      gap: 4,
      shorten: true,
      priority: 1,
    },
    {
      lines: wrap(`Ticket type: ${ticket.ticket_type_name}`, font, 12, CONTENT_WIDTH),
      size: 12,
      lineHeight: 16,
      gap: 18,
      shorten: true,
      priority: 2,
    },
    {
      lines: wrap(`Attendee: ${ticket.attendee_name}`, font, 12, CONTENT_WIDTH),
      size: 12,
      lineHeight: 16,
      gap: 4,
      shorten: true,
      priority: 3,
    },
  ];

  // One line of every block together is 129 points against 413 points of room, so this
  // loop always ends with the page full or the text short, never with text below the QR.
  while (blocksHeight(blocks) + TAIL_HEIGHT > TEXT_SPACE) {
    const candidates = blocks.filter((block) => block.shorten && block.lines.length > 1);
    if (candidates.length === 0) break;

    // The block with the most lines gives one up first, so no single field vanishes.
    // On a tie the least critical block goes first: attendee, then ticket type, then
    // venue, and the event name last.
    candidates.sort((a, b) => b.lines.length - a.lines.length || b.priority - a.priority);
    const victim = candidates[0];
    if (!victim) break;

    victim.lines.pop();
    const last = victim.lines.length - 1;
    const line = victim.lines[last];
    if (line !== undefined)
      victim.lines[last] = shortenLine(line, font, victim.size, CONTENT_WIDTH);
  }

  // Place the blocks down the page, starting at the top margin.
  const lines: TicketPdfLine[] = [];
  let top = PAGE.height - PAGE.margin;

  for (const block of blocks) {
    top -= block.gap;
    for (const text of block.lines) {
      lines.push({ text, x: PAGE.margin, y: baselineOf(top, block.size), size: block.size });
      top -= block.lineHeight;
    }
  }

  // A rule between the event and the holder.
  top -= RULE_GAP;
  const rules = [top];

  // The ticket code, large enough to read out to staff without squinting.
  top -= CODE_GAP;
  lines.push({ text: ticket.code, x: PAGE.margin, y: baselineOf(top, CODE_SIZE), size: CODE_SIZE });
  top -= CODE_LINE;

  // The status. Every status prints, so a refunded ticket's paper says so instead of
  // looking valid; a status other than valid sits inside a box a glance cannot miss.
  top -= STATUS_GAP;
  const padded = ticket.status !== 'valid';
  const padding = padded ? 8 : 0;
  const statusText = padded ? ticket.status.toUpperCase() : 'Valid for entry';
  const statusBaseline = baselineOf(top, STATUS_SIZE);
  const statusBox: Rect | null = padded
    ? {
        x: PAGE.margin,
        y: statusBaseline - 5,
        width: font.widthOfTextAtSize(statusText, STATUS_SIZE) + padding * 2,
        height: STATUS_SIZE + 10,
      }
    : null;
  lines.push({
    text: statusText,
    x: PAGE.margin + padding,
    y: statusBaseline,
    size: STATUS_SIZE,
  });

  return {
    lines,
    rules,
    statusBox,
    qr: { x: (PAGE.width - QR_SIZE) / 2, y: QR_BOTTOM, width: QR_SIZE, height: QR_SIZE },
    footer: { text: FOOTER, x: PAGE.margin, y: FOOTER_Y, size: FOOTER_SIZE },
  };
}

/** Registers fontkit and embeds the bundled DejaVu Sans, subset to the glyphs used. */
export async function embedTicketFont(pdfDoc: PDFDocument): Promise<PDFFont> {
  pdfDoc.registerFontkit(fontkit);
  return pdfDoc.embedFont(new Uint8Array(await readFile(FONT_PATH)), { subset: true });
}

export async function renderTicketPdf(ticket: TicketPdfInput): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await embedTicketFont(pdfDoc);
  const page: PDFPage = pdfDoc.addPage([PAGE.width, PAGE.height]);

  const layout = layoutTicket(ticket, font);

  for (const y of layout.rules) {
    page.drawLine({
      start: { x: PAGE.margin, y },
      end: { x: PAGE.width - PAGE.margin, y },
      thickness: 1,
      color: BLACK,
    });
  }
  if (layout.statusBox) {
    page.drawRectangle({ ...layout.statusBox, borderColor: BLACK, borderWidth: 1 });
  }
  for (const line of layout.lines) {
    page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font, color: BLACK });
  }

  // The ticket's own payload, the same string the app shows, so the paper and the phone
  // are one admission and the scanner, not the page, decides what is valid. Margin 4 is
  // a quiet zone; level Q survives a grayscale print on ordinary paper.
  const qrImage = await pdfDoc.embedPng(
    await QRCode.toBuffer(ticket.qr_payload, {
      type: 'png',
      errorCorrectionLevel: 'Q',
      margin: 4,
      width: 1024,
    }),
  );
  page.drawRectangle({ ...layout.qr, color: WHITE });
  page.drawImage(qrImage, layout.qr);

  page.drawText(layout.footer.text, {
    x: layout.footer.x,
    y: layout.footer.y,
    size: layout.footer.size,
    font,
    color: BLACK,
  });

  return Buffer.from(await pdfDoc.save());
}
