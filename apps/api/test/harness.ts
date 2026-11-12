import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger, JobRunner, loadConfig, newWorkerId, QUEUES, Storage, type AppConfig } from '@projecthub/core';
import { freshDatabase, TEST_DATABASE_URL } from '../../../test/support/db.js';
import { inArray } from 'drizzle-orm';
import { previews } from '@projecthub/database';
// Nest resolves dependencies from decorator metadata, which only the tsc build emits (pnpm test builds first).
import { createApiServer, type ApiServer } from '../dist/server.js';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const ADMIN = { email: 'Admin@Example.com', password: 'Yonetici-2026-Test' };

export interface Harness {
  base: string;
  server: ApiServer;
  config: AppConfig;
  /** Stops the in-process worker as a deploy or dev rebuild would (running jobs see their signal aborted). */
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Fresh test database, first Super Admin through the real `admin:create` CLI, the real API on a random port and —
 * when asked — the real worker job handlers running in-process (repository provisioning, scans, notifications).
 */
export async function startHarness(opts: { worker?: boolean; env?: Record<string, string> } = {}): Promise<Harness> {
  // The handle holds the test database's lock for the harness lifetime: another test file started meanwhile waits
  // instead of dropping the schema under this API and worker.
  const h = await freshDatabase();
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'packages/core/dist/cli/create-admin.js'), '--email', ADMIN.email, '--name', 'Test Yönetici', '--org', 'Test Şirketi'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PH_ADMIN_PASSWORD: ADMIN.password },
  });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-api-'));
  // The developer's .env (loaded for DATABASE_URL) must not decide where tests run project code: host unless a test
  // asks for containers through opts.env.
  const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DATABASE_URL, STORAGE_DIR: tmp, APP_URL: 'http://localhost:3100', COOKIE_SECURE: 'false', GIT_IMPORT_ALLOW_LOCAL: 'true', SMTP_HOST: '', BUILD_EXECUTOR: 'host', PREVIEW_EXECUTOR: 'host', OSV_API_URL: '', NPM_REGISTRY_URL: '', PYPI_URL: '', PACKAGIST_URL: '', ...opts.env }, { cwd: tmp });
  const server = await createApiServer(config, { logger: createLogger('api', process.env.TEST_LOG_LEVEL ?? 'silent') });
  await server.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.app.getHttpServer().address() as AddressInfo).port}`;
  let runner: JobRunner | null = null;
  let workerCtx: unknown = null;
  if (opts.worker) {
    const { buildHandlers } = await import('../../worker/dist/handlers.js');
    const logger = createLogger('worker', process.env.TEST_LOG_LEVEL ?? 'silent');
    const storage = new Storage(config.storageDir);
    const workerId = newWorkerId();
    const ctx = { config, db: server.handle.db, pool: server.handle.pool, storage, logger, workerId };
    workerCtx = ctx;
    runner = new JobRunner({ db: server.handle.db, pool: server.handle.pool, logger }, buildHandlers(ctx), [QUEUES.git, QUEUES.build, QUEUES.preview, QUEUES.deployment, QUEUES.ai, QUEUES.fix, QUEUES.index, QUEUES.security, QUEUES.notification, QUEUES.default, QUEUES.terminal].map((name) => ({ name, concurrency: 1 })), { leaseMs: 30_000, workerId });
    await runner.start();
  }
  return {
    base,
    server,
    config,
    async stopWorker() {
      await runner?.stop(10_000);
      runner = null;
    },
    async close() {
      const t = Date.now();
      const trace = (step: string) => process.env.HARNESS_TRACE && console.error(`[harness] ${step} +${Date.now() - t} ms`);
      // Previews (e.g. of a fix's behaviour check) run app processes that would keep the temp folder locked on Windows.
      if (workerCtx) {
        const { stopPreviewNow } = await import('../../worker/dist/jobs/preview.js');
        const open = await server.handle.db.select({ id: previews.id }).from(previews).where(inArray(previews.status, ['queued', 'starting', 'ready']));
        for (const p of open) await stopPreviewNow(workerCtx as never, p.id, 'stopped').catch(() => undefined);
        trace(`${open.length} previews stopped`);
      }
      await runner?.stop(5_000);
      trace('worker stopped');
      await server.close();
      trace('api closed');
      await h.close();
      trace('database closed');
      // Windows keeps files of just-exited processes (git, terminal shells) locked for a moment; a leftover temp
      // folder must not fail an otherwise green suite.
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
    },
  };
}

/** Tiny client with a cookie jar, the CSRF header for writes and the API envelope unwrapped. */
export function client(base: () => string) {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base()}/api/v1${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-requested-with': 'projecthub' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('ph_session='));
    if (set) cookie = set.split(';')[0]!;
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } | null;
    return { status: res.status, data: json?.data as never, error: json?.error };
  };
  return {
    get: (u: string, h?: Record<string, string>) => call('GET', u, undefined, h),
    post: (u: string, b: unknown = {}, h?: Record<string, string>) => call('POST', u, b, h),
    put: (u: string, b: unknown) => call('PUT', u, b),
    patch: (u: string, b: unknown) => call('PATCH', u, b),
    del: (u: string) => call('DELETE', u),
    raw: call,
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}
