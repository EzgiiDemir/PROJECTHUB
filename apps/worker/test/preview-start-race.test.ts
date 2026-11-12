import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ exec: vi.fn(), reuse: vi.fn(), remove: vi.fn(), seed: vi.fn(), complete: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mock.exec }) };
});
vi.mock('../src/runner/container-workspace.js', () => ({
  ContainerWorkspace: class {
    reuseIfComplete = mock.reuse;
    remove = mock.remove;
    seed = mock.seed;
    markComplete = mock.complete;
    mount() { return 'type=volume,source=test-preview,target=/workspace'; }
  },
}));

import { PreviewContainer } from '../src/runner/preview-container.js';
import { previewAttemptOwner } from '../src/jobs/preview-owner.js';

const ID = 'a'.repeat(64);
const range = { from: 41000, to: 41999 };
const box = () => new PreviewContainer('docker', { image: 'test-image', cpus: 1, memoryMb: 512, pids: 128 }, 'test-preview', 'test-artifact');

beforeEach(() => {
  vi.resetAllMocks();
  mock.exec.mockImplementation(async (_binary, args) => ({ stdout: args[0] === 'run' ? ID + '\n' : '', stderr: '' }));
  mock.reuse.mockResolvedValue(false);
  mock.remove.mockResolvedValue(undefined);
  mock.seed.mockResolvedValue(undefined);
  mock.complete.mockResolvedValue(undefined);
});

describe('preview startup fencing', () => {
  it('distinguishes jobs and retries on the same worker without breaking local cleanup', () => {
    const first = previewAttemptOwner('workstation:123:abc', 'job-a', 1);
    expect(previewAttemptOwner('workstation:123:abc', 'job-a', 1)).toBe(first);
    expect(previewAttemptOwner('workstation:123:abc', 'job-b', 1)).not.toBe(first);
    expect(previewAttemptOwner('workstation:123:abc', 'job-a', 2)).not.toBe(first);
    expect(first.split(':')[0]).toBe('workstation');
    expect(previewAttemptOwner('h'.repeat(63) + ':123:abc', 'job-a', 1).length).toBeLessThanOrEqual(100);
  });
  it('does nothing when the job was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(box().start('/source', [41001], range, { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it('does not mark or launch a copy completed after worker shutdown', async () => {
    let finish!: () => void;
    mock.seed.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const started = box().start('/source', [41001], range, { signal: controller.signal });
    const rejected = expect(started).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(mock.seed).toHaveBeenCalledOnce());
    controller.abort();
    finish();
    await rejected;
    expect(mock.complete).not.toHaveBeenCalled();
    expect(mock.exec.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false);
  });

  it('does not remove a named container after ownership changed during inspection', async () => {
    let current = true;
    mock.exec.mockImplementation(async () => { current = false; return { stdout: ID, stderr: '' }; });
    await expect(box().start('/source', [41001], range, { assertCurrent: async () => {
      if (!current) throw new Error('startup ownership changed');
    } })).rejects.toThrow('ownership changed');
    expect(mock.exec.mock.calls.some(([, args]) => args[0] === 'rm' || args[0] === 'run')).toBe(false);
  });

  it('stops after copy when the preview was stopped or its job lease changed', async () => {
    let current = true;
    mock.seed.mockImplementation(async () => { current = false; });
    await expect(box().start('/source', [41001], range, { assertCurrent: async () => {
      if (!current) throw new Error('startup ownership changed');
    } })).rejects.toThrow('ownership changed');
    expect(mock.complete).not.toHaveBeenCalled();
    expect(mock.exec.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false);
  });

  it('cleans up only its captured container ID if shutdown happens during docker run', async () => {
    const controller = new AbortController();
    mock.exec.mockImplementation(async (_binary, args) => {
      if (args[0] === 'run') controller.abort();
      return { stdout: args[0] === 'run' ? ID : '', stderr: '' };
    });
    const preview = box();
    await expect(preview.start('/source', [41001], range, { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(mock.exec.mock.calls.at(-1)?.[1]).toEqual(['rm', '-f', ID]);
    expect(() => preview.execArgs('node app.js', [])).toThrow('başlangıcı tamamlanmadı');
  });

  it('pins commands and late cleanup to its own immutable ID rather than a reusable name', async () => {
    const preview = box();
    await preview.start('/source', [41001], range);
    expect(preview.execArgs('node app.js', [])).toContain(ID);
    expect(preview.execArgs('node app.js', [])).not.toContain(preview.name);
    await preview.remove();
    expect(mock.exec.mock.calls.at(-1)?.[1]).toEqual(['rm', '-f', ID]);
    const calls = mock.exec.mock.calls.length;
    await preview.remove();
    expect(mock.exec).toHaveBeenCalledTimes(calls);
  });
});
