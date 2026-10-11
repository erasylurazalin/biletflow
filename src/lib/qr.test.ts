/**
 * Tests for the ticket QR payload. No database and no app: these are plain functions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { signTicketPayload, verifyTicketPayload } from './qr';

const TICKET_ID = '8f2c1d3e-5b6a-4c7d-9e8f-0a1b2c3d4e5f';
const OTHER_TICKET_ID = '99999999-9999-4999-8999-999999999999';

// Set once up front as well, because the it.each tables below sign payloads while the
// file is collected, before any beforeEach runs. beforeEach puts it back after the
// rotation test.
process.env.JWT_SECRET = 'test-jwt-secret';
beforeEach(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
});

// Flips the last character of the signature to another valid base64url character.
function tamper(payload: string): string {
  const last = payload.at(-1) === 'A' ? 'B' : 'A';
  return payload.slice(0, -1) + last;
}

describe('signTicketPayload', () => {
  it('produces BF1:<ticket_id>:<43-character signature>', () => {
    expect(signTicketPayload(TICKET_ID)).toMatch(
      new RegExp(`^BF1:${TICKET_ID}:[A-Za-z0-9_-]{43}$`),
    );
  });

  it('is stable for the same ticket and secret', () => {
    expect(signTicketPayload(TICKET_ID)).toBe(signTicketPayload(TICKET_ID));
  });

  it('writes the id lower-cased', () => {
    expect(signTicketPayload(TICKET_ID.toUpperCase())).toBe(signTicketPayload(TICKET_ID));
  });
});

describe('verifyTicketPayload', () => {
  it('accepts a payload it signed and returns the ticket id', () => {
    expect(verifyTicketPayload(signTicketPayload(TICKET_ID))).toEqual({
      ok: true,
      ticketId: TICKET_ID,
    });
  });

  it('ignores whitespace a scanner adds around the payload', () => {
    expect(verifyTicketPayload(`${signTicketPayload(TICKET_ID)}\n`)).toEqual({
      ok: true,
      ticketId: TICKET_ID,
    });
  });

  it('rejects a tampered signature', () => {
    expect(verifyTicketPayload(tamper(signTicketPayload(TICKET_ID)))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it("rejects one ticket's signature on another ticket's id", () => {
    const signature = signTicketPayload(OTHER_TICKET_ID).split(':')[2];
    expect(verifyTicketPayload(`BF1:${TICKET_ID}:${signature}`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a payload signed with a different secret', () => {
    const payload = signTicketPayload(TICKET_ID);
    process.env.JWT_SECRET = 'rotated-secret';
    expect(verifyTicketPayload(payload)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['another version', signTicketPayload(TICKET_ID).replace(/^BF1/, 'BF2')],
    ['a Campaign QR Code link', 'https://biletflow.kz/e/astana-tech?promo=Zx81kQ'],
    ['a lower-case prefix', signTicketPayload(TICKET_ID).replace(/^BF1/, 'bf1')],
    ['an empty string', ''],
  ])('rejects %s as wrong_prefix', (_label, payload) => {
    expect(verifyTicketPayload(payload)).toEqual({ ok: false, reason: 'wrong_prefix' });
  });

  it.each([
    ['no signature', `BF1:${TICKET_ID}`],
    ['an empty signature', `BF1:${TICKET_ID}:`],
    ['an extra part', `${signTicketPayload(TICKET_ID)}:extra`],
    ['an id that is not a uuid', `BF1:42:${'a'.repeat(43)}`],
    ['an upper-case id', `BF1:${TICKET_ID.toUpperCase()}:${'a'.repeat(43)}`],
    ['a short signature', `BF1:${TICKET_ID}:abc`],
    ['characters outside base64url', `BF1:${TICKET_ID}:${'+'.repeat(43)}`],
  ])('rejects a payload with %s as malformed', (_label, payload) => {
    expect(verifyTicketPayload(payload)).toEqual({ ok: false, reason: 'malformed' });
  });
});
