/**
 * Runs every migrations/*.sql file that has not run yet, in filename order.
 *
 * Run it with `npm run migrate`. It is safe to run repeatedly: applied filenames are
 * recorded in the schema_migrations table and skipped next time.
 *
 * To add a migration, create migrations/002_something.sql. Never edit a file that has
 * already run on someone else's machine, because their database will not re-run it.
 * Write a new numbered file instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool';

// Works from src/db (via tsx) and from dist/db (after npm run build).
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const alreadyRun = new Set(applied.rows.map((row) => row.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort(); // 001_, 002_, ... which is why the numbers are zero-padded

  for (const filename of files) {
    if (alreadyRun.has(filename)) {
      console.log(`skip  ${filename}`);
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

    // One transaction per file: a migration either applies completely or not at all,
    // so a syntax error halfway down does not leave a half-built schema behind.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`apply ${filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log('Migrations up to date.');
}

migrate()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
