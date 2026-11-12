import { describe, expect, it } from 'vitest';
import { decryptFromString, encryptToString, hashPassword, randomToken, verifyPassword } from '../src/crypto.js';
import { detectProject, manifestFromDetection, parseManifest, serializeManifest, slugify } from '../src/manifest.js';
import { scan } from '../src/index.js';

const src = (files: Record<string, string>) => ({
  paths: Object.keys(files),
  read: async (p: string) => files[p] ?? null,
});

describe('project detection', () => {
  it('reports a Flutter target without inventing an available runtime or a compiled web preview', async () => {
    const detected = await detectProject(src({
      'pubspec.yaml': 'name: campus\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'index.html': '<html>uncompiled client template</html>',
      'test/widget_test.dart': 'void main() {}',
    }), 'campus');
    expect(detected.technologies).toContain('Flutter');
    expect(detected).toMatchObject({ runtime: { type: 'other' }, projectType: 'Flutter uygulaması', previewMode: 'none' });
    expect(detected.buildCommand).toBeUndefined();
    expect(detected.checks.join('\n')).toContain('1 test dosyası');
    expect(detected.warnings.join('\n')).toContain('izole bir çalıştırıcı');
    expect(manifestFromDetection(detected, 'campus').preview.enabled).toBe(false);
  });

  it('preserves the backend profile and separately flags a deep monorepo Flutter client', async () => {
    const detected = await detectProject(src({
      'backend/composer.json': '{"require":{"laravel/framework":"^13.0"}}',
      'apps/mobile/pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n',
    }), 'campus');
    expect(detected.runtime.type).toBe('php');
    expect(detected.startCommand).toContain('cd backend &&');
    expect(detected.technologies).toEqual(expect.arrayContaining(['Laravel', 'Flutter']));
    expect(detected.warnings.join('\n')).toContain('backend build');
  });

  it('does not confuse plain Dart or cached dependency pubspec files with a Flutter application', async () => {
    const detected = await detectProject(src({
      'pubspec.yaml': 'name: utilities\ndependencies:\n  collection: any\n',
      '.dart_tool/vendor/pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n',
      'node_modules/example/pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n',
    }), 'utilities');
    expect(detected.technologies).not.toContain('Flutter');
  });

  it('keeps Laravel primary when root tooling and Python sidecars are also present', async () => {
    const detected = await detectProject(src({
      'package.json': '{"dependencies":{"openai":"^7.0.0"}}',
      'backend/composer.json': '{"require":{"laravel/framework":"^13.0"},"require-dev":{"phpunit/phpunit":"^12.0"}}',
      'backend/package.json': '{"scripts":{"build":"vite build"},"devDependencies":{"vite":"^8.0.0"}}',
      'backend/package-lock.json': '{}',
      'backend/tests/Feature/LoginTest.php': '<?php',
      'moderation-service/requirements.txt': 'fastapi\npytest',
      'moderation-service/app/main.py': 'app = FastAPI()',
    }), 'campus');
    expect(detected).toMatchObject({ runtime: { type: 'php' }, installCommand: 'cd backend && composer install && npm ci', buildCommand: 'cd backend && npm run build', testCommand: 'cd backend && php artisan test', startCommand: 'cd backend && php artisan serve --host=127.0.0.1 --port=$PORT' });
    expect(detected.warnings.join('\n')).toContain('services');
  });

  it('uses a nested Python app directory and its actual entry without guessing missing entries', async () => {
    const detected = await detectProject(src({ 'api/requirements.txt': 'fastapi\npytest\nalembic', 'api/app/main.py': 'app = FastAPI()' }), 'api');
    expect(detected).toMatchObject({ runtime: { type: 'python' }, installCommand: 'cd api && python -m pip install --target ../.pydeps -r requirements.txt', startCommand: 'cd api && python -m uvicorn app.main:app --host 127.0.0.1 --port $PORT', testCommand: 'cd api && python -m pytest -q', migrateCommand: 'cd api && python -m alembic upgrade head', migrationDirectory: 'api/alembic/versions' });
    const missing = await detectProject(src({ 'requirements.txt': 'fastapi' }), 'missing');
    expect(missing.startCommand).toBeUndefined();
    expect(missing.previewMode).toBe('none');
  });

  it('detects a Next.js + Prisma + PostgreSQL project', async () => {
    const det = await detectProject(
      src({
        'package.json': JSON.stringify({
          name: 'bayi-portali',
          version: '1.3.0',
          scripts: { dev: 'next dev', build: 'next build', start: 'next start', test: 'vitest run' },
          dependencies: { next: '16.0.0', react: '19.0.0', '@prisma/client': '6.0.0', ioredis: '5.4.0' },
          devDependencies: { typescript: '5.0.0', prisma: '6.0.0' },
        }),
        'package-lock.json': '{}',
        'prisma/schema.prisma': 'datasource db { provider = "postgresql" }',
        '.env.example': 'DATABASE_URL=\nREDIS_URL=\nAPP_URL=\n',
        'src/app/page.test.tsx': '',
      }),
      'fallback',
    );
    expect(det).toMatchObject({
      name: 'bayi-portali',
      version: '1.3.0',
      database: 'postgresql',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
      testCommand: 'npm test',
      previewMode: 'process',
      migrationDirectory: 'prisma/migrations',
      envVars: ['DATABASE_URL', 'REDIS_URL', 'APP_URL'],
    });
    expect(det.technologies).toEqual(expect.arrayContaining(['Next.js', 'React', 'TypeScript', 'Prisma', 'Redis']));
    const manifest = manifestFromDetection(det, 'bayi-portali');
    const roundTrip = parseManifest(serializeManifest(manifest));
    expect(roundTrip.start?.port).toBe(3000);
    expect(roundTrip.database.migrate?.directory).toBe('prisma/migrations');
  });

  it('detects a Vite SPA as a static preview', async () => {
    const det = await detectProject(
      src({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19' }, devDependencies: { vite: '7' } }), 'pnpm-lock.yaml': '' }),
      'x',
    );
    expect(det).toMatchObject({ previewMode: 'static', buildOutput: 'dist', installCommand: 'pnpm install --frozen-lockfile', buildCommand: 'pnpm run build' });
  });

  it('detects a plain static site and Laravel', async () => {
    expect(await detectProject(src({ 'index.html': '<h1>x</h1>', 'style.css': '' }), 'site')).toMatchObject({ previewMode: 'static', buildOutput: '.', projectType: 'Statik site' });
    const laravel = await detectProject(src({ 'composer.json': '{"require":{"php":"^8.2","laravel/framework":"^11.0"}}', '.env.example': 'DB_CONNECTION=mysql\n' }), 'l');
    expect(laravel).toMatchObject({ database: 'mysql', migrationDirectory: 'database/migrations', migrateCommand: 'php artisan migrate --force' });
  });

  it('installs both Composer and Node dependencies for a Laravel Vite application', async () => {
    const hybrid = await detectProject(
      src({
        'composer.json': '{"require":{"php":"^8.3","laravel/framework":"^13.0"}}',
        'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^7.0.0' } }),
        'package-lock.json': '{}',
      }),
      'hybrid',
    );
    expect(hybrid).toMatchObject({ installCommand: 'composer install --no-dev --optimize-autoloader && npm ci', buildCommand: 'npm run build' });
  });

  it('runs commands inside the folder that holds the app (backend/ + frontend/ layout)', async () => {
    const split = await detectProject(
      src({
        'backend/composer.json': '{"require":{"php":"^8.2","laravel/framework":"^12.0"}}',
        'backend/package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^7.0.0' } }),
        'backend/package-lock.json': '{}',
        'frontend/package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '16.0.0', react: '19.0.0' } }),
      }),
      'split',
    );
    expect(split).toMatchObject({
      installCommand: 'cd backend && composer install --no-dev --optimize-autoloader && npm ci',
      buildCommand: 'cd backend && npm run build',
      startCommand: 'cd backend && php artisan serve --host=127.0.0.1 --port=$PORT',
      migrateCommand: 'cd backend && php artisan migrate --force',
      migrationDirectory: 'backend/database/migrations',
    });
    expect(split.warnings.filter((w) => w.startsWith('frontend/ klasöründeki ayrı uygulama'))).toHaveLength(1);
    // With a test suite, development dependencies are installed, tests run on an in-memory database and the
    // artifact drops the dev packages afterwards.
    const tested = await detectProject(
      src({
        'backend/composer.json': '{"require":{"php":"^8.2","laravel/framework":"^12.0"},"require-dev":{"phpunit/phpunit":"^11.5"}}',
        'backend/artisan': '<?php',
        'backend/tests/Feature/LoginTest.php': '<?php',
      }),
      'tested',
    );
    expect(tested).toMatchObject({
      installCommand: 'cd backend && composer install',
      testCommand: 'cd backend && php artisan test',
      testEnv: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' },
      artifactPrepare: 'cd backend && composer install --no-dev --optimize-autoloader',
    });
    expect(manifestFromDetection(tested, 'tested')).toMatchObject({ test: { command: 'cd backend && php artisan test', env: { DB_CONNECTION: 'sqlite' } }, artifact: { prepare: 'cd backend && composer install --no-dev --optimize-autoloader' } });
    const front = await detectProject(src({ 'web/package.json': JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19' }, devDependencies: { vite: '7' } }), 'web/package-lock.json': '{}' }), 'w');
    expect(front).toMatchObject({ installCommand: 'cd web && npm ci', buildCommand: 'cd web && npm run build', buildOutput: 'web/dist', previewMode: 'static' });
  });

  it('recognises a dependency-free Node app and takes the database from its manifest', async () => {
    const det = await detectProject(
      src({
        'package.json': JSON.stringify({ name: 'shop', scripts: { build: 'node build.mjs', start: 'node server.mjs' }, engines: { node: '>=22' } }),
        'package-lock.json': '{}',
        '.env.example': 'DATABASE_URL=\n',
        'db/migrations/0001_init.sql': 'CREATE TABLE x (id int);',
        'projecthub.yml': 'project:\n  name: Shop\n  slug: shop\nruntime:\n  type: node\ndatabase:\n  type: postgresql\n',
      }),
      'shop',
    );
    expect(det.technologies).toContain('Node.js');
    expect(det.warnings).not.toContain('Teknoloji otomatik tanınamadı. Manifesti elle düzenleyebilirsiniz.');
    expect(det).toMatchObject({ database: 'postgresql', migrationDirectory: 'db/migrations', hasManifest: true, name: 'Shop' });
  });

  it('slugifies Turkish names', () => {
    expect(slugify('Ödeme Portalı 2024')).toBe('odeme-portali-2024');
    expect(slugify('Saha Servis Uygulaması')).toBe('saha-servis-uygulamasi');
  });
});

