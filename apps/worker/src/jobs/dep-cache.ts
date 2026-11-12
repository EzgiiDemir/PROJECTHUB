import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Manifest } from '@projecthub/contracts';
import { linkTree, type GitRepository } from '@projecthub/core';
import type { WorkerCtx } from '../context.js';
import { composerPlatformWaivers } from '../runner/process.js';

/** Folders an install fills, in the repository root and in app folders one level down (backend/, frontend/). */
const DEP_DIRS = ['node_modules', 'vendor', '.pydeps'];
/** Files whose content decides what an install produces. */
const KEY_FILE = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.json|composer\.lock|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock)$/;
/** Dependency sets kept per project (current lockfiles plus recent ones, e.g. an AI branch that changed one). */
const KEEP = 3;

/** Whether edits change what an install produces (a lockfile or package manifest in the root or an app folder). */
export function touchesDependencies(paths: string[]): boolean {
  return paths.some((p) => p.split('/').length <= 2 && KEY_FILE.test(p.slice(p.lastIndexOf('/') + 1)));
}

export interface DependencyCache {
  key: string;
  /** Dependency folders (repository-relative) this project's install fills. */
  dirs: string[];
  /** Set when a snapshot for this key exists. */
  hit: boolean;
}

/**
 * Installs are repeated for every build and every AI check, although the dependencies only change with the lockfiles:
 * on a 50k-file project that is ten minutes each time. A finished install is kept (hard links, no copied content)
 * under a key from the lockfiles, the install command and the runtime, and restored instead of installing again.
 */
export async function dependencyCache(ctx: WorkerCtx, projectId: string, git: GitRepository, commit: string, manifest: Manifest, containerized: boolean): Promise<DependencyCache | null> {
  const command = manifest.install?.command;
  if (!command) return null;
  const inputs = (await git.listFiles(commit)).filter((f) => f.type === 'blob' && f.path.split('/').length <= 2 && KEY_FILE.test(f.name)).sort((a, b) => a.path.localeCompare(b.path));
  if (!inputs.length) return null;
  const appDirs = [...new Set(inputs.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '')))];
  const dirs = appDirs.flatMap((d) => DEP_DIRS.map((name) => (d ? `${d}/${name}` : name)));
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ v: 1, command, runtime: manifest.runtime, env: manifest.build?.env ?? {}, platform: `${process.platform}-${process.arch}`, node: process.versions.node, containerized, waivers: composerPlatformWaivers(manifest.runtime?.type, containerized) }));
  for (const f of inputs) hash.update(`${f.path}\0${f.sha}\0`);
  const key = hash.digest('hex').slice(0, 32);
  const hit = !!(await fs.stat(path.join(cacheRoot(ctx, projectId), key, 'meta.json')).catch(() => null));
  return { key, dirs, hit };
}

/** Links the cached dependency folders into a fresh workspace; false when the snapshot is incomplete. */
export async function restoreDependencies(ctx: WorkerCtx, projectId: string, cache: DependencyCache, workspace: string): Promise<{ ok: boolean; files: number }> {
  const dir = path.join(cacheRoot(ctx, projectId), cache.key);
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => 'null')) as { dirs: string[] } | null;
  if (!meta) return { ok: false, files: 0 };
  let files = 0;
  for (const rel of meta.dirs) {
    const target = path.join(workspace, rel);
    await fs.rm(target, { recursive: true, force: true });
    files += await linkTree(path.join(dir, 'tree', rel), target);
  }
  // Mark it used so pruning keeps the snapshots that are still needed.
  await fs.utimes(path.join(dir, 'meta.json'), new Date(), new Date()).catch(() => undefined);
  return { ok: true, files };
}

/** Keeps the dependency folders of a successful install for the next build with the same lockfiles. */
export async function saveDependencies(ctx: WorkerCtx, projectId: string, cache: DependencyCache, workspace: string): Promise<number> {
  const root = cacheRoot(ctx, projectId);
  const dir = path.join(root, cache.key);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  const present: string[] = [];
  let files = 0;
  try {
    for (const rel of cache.dirs) {
      const source = path.join(workspace, rel);
      if (!(await fs.stat(source).catch(() => null))?.isDirectory()) continue;
      files += await linkTree(source, path.join(tmp, 'tree', rel));
      present.push(rel);
    }
    if (!present.length) return 0;
    await fs.writeFile(path.join(tmp, 'meta.json'), JSON.stringify({ dirs: present, savedAt: new Date().toISOString() }));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  await prune(root);
  return files;
}

/**
 * Gives the files package managers rewrite in place (Composer's autoload and bin proxies, npm's hidden lockfile) their
 * own copy, so a command that changes them — "composer install --no-dev" before packaging — cannot alter the cached
 * set the workspace is hard-linked to. Removing packages only unlinks and needs nothing.
 */
export async function detachRewrittenFiles(workspace: string, dirs: string[]): Promise<number> {
  let copied = 0;
  const detach = async (target: string) => {
    const st = await fs.lstat(target).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      for (const entry of await fs.readdir(target)) await detach(path.join(target, entry));
    } else if (st.isFile() && st.nlink > 1) {
      const tmp = `${target}.detach-${process.pid}`;
      await fs.copyFile(target, tmp);
      await fs.rename(tmp, target);
      copied++;
    }
  };
  for (const rel of dirs) {
    const name = path.basename(rel);
    const inside = name === 'vendor' ? ['composer', 'autoload.php', 'bin'] : name === 'node_modules' ? ['.package-lock.json', '.bin', '.modules.yaml'] : [];
    for (const p of inside) await detach(path.join(workspace, rel, p));
  }
  return copied;
}

function cacheRoot(ctx: WorkerCtx, projectId: string) {
  return ctx.storage.resolve(`tmp/dep-cache/${projectId}`);
}

async function prune(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const sets = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.includes('.tmp-'))
      .map(async (e) => ({ name: e.name, used: (await fs.stat(path.join(root, e.name, 'meta.json')).catch(() => null))?.mtimeMs ?? 0 })),
  );
  for (const old of sets.sort((a, b) => b.used - a.used).slice(KEEP)) await fs.rm(path.join(root, old.name), { recursive: true, force: true }).catch(() => undefined);
}
