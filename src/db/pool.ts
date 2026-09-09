/**
 * The one Postgres connection pool for the whole app.
 *
 * Import `pool` and call `pool.query(...)`. Do not create your own Pool anywhere
 * else: each pool opens its own set of connections and Postgres has a limit.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Failing here, loudly, at startup beats failing on the first request with a
  // confusing "password authentication failed for user undefined".
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

export const pool = new Pool({ connectionString });

// pg emits this for connection-level problems (database restarted, network dropped).
// Without a listener, Node treats it as an uncaught exception and kills the process.
pool.on('error', (err) => {
  console.error('Unexpected Postgres client error:', err);
});
