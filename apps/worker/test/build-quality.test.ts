import { describe, expect, it } from 'vitest';
import { blockingCriticals, criticalSecurityGate, hasSourceTests, inferTestCommand } from '../src/jobs/build-quality.js';

describe('build quality gates', () => {
  it('requires an explicit verified runner for Dart tests instead of silently treating them as no tests', async () => {
    const files = ['frontend/pubspec.yaml', 'frontend/test/widget_test.dart'];
    expect(hasSourceTests(files)).toBe(true);
    expect(hasSourceTests(['frontend\\test\\widget_test.dart'])).toBe(true);
    await expect(inferTestCommand(files, async () => null)).resolves.toBeNull();
  });

  it('never counts installed dependency or build-output tests as project source coverage', async () => {
    const files = ['frontend/node_modules/a/test/a.test.js', 'backend/vendor/a/tests/Unit/A.php', '.venv/a/tests/test_a.py', 'frontend/.dart_tool/a/test/widget_test.dart', 'frontend/build/test/widget_test.dart'];
    expect(hasSourceTests(files)).toBe(false);
    await expect(inferTestCommand(files, async () => null)).resolves.toBeNull();
  });

  it('recognizes test suites without mistaking ordinary source files for tests', () => {
    expect(hasSourceTests(['src/app.ts', 'frontend/src/a.spec.tsx'])).toBe(true);
    expect(hasSourceTests(['backend/app/User.php', 'backend/tests/Feature/LoginTest.php'])).toBe(true);
    expect(hasSourceTests(['cmd/main.go', 'pkg/auth_test.go'])).toBe(true);
    expect(hasSourceTests(['src/latest.ts', 'docs/testing.md'])).toBe(false);
  });

  it('blocks artifact creation when the scan contains a critical finding', () => {
    expect(criticalSecurityGate(0)).toBeNull();
    expect(criticalSecurityGate(2)).toContain('2 açık kritik bulgu');
    expect(criticalSecurityGate(1, false)).toContain('1 yeni kritik');
  });

  it('never blocks on triaged findings, and on branches only on criticals the branch adds', () => {
    const known = new Map([['fp-env', 'false_positive'], ['fp-old', 'open'], ['fp-ok', 'accepted'], ['fp-fixed', 'resolved']]);
    const scan = ['fp-env', 'fp-old', 'fp-ok', 'fp-fixed', 'fp-new'];
    expect(blockingCriticals(scan, known, true)).toEqual(['fp-old', 'fp-fixed', 'fp-new']);
    expect(blockingCriticals(scan, known, false)).toEqual(['fp-fixed', 'fp-new']);
  });

  it('infers tests only for the project apps the install step sets up', async () => {
    const files = ['frontend/node_modules/left-pad/package.json', 'frontend/package.json', 'frontend/src/a.test.ts', 'backend/composer.json', 'backend/artisan', 'backend/tests/Feature/A.php'];
    const read = async (path: string) =>
      path === 'frontend/package.json' ? JSON.stringify({ scripts: { test: 'vitest run' } }) : path.includes('node_modules') ? JSON.stringify({ scripts: { test: 'tap test/*.js' } }) : path === 'backend/composer.json' ? JSON.stringify({ require: { 'laravel/framework': '^12' } }) : null;
    // Only the backend is installed, without dev packages: neither suite can run, so nothing is guessed.
    await expect(inferTestCommand(files, read, 'cd backend && composer install --no-dev --optimize-autoloader && npm install')).resolves.toBeNull();
    await expect(inferTestCommand(files, read, 'cd backend && composer install && npm install')).resolves.toBe('cd backend && php artisan test');
    await expect(inferTestCommand(files, read, 'cd backend && composer install && cd ../frontend && npm ci')).resolves.toBe('cd frontend && npm test');
  });

  it('infers conventional test commands without executing project code', async () => {
    const read = async (path: string) => path === 'frontend/package.json' ? JSON.stringify({ scripts: { test: 'vitest run' } }) : null;
    await expect(inferTestCommand(['frontend/package.json', 'frontend/src/a.test.ts'], read)).resolves.toBe('cd frontend && npm test');
    const laravel = async (path: string) => path === 'backend/composer.json' ? JSON.stringify({ require: { 'laravel/framework': '^12' } }) : null;
    await expect(inferTestCommand(['backend/composer.json', 'backend/artisan', 'backend/tests/Feature/LoginTest.php'], laravel)).resolves.toBe('cd backend && php artisan test');
    await expect(inferTestCommand(['src/app.ts', 'tests/readme.txt'], async () => null)).resolves.toBeNull();
  });
});

