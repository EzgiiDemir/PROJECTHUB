/** An artifact.prepare command only prepares files. Copy, pruning, digest and provenance still must succeed. */
export function completedCommandStep(key: string, durationMs: number): { status: 'running' | 'passed'; summary: string } {
  const duration = `${(durationMs / 1000).toFixed(1)} sn`;
  return key === 'artifact'
    ? { status: 'running', summary: `Hazırlık tamamlandı (${duration}); artifact aktarımı ve doğrulaması sürüyor` }
    : { status: 'passed', summary: duration };
}
