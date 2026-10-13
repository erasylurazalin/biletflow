/**
 * Runs `work` inside one Postgres transaction on one connection.
 *
 * Use it when several statements must happen together or not at all, or when a row
 * lock (SELECT ... FOR UPDATE) has to last until the end of the work:
 *
 *   const id = await withTransaction(async (client) => {
 *     await client.query('SELECT ... FOR UPDATE', [...]);
 *     return (await client.query('INSERT ... RETURNING id', [...])).rows[0].id;
 *   });
 *
 * Inside `work`, use `client.query`, never `pool.query`: the pool may hand the query to
 * another connection, which is outside the transaction and does not see its locks.
 * Throwing anything rolls the whole transaction back.
 */
import type { PoolClient } from 'pg';
import { pool } from './pool';

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // Set when the connection itself failed, so the pool throws it away instead of
  // handing a broken connection to the next request.
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
