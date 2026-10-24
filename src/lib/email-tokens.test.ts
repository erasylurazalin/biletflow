import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { consumeEmailToken, createEmailToken } from './email-tokens';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function fakeClient(result: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows: result });
  return { client: { query } as unknown as PoolClient, query };
}

describe('createEmailToken', () => {
  it('returns a random token and stores only its sha256 hash', async () => {
    const { client, query } = fakeClient();

    const token = await createEmailToken(client, USER_ID, 'verify_email', 24 * 60);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO email_tokens');
    expect(params).toEqual([
      USER_ID,
      'verify_email',
      createHash('sha256').update(token).digest('hex'),
      24 * 60,
    ]);
    expect(params[2]).not.toBe(token);
    expect(params[2]).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('consumeEmailToken', () => {
  it('returns null for an unknown token', async () => {
    const { client, query } = fakeClient();

    await expect(consumeEmailToken(client, 'unknown', 'verify_email')).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      createHash('sha256').update('unknown').digest('hex'),
      'verify_email',
    ]);
  });

  it('atomically marks a valid token used and returns its user id', async () => {
    const { client, query } = fakeClient([{ user_id: USER_ID }]);

    await expect(consumeEmailToken(client, 'raw-token', 'reset_password')).resolves.toBe(USER_ID);
    expect(query).toHaveBeenCalledOnce();
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('UPDATE email_tokens');
    expect(sql).toContain('used_at IS NULL');
    expect(sql).toContain('expires_at > now()');
    expect(sql).toContain('RETURNING user_id');
  });
});
