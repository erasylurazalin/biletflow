/**
 * The audit log: one row for every organizer, administrator, payment and refund action.
 *
 * Call recordAudit with the transaction client, inside withTransaction, right next to
 * the change it describes:
 *
 *   await withTransaction(async (client) => {
 *     await client.query(`UPDATE events SET status = 'published' WHERE id = $1`, [eventId]);
 *     await recordAudit(client, {
 *       actorId: req.user.id,
 *       action: 'event.published',
 *       entityType: 'event',
 *       entityId: eventId,
 *       eventId,
 *       description: 'Published the event',
 *     });
 *   });
 *
 * That way the entry commits or rolls back together with the action: there is never an
 * entry for something that did not happen, or a change with no entry. Do not pass
 * `pool` here. Its query may run on another connection, outside the transaction.
 *
 * The table is append-only (see migrations/005_audit_log.sql). There is no way to edit
 * or remove an entry, so write the description as if it will be read in a year.
 */
import type { PoolClient } from 'pg';

/**
 * Every action name in use. The same list, with what each one means, is in the "Audit
 * log" section of docs/api.md. A new action goes into both, in the same PR.
 */
export const AUDIT_ACTIONS = [
  'event.created',
  'event.updated',
  'event.published',
  'event.cancelled',
  'event.deleted',
  'event.duplicated',
  'event.suspended',
  'event.unsuspended',
  'ticket_type.created',
  'ticket_type.updated',
  'ticket_type.deleted',
  'staff.assigned',
  'staff.removed',
  'organizer_profile.identity_verified',
  'paid_sales.fee_paid',
  'paid_sales.activated',
  'order.paid',
  'order.payment_failed',
  'order.cancelled',
  'order.refunded',
  'ticket.checked_in',
  'ticket.check_in_reversed',
  'promo_code.created',
  'promo_code.disabled',
  'support_case.status_changed',
  'user.suspended',
  'user.unsuspended',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntityType =
  | 'event'
  | 'ticket_type'
  | 'user'
  | 'organizer_profile'
  | 'payment'
  | 'order'
  | 'ticket'
  | 'promo_code'
  | 'support_case';

export interface AuditEntry {
  /** Who did it. null only for the system itself, never for a logged-in request. */
  actorId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  /** The event the action belongs to, when there is one. The timeline is built from it. */
  eventId?: string | null;
  /** One short sentence, at most 500 characters, e.g. "Price changed from 5000 to 6000 KZT". */
  description: string;
}

export async function recordAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, event_id, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.eventId ?? null,
      entry.description,
    ],
  );
}
