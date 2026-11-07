import { getDatabase } from '@netlify/database';

// Netlify Database (the replacement for the discontinued @netlify/neon extension).
// Migrations in netlify/database/migrations are applied by Netlify on deploy.
let pool;
export function productionSql() {
  pool ??= getDatabase().pool;
  return async (statement, values = []) => (await pool.query(statement, values)).rows;
}

export function pgliteSql(database) {
  return async (statement, values = []) => (await database.query(statement, values)).rows;
}
