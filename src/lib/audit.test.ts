/**
 * Tests for recordAudit with a fake client: which SQL it sends and with what values.
 * That the entry really rolls back with its transaction is in audit.db.test.ts.
 */
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS, recordAudit } from './audit';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const TICKET_TYPE_ID = '33333333-3333-4333-8333-333333333333';

function fakeClient() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  return { client: { query } as unknown as PoolClient, query };
}

describe('recordAudit', () => {
  it('inserts one row into audit_log with the entry values in order', async () => {
    const { client, query } = fakeClient();

    await recordAudit(client, {
      actorId: USER_ID,
      action: 'ticket_type.updated',
      entityType: 'ticket_type',
      entityId: TICKET_TYPE_ID,
      eventId: EVENT_ID,
      description: 'Price changed from 5000 to 6000 KZT',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO audit_log/);
    expect(params).toEqual([
      USER_ID,
      'ticket_type.updated',
      'ticket_type',
      TICKET_TYPE_ID,
      EVENT_ID,
      'Price changed from 5000 to 6000 KZT',
    ]);
  });

  it('stores NULL for the event when the action belongs to none', async () => {
    const { client, query } = fakeClient();

    await recordAudit(client, {
      actorId: USER_ID,
      action: 'organizer_profile.identity_verified',
      entityType: 'organizer_profile',
      entityId: USER_ID,
      description: 'Identity check completed',
    });

    expect(query.mock.calls[0]![1][4]).toBeNull();
  });

  it('passes a database error on, so the surrounding transaction rolls back', async () => {
    const { client, query } = fakeClient();
    query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      recordAudit(client, {
        actorId: null,
        action: 'order.cancelled',
        entityType: 'order',
        entityId: EVENT_ID,
        eventId: EVENT_ID,
        description: 'Order expired before payment',
      }),
    ).rejects.toThrow('connection lost');
  });
});

describe('AUDIT_ACTIONS', () => {
  // The same rule as the CHECK constraint in migrations/005_audit_log.sql, so a badly
  // named action fails here and not on the first real request.
  it.each(AUDIT_ACTIONS)('%s has the shape the database accepts', (action) => {
    expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('has no duplicates', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
