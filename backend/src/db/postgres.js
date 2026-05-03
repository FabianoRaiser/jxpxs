import pg from 'pg';

const { Pool } = pg;

let _pool;

export function getPool() {
  if (_pool) return _pool;
  const connectionString =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/filmes';
  _pool = new Pool({ connectionString });
  return _pool;
}

export async function withClient(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

