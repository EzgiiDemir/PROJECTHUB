import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { JobRunner, QUEUES } from '../src/queue.js';

describe('queue scheduling serialization', () => {
  it('does not exceed a single slot when notifications overlap an awaited claim', async () => {
    const runner = new JobRunner({ logger: createLogger('test', 'silent') } as ConstructorParameters<typeof JobRunner>[0], {}, [{ name: QUEUES.ai, concurrency: 1 }]);
    const internals = runner as unknown as { fill(): Promise<void>; claim(queue: string): Promise<unknown>; launch(queue: string, job: unknown): void; running: Map<string, number> };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const claim = vi.spyOn(internals, 'claim').mockImplementation(async () => {
      await gate;
      return { id: 'only-job' };
    });
    const launch = vi.spyOn(internals, 'launch').mockImplementation((queue) => { internals.running.set(queue, 1); });
    const first = internals.fill();
    const second = internals.fill();
    const concurrentClaims = claim.mock.calls.length;
    release();
    await Promise.all([first, second]);
    expect(concurrentClaims).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('releases the scheduling gate after an unexpected failure', async () => {
    const runner = new JobRunner({ logger: createLogger('test', 'silent') } as ConstructorParameters<typeof JobRunner>[0], {}, []);
    const internals = runner as unknown as { fill(): Promise<void>; fillQueues(): Promise<void> };
    const fill = vi.spyOn(internals, 'fillQueues').mockRejectedValueOnce(new Error('test failure')).mockResolvedValue(undefined);
    await expect(internals.fill()).rejects.toThrow('test failure');
    await internals.fill();
    expect(fill).toHaveBeenCalledTimes(2);
  });
});
