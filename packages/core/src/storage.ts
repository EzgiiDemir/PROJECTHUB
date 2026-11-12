import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invalid } from './errors.js';

/**
 * Filesystem layout under STORAGE_DIR. Everything the hub persists outside PostgreSQL lives here,
 * so backing up the system = pg_dump + this directory.
 */
export class Storage {
  constructor(public root: string) {}

  async init(): Promise<void> {
    for (const d of ['repos', 'artifacts', 'workspaces', 'logs', 'backups', 'uploads', 'tmp', 'deploy-local']) {
      await fs.mkdir(path.join(this.root, d), { recursive: true });
    }
    // The long, real path: Windows 8.3 short names (C:\Users\EZGI~1.DEM\...) break tools that compare resolved paths,
    // e.g. Vitest/Vite then looks for a project's setup file at "/vitest.setup.ts" and every test suite fails.
    this.root = await fs.realpath(this.root);
  }

  /** Resolves a key below root and refuses anything that would escape it. */
  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const rel = path.relative(this.root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw invalid('Geçersiz depolama yolu');
    return full;
  }

  repoKey(projectId: string): string {
    return `repos/${projectId}.git`;
  }
  workspaceKey(kind: 'build' | 'ai' | 'deploy' | 'terminal', id: string): string {
    return `workspaces/${kind}-${id}`;
  }
  buildArtifactKey(projectId: string, buildId: string): string {
    return `artifacts/${projectId}/builds/${buildId}`;
  }
  buildLogKey(projectId: string, buildId: string): string {
    return `logs/${projectId}/build-${buildId}.log`;
  }
  deploymentLogKey(projectId: string, deploymentId: string): string {
    return `logs/${projectId}/deploy-${deploymentId}.log`;
  }
  previewLogKey(projectId: string, previewId: string): string {
    return `logs/${projectId}/preview-${previewId}.log`;
  }
  screenshotKey(projectId: string, name: string): string {
    return `artifacts/${projectId}/screenshots/${name}`;
  }
  backupKey(projectId: string, name: string): string {
    return `backups/${projectId}/${name}`;
  }
  /** Generated documents (user guide and presentation PDFs). */
  reportKey(projectId: string, name: string): string {
    return `artifacts/${projectId}/reports/${name}`;
  }
  uploadKey(uploadId: string): string {
    return `uploads/${uploadId}`;
  }

  async ensureDir(key: string): Promise<string> {
    const p = this.resolve(key);
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async sizeOf(key: string): Promise<number> {
    return dirSize(this.resolve(key));
  }
}

export async function dirSize(p: string): Promise<number> {
  let total = 0;
  let stat;
  try {
    stat = await fs.lstat(p);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  const stack = [p];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* file vanished */
        }
      }
    }
  }
  return total;
}

/** Recursively lists files below `dir` as forward-slash relative paths, skipping the given directory names. */
export async function walkFiles(dir: string, skip: (rel: string, isDir: boolean) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip(r, true)) stack.push(r);
      } else if (e.isFile() && !skip(r, false)) out.push(r);
    }
  }
  return out.sort();
}

/** Deterministic content hash for an artifact tree. External links are rejected to keep artifacts self-contained. */
export async function hashDirectory(dir: string): Promise<string> {
  return (await digestDirectory(dir)).checksum;
}

/**
 * hashDirectory plus the total file size, in one pass. Small files are read ahead in parallel and fed to the hash in
 * sorted order, so the digest is byte-for-byte the sequential one; reading a 50k-file, 4 GB server artifact one file
 * at a time took over seven minutes on Windows.
 */
