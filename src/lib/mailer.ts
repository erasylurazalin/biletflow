/**
 * Email is simulated for the academic MVP (SRS 3.2 and 4.6 allow simulations).
 * The outbox stores what a real email provider would receive.
 */
import type { PoolClient } from 'pg';

type QueryClient = Pick<PoolClient, 'query'>;

interface Email {
  userId: string | null;
  to: string;
  kind: string;
  subject: string;
  body: string;
}

export async function sendEmail(db: QueryClient, email: Email): Promise<void> {
  await db.query(
    `INSERT INTO email_outbox (user_id, to_email, kind, subject, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [email.userId, email.to, email.kind, email.subject, email.body],
  );
  console.info(`[email] to=${email.to} kind=${email.kind} subject=${email.subject}`);
}

export function webUrl(): string {
  return (process.env.WEB_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}
