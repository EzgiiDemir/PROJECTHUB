import type pg from 'pg';

/** A development stack and `start:worker` must not silently compete on the same host/database. */
export async function acquireDevWorkerLease(pool: pg.Pool, hostname: string, environment: string): Promise<() => Promise<void>> {
  if (environment !== 'development') return async () => {};
  const client = await pool.connect();
  const key = `projecthub:dev-worker:${hostname}`;
  try {
    const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [key]);
    if (!result.rows[0]?.acquired) throw new Error('Bu makine ve veritabanı için başka bir geliştirme worker’ı zaten çalışıyor. İkinci worker başlatılmadı.');
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
    finally { client.release(); }
  };
}