export async function digestDirectory(dir: string): Promise<{ checksum: string; sizeBytes: number }> {
  const root = path.resolve(dir);
  const files: string[] = [];
  const links: { rel: string; target: string }[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(root, child);
      if (entry.isSymbolicLink()) {
        const raw = (await fs.readlink(full)).replace(/^\\\\\?\\/, '');
        const absolute = path.resolve(path.dirname(full), raw);
        const inside = path.relative(root, absolute);
        if (inside.startsWith('..') || path.isAbsolute(inside)) throw invalid(`Artifact dışına işaret eden bağlantı: ${child}`);
        links.push({ rel: child.replace(/\\/g, '/'), target: inside.replace(/\\/g, '/') });
      } else if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child.replace(/\\/g, '/'));
      else throw invalid(`Desteklenmeyen artifact girdisi: ${child}`);
    }
  }
  const hash = createHash('sha256');
  for (const link of links.sort((a, b) => a.rel.localeCompare(b.rel))) hash.update(`link\0${link.rel}\0${link.target}\0`);
  const sorted = files.sort();
  const load = async (rel: string) => {
    const full = path.join(root, ...rel.split('/'));
    const stat = await fs.stat(full);
    return { full, size: stat.size, data: stat.size <= PREFETCH_MAX_BYTES ? await fs.readFile(full) : null };
  };
  const pending: Promise<Awaited<ReturnType<typeof load>>>[] = [];
  let next = 0;
  const fill = () => {
    while (pending.length < PREFETCH_FILES && next < sorted.length) {
      const p = load(sorted[next++]!);
      p.catch(() => undefined); // surfaced when awaited in order below
      pending.push(p);
    }
  };
  let sizeBytes = 0;
  fill();
  for (const rel of sorted) {
    const { full, size, data } = await pending.shift()!;
    fill();
    sizeBytes += size;
    hash.update(`file\0${rel}\0${size}\0`);
    if (data) hash.update(data);
    else for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
    hash.update('\0');
  }
  return { checksum: hash.digest('hex'), sizeBytes };
}

const PREFETCH_FILES = 16;
const PREFETCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Copies a directory tree (build workspace → artifact, artifact → deployment workspace).
 *
 * Links are recreated by us instead of `fs.cp`: Turbopack externalises server packages through links such as
 * `.next/node_modules/pg-<hash>` (a relative symlink on Linux, an absolute junction on Windows). `fs.cp` either
 * resolves them to absolute paths into `src` — which break as soon as the temporary build workspace is deleted —
 * or fails with EPERM on Windows without the symlink privilege. A link that points inside `src` is re-pointed at the
 * same place inside `dest`; links pointing elsewhere are kept as written.
 */
export async function copyDir(src: string, dest: string, filter?: (rel: string) => boolean): Promise<void> {
  const root = path.resolve(src);
  const links: string[] = [];
  await fs.cp(root, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: async (s) => {
      const rel = path.relative(root, s).replace(/\\/g, '/');
      if (rel && filter && !filter(rel)) return false;
      if (rel && (await fs.lstat(s)).isSymbolicLink()) {
        links.push(rel);
        return false;
      }
      return true;
    },
  });
  for (const rel of links) await copyLink(root, path.resolve(dest), rel);
}

/**
 * Moves a directory tree (build workspace → artifact). A rename keeps link targets as written, so links that pointed
 * inside the old location (Windows junctions are always absolute) are re-pointed at the new one. Falls back to a copy
 * when the rename is not possible (e.g. across volumes).
 */
export async function moveDir(src: string, dest: string): Promise<void> {
  const from = path.resolve(src);
  const to = path.resolve(dest);
  // Windows cannot reliably read a junction once its absolute target became dangling after the rename.
  // Capture internal targets while the source tree is still intact, then recreate them below the new root.
  const internalLinks = await collectInternalLinks(from);
  for (const link of internalLinks) await fs.rm(path.join(from, link.rel), { force: true, recursive: true });
  try {
    await fs.rename(from, to);
  } catch {
    for (const link of internalLinks) await writeLink(path.join(from, link.rel), path.join(from, link.inside), from);
    await copyDir(from, to);
    return;
  }
  for (const link of internalLinks) await writeLink(path.join(to, link.rel), path.join(to, link.inside), to);
}

