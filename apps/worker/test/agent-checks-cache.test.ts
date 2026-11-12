import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileChange, GitRepository } from '@projecthub/core';
import type { WorkerCtx } from '../src/context.js';
import { AgentChecks, type CheckKind } from '../src/jobs/agent-checks.js';

function fixture() {
  const controller = new AbortController();
  const checks = new AgentChecks({} as WorkerCtx, {
    organizationId: 'org', projectId: 'project', taskId: 'task', git: {} as GitRepository,
    base: 'base', signal: controller.signal,
  });
  const run = vi.spyOn(checks as unknown as { run(kind: CheckKind, changes: FileChange[]): Promise<string> }, 'run');
  const edits = (content: string): FileChange[] => [{ path: 'src/index.ts', action: 'upsert', content: Buffer.from(content) }];
  return { checks, controller, run, edits };
}

describe('agent verification reuse', () => {
  it('rolls back package and lock files after a failed dependency resolver', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-agent-lock-rollback-'));
    const checks = new AgentChecks({ config: { BUILD_INSTALL_TIMEOUT_MINUTES: 1 } } as WorkerCtx, { organizationId: 'org', projectId: 'project', taskId: 'task', git: {} as GitRepository, base: 'base', signal: new AbortController().signal });
    const state = checks as unknown as { dir: string; env: NodeJS.ProcessEnv; applied: Map<string, string | null>; prepare(): Promise<void>; exec(): Promise<{ exitCode: number }> };
    state.dir = dir;
    state.env = {};
    vi.spyOn(state, 'prepare').mockResolvedValue(undefined);
    const original = '{"name":"original"}';
    try {
      await fs.writeFile(path.join(dir, 'package.json'), original);
      await fs.writeFile(path.join(dir, 'package-lock.json'), 'original lock');
      vi.spyOn(state, 'exec').mockImplementation(async () => {
        await fs.writeFile(path.join(dir, 'package-lock.json'), 'partial lock');
        return { exitCode: 1 };
      });
      await expect(checks.updateNpmLock('package.json', [{ action: 'upsert', path: 'package.json', content: '{"name":"unaccepted"}' }])).rejects.toThrow('Lock üretilemedi');
      expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe(original);
      expect(await fs.readFile(path.join(dir, 'package-lock.json'), 'utf8')).toBe('original lock');
      expect(state.applied.has('package.json')).toBe(false);
    } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
  });
  it('generates a real npm lockfile without executing package lifecycle scripts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-agent-lock-'));
    const controller = new AbortController();
    const checks = new AgentChecks({ config: { BUILD_EXECUTOR: 'host', BUILD_INSTALL_TIMEOUT_MINUTES: 1 } } as WorkerCtx, { organizationId: 'org', projectId: 'project', taskId: 'task', git: {} as GitRepository, base: 'base', signal: controller.signal });
    const state = checks as unknown as { dir: string; env: NodeJS.ProcessEnv; prepare(): Promise<void> };
    state.dir = dir;
    state.env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, npm_config_cache: path.join(dir, 'cache') };
    vi.spyOn(state, 'prepare').mockResolvedValue(undefined);
    try {
      await fs.mkdir(path.join(dir, 'frontend'));
      await fs.writeFile(path.join(dir, 'frontend/package.json'), JSON.stringify({ name: 'lock-test', version: '1.0.0', scripts: { preinstall: 'node -e "process.exit(99)"' } }));
      const change = await checks.updateNpmLock('frontend/package.json', []);
      expect(change.path).toBe('frontend/package-lock.json');
      expect(change.action).toBe('upsert');
      if (change.action !== 'delete') expect(JSON.parse(change.content.toString()).packages[''].name).toBe('lock-test');
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);

  it('does not reinstall unchanged code after the same failed check', async () => {
    const { checks, run, edits } = fixture();
    run.mockResolvedValue('✘ Kurulum BAŞARISIZ\nHata: Permission denied');
    await checks.check('all', edits('v1'));
    expect(await checks.check('all', edits('v1'))).toContain('komutlar yeniden çalıştırılmadı');
    expect(run).toHaveBeenCalledTimes(1);
    await checks.check('all', edits('v2'));
    await checks.check('test', edits('v2'));
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('reuses a success but does not cache cancellation or an incomplete result', async () => {
    const { checks, run, edits } = fixture();
    run.mockResolvedValueOnce('Kontrol iptal edildi.').mockResolvedValueOnce('Henüz tamamlanmadı.').mockResolvedValue('✔ Build başarılı\nTüm kontroller geçti.');
    await checks.check('build', edits('v1'));
    await checks.check('build', edits('v1'));
    await checks.check('build', edits('v1'));
    expect(await checks.check('build', edits('v1'))).toContain('komutlar yeniden çalıştırılmadı');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not reuse results from an aborted task', async () => {
    const { checks, controller, run, edits } = fixture();
    controller.abort();
    run.mockResolvedValue('✘ Kurulum BAŞARISIZ');
    await checks.check('all', edits('v1'));
    await checks.check('all', edits('v1'));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
