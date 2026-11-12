import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneArtifact } from '../src/jobs/artifact-prune.js';

describe('artifact pruning', () => {
  it('drops credential env files and Laravel runtime data, keeps templates, config, dependencies and writable folders', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-prune-'));
    const files: Record<string, string> = {
      'backend/artisan': '<?php',
      'backend/.env': 'APP_KEY=secret',
      'backend/.env.example': 'APP_KEY=',
      'backend/storage/app/.gitignore': '*\n!.gitignore\n',
      'backend/storage/app/private/applications/100/cv.pdf': 'private',
      'backend/storage/logs/laravel.log': 'log line',
      'backend/storage/framework/views/compiled.php': 'cache',
      'backend/vendor/pkg/.env': 'PACKAGE_FIXTURE=1',
      'backend/app/Models/User.php': '<?php class User {}',
      'frontend/.env.local': 'NEXT_PUBLIC_API_URL=http://127.0.0.1:8010/api',
      'frontend/.env.production': 'NEXT_PUBLIC_SITE=apply',
      'frontend/node_modules/x/index.js': 'module.exports = 1',
      '.tools/clamav/bin/clamd.exe': 'scanner',
    };
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }
    const report = await pruneArtifact(root);
    expect(report.envFiles.sort()).toEqual(['backend/.env', 'frontend/.env.local']);
    expect(report.runtimeFiles).toBe(3);
    expect(report.toolFiles).toBe(1);
    expect(report.toolBytes).toBe(7);
    // The same list prunes the preview container's copy of the tree.
    expect(report.removed.sort()).toEqual(['.tools', 'backend/.env', 'backend/storage/app/private/applications/100/cv.pdf', 'backend/storage/framework/views/compiled.php', 'backend/storage/logs/laravel.log', 'frontend/.env.local']);
    const exists = async (rel: string) => !!(await fs.stat(path.join(root, rel)).catch(() => null));
    for (const gone of ['backend/.env', 'frontend/.env.local', 'backend/storage/app/private/applications/100/cv.pdf', 'backend/storage/logs/laravel.log', 'backend/storage/framework/views/compiled.php', '.tools']) expect(await exists(gone), gone).toBe(false);
    for (const kept of ['backend/.env.example', 'frontend/.env.production', 'backend/vendor/pkg/.env', 'backend/storage/app/.gitignore', 'backend/storage/app/private/applications', 'backend/storage/logs', 'backend/app/Models/User.php', 'frontend/node_modules/x/index.js']) expect(await exists(kept), kept).toBe(true);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
});