async function collectInternalLinks(root: string): Promise<{ rel: string; inside: string }[]> {
  const links: { rel: string; inside: string }[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      const full = path.join(root, child);
      if (entry.isSymbolicLink()) {
        const raw = (await fs.readlink(full)).replace(/^\\\\\?\\/, '');
        const absolute = path.resolve(path.dirname(full), raw);
        const inside = path.relative(root, absolute);
        if (!inside.startsWith('..') && !path.isAbsolute(inside)) links.push({ rel: child, inside });
      } else if (entry.isDirectory()) stack.push(child);
    }
  }
  return links;
}

/** After a tree was renamed from `oldRoot` to `newRoot`, re-points links that still point into `oldRoot`. */
export async function relinkMoved(oldRoot: string, newRoot: string): Promise<void> {
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  const stack = [to];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const absolute = path.resolve(dir, (await fs.readlink(p)).replace(/^\\\\\?\\/, ''));
        const inside = path.relative(from, absolute);
        if (!inside.startsWith('..') && !path.isAbsolute(inside)) await writeLink(p, path.join(to, inside), to);
      } else if (e.isDirectory()) stack.push(p);
    }
  }
}

/**
 * Recreates `src` at `dest` with hard links: no file content is copied, so a 26k-file node_modules takes seconds
 * instead of a reinstall. Links inside the tree are re-pointed at `dest` (copyDir rules); a file that cannot be
 * linked (another volume) is copied. Returns the number of files.
 */
export async function linkTree(src: string, dest: string): Promise<number> {
  const root = path.resolve(src);
  const out = path.resolve(dest);
  const links: string[] = [];
  let files = 0;
  const walk = async (rel: string) => {
    await fs.mkdir(path.join(out, rel), { recursive: true });
    const pending: string[] = [];
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) links.push(child);
      else if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) pending.push(child);
    }
    for (let i = 0; i < pending.length; i += 64) {
      await Promise.all(
        pending.slice(i, i + 64).map((child) => fs.link(path.join(root, child), path.join(out, child)).catch(() => fs.copyFile(path.join(root, child), path.join(out, child)))),
      );
    }
    files += pending.length;
  };
  await walk('');
  for (const rel of links) await copyLink(root, out, rel);
  return files;
}

async function copyLink(srcRoot: string, destRoot: string, rel: string): Promise<void> {
  const from = path.join(srcRoot, rel);
  const raw = (await fs.readlink(from)).replace(/^\\\\\?\\/, '');
  const absolute = path.resolve(path.dirname(from), raw);
  const inside = path.relative(srcRoot, absolute);
  const internal = !inside.startsWith('..') && !path.isAbsolute(inside);
  await writeLink(path.join(destRoot, rel), internal ? path.join(destRoot, inside) : absolute, internal ? destRoot : null, internal ? null : raw);
}

/**
 * (Re)creates the link `at` → `target`. Windows: junctions (no privilege needed, always absolute) for directories,
 * a copy for files. POSIX: links inside `tree` stay relative so the tree remains valid wherever it is moved.
 */
async function writeLink(at: string, target: string, tree: string | null, verbatim: string | null = null): Promise<void> {
  const isDir = (await fs.stat(target).catch(() => null))?.isDirectory() ?? false;
  await fs.mkdir(path.dirname(at), { recursive: true });
  if (process.platform === 'win32') {
    // A dangling Windows junction may be visible to readdir but return ENOENT from lstat/unlink.
    // rm on the exact junction path removes the reparse point, not its target tree.
    await fs.rm(at, { force: true, recursive: true }).catch(() => undefined);
    if (isDir) await fs.symlink(target, at, 'junction');
    else if (await fs.stat(target).catch(() => null)) await fs.copyFile(target, at);
    return;
  }
  const existing = await fs.lstat(at).catch(() => null);
  if (existing?.isSymbolicLink()) await fs.unlink(at);
  else if (existing) await fs.rm(at, { force: true, recursive: existing.isDirectory() });
  await fs.symlink(verbatim ?? (tree ? path.relative(path.dirname(at), target) : target), at);
}
