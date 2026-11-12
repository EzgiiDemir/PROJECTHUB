import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';

const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  PROJECTHUB_RUNTIME_DIR: '../projecthub-runtime-test',
  STORAGE_DIR: '../projecthub-runtime-test/storage',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_URL: 'https://hub.example.com',
  REVIEW_BASE_URL: 'https://hub.example.com/r',
  PREVIEW_BASE_DOMAIN: 'preview.example.com',
  PREVIEW_PUBLIC_URL_TEMPLATE: 'https://{slug}.preview.example.com',
};

describe('production build executor policy', () => {
  it('refuses host builds in production unless explicitly allowed for an isolated build machine', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', BUILD_EXECUTOR: 'host' }, { cwd: '.' })).toThrow(/BUILD_EXECUTOR=host is refused in production/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', BUILD_EXECUTOR: 'container', PREVIEW_EXECUTOR: 'container' }, { cwd: '.' }).BUILD_EXECUTOR).toBe('container');
    expect(loadConfig({ ...base, NODE_ENV: 'production', BUILD_EXECUTOR: 'host', ALLOW_HOST_BUILDS: 'true' }, { cwd: '.' }).BUILD_EXECUTOR).toBe('host');
    // A developer workstation may keep host builds.
    expect(loadConfig({ ...base, NODE_ENV: 'development', BUILD_EXECUTOR: 'host' }, { cwd: '.' }).BUILD_EXECUTOR).toBe('host');
  });

  it('refuses host previews in production unless explicitly allowed', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', BUILD_EXECUTOR: 'container' }, { cwd: '.' })).toThrow(/PREVIEW_EXECUTOR=host is refused in production/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', BUILD_EXECUTOR: 'container', PREVIEW_EXECUTOR: 'host', ALLOW_HOST_BUILDS: 'true' }, { cwd: '.' }).PREVIEW_EXECUTOR).toBe('host');
  });

  it('keeps runtime data under one root outside production source', () => {
    const config = loadConfig({ ...base }, { cwd: 'checkout' });
    expect(config.storageDir.startsWith(config.runtimeDir)).toBe(true);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', BUILD_EXECUTOR: 'container', PREVIEW_EXECUTOR: 'container', PROJECTHUB_RUNTIME_DIR: './runtime', STORAGE_DIR: './runtime/storage' }, { cwd: 'checkout' })).toThrow(/outside the application source/);
    expect(() => loadConfig({ ...base, STORAGE_DIR: '../unrelated/storage' }, { cwd: 'checkout' })).toThrow(/inside PROJECTHUB_RUNTIME_DIR/);
  });
});
