import { describe, expect, it } from 'vitest';
import { assertImportFileCount, createImportFilter, importRuleFiles } from '../src/import-filter.js';

const keep = (paths: string[], rules: Record<string, string>) => {
  const filter = createImportFilter(paths, rules);
  return paths.filter(filter);
};

describe('project import filter', () => {
  it('rejects silent losses or unexpected additions after server extraction', () => {
    expect(() => assertImportFileCount(584, 584)).not.toThrow();
    expect(() => assertImportFileCount(584, 583)).toThrow('584 kaynak dosya gönderildi, sunucu 583');
    expect(() => assertImportFileCount(584, 585)).toThrow('Eksik aktarım ile proje oluşturulmadı');
  });
  it('imports a Laravel app like git would: hand-written public/vendor stays, Composer vendor, caches and .env go', () => {
    const paths = [
      '.gitignore',
      '.env',
      '.env.example',
      'composer.json',
      'artisan',
      'app/Models/User.php',
      'vendor/autoload.php',
      'vendor/laravel/framework/src/x.php',
      'public/index.php',
      'public/vendor/bootstrap/bootstrap.custom.min.css',
      'public/build/manifest.json',
      'public/dist/app.css',
      'storage/app/public/.gitignore',
      'storage/app/public/uploads/photo.jpg',
      'storage/framework/views/abc.php',
      'storage/framework/views/.gitignore',
      'node_modules/vite/index.js',
      'package.json',
      'resources/js/app.js',
    ];
    const rules = {
      '.gitignore': '/vendor\n/node_modules\n/public/build\n.env\n.env.*\n!.env.example\n',
      'storage/app/public/.gitignore': '*\n!.gitignore\n',
      'storage/framework/views/.gitignore': '*\n!.gitignore\n',
    };
    expect(importRuleFiles(paths)).toEqual(['.gitignore', 'storage/app/public/.gitignore', 'storage/framework/views/.gitignore']);
    expect(keep(paths, rules)).toEqual([
      '.gitignore',
      '.env.example',
      'composer.json',
      'artisan',
      'app/Models/User.php',
      'public/index.php',
      'public/vendor/bootstrap/bootstrap.custom.min.css',
      'public/dist/app.css',
      'storage/app/public/.gitignore',
      'storage/framework/views/.gitignore',
      'package.json',
      'resources/js/app.js',
    ]);
  });

  it('keeps nested repositories that the outer repository ignores, and applies their own rules', () => {
    const paths = [
      '.gitignore',
      '.git/HEAD',
      '.git/info/exclude',
      'README.md',
      '.tools/clamav/main.cvd',
      'scratch.log',
      'backend/.git/HEAD',
      'backend/.gitignore',
      'backend/composer.json',
      'backend/app/Http/Kernel.php',
      'backend/vendor/autoload.php',
      'backend/storage/app/.gitignore',
      'backend/storage/app/migration-source/files/huge.zip',
      'backend/storage/logs/laravel.log',
      'frontend/.git/HEAD',
      'frontend/.gitignore',
      'frontend/package.json',
      'frontend/src/app/page.tsx',
      'frontend/.next/cache/x',
      'frontend/out/index.html',
    ];
    const rules = {
      '.gitignore': '.env\n.tools/\nbackend/storage/logs/\n/backend/\nfrontend/.next/\n',
      '.git/info/exclude': '*.log\n',
      'backend/.gitignore': '/vendor\n/storage/*.key\n',
      'backend/storage/app/.gitignore': '*\n!.gitignore\n',
      'frontend/.gitignore': '/.next/\n/out/\n',
    };
    expect(keep(paths, rules)).toEqual([
      '.gitignore',
      'README.md',
      'backend/.gitignore',
      'backend/composer.json',
      'backend/app/Http/Kernel.php',
      'backend/storage/app/.gitignore',
      'frontend/.gitignore',
      'frontend/package.json',
      'frontend/src/app/page.tsx',
    ]);
  });

  it('supports ** globs, character classes, directory-only rules and later negation', () => {
    const paths = ['docs/a.md', 'docs/deep/b.md', 'logs/today.txt', 'logs', 'src/logs.ts', 'img/a1.png', 'img/ab.png', 'keep/important.tmp', 'x.tmp'];
    const rules = { '.gitignore': 'docs/**/*.md\nlogs/\nimg/a[0-9].png\n*.tmp\n!keep/*.tmp\n' };
    expect(keep(paths, rules)).toEqual(['logs', 'src/logs.ts', 'img/ab.png', 'keep/important.tmp']);
  });

  it('rejects secret env files and Laravel runtime data even when an archive has no ignore rules', () => {
    const paths = [
      '.env',
      '.env.local',
      '.env.production',
      '.env.example',
      'backend/.env',
      'backend/.env.sample',
      'backend/storage/app/private/applications/1/portfolio.pdf',
      'backend/storage/framework/views/cache.php',
      'backend/storage/logs/laravel.log',
      'backend/app/Models/Application.php',
      '.tools/clamav/main.cvd',
    ];
    expect(keep(paths, {})).toEqual(['.env.example', 'backend/.env.sample', 'backend/app/Models/Application.php']);
  });
});
