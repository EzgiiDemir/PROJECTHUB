import { describe, expect, it } from 'vitest';
import { testEnvironment } from '../src/jobs/test-env.js';

describe('test environment isolation', () => {
  it('removes every project secret, including live provider credentials and feature switches', () => {
    const env = { PATH: 'tools', DB_PASSWORD: 'private-db', OPENAI_MODERATION_API_KEY: 'private-provider', IMAGE_MODERATION_ENABLED: 'true', TEXT_MODERATION_ENABLED: 'true' };
    expect(testEnvironment(env, Object.keys(env).filter((name) => name !== 'PATH'))).toEqual({ PATH: 'tools' });
    expect(env.IMAGE_MODERATION_ENABLED).toBe('true');
  });

  it('accepts deliberate isolated test configuration after stripping live values', () => {
    expect(testEnvironment({ PATH: 'tools', DB_DATABASE: 'real', APP_KEY: 'real-key' }, ['DB_DATABASE', 'APP_KEY'].values(), { DB_DATABASE: ':memory:', APP_KEY: 'test-key' }))
      .toEqual({ PATH: 'tools', DB_DATABASE: ':memory:', APP_KEY: 'test-key' });
  });
});
