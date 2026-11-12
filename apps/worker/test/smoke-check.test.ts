import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest } from '@projecthub/contracts';
import { createLogger, loadConfig } from '@projecthub/core';
import { builds, jobs, organizations, previews, projects, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import type { WorkerCtx } from '../src/context.js';
import { smokeCheck } from '../src/jobs/autofix.js';

let h: DatabaseHandle & { close(): Promise<void> };
let ctx: WorkerCtx;
let orgId: string;
let projectId: string;
let app: http.Server;
let backend: http.Server;
const port = (s: http.Server) => (s.address() as AddressInfo).port;
const manifest = { health: { path: '/health' }, smoke: { paths: ['/', '/api/forms'] } } as unknown as Manifest;
let n = 0;

async function verificationBuild(preview: Partial<typeof previews.$inferInsert> | null) {
  n += 1;
  const b = (await h.db.insert(builds).values({ organizationId: orgId, projectId, number: n, branch: `ai/AI-${n}`, commitSha: 'a'.repeat(40), status: 'passed', finishedAt: new Date() }).returning())[0]!;
  if (preview) await h.db.insert(previews).values({ organizationId: orgId, projectId, buildId: b.id, slug: `smoke-${n}`, kind: 'process', sourceBranch: b.branch, sourceCommit: b.commitSha, expiresAt: new Date(Date.now() + 3600_000), ...preview });
  return b;
}

describe('behaviour check of a fix (smoke paths against its preview)', () => {
  let status = 200;
  beforeAll(async () => {
    h = (await freshDatabase()) as typeof h;
    ctx = { config: loadConfig({ ...process.env }), db: h.db, pool: h.pool, logger: createLogger('worker', 'silent') } as unknown as WorkerCtx;
    orgId = (await h.db.insert(organizations).values({ name: 'Test', slug: 'test' }).returning())[0]!.id;
    projectId = (await h.db.insert(projects).values({ organizationId: orgId, name: 'Duman', slug: 'duman' }).returning())[0]!.id;
    app = http.createServer((req, res) => res.writeHead(req.url === '/' ? status : 200).end('ok'));
    backend = http.createServer((_req, res) => res.writeHead(200).end('[]'));
    await Promise.all([app, backend].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app, backend].map((s) => new Promise((r) => s.close(r))));
    await h?.close();
  });

  it('passes when the app and its backend answer, routing service paths, and stops the preview', async () => {
    const b = await verificationBuild({ status: 'ready', internalPort: port(app), services: [{ name: 'backend', port: port(backend), paths: ['/api'], processId: null }] });
    const out = await smokeCheck(ctx, b, manifest);
    expect(out).toEqual({ ok: 'Davranış kontrolü geçti: uygulama açıldı, /health → 200, / → 200, /api/forms → 200.' });
    expect((await h.db.select().from(jobs).where(eq(jobs.type, 'preview.stop'))).length).toBe(1);
  });

  it('fails the fix when a page of the running app answers 5xx', async () => {
    status = 500;
    const out = await smokeCheck(ctx, await verificationBuild({ status: 'ready', internalPort: port(app) }), manifest);
    status = 200;
    expect(out?.failed).toMatch(/Davranış kontrolü başarısız: .*\/ → 500/);
  });

  it('waits while the app starts, and blames the fix only for a regression', async () => {
    expect(await smokeCheck(ctx, await verificationBuild({ status: 'starting' }), manifest)).toEqual({ pending: 'Uygulama açılıyor; davranış kontrolü bekliyor' });
    // Earlier previews of this project did start (the first test), so an app that no longer starts is a regression.
    const broken = await smokeCheck(ctx, await verificationBuild({ status: 'failed', error: 'Uygulama süreci beklenmedik şekilde kapandı (kod 1)' }), manifest);
    expect(broken?.failed).toMatch(/başlatılamadı.*önceki sürümler açılıyordu/);
    // No preview at all (preview disabled / static site): nothing to check.
    expect(await smokeCheck(ctx, await verificationBuild(null), manifest)).toBeNull();
  });

  it('does not blame a fix when the app never started in any preview of the project', async () => {
    await h.db.delete(previews).where(eq(previews.projectId, projectId));
    const out = await smokeCheck(ctx, await verificationBuild({ status: 'failed', error: 'kod 1' }), manifest);
    expect(out?.ok).toMatch(/yapılamadı/);
  });
});
