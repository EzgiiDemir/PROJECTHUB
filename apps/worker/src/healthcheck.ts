import os from 'node:os';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function isWorkerAlive(
  row: { hostname: string; pid: number; last_seen_at: Date | string },
  hostname: string,
  now: number,
  processAlive: (pid: number) => boolean,
): boolean {
  const age = now - new Date(row.last_seen_at).getTime();
  return row.hostname === hostname && Number.isInteger(row.pid) && row.pid > 1
    && Number.isFinite(age) && age >= -5_000 && age <= 45_000 && processAlive(row.pid);
}

/** A stale row or another container's healthy worker must not hide this worker's failure. */
export async function checkWorker(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
    application_name: 'projecthub-worker-health', connectionTimeoutMillis: 2_000,
    query_timeout: 2_000, statement_timeout: 2_000 });
  // PostgreSQL/network failures are intentionally redacted, including asynchronous socket errors.
  let connectionFailed = false;
  client.on('error', () => { connectionFailed = true; });
  try {
    await client.connect();
    const hostname = os.hostname();
    const result = await client.query<{ hostname: string; pid: number; last_seen_at: Date }>(
      'SELECT hostname, pid, last_seen_at FROM worker_heartbeats WHERE hostname = $1 AND last_seen_at > now() - interval \'45 seconds\'', [hostname],
    );
    return !connectionFailed && result.rows.some((row) => isWorkerAlive(row, hostname, Date.now(), (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }));
  } catch { return false; }
  finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const healthy = await checkWorker();
  if (!healthy) console.error('Worker heartbeat/process/database check failed.');
  process.exitCode = healthy ? 0 : 1;
}
