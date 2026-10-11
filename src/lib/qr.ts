/**
 * The string a ticket's QR code encodes: `BF1:<ticket_id>:<signature>`.
 *
 * The signature is an HMAC-SHA256 over `BF1:<ticket_id>` with JWT_SECRET, written as
 * base64url without padding (always 43 characters). Nothing is stored: the payload is
 * computed whenever a ticket is returned (see the note on qr_payload in
 * migrations/001_init.sql), so rotating the secret invalidates every old QR code.
 *
 * Signing the prefix together with the id means the same secret can never produce a
 * valid QR signature by accident somewhere else, for example inside a JWT.
 *
 * Check-in uses verifyTicketPayload() before it touches the database. A rejected payload
 * is a normal scan result, not an HTTP error: the scanner shows a red screen.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecret } from '../middleware/auth';

const PREFIX = 'BF1';

// Lower-case only, because that is what Postgres returns and what signTicketPayload()
// writes. A payload with an upper-case id was not made by us.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;

// Why a payload was refused. `wrong_prefix` covers anything that is not ours at all,
// such as a Campaign QR Code (an https link), which must never open the door (SRS 4.14).
export type QrRejection = 'wrong_prefix' | 'malformed' | 'bad_signature';

export type QrVerification = { ok: true; ticketId: string } | { ok: false; reason: QrRejection };

function sign(ticketId: string): string {
  return createHmac('sha256', getSecret()).update(`${PREFIX}:${ticketId}`).digest('base64url');
}

export function signTicketPayload(ticketId: string): string {
  const id = ticketId.toLowerCase();
  return `${PREFIX}:${id}:${sign(id)}`;
}

export function verifyTicketPayload(payload: string): QrVerification {
  // Some scanners append a newline. Surrounding whitespace is never part of a payload.
  const trimmed = payload.trim();

  if (!trimmed.startsWith(`${PREFIX}:`)) {
    return { ok: false, reason: 'wrong_prefix' };
  }

  const parts = trimmed.split(':');
  const ticketId = parts[1];
  const signature = parts[2];
  if (
    parts.length !== 3 ||
    !ticketId ||
    !signature ||
    !UUID_RE.test(ticketId) ||
    !SIGNATURE_RE.test(signature)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // Compare in constant time, so response timing does not leak how much of a forged
  // signature was right. Both sides are 43 ASCII characters here, as timingSafeEqual
  // requires equal lengths.
  const expected = Buffer.from(sign(ticketId));
  if (!timingSafeEqual(expected, Buffer.from(signature))) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, ticketId };
}
