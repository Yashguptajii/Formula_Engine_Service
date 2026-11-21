import 'dotenv/config';
import mysql from 'mysql2/promise';

export function buildPoolConfig(env = process.env) {
  const port = Number(env.DB_PORT || 3306);
  const connectionLimit = Number(env.DB_CONNECTION_LIMIT || 15);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT must be a valid TCP port');
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) throw new Error('DB_CONNECTION_LIMIT must be a positive integer');
  return {
    host: env.DB_HOST || '127.0.0.1',
    port,
    user: env.DB_USER || 'formula_user',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'formula_engine',
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    decimalNumbers: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  };
}

export function createDbPool(env = process.env) {
  return mysql.createPool(buildPoolConfig(env));
}

export const pool = createDbPool();

export async function withTransaction(work, db = pool) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve original error */ }
    throw error;
  } finally {
    connection.release();
  }
}
