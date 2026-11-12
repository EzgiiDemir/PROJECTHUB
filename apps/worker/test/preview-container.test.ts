import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { artifactWorkspace, forwarderPort, hostLoopbackToGateway, listPreviewResources, PreviewContainer } from '../src/runner/preview-container.js';
import { ContainerWorkspace } from '../src/runner/container-workspace.js';
import { dockerBinary, isPortFree, killPortListener, killTree, startService } from '../src/runner/process.js';

const IMAGE = process.env.BUILD_CONTAINER_IMAGE_TEST ?? 'projecthub/build:php8.4-node22';
const available = (() => {
  try {
    execFileSync(dockerBinary(), ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

describe('preview container helpers', () => {
  it('points loopback secrets at the host gateway and leaves everything else alone', () => {
    expect(
      hostLoopbackToGateway({
        DB_HOST: '127.0.0.1',
        REDIS_HOST: 'localhost',
        DATABASE_URL: 'postgres://u:p@localhost:5432/app',
        API: 'http://127.0.0.1:8000/v1',
        REMOTE: 'https://db.example.com',
        NOTE: 'localhost-only mode',
      }),
    ).toEqual({
      DB_HOST: 'host.docker.internal',
      REDIS_HOST: 'host.docker.internal',
      DATABASE_URL: 'postgres://u:p@host.docker.internal:5432/app',
      API: 'http://host.docker.internal:8000/v1',
      REMOTE: 'https://db.example.com',
      NOTE: 'localhost-only mode',
    });
  });

  it('keeps forwarder ports outside the preview port range', () => {
    expect(forwarderPort(0, { from: 41000, to: 41999 })).toBe(60001);
    expect(forwarderPort(1, { from: 61000, to: 61999 })).toBe(60998);
  });
});

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

async function freePort(): Promise<number> {
  for (;;) {
    const p = 42000 + Math.floor(Math.random() * 900);
    if (await isPortFree(p)) return p;
  }
}

async function get(port: number, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
      return await res.text();
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no answer on ${port}: ${last}`);
}

describe.skipIf(!available)('preview container (real Docker)', () => {
  it('late cleanup of an old attempt cannot remove its same-name replacement', async () => {
    const host = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-pvr-'));
    dirs.push(host);
    await fs.writeFile(path.join(host, 'marker.txt'), 'test-only');
    const identity = `test-race-${Date.now()}`;
    const limits = { image: IMAGE, cpus: 1, memoryMb: 512, pids: 128 };
    const previous = new PreviewContainer(dockerBinary(), limits, identity, identity);
    const replacement = new PreviewContainer(dockerBinary(), limits, identity, identity);
    try {
      await previous.start(host, [await freePort()], { from: 41000, to: 41999 });
      await replacement.start(host, [await freePort()], { from: 41000, to: 41999 });
      await previous.remove();
      const answer = execFileSync(dockerBinary(), replacement.execArgs('node -p "6 * 7"', []), { encoding: 'utf8', timeout: 15_000 });
      expect(answer.trim()).toBe('42');
    } finally {
      await previous.remove();
      await replacement.remove();
      await replacement.removeVolume();
    }
  }, 120_000);

  it('fills an artifact volume from a build volume inside Docker, pruned like the stored artifact', async () => {
    const host = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-pvs-'));
    dirs.push(host);
    for (const [rel, content] of Object.entries({ 'backend/artisan': '<?php', 'backend/.env': 'APP_KEY=secret', 'backend/storage/logs/laravel.log': 'x', 'backend/storage/logs/.gitignore': '*', 'odd name/-dash.txt': 'keep' })) {
      await fs.mkdir(path.dirname(path.join(host, rel)), { recursive: true });
      await fs.writeFile(path.join(host, rel), content);
    }
    const build = new ContainerWorkspace(dockerBinary(), IMAGE, `test-build-${Date.now()}`);
    const target = artifactWorkspace(dockerBinary(), IMAGE, `test-art-${Date.now()}`);
    try {
      await build.seed(host);
      await target.seedFrom(build, ['backend/.env', 'backend/storage/logs/laravel.log', '../escape']);
      const list = execFileSync(dockerBinary(), ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--mount', target.mount(), IMAGE, '-c', 'cd /workspace && find . -type f | sort && stat -c %u backend/artisan'], { encoding: 'utf8' });
      expect(list.trim().split('\n')).toEqual(['./.projecthub-seeded', './backend/artisan', './backend/storage/logs/.gitignore', './odd name/-dash.txt', '1000']);
      // A later preview start sees the complete copy and does not copy again.
      expect(await artifactWorkspace(dockerBinary(), IMAGE, target.volume.replace('projecthub-ws-art-', '')).reuseIfComplete()).toBe(true);
    } finally {
      await build.remove();
      await target.remove();
    }
  }, 120_000);

  it('runs a 127.0.0.1-bound app and service non-root and read-only, reachable from the host, and removes everything', async () => {
    const host = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-pvc-'));
    dirs.push(host);
    // Both bind 127.0.0.1 inside the container, as Form's next start and artisan serve do.
    await fs.writeFile(path.join(host, 'service.js'), "require('http').createServer((q, s) => s.end('service-ok')).listen(Number(process.env.PORT), '127.0.0.1');\n");
    await fs.writeFile(
      path.join(host, 'app.js'),
      [
        "const fs = require('fs');",
        "const ro = (() => { try { fs.writeFileSync('/etc/x', '1'); return false; } catch { return true; } })();",
        "fs.writeFileSync('storage.txt', 'written');",
        "console.log('token is ' + process.env.API_TOKEN);",
        "require('http').createServer(async (q, s) => {",
        "  const svc = await fetch(process.env.SERVICE_URL).then((r) => r.text()).catch((e) => e.message);",
        "  s.end(JSON.stringify({ uid: process.getuid(), ro, db: process.env.DB_HOST, svc, path: process.env.PATH.includes('Windows') }));",
        "}).listen(Number(process.env.PORT), '127.0.0.1');",
      ].join('\n'),
    );
    const appPort = await freePort();
    let svcPort = await freePort();
    while (svcPort === appPort) svcPort = await freePort();
    const box = new PreviewContainer(dockerBinary(), { image: IMAGE, cpus: 1, memoryMb: 512, pids: 128 }, `test-${Date.now()}`, `art-test-${Date.now()}`);
    const logFile = path.join(host, 'preview.log');
    const env = { ...hostLoopbackToGateway({ DB_HOST: '127.0.0.1', API_TOKEN: 'tok_9f8e7d6c5b4a3210' }), SERVICE_URL: `http://127.0.0.1:${svcPort}` };
    const children = [];
    try {
      await box.start(host, [appPort, svcPort], { from: 41000, to: 41999 });
      const svcEnv = { ...env, PORT: String(svcPort) };
      children.push(startService({ command: 'node service.js', cwd: host, env: svcEnv, logFile, mask: ['tok_9f8e7d6c5b4a3210'], dockerArgs: box.execArgs('node service.js', Object.keys(svcEnv)) }));
      expect(await get(svcPort)).toBe('service-ok');
      const appEnv = { ...env, PORT: String(appPort) };
      children.push(startService({ command: 'node app.js', cwd: host, env: appEnv, logFile, mask: ['tok_9f8e7d6c5b4a3210'], dockerArgs: box.execArgs('node app.js', Object.keys(appEnv)) }));
      const answer = JSON.parse(await get(appPort)) as Record<string, unknown>;
      expect(answer).toEqual({ uid: 1000, ro: true, db: 'host.docker.internal', svc: 'service-ok', path: false });
      // The host's preview cleanup must never kill Docker's port proxy that holds the published port.
      await killPortListener(appPort);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(JSON.parse(await get(appPort, 10_000)).uid).toBe(1000);
      const log = await fs.readFile(logFile, 'utf8');
      expect(log).toContain('token is ***');
      expect(log).not.toContain('tok_9f8e7d6c5b4a3210');
      // The app wrote into its own volume, never into the stored artifact.
      await expect(fs.access(path.join(host, 'storage.txt'))).rejects.toThrow();
      for (const c of children.splice(0)) await killTree(c);
      await box.remove();
      expect(await isPortFree(appPort)).toBe(true);

      // A restart reuses the artifact's volume (the app's own writes included) instead of copying the files again.
      await fs.writeFile(path.join(host, 'app.js'), "require('http').createServer((q, s) => s.end(require('fs').readFileSync('storage.txt', 'utf8'))).listen(Number(process.env.PORT), '127.0.0.1');\n");
      await box.start(host, [appPort], { from: 41000, to: 41999 });
      children.push(startService({ command: 'node app.js', cwd: host, env: appEnv, logFile, dockerArgs: box.execArgs('node app.js', Object.keys(appEnv)) }));
      // Still the first copy's app.js: it answers with its JSON, not with the stored file's content.
      expect(await get(appPort)).toContain('"uid":1000');
    } finally {
      for (const c of children) await killTree(c);
      await box.remove();
    }
    let left = await listPreviewResources(dockerBinary());
    expect(left.containers.filter((r) => r.previewId === box.previewId)).toEqual([]);
    expect(left.volumes.filter((r) => r.artifactId === box.artifactId)).toHaveLength(1);
    await box.removeVolume();
    left = await listPreviewResources(dockerBinary());
    expect(left.volumes.filter((r) => r.artifactId === box.artifactId)).toEqual([]);
  }, 240_000);
});
