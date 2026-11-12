import { createHash } from 'node:crypto';

/** Preserve hostname-based local cleanup while fencing even two jobs handled by the same worker. */
export function previewAttemptOwner(workerId: string, jobId: string, attempt: number): string {
  const hostname = workerId.split(':')[0]!;
  const token = createHash('sha256').update(JSON.stringify([workerId, jobId, attempt])).digest('hex').slice(0, 32);
  return `${hostname}:${token}`;
}
