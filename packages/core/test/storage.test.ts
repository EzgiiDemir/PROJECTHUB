import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyDir, digestDirectory, hashDirectory, moveDir, Storage } from '../src/index.js';

/** A workspace with a Turbopack-style server external link: absolute junction on Windows, relative symlink elsewhere. */
async function workspace(tmp: string) {
  const src = path.join(tmp, 'workspace');
  await fs.mkdir(path.join(src, 'node_modules', 'pg'), { recursive: true });
  await fs.writeFile(path.join(src, 'node_modules', 'pg', 'index.js'), 'module.exports = 1;');
  await fs.mkdir(path.join(src, '.next', 'node_modules'), { recursive: true });
  const link = path.join(src, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
  if (process.platform === 'win32') await fs.symlink(path.join(src, 'node_modules', 'pg'), link, 'junction');
  else await fs.symlink('../../node_modules/pg', link);
  return src;
}

describe('moveDir (process artifacts are moved, not copied)', () => {
  it('re-points links that pointed into the old location', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-move-'));
    const src = await workspace(tmp);
    const dest = path.join(tmp, 'artifact');
    await moveDir(src, dest);
    await expect(fs.access(src)).rejects.toThrow();
    const moved = path.join(dest, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
    expect(await fs.readFile(path.join(moved, 'index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(path.resolve(path.dirname(moved), (await fs.readlink(moved)).replace(/^\\\\\?\\/, ''))).toBe(path.join(dest, 'node_modules', 'pg'));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe('copyDir (build workspace → artifact)', () => {
  it('keeps links into the copied tree valid after the source is deleted (Turbopack server externals)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-copy-'));
    const src = path.join(tmp, 'workspace');
    const dest = path.join(tmp, 'artifact');
    await fs.mkdir(path.join(src, 'node_modules', 'pg'), { recursive: true });
    await fs.writeFile(path.join(src, 'node_modules', 'pg', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(src, '.next', 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(src, 'secret.env'), 'X=1');
    // What Turbopack creates: an absolute junction on Windows, a relative symlink elsewhere.
    const link = path.join(src, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
    if (process.platform === 'win32') await fs.symlink(path.join(src, 'node_modules', 'pg'), link, 'junction');
    else await fs.symlink('../../node_modules/pg', link);

    await copyDir(src, dest, (rel) => !rel.endsWith('.env'));
    await fs.rm(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const copied = path.join(dest, '.next', 'node_modules', 'pg-b1376c1eb08f9ce3');
    expect(await fs.readFile(path.join(copied, 'index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(path.resolve(path.dirname(copied), (await fs.readlink(copied)).replace(/^\\\\\?\\/, ''))).toBe(path.join(dest, 'node_modules', 'pg'));
    await expect(fs.access(path.join(dest, 'secret.env'))).rejects.toThrow(); // filter still applies
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe('hashDirectory (artifact provenance)', () => {
  it('is deterministic and detects changed content', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-hash-'));
    await fs.mkdir(path.join(tmp, 'b'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'b', 'two.txt'), 'two');
    await fs.writeFile(path.join(tmp, 'one.txt'), 'one');
    const first = await hashDirectory(tmp);
    expect(await hashDirectory(tmp)).toBe(first);
    await fs.writeFile(path.join(tmp, 'one.txt'), 'changed');
    expect(await hashDirectory(tmp)).not.toBe(first);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('keeps the sequential digest format (deployments verify artifacts built before the parallel reader)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-hash-'));
    const files: Record<string, Buffer> = { 'a.txt': Buffer.from('a'), 'z/big.bin': Buffer.alloc(9 * 1024 * 1024, 7) };
    for (let i = 0; i < 40; i++) files[`m/${String(i).padStart(2, '0')}.txt`] = Buffer.from(`file ${i}`);
    for (const [rel, data] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
      await fs.writeFile(path.join(tmp, rel), data);
    }
    const expected = createHash('sha256');
    for (const rel of Object.keys(files).sort()) expected.update(`file\0${rel}\0${files[rel]!.length}\0`).update(files[rel]!).update('\0');
    expect(await digestDirectory(tmp)).toEqual({ checksum: expected.digest('hex'), sizeBytes: Object.values(files).reduce((n, b) => n + b.length, 0) });
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('rejects links outside the artifact tree', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-hash-link-'));
    const artifact = path.join(tmp, 'artifact');
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(artifact);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    await fs.symlink(outside, path.join(artifact, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(hashDirectory(artifact)).rejects.toThrow('Artifact dışına');
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe('Storage root', () => {
  it('uses the long real path, so build tools never see a Windows 8.3 short name', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-root-'));
    const storage = new Storage(tmp);
    await storage.init();
    expect(storage.root).toBe(await fs.realpath(tmp));
    expect(storage.root).not.toMatch(/~\d/);
    expect(storage.resolve('workspaces/build-1').startsWith(storage.root)).toBe(true);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