describe('scanners', () => {
  it('reports the project’s own files but not installed third-party code (vendor, node_modules)', async () => {
    const files: Record<string, string> = {
      Dockerfile: 'FROM node:22\nCMD ["node", "server.js"]\n',
      'backend/vendor/laravel/sail/runtimes/8.4/Dockerfile': 'FROM ubuntu:24.04\nCMD ["start"]\n',
      'frontend/node_modules/pkg/.env': 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1\n',
      // A tool folder and a minified published asset: generated, not fixable where reported.
      '.tools/clamav/UserManual/book.js': 'document.body.innerHTML = location.hash;\n',
      'backend/public/js/filament/rich-editor.js': `var a=1;${'x=document.write(location.hash);'.repeat(200)}\n`,
    };
    const r = await scan.scanRepository(
      { files: Object.keys(files).map((p) => ({ path: p, size: files[p]!.length })), read: async (p) => files[p] ?? null },
      { secretScan: true, dependencyScan: false, osvUrl: 'http://127.0.0.1:9' },
    );
    const paths = new Set(r.findings.map((f) => f.filePath));
    expect(paths.has('Dockerfile')).toBe(true);
    expect([...paths].some((p) => p?.includes('vendor/') || p?.includes('node_modules/') || p?.startsWith('.tools/') || p?.includes('public/js/filament'))).toBe(false);
  });

  it('keeps generated caches, lockfiles and minified assets out of the AI code index', () => {
    for (const p of ['app/Models/User.php', 'resources/views/home.blade.php', 'src/index.ts', 'composer.json']) expect(scan.isIndexable(p, 1000)).toBe(true);
    for (const p of ['storage/framework/views/abc.php', 'bootstrap/cache/packages.php', 'public/vendor/livewire/x.js', 'public/css/app.min.css', 'package-lock.json', 'composer.lock']) {
      expect(scan.isIndexable(p, 1000)).toBe(false);
    }
  });

  it('maps architecture relationships, cycles, entry points and test frameworks locally', () => {
    const report = scan.analyseArchitecture(
      new Map([
        ['package.json', JSON.stringify({ devDependencies: { vitest: '^5.0.0' } })],
        ['src/main.ts', "import { a } from './a';\nexport const main = () => a();"],
        ['src/a.ts', "import { b } from './b';\nexport const a = () => b();"],
        ['src/b.ts', "import { a } from './a';\nexport const b = () => a();"],
        ['src/a.test.ts', "import { a } from './a';\nit('works', () => a());"],
        ['db/migrations/001.sql', 'create table example(id int);'],
      ]),
    );
    expect(report.entryPoints).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/main.ts' })]));
    expect(report.testFrameworks).toContain('Vitest');
    expect(report.migrationFiles).toEqual(['db/migrations/001.sql']);
    expect(report.relationships).toEqual(expect.arrayContaining([{ from: 'src/a.ts', to: 'src/b.ts' }, { from: 'src/b.ts', to: 'src/a.ts' }]));
    expect(report.circularDependencies.some((cycle) => cycle.includes('src/a.ts') && cycle.includes('src/b.ts'))).toBe(true);
  });

  it('finds secrets but ignores examples and env lookups', () => {
    const f = scan.scanSecrets('src/lib/config.ts', [
      'export const a = "AKIA' + 'ABCDEFGHIJKLMNOP";',
      'const stripe = "sk_live_' + '51NxQ2abcdEFGHijklMNOP";',
      'const password = process.env.DB_PASSWORD;',
      'const apiKey = "your-api-key-here";',
      'const url = "postgres://app:S3cr3tPassw0rd@db:5432/app";',
    ].join('\n'));
    expect(f.map((x) => x.ruleId)).toEqual(['secret/aws-access-key', 'secret/stripe-live-key', 'secret/database-url-password']);
    expect(f.every((x) => !x.description.includes('51NxQ2abcdEFGHijklMNOP'))).toBe(true);
    expect(scan.scanSecrets('.env.example', 'STRIPE=sk_live_' + '51NxQ2abcdEFGHijklMNOP')).toEqual([]);
  });

  it('does not flag password labels, translations or configuration status messages as credentials', () => {
    const php = [
      "$this->line('Password: '.(config('mail.mailers.smtp.password') ? 'configured' : 'missing'));",
      "<label>{{ $en ? 'Password' : 'Şifreniz' }}</label>",
      "<input type=\"password\" name=\"password\" placeholder=\"Şifreniz\" required>",
    ].join('\n');
    expect(scan.scanSecrets('resources/views/account.blade.php', php)).toEqual([]);
    expect(scan.scanSecrets('config/real.php', "const password = 'S3cret-Value-2026';").map((x) => x.ruleId)).toEqual(['secret/hardcoded-credential']);
    expect(scan.scanSecrets('frontend/src/lib/i18n.ts', '  password: "Password",')).toEqual([]);
    expect(scan.scanSecrets('frontend/src/lib/i18n.ts', '  password: "S3cret-Value-2026",').map((x) => x.ruleId)).toEqual(['secret/hardcoded-credential']);
    expect(scan.scanSecrets('config.ts', '  password: "Password",').map((x) => x.ruleId)).toEqual(['secret/hardcoded-credential']);
  });

  it('flags SQL injection and command injection', () => {
    const f = scan.scanCode('src/db.ts', 'await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\nexec(`convert ${input}`);');
    expect(f.map((x) => x.ruleId)).toEqual(['code/js-sql-injection', 'code/js-command-injection']);
  });

  it('classifies migration risk', () => {
    expect(scan.analyseMigration('m/1.sql', 'ALTER TABLE customers ADD COLUMN status text;').risk).toBe('low');
    expect(scan.analyseMigration('m/2.sql', 'CREATE INDEX customers_status_idx ON customers(status);').risk).toBe('medium');
    expect(scan.analyseMigration('m/3.sql', 'ALTER TABLE users DROP COLUMN phone;').risk).toBe('high');
    expect(scan.analyseMigration('m/4.sql', 'ALTER TABLE t ADD COLUMN x int NOT NULL;').risk).toBe('high');
  });

  it('parses lockfiles', () => {
    const deps = scan.parseDependencies(
      new Map([
        ['package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0' } })],
        ['package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/@scope/x/node_modules/y': { version: '1.0.0' } } })],
        ['requirements.txt', 'Django==4.2.1\nrequests>=2\n'],
      ]),
    );
    expect(deps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'lodash', version: '4.17.20', direct: true, approximate: false }),
        expect.objectContaining({ name: 'y', version: '1.0.0' }),
        expect.objectContaining({ name: 'django', version: '4.2.1', ecosystem: 'PyPI' }),
      ]),
    );
  });

  it('computes CVSS v3 base scores', () => {
    expect(scan.cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(scan.cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
  });

  it('scores security: any critical caps the score below 50', () => {
    expect(scan.securityScore([]).score).toBe(100);
    expect(scan.securityScore([{ severity: 'critical', type: 'secret' }]).score).toBeLessThan(50);
  });

  it('counts a vulnerable package once, at its worst severity, however many advisories it has', () => {
    const axios = Array.from({ length: 33 }, (_, i) => ({ severity: (i < 15 ? 'high' : 'medium') as 'high' | 'medium', type: 'dependency' as const, packageName: 'axios', filePath: 'backend/package.json' }));
    const one = scan.securityScore([{ severity: 'high', type: 'dependency', packageName: 'axios', filePath: 'backend/package.json' }]).score;
    expect(scan.securityScore(axios).score).toBe(one);
    // The same package in two apps is two problems; code findings still count one by one.
    expect(scan.securityScore([...axios, { severity: 'high', type: 'dependency', packageName: 'axios', filePath: 'frontend/package-lock.json' }]).score).toBeLessThan(one);
    expect(scan.securityScore([{ severity: 'medium', type: 'code' }, { severity: 'medium', type: 'code' }]).score).toBeLessThan(scan.securityScore([{ severity: 'medium', type: 'code' }]).score);
  });

  it('resolves npm ranges the way a fresh install does', () => {
    const versions = ['1.7.4', '1.7.9', '1.12.0', '1.16.1', '2.0.0', '2.1.0-beta.1', '0.2.3', '0.2.9', '0.3.0'];
    expect(scan.maxSatisfying(versions, '^1.7.4')).toBe('1.16.1');
    expect(scan.maxSatisfying(versions, '~1.7.4')).toBe('1.7.9');
    expect(scan.maxSatisfying(versions, '1.7.4')).toBe('1.7.4');
    expect(scan.maxSatisfying(versions, '^0.2.3')).toBe('0.2.9');
    expect(scan.maxSatisfying(versions, '>=1.8 <2')).toBe('1.16.1');
    expect(scan.maxSatisfying(versions, '1.x || 0.3')).toBe('1.16.1');
    expect(scan.maxSatisfying(versions, '*')).toBe('2.0.0');
    expect(scan.maxSatisfying(versions, '^3.0.0')).toBeNull();
    expect(scan.maxSatisfying(versions, 'github:axios/axios')).toBeNull();
  });

  it('scans a manifest without lockfile at the version a fresh install gets, not the range lower bound', async () => {
    const deps = scan.parseDependencies(new Map([['package.json', JSON.stringify({ devDependencies: { axios: '^1.7.4' } })]]));
    const queried: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://registry.test/axios')) return new Response(JSON.stringify({ versions: { '1.7.4': {}, '1.16.1': {}, '2.0.0': {} } }));
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init!.body)) as { queries: { version: string }[] };
        queried.push(...body.queries.map((q) => q.version));
        return new Response(JSON.stringify({ results: body.queries.map(() => ({})) }));
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const out = await scan.scanDependencies(deps, { osvUrl: 'https://osv.test', fetchImpl, registries: { npm: 'https://registry.test' } });
    expect(queried).toEqual(['1.16.1']);
    expect(out.findings).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/temiz bir kurulumda gelecek sürüme/);
  });
});

describe('crypto', () => {
  it('encrypts, hashes and generates tokens', async () => {
    const key = Buffer.alloc(32, 7);
    expect(decryptFromString(key, encryptToString(key, 'gizli değer'))).toBe('gizli değer');
    expect(() => decryptFromString(Buffer.alloc(32, 8), encryptToString(key, 'x'))).toThrow();
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9]{32}$/);
    const h = await hashPassword('correct horse 123');
    expect(await verifyPassword(h, 'correct horse 123')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
});
