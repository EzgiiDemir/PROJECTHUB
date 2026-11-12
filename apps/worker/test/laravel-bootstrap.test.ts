import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { laravelBootstrapEnv, prepareLaravelWorkspace } from '../src/jobs/laravel-bootstrap.js';

describe('Laravel build bootstrap isolation', () => {
  it('creates empty writable folders on repeated checkouts without removing user content', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-bootstrap-'));
    try {
      await prepareLaravelWorkspace(tmp, ['backend/artisan']);
      expect(await fs.readFile(path.join(tmp, 'backend/.env'), 'utf8')).toBe('');
      await fs.writeFile(path.join(tmp, 'backend/.env'), 'EXPLICIT_BUILD_SETTING=preserve');
      const marker = path.join(tmp, 'backend/storage/app/private/preserve.txt');
      await fs.writeFile(marker, 'preserve');
      await prepareLaravelWorkspace(tmp, ['backend/artisan']);
      expect(await fs.readFile(marker, 'utf8')).toBe('preserve');
      expect(await fs.readFile(path.join(tmp, 'backend/.env'), 'utf8')).toBe('EXPLICIT_BUILD_SETTING=preserve');
      expect((await fs.stat(path.join(tmp, 'backend/bootstrap/cache'))).isDirectory()).toBe(true);
      await expect(prepareLaravelWorkspace(tmp, ['../artisan'])).rejects.toThrow('escapes workspace');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  it('boots root and nested Laravel sources without a persistent database', () => {
    for (const files of [['artisan'], ['backend/artisan', 'frontend/package.json']]) {
      const env = { PATH: 'tools', APP_NAME: 'Form' };
      expect(laravelBootstrapEnv(env, files)).toMatchObject({ ...env, DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', CACHE_STORE: 'array', SESSION_DRIVER: 'array', QUEUE_CONNECTION: 'sync' });
      expect(env).not.toHaveProperty('DB_CONNECTION');
    }
  });
  it('never replaces explicit build database settings or changes non-Laravel apps', () => {
    for (const env of [{ DB_CONNECTION: 'pgsql' }, { DB_DATABASE: 'explicit' }, { DB_HOST: 'db' }, { DATABASE_URL: 'test-only-dsn' }, { DB_URL: 'test-only-dsn' }]) {
      expect(laravelBootstrapEnv(env, ['backend/artisan'])).toBe(env);
    }
    const plain = { APP_NAME: 'Node' };
    expect(laravelBootstrapEnv(plain, ['package.json', 'vendor/example/artisan'])).toBe(plain);
  });
});
