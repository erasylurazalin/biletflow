import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmail, webUrl } from './mailer';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('sendEmail', () => {
  it('inserts the outbox row and logs without exposing the body', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as PoolClient;
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const body = 'Open http://localhost:3001/verify-email?token=secret-token';

    await sendEmail(db, {
      userId: '11111111-1111-4111-8111-111111111111',
      to: 'aidos@example.kz',
      kind: 'verify_email',
      subject: 'Confirm your BiletFlow email',
      body,
    });

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'aidos@example.kz',
      'verify_email',
      'Confirm your BiletFlow email',
      body,
    ]);
    expect(info).toHaveBeenCalledWith(
      '[email] to=aidos@example.kz kind=verify_email subject=Confirm your BiletFlow email',
    );
    expect(info.mock.calls[0]?.[0]).not.toContain(body);
    expect(info.mock.calls[0]?.[0]).not.toContain('secret-token');
  });
});

describe('webUrl', () => {
  it('uses the local web app by default and removes trailing slashes', () => {
    vi.stubEnv('WEB_URL', undefined);
    expect(webUrl()).toBe('http://localhost:3001');

    vi.stubEnv('WEB_URL', 'https://tickets.example.kz///');
    expect(webUrl()).toBe('https://tickets.example.kz');
  });
});
