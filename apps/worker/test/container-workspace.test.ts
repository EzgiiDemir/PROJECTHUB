import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ContainerWorkspace } from '../src/runner/container-workspace.js';
import { dockerBinary, runContainerCommand } from '../src/runner/process.js';

const IMAGE = process.env.BUILD_CONTAINER_IMAGE_TEST ?? 'projecthub/build:php8.4-node22';
const available = (() => {
  try {
    execFileSync(dockerBinary(), ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

describe.skipIf(!available)('container workspace (real Docker, volume instead of a bind mount)', () => {
  it('runs commands as UID 1000 on the volume and brings the result back without escaping links', async () => {
    const host = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-cws-'));
    dirs.push(host);
    await fs.mkdir(path.join(host, 'src'), { recursive: true });
    await fs.writeFile(path.join(host, 'src', 'app.js'), 'console.log(1)\n');
    const ws = new ContainerWorkspace(dockerBinary(), IMAGE, `test-${Date.now()}`);
    try {
      await ws.seed(host);
      const out: string[] = [];
      const r = await runContainerCommand({
        command:
          'id -u > uid.txt && mkdir -p node_modules/acorn/bin node_modules/.bin && echo tool > node_modules/acorn/bin/acorn && ln -s ../acorn/bin/acorn node_modules/.bin/acorn && ln -s /etc/passwd leak && ln -s missing broken && cat src/app.js > built.js',
        cwd: host,
        env: {},
        timeoutMs: 120_000,
        workspaceMount: ws.mount(),
        limits: { image: IMAGE, cpus: 1, memoryMb: 512, pids: 128, network: 'none' },
        onOutput: (t) => out.push(t),
      });
      expect(r.exitCode, out.join('')).toBe(0);
      // Nothing was written into the host folder directly.
      await expect(fs.access(path.join(host, 'built.js'))).rejects.toThrow();
      await ws.copyBack(host);
      expect((await fs.readFile(path.join(host, 'uid.txt'), 'utf8')).trim()).toBe('1000');
      expect(await fs.readFile(path.join(host, 'built.js'), 'utf8')).toBe('console.log(1)\n');
      expect((await fs.readFile(path.join(host, 'node_modules', '.bin', 'acorn'), 'utf8')).trim()).toBe('tool');
      // A link out of the workspace or to nothing never reaches the host.
      await expect(fs.access(path.join(host, 'leak'))).rejects.toThrow();
      await expect(fs.access(path.join(host, 'broken'))).rejects.toThrow();
    } finally {
      await ws.remove();
    }
  }, 300_000);
});
