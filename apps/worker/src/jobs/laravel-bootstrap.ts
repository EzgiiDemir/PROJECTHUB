import fs from 'node:fs/promises';
import path from 'node:path';

/** Build-only Laravel boot: package discovery may probe Schema::hasTable before any database exists.
 * Never borrow runtime credentials or create a persistent database just to install dependencies.
 * Explicit build database configuration remains authoritative; preview/deploy environments are untouched.
 */
export function laravelBootstrapEnv(env: NodeJS.ProcessEnv, sourceFiles: string[]): NodeJS.ProcessEnv {
  const laravel = sourceFiles.some((p) => /^(?:[^/]+\/)?artisan$/.test(p));
  if (!laravel || ['DB_CONNECTION', 'DB_DATABASE', 'DB_HOST', 'DB_URL', 'DATABASE_URL'].some((name) => !!env[name])) return env;
  return { CACHE_STORE: 'array', SESSION_DRIVER: 'array', QUEUE_CONNECTION: 'sync', ...env, DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' };
}
/** Safe imports omit runtime data, but Laravel still needs empty writable folders on every fresh checkout/cache hit. */
export async function prepareLaravelWorkspace(workspace: string, sourceFiles: string[]): Promise<void> {
  const root = path.resolve(workspace);
  for (const file of sourceFiles.filter((p) => /^(?:[^/]+\/)?artisan$/.test(p))) {
    const app = path.resolve(root, path.dirname(file));
    if (app !== root && !app.startsWith(root + path.sep)) throw new Error('Laravel bootstrap path escapes workspace');
    // Dotenv's suppressed missing-file read is still reported as a warning by Laravel's test runner.
    // An empty build-only marker avoids that noise without importing credentials; artifact pruning removes it.
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, '.env'), '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    for (const dir of ['bootstrap/cache', 'storage/app/public', 'storage/app/private', 'storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/logs']) {
      await fs.mkdir(path.join(app, dir), { recursive: true });
    }
  }
}
