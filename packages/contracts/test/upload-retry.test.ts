import { describe, expect, it, vi } from 'vitest';
import { retryUploadRequest } from '../src/upload-retry.js';

describe('upload restart recovery', () => {
  it('retains the same prepared payload across API restarts', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const send = vi.fn().mockRejectedValueOnce({ status: 500 }).mockRejectedValueOnce({ status: 0 }).mockResolvedValue({ uploadId: 'recovered' });
    const wait = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn();
    await expect(retryUploadRequest(() => send(payload), retry, wait)).resolves.toEqual({ uploadId: 'recovered' });
    expect(send.mock.calls.every(([data]) => data === payload)).toBe(true);
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
    expect(retry.mock.calls).toEqual([[1], [2]]);
  });
  it.each([400, 401, 403, 404, 409, 413, 422, 507])('never loops on permanent HTTP %s', async (status) => {
    const send = vi.fn().mockRejectedValue({ status });
    const wait = vi.fn();
    await expect(retryUploadRequest(send, undefined, wait)).rejects.toEqual({ status });
    expect(send).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
  it('stops after a bounded 65-second retry delay budget', async () => {
    const send = vi.fn().mockRejectedValue({ status: 503 });
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(retryUploadRequest(send, undefined, wait)).rejects.toEqual({ status: 503 });
    expect(send).toHaveBeenCalledTimes(16);
    expect(wait.mock.calls.reduce((n, [ms]) => n + ms, 0)).toBe(65_000);
  });
  it('preserves explicit cancellation', async () => {
    const send = vi.fn().mockRejectedValue({ name: 'AbortError' });
    await expect(retryUploadRequest(send)).rejects.toEqual({ name: 'AbortError' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
