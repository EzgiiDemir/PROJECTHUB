import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signPreviewTicket } from '@projecthub/core';
import { createPreviewGateway, servicePort } from '../dist/modules/gateway/gateway.js';
import { ADMIN, client, startHarness, waitFor, type Harness } from './harness.js';

/** A frontend app with its API as a manifest service: one preview address, two processes. */
const MANIFEST = `project:
  name: Servisli
runtime:
  type: node
build:
  command: node -e "require('fs').writeFileSync('built.txt', 'built in build step')"
start:
  command: node app.mjs
services:
  - name: api
    command: node api.mjs
    paths: [/api, /admin]
    health: /api/ping
    urlEnv: API_INTERNAL_URL
preview:
  mode: process
`;
const APP = `import http from 'node:http';
http.createServer(async (req, res) => {
  if (req.url === '/server-side') {
    const r = await fetch(process.env.API_INTERNAL_URL + '/api/ping');
    return res.end('app via ' + (await r.text()));
  }
  if (req.url === '/built') return res.end((await import('node:fs')).readFileSync('built.txt', 'utf8'));
  if (req.url === '/page') {
    // Streamed HTML (chunked), as Next.js sends it.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<html><head><title>x</title></head>');
    return setTimeout(() => res.end('<body>sayfa</body></html>'), 20);
  }
  res.end('app ' + req.url);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
const API = `import http from 'node:http';
http.createServer((req, res) => res.end(req.url === '/api/ping' ? 'pong' : 'api ' + req.url)).listen(Number(process.env.PORT), '127.0.0.1');
`;

const IMAGE = process.env.BUILD_CONTAINER_IMAGE ?? 'projecthub/build:php8.4-node22';
const dockerImage = (() => {
  try {
    execFileSync(process.env.DOCKER_BINARY || 'docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

// Host processes, and (with Docker and the build image) a container build whose preview runs in its own container
// from the volume the build filled.
describe.each(['host', ...(dockerImage ? ['container'] : [])])('preview with manifest services (%s)', (executor) => {
  let h: Harness;
  let gateway: http.Server;
  const api = client(() => h.base);
  const slug = 'servisli';

  beforeAll(async () => {
    h = await startHarness({ worker: true, env: { BUILD_EXECUTOR: executor, PREVIEW_EXECUTOR: executor, BUILD_CONTAINER_IMAGE: IMAGE } });
    gateway = createPreviewGateway(h.server.ctx);
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => gateway?.close(r));
    await h?.close();
  }, 120_000);

  it('routes service paths by longest prefix and everything else to the app', () => {
    const services = [
      { name: 'api', port: 1, paths: ['/api'], processId: null },
      { name: 'files', port: 2, paths: ['/api/files/'], processId: null },
    ];
    expect(servicePort(services, '/api')).toBe(1);
    expect(servicePort(services, '/api/forms/x')).toBe(1);
    expect(servicePort(services, '/api/files/a.pdf')).toBe(2);
    expect(servicePort(services, '/apis')).toBeUndefined();
    expect(servicePort(services, '/')).toBeUndefined();
  });

  it('starts the app and its service, gives the app the service URL and serves both on one address', async () => {
    expect((await api.post('/projects', { name: 'Servisli', slug, source: { type: 'empty' } })).status).toBe(201);
    await waitFor(async () => ((await api.get(`/projects/${slug}`)).data as { repository?: { status?: string } }).repository?.status === 'ready', 60_000);
    const head = ((await api.get(`/projects/${slug}/repo/branches`)).data as { branches: { name: string; sha: string }[] }).branches.find((b) => b.name === 'main')!.sha;
    const commit = await api.post(`/projects/${slug}/repo/commits`, {
      branch: 'main',
      baseCommit: head,
      message: 'app + api',
      changes: [
        { action: 'upsert', path: 'projecthub.yml', content: MANIFEST },
        { action: 'upsert', path: 'app.mjs', content: APP },
        { action: 'upsert', path: 'api.mjs', content: API },
      ],
    });
    expect(commit.status, JSON.stringify(commit.error)).toBe(201);
    const build = await api.post(`/projects/${slug}/builds`, { createPreview: true });
    expect(build.status, JSON.stringify(build.error)).toBe(201);
    const buildId = (build.data as { id: string }).id;
    const done = await waitFor(async () => {
      const b = (await api.get(`/builds/${buildId}`)).data as { status: string };
      return ['passed', 'failed'].includes(b.status) ? b : null;
    }, 180_000);
    expect(done.status).toBe('passed');

    const pv = await waitFor(async () => {
      const row = (await h.server.handle.db.execute<{ id: string; slug: string; status: string; error: string | null; services: { name: string; port: number }[] }>(sql`SELECT id, slug, status, error, services FROM previews WHERE build_id = ${buildId}`)).rows[0];
      return row && ['ready', 'failed'].includes(row.status) ? row : null;
    }, 180_000);
    expect(pv.error).toBeNull();
    expect(pv.status).toBe('ready');
    expect(pv.services.map((s) => s.name)).toEqual(['api']);

    const ticket = signPreviewTicket(h.config.encryptionKey, { previewId: pv.id, subject: 'system', ttlSeconds: 300 });
    const get = (path: string) =>
      new Promise<string>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: (gateway.address() as AddressInfo).port, path, headers: { host: `${pv.slug}.${h.config.PREVIEW_BASE_DOMAIN}`, cookie: `ph_pv=${ticket}` } }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.end();
      });
    expect(await get('/apply/form')).toBe('app /apply/form');
    expect(await get('/api/forms')).toBe('api /api/forms');
    expect(await get('/admin/login')).toBe('api /admin/login');
    expect(await get('/server-side')).toBe('app via pong');
    expect(await get('/built')).toBe('built in build step');
    const page = await get('/page');
    expect(page).toContain('<body>sayfa</body>');
    expect(page).toContain('/__ph/bridge.js');

    // A delayed duplicate job (original requeue plus lifecycle restart) must leave the winning preview alone.
    const { startPreview } = await import('../../worker/dist/jobs/preview.js');
    expect(await startPreview({ db: h.server.handle.db } as never, { job: { payload: { previewId: pv.id } } } as never))
      .toEqual({ skipped: 'ready' });
    expect(await get('/server-side')).toBe('app via pong');

    // Stopping the preview stops the service too.
    expect((await api.post(`/previews/${pv.id}/stop`)).status).toBeLessThan(300);
    const port = pv.services[0]!.port;
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/ping`).then(() => false).catch(() => true)), 30_000);
    // The processes' exits after an intentional stop do not turn it into a failure.
    await new Promise((r) => setTimeout(r, 2_000));
    const after = (await h.server.handle.db.execute<{ status: string; error: string | null }>(sql`SELECT status, error FROM previews WHERE id = ${pv.id}`)).rows[0]!;
    expect(after).toEqual({ status: 'stopped', error: null });
  }, 420_000);

  it.skipIf(executor !== 'container')('does not resurrect a stopped preview when delayed container startup returns', async () => {
    const { PreviewContainer } = await import('../../worker/dist/runner/preview-container.js');
    const original = PreviewContainer.prototype.start;
    let release!: () => void;
    let entered = false;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(PreviewContainer.prototype, 'start').mockImplementationOnce(async function (...args) {
      entered = true;
      await paused;
      return original.apply(this, args);
    });
    try {
      const build = (await h.server.handle.db.execute<{ id: string }>(sql`SELECT b.id FROM builds b JOIN projects p ON p.id = b.project_id WHERE p.slug = ${slug} AND b.status = 'passed' LIMIT 1`)).rows[0]!;
      const created = await api.post(`/projects/${slug}/previews`, { buildId: build.id });
      expect(created.status).toBe(201);
      const previewId = (created.data as { id: string }).id;
      await waitFor(async () => entered, 60_000);
      expect((await api.post(`/previews/${previewId}/stop`)).status).toBeLessThan(300);
      // Production has two preview slots. Simulate the other slot's committed stop while this slot is copying;
      // the harness intentionally has only one slot, so its queued stop handler cannot run until we release it.
      await h.server.handle.db.execute(sql`UPDATE previews SET status = 'stopped', stopped_at = now() WHERE id = ${previewId}`);
      release();
      await waitFor(async () => {
        const job = (await h.server.handle.db.execute<{ status: string }>(sql`SELECT status FROM jobs WHERE type = 'preview.start' AND payload->>'previewId' = ${previewId} ORDER BY created_at DESC LIMIT 1`)).rows[0];
        return job?.status === 'completed';
      }, 60_000);
      const preview = (await h.server.handle.db.execute<{ status: string; error: string | null }>(sql`SELECT status, error FROM previews WHERE id = ${previewId}`)).rows[0];
      expect(preview).toEqual({ status: 'stopped', error: null });
      const { listPreviewResources } = await import('../../worker/dist/runner/preview-container.js');
      expect((await listPreviewResources()).containers.some((c) => c.previewId === previewId)).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  }, 120_000);
});
