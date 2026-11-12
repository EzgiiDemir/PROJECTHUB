import { describe, expect, it } from 'vitest';
import { buildDecisionText, buildRelevantPaths } from '../src/jobs/build-need.js';

describe('which changes need a build', () => {
  it('ordinary code, styles, tests and docs never start a build', () => {
    expect(buildRelevantPaths(['frontend/src/app/page.tsx', 'backend/app/Http/Controllers/FormController.php', 'src/styles.css', 'tests/Feature/LoginTest.php', 'README.md', 'docs/setup.md', 'public/logo.svg'])).toEqual([]);
    expect(buildDecisionText([])).toMatch(/build gerekmedi/);
  });

  it('dependencies, build configuration, containers, the manifest, migrations and CI do', () => {
    const relevant = ['frontend/package-lock.json', 'backend/composer.json', 'next.config.ts', 'frontend/tsconfig.json', 'Dockerfile', 'docker-compose.yml', 'projecthub.yml', 'backend/database/migrations/2026_10_16_000000_add_unit.php', 'prisma/schema.prisma', '.github/workflows/ci.yml', 'requirements-dev.txt', '.env.example'];
    expect(buildRelevantPaths(['src/a.ts', ...relevant])).toEqual(relevant);
    expect(buildDecisionText(relevant)).toMatch(/^Build gerekli: frontend\/package-lock\.json, backend\/composer\.json, next\.config\.ts, frontend\/tsconfig\.json ve 8 dosya daha/);
  });

  it('ignores committed dependency folders and accepts Windows separators', () => {
    expect(buildRelevantPaths(['frontend/node_modules/left-pad/package.json', 'backend/vendor/laravel/framework/composer.json'])).toEqual([]);
    expect(buildRelevantPaths(['frontend\\package.json'])).toEqual(['frontend/package.json']);
  });
});
