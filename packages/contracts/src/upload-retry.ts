/** Retry only transient transport failures; never retry validation, authentication or permission errors. */
export async function retryUploadRequest<T>(
  request: () => Promise<T>,
  onRetry: (attempt: number) => void = () => {},
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); }
    catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const transient = status === undefined || [0, 408, 429, 500, 502, 503, 504].includes(status);
      if (!transient || attempt >= 15 || (error as { name?: string } | null)?.name === 'AbortError') throw error;
      onRetry(attempt + 1);
      await wait(Math.min(5_000, (attempt + 1) * 1_000));
    }
  }
}
