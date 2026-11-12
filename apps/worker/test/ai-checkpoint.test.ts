import { describe, expect, it } from 'vitest';
import { checkpointIdentity, decodeCheckpoint, encodeCheckpoint } from '../src/jobs/ai-checkpoint.js';

describe('encrypted AI draft checkpoints', () => {
  const key = Buffer.alloc(32, 7);
  const input = { taskId: 'task', projectId: 'project', base: 'abc', baseBranch: 'main', instruction: 'fix', title: 'Bug' };
  const changes = [{ action: 'upsert' as const, path: 'src/code.ts', content: 'private source' }, { action: 'delete' as const, path: 'old.ts' }];
  it('round-trips changes without putting source text in a job payload', () => {
    const identity = checkpointIdentity(input);
    const packed = encodeCheckpoint(key, identity, changes);
    expect(packed).not.toContain('private source');
    expect(decodeCheckpoint(key, packed, identity)).toEqual(changes);
    expect(encodeCheckpoint(key, identity, changes)).not.toBe(packed);
  });
  it('rejects cross-project/task, moved-base and changed-instruction reuse', () => {
    const packed = encodeCheckpoint(key, checkpointIdentity(input), changes);
    for (const patch of [{ taskId: 'other' }, { projectId: 'other' }, { base: 'new-head' }, { baseBranch: 'other' }, { instruction: 'changed' }]) expect(decodeCheckpoint(key, packed, checkpointIdentity({ ...input, ...patch }))).toBeNull();
  });
  it('rejects corrupted ciphertext and a different encryption key', () => {
    const identity = checkpointIdentity(input);
    const packed = encodeCheckpoint(key, identity, changes);
    expect(() => decodeCheckpoint(Buffer.alloc(32, 8), packed, identity)).toThrow();
    const parts = packed.split('.');
    parts[2] = '00'.repeat(16);
    expect(() => decodeCheckpoint(key, parts.join('.'), identity)).toThrow();
  });
});
