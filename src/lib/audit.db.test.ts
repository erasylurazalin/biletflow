/**
 * The audit log against a real Postgres: an entry commits and rolls back together with
 * the transaction it was written in, and the table refuses edits and deletes.
 *
 * Runs only when TEST_DATABASE_URL is set, like src/routes/orders.db.test.ts, which
 * explains how to set up the test database.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEntry } from './audit';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('audit log against a real database', () => {
  let pool: Pool;
  let withTransaction: typeof import('../db/transaction').withTransaction;
  let recordAudit: typeof import('./audit').recordAudit;

  beforeAll(async () => {
    // Set before the pool module loads, because it reads DATABASE_URL on import.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    ({ pool } = await import('../db/pool'));
    ({ withTransaction } = await import('../db/transaction'));
    ({ recordAudit } = await import('./audit'));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newUser(): Promise<string> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'not-a-real-hash', 'Audit test')
       RETURNING id`,
      [`${randomUUID()}@test.biletflow.kz`],
    );
    return user.rows[0]!.id;
  }

  // Each test uses its own event id, so entries from other tests and earlier runs never
  // get counted.
  function entry(actorId: string, eventId: string): AuditEntry {
    return {
      actorId,
      action: 'event.published',
      entityType: 'event',
      entityId: eventId,
      eventId,
      description: 'Published the event',
    };
  }

  async function entriesFor(eventId: string) {
    const rows = await pool.query(
      `SELECT actor_id, action, entity_type, entity_id, event_id, description
       FROM audit_log WHERE event_id = $1`,
      [eventId],
    );
    return rows.rows;
  }

  it('keeps an entry written inside a committed transaction', async () => {
    const actorId = await newUser();
    const eventId = randomUUID();

    await withTransaction((client) => recordAudit(client, entry(actorId, eventId)));

    expect(await entriesFor(eventId)).toEqual([
      {
        actor_id: actorId,
        action: 'event.published',
        entity_type: 'event',
        entity_id: eventId,
        event_id: eventId,
        description: 'Published the event',
      },
    ]);
  });

  it('drops an entry written inside a transaction that rolls back', async () => {
    const actorId = await newUser();
    const eventId = randomUUID();

    await expect(
      withTransaction(async (client) => {
        await recordAudit(client, entry(actorId, eventId));
        throw new Error('the action itself failed');
      }),
    ).rejects.toThrow('the action itself failed');

    expect(await entriesFor(eventId)).toEqual([]);
  });

  it('refuses to update or delete an entry', async () => {
    const actorId = await newUser();
    const eventId = randomUUID();
    await withTransaction((client) => recordAudit(client, entry(actorId, eventId)));

    await expect(
      pool.query(`UPDATE audit_log SET description = 'rewritten' WHERE event_id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM audit_log WHERE event_id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);

    expect(await entriesFor(eventId)).toHaveLength(1);
  });

  it('refuses an action name that is not in the dotted shape', async () => {
    const actorId = await newUser();
    const eventId = randomUUID();

    await expect(
      withTransaction((client) =>
        recordAudit(client, {
          ...entry(actorId, eventId),
          action: 'Published Event' as AuditEntry['action'],
        }),
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  });
});
