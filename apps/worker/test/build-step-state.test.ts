import { describe, expect, it } from 'vitest';
import { completedCommandStep } from '../src/jobs/build-step-state.js';

describe('build command completion evidence', () => {
  it('does not publish passed artifact evidence after only its preparation command', () => {
    const result = completedCommandStep('artifact', 3800);
    expect(result.status).toBe('running');
    expect(result.summary).toContain('aktarımı ve doğrulaması sürüyor');
    expect(result.summary).toContain('3.8 sn');
  });
  it.each(['install', 'build', 'test'])('completes the actual %s command step', (key) => {
    expect(completedCommandStep(key, 1250)).toEqual({ status: 'passed', summary: '1.3 sn' });
  });
});
