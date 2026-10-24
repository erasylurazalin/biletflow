import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';

type QueryClient = Pick<PoolClient, 'query'>;
export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export async function createEmailToken(
  db: QueryClient,
  userId: string,
  purpose: EmailTokenPurpose,
  ttlMinutes: number,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await db.query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))`,
    [userId, purpose, tokenHash, ttlMinutes],
  );
  return token;
}

export async function consumeEmailToken(
  db: QueryClient,
  rawToken: string,
  purpose: EmailTokenPurpose,
): Promise<string | null> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const result = await db.query<{ user_id: string }>(
    `UPDATE email_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND purpose = $2
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [tokenHash, purpose],
  );
  return result.rows[0]?.user_id ?? null;
}
