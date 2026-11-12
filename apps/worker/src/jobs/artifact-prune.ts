import fs from 'node:fs/promises';
import path from 'node:path';

/** Local env files that hold credentials by convention. Templates and committed Next.js config files stay. */
const SECRET_ENV = /^\.env(\.local|\.[\w-]+\.local|\.backup|\.bak|\.old|\.save|\.orig)?$/i;
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.next', 'dist', 'build']);
const DROP_DIRS = new Set(['.tools']);
/** Laravel runtime data below an app root (folder with artisan): uploads, logs, framework caches. */
// bootstrap/cache holds the package manifest of the machine that generated it: a committed one listed development
// providers (Laravel Pail) the artifact does not have, and Form's preview died at boot. Laravel rebuilds it.
const LARAVEL_RUNTIME = ['storage/app', 'storage/logs', 'storage/framework/cache', 'storage/framework/sessions', 'storage/framework/views', 'storage/framework/testing', 'bootstrap/cache'];

export interface PruneReport {
  envFiles: string[];
  runtimeFiles: number;
  runtimeBytes: number;
  toolFiles: number;
  toolBytes: number;
  /** Every removed path relative to the root ('/'-separated), so another copy of the tree can be pruned the same way. */
  removed: string[];
}

/**
 * Removes what must not live in a build artifact before it is hashed and kept: credential files a repository may
 * still contain (secrets reach previews and deployments from Secrets at launch) and an app's runtime data — users'
 * uploads, logs, caches — that an import brought along. Form's artifacts held a populated backend/.env and 1.75 GB
 * of private application uploads and logs, copied into every build and preview.
 * Folders and their .gitignore files are kept so the app can still write there.
 */
export async function pruneArtifact(root: string): Promise<PruneReport> {
  const report: PruneReport = { envFiles: [], runtimeFiles: 0, runtimeBytes: 0, toolFiles: 0, toolBytes: 0, removed: [] };
  const appRoots: string[] = [];
  const walk = async (rel: string, depth: number) => {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile() && SECRET_ENV.test(entry.name)) {
        await fs.rm(path.join(root, child), { force: true });
        report.envFiles.push(child);
        report.removed.push(child);
      } else if (entry.isFile() && entry.name === 'artisan') appRoots.push(rel);
      else if (entry.isDirectory() && DROP_DIRS.has(entry.name)) {
        const measured = await measure(path.join(root, child));
        report.toolFiles += measured.files;
        report.toolBytes += measured.bytes;
        await fs.rm(path.join(root, child), { recursive: true, force: true, maxRetries: 5 });
        report.removed.push(child);
      }
      else if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name) && depth < 6) await walk(child, depth + 1);
    }
  };
  await walk('', 0);
  for (const app of appRoots) {
    for (const dir of LARAVEL_RUNTIME) await emptyKeepingStructure(root, app ? `${app}/${dir}` : dir, report);
  }
  return report;
}

async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const child = await measure(full);
      files += child.files;
      bytes += child.bytes;
    } else {
      files += 1;
      bytes += (await fs.lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return { files, bytes };
}

async function emptyKeepingStructure(root: string, rel: string, report: PruneReport) {
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const child = `${rel}/${entry.name}`;
    const full = path.join(root, child);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await emptyKeepingStructure(root, child, report);
    else if (entry.name !== '.gitignore') {
      report.runtimeBytes += (await fs.lstat(full).catch(() => null))?.size ?? 0;
      report.runtimeFiles += 1;
      await fs.rm(full, { force: true, recursive: true });
      report.removed.push(child);
    }
  }
}
