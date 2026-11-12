import { describe, expect, it, vi } from 'vitest';
import { assertTerminalRuntime } from '../src/jobs/terminal-runtime.js';

describe('terminal worker runtime preflight', () => {
  it('accepts a reachable runtime without a host-shell fallback', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    await expect(assertTerminalRuntime('docker', probe)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('returns an actionable safe error without leaking daemon details', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('private engine path or credentials'));
    await expect(assertTerminalRuntime('docker', probe)).rejects.toThrow('Docker');
    await expect(assertTerminalRuntime('docker', probe)).rejects.not.toThrow('private engine');
  });
});
