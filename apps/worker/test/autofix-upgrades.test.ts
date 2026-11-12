import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@projecthub/core';
import { applyUpgrades } from '../src/jobs/autofix.js';

const win = process.platform === 'win32';
const composer = spawnSync('composer', ['--version'], { shell: win, stdio: 'ignore' }).status === 0;
const logger = createLogger('test', 'silent');

describe.skipIf(!composer)('deterministic Composer upgrade (real composer, packagist)', () => {
  it('moves a vulnerable package to the fixed version in composer.lock without running scripts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-composer-'));
    try {
      // A real lock pinned to an old version, then a normal caret constraint (as projects usually have).
      await fs.writeFile(path.join(dir, 'composer.json'), JSON.stringify({ name: 'ph/test', require: { 'psr/log': '1.1.0' }, scripts: { 'post-update-cmd': 'php -r "file_put_contents(\'SCRIPT_RAN\', 1);"' } }, null, 4));
      const init = spawnSync('composer', ['update', '--no-install', '--no-scripts', '--no-plugins', '--no-interaction', '--ignore-platform-reqs'], { cwd: dir, shell: win, encoding: 'utf8' });
      expect(init.status, init.stderr).toBe(0);
      const json = JSON.parse(await fs.readFile(path.join(dir, 'composer.json'), 'utf8'));
      json.require['psr/log'] = '^1.1';
      await fs.writeFile(path.join(dir, 'composer.json'), JSON.stringify(json, null, 4));

      const out = await applyUpgrades(dir, [{ ecosystem: 'Packagist', name: 'psr/log', from: '1.1.0', to: '1.1.4', source: 'composer.lock' }], logger);

      expect(out.applied.map((u) => u.name)).toEqual(['psr/log']);
      const lock = JSON.parse(await fs.readFile(path.join(dir, 'composer.lock'), 'utf8')) as { packages: { name: string; version: string }[] };
      const version = lock.packages.find((p) => p.name === 'psr/log')!.version;
      expect(version.replace(/^v/, '').localeCompare('1.1.4', undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
      expect(version.startsWith('1.')).toBe(true);
      expect(out.changes.map((c) => c.path).sort()).toEqual(['composer.lock']);
      await expect(fs.access(path.join(dir, 'SCRIPT_RAN'))).rejects.toThrow();
      await expect(fs.access(path.join(dir, 'vendor'))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('raises the constraint when it does not allow the fixed version', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-composer-'));
    try {
      await fs.writeFile(path.join(dir, 'composer.json'), JSON.stringify({ name: 'ph/test', require: { 'psr/log': '1.1.0' } }, null, 4));
      const init = spawnSync('composer', ['update', '--no-install', '--no-scripts', '--no-plugins', '--no-interaction', '--ignore-platform-reqs'], { cwd: dir, shell: win, encoding: 'utf8' });
      expect(init.status, init.stderr).toBe(0);

      const out = await applyUpgrades(dir, [{ ecosystem: 'Packagist', name: 'psr/log', from: '1.1.0', to: '1.1.4', source: 'composer.lock' }], logger);

      expect(out.applied.map((u) => u.name)).toEqual(['psr/log']);
      expect(JSON.parse(await fs.readFile(path.join(dir, 'composer.json'), 'utf8')).require['psr/log']).toBe('^1.1.4');
      expect(out.changes.map((c) => c.path).sort()).toEqual(['composer.json', 'composer.lock']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('deterministic npm lockfile (real npm, no network needed)', () => {
  it('creates package-lock.json for a project without one, never running package scripts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-npmlock-'));
    try {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ph-lock-test', version: '1.0.0', private: true, scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'SCRIPT_RAN\',\'1\')"' } }, null, 2));
      // The task page shows each real command live: first "running", last the exit code and output.
      const reports: { command: string; cwd: string; code: number | null }[] = [];
      const out = await applyUpgrades(dir, [{ ecosystem: 'npm', name: '', from: null, to: 'lockfile', source: 'package.json' }], logger, async (e) => void reports.push({ command: e.command, cwd: e.cwd, code: e.code }));
      expect(out.changes.map((c) => c.path).sort()).toEqual(['package-lock.json']);
      expect(reports[0]).toEqual({ command: 'npm install --package-lock-only --ignore-scripts --strict-peer-deps --no-audit --no-fund', cwd: '.', code: null });
      expect(reports.at(-1)).toMatchObject({ code: 0 });
      const lock = JSON.parse(await fs.readFile(path.join(dir, 'package-lock.json'), 'utf8')) as { name: string; lockfileVersion: number };
      expect(lock).toMatchObject({ name: 'ph-lock-test' });
      await expect(fs.access(path.join(dir, 'SCRIPT_RAN'))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
