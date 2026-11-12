import { describe, expect, it } from 'vitest';
import { composerPlatformWaivers, listManagedBuildContainers, runContainerCommand, runtimeEnv, sanitizedEnv } from '../src/runner/process.js';

describe('project process environment boundary', () => {
  it('passes only host runtime plumbing and explicit project variables', () => {
    const previous = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'must-not-reach-project-code';
    try {
      const env = sanitizedEnv({ PROJECT_SETTING: 'visible' });
      expect(env.PROJECT_SETTING).toBe('visible');
      expect(env.PROJECTHUB).toBe('true');
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.APP_ENCRYPTION_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous;
    }
  });

  it('passes the PHP CLI configuration to host builds but not containers', () => {
    const previous = process.env.PHPRC;
    process.env.PHPRC = 'C:\\isolated\\php.ini';
    try {
      expect(runtimeEnv('php')).toEqual({ PHPRC: 'C:\\isolated\\php.ini' });
      expect(runtimeEnv('php', true)).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.PHPRC;
      else process.env.PHPRC = previous;
    }
  });

  it('waives only platform requirements a host build cannot meet', () => {
    expect(composerPlatformWaivers('php', false, 'win32')).toEqual(['ext-pcntl', 'ext-posix', 'php+']);
    expect(composerPlatformWaivers('php', false, 'linux')).toEqual(['php+']);
    expect(composerPlatformWaivers('php', true, 'win32')).toEqual([]);
    expect(composerPlatformWaivers('node', false, 'win32')).toEqual([]);
  });
});

const dockerIt = process.env.PROJECTHUB_REAL_DOCKER === '1' ? it : it.skip;

describe('real constrained container runner', () => {
  dockerIt('runs non-root without a Docker socket, host secrets, or network access', async () => {
    const output: string[] = [];
    const buildId = `runner-test-${Date.now()}`;
    const result = await runContainerCommand({
      command:
        'test "$(id -u)" != "0" && test ! -S /var/run/docker.sock && test -z "$DATABASE_URL" && test "$PROJECT_SETTING" = "visible" && printf container-ok',
      cwd: process.cwd(),
      env: sanitizedEnv({ PROJECT_SETTING: 'visible' }),
      timeoutMs: 30_000,
      limits: {
        image: process.env.PROJECTHUB_TEST_CONTAINER_IMAGE ?? 'alpine:3.21',
        cpus: 0.5,
        memoryMb: 256,
        pids: 64,
        network: 'none',
      },
      labels: {
        'com.projecthub.managed': 'build',
        'com.projecthub.worker': 'vitest',
        'com.projecthub.build': buildId,
      },
      onOutput: (text) => output.push(text),
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(output.join('')).toContain('container-ok');
    expect((await listManagedBuildContainers()).some((item) => item.buildId === buildId)).toBe(false);
  }, 60_000);
});
