import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Run a query that's not part of a manual transaction
export function query(text, params) {
  return pool.query(text, params);
}

// Run a set of queries inside a single DB transaction with row locking support.
// Usage: await withTransaction(async (client) => { ... await client.query(...) ... })
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
