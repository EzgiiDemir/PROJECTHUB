import { describe, expect, it } from 'vitest';
import { scanRepository } from '../src/scan/index.js';

describe('multi-application dependency discovery', () => {
  it('finds nested frontend/backend locks, keeps provenance and excludes installed/tool code', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ dependencies: { 'root-only': '1.0.0' } }),
      'frontend/package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'frontend/package-lock.json': JSON.stringify({ packages: { '': {}, 'node_modules/react': { version: '19.0.1' }, 'node_modules/root-only': { version: '2.0.0' } } }),
      'backend/composer.json': JSON.stringify({ require: { 'laravel/framework': '^12.0' } }),
      'backend/composer.lock': JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v12.0.1' }] }),
      'apps/services/api/requirements.txt': 'Django==4.2.1\n',
      'frontend/node_modules/hidden/package.json': JSON.stringify({ dependencies: { hidden: '1.0.0' } }),
      '.tools/private/package.json': JSON.stringify({ dependencies: { hidden: '1.0.0' } }),
    };
    const result = await scanRepository({ files: Object.keys(files).map((path) => ({ path, size: files[path]!.length })), read: async (path) => files[path] ?? null }, { secretScan: false, dependencyScan: true, osvUrl: '' });
    expect(result.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'root-only', version: '1.0.0', source: 'package.json', direct: true }),
      expect.objectContaining({ name: 'root-only', version: '2.0.0', source: 'frontend/package-lock.json', direct: false }),
      expect.objectContaining({ name: 'react', version: '19.0.1', source: 'frontend/package-lock.json', direct: true, approximate: false }),
      expect.objectContaining({ name: 'laravel/framework', source: 'backend/composer.lock', direct: true }),
      expect.objectContaining({ name: 'django', source: 'apps/services/api/requirements.txt' }),
    ]));
    expect(result.dependencies.some((d) => d.name === 'hidden')).toBe(false);
    expect(result.notes).toContain('Çevrimiçi bağımlılık taraması kapalı (OSV_API_URL boş).');
  });
});
