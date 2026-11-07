import { getDatabase } from '@netlify/database';

// Netlify Database (the replacement for the discontinued @netlify/neon extension).
// Migrations in netlify/database/migrations are applied by Netlify on deploy.
let pool;
export function productionSql() {
  pool ??= getDatabase().pool;
  const sql = async (statement, values = []) => (await pool.query(statement, values)).rows;
  sql.transaction = async (work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(async (statement, values = []) => (await client.query(statement, values)).rows);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  return sql;
}

export function pgliteSql(database) {
  const sql = async (statement, values = []) => (await database.query(statement, values)).rows;
  sql.transaction = (work) => database.transaction((tx) => work(async (statement, values = []) => (await tx.query(statement, values)).rows));
  return sql;
}
