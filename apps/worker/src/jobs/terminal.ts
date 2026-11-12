import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, lt, sql } from 'drizzle-orm';
import { audit, enqueue, isProtectedBranch, publish, QUEUES, timeline, type FileChange, type JobContext } from '@projecthub/core';
import { repositories, terminalCommands, terminalSessions, users } from '@projecthub/database';
import { runContainerCommand } from '../runner/process.js';
import { loadProject, openRepo, type WorkerCtx } from '../context.js';
import { registerPeriodic } from './maintenance.js';
import { assertTerminalRuntime } from './terminal-runtime.js';

const run = promisify(execFile);
const OUTPUT_CAP = 256 * 1024;
const MAX_SYNC_FILE = 5 * 1024 * 1024;
/** Never committed from a terminal, even without a .gitignore. Local to the working copy (.git/info/exclude). */
const EXCLUDES = ['node_modules/', 'vendor/', '.venv/', '__pycache__/', '.next/', '.nuxt/', 'dist/', 'build/', 'coverage/', '.ph-home/', '.env', '.env.*', '!.env.example'];

type Session = typeof terminalSessions.$inferSelect;

const workDir = (ctx: WorkerCtx, id: string) => ctx.storage.resolve(ctx.storage.workspaceKey('terminal', id));
const git = (ctx: WorkerCtx, cwd: string, args: string[]) =>
  run(ctx.config.GIT_BINARY, ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=off', '-c', 'core.longpaths=true', ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).then((r) => r.stdout);
const tell = (ctx: WorkerCtx, s: Session) => publish(ctx.db, { type: 'terminal.updated', organizationId: s.organizationId, projectId: s.projectId, id: s.id });

/** `terminal.open`: private working copy of the session's branch, cloned from the hub's own repository. */
export async function openTerminal(ctx: WorkerCtx, { job }: JobContext) {
  const { sessionId } = job.payload as { sessionId: string };
  const s = (await ctx.db.select().from(terminalSessions).where(eq(terminalSessions.id, sessionId)))[0];
  if (!s || s.status !== 'starting') return { skipped: true };
  const dir = workDir(ctx, s.id);
  try {
    await assertTerminalRuntime(process.env.DOCKER_BINARY || 'docker');
    const { git: bare } = await openRepo(ctx, s.projectId);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await run(ctx.config.GIT_BINARY, ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', 'clone', '--quiet', '--no-hardlinks', '--branch', s.branch, bare.dir, dir], { windowsHide: true });
    await fs.appendFile(path.join(dir, '.git', 'info', 'exclude'), `\n# projecthub terminal\n${EXCLUDES.join('\n')}\n`);
    const head = (await git(ctx, dir, ['rev-parse', 'HEAD'])).trim();
    await ctx.db.update(terminalSessions).set({ status: 'ready', headCommit: head, lastActivityAt: new Date() }).where(eq(terminalSessions.id, s.id));
  } catch (e) {
    await ctx.db.update(terminalSessions).set({ status: 'failed', error: (e as Error).message.slice(0, 500) }).where(eq(terminalSessions.id, s.id));
  }
  await tell(ctx, s);
  return { opened: true };
}

/**
 * `terminal.run`: one command in a fresh container (no root, no capabilities, read-only image, CPU/RAM/process and
 * time limits, no Docker socket, no Project Hub secrets). Output streams to the browser; changed files are committed
 * back to the branch so every other view sees them.
 */
export async function runTerminalCommand(ctx: WorkerCtx, { job, logger }: JobContext) {
  const { commandId } = job.payload as { commandId: string };
  const db = ctx.db;
  const cmd = (await db.select().from(terminalCommands).where(eq(terminalCommands.id, commandId)))[0];
  if (!cmd || cmd.status !== 'queued') return { skipped: true };
  const s = (await db.select().from(terminalSessions).where(eq(terminalSessions.id, cmd.sessionId)))[0];
  if (!s || s.status !== 'ready') {
    await db.update(terminalCommands).set({ status: 'failed', output: 'Terminal oturumu hazır değil.', finishedAt: new Date() }).where(eq(terminalCommands.id, cmd.id));
    return { skipped: 'session' };
  }
  const dir = workDir(ctx, s.id);
  let output = '';
  let flushed = 0;
  let dirty = false;
  const append = (text: string) => {
    output += text;
    if (output.length > OUTPUT_CAP) output = `[… baş kısım kısaltıldı]\n${output.slice(-OUTPUT_CAP)}`;
    dirty = true;
  };
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    flushed = Date.now();
    await db.update(terminalCommands).set({ output }).where(eq(terminalCommands.id, cmd.id));
    await tell(ctx, s);
  };
  const ticker = setInterval(() => void (Date.now() - flushed > 400 ? flush() : undefined), 400);
  await db.update(terminalCommands).set({ status: 'running', startedAt: new Date() }).where(eq(terminalCommands.id, cmd.id));
  await db.update(terminalSessions).set({ lastActivityAt: new Date() }).where(eq(terminalSessions.id, s.id));
  await tell(ctx, s);

  let head = s.headCommit;
  try {
    // Changes pushed elsewhere since the last command come in first (only when nothing local would be overwritten).
    head = await pullRemote(ctx, s, dir, append);
    const result = await runContainerCommand({
      command: `${PACKAGE_MANAGER_SHIMS}
${cmd.command}`,
      cwd: dir,
      env: { HOME: '/workspace/.ph-home', npm_config_cache: '/workspace/.ph-home/.npm', CI: 'true', FORCE_COLOR: '0' },
      timeoutMs: ctx.config.TERMINAL_COMMAND_TIMEOUT_MINUTES * 60_000,
      limits: { image: ctx.config.TERMINAL_IMAGE, cpus: ctx.config.BUILD_CONTAINER_CPUS, memoryMb: ctx.config.BUILD_CONTAINER_MEMORY_MB, pids: ctx.config.BUILD_CONTAINER_PIDS, network: ctx.config.TERMINAL_NETWORK },
      labels: { 'com.projecthub.managed': 'terminal', 'com.projecthub.session': s.id },
      onOutput: append,
      isCancelled: async () => (await db.select({ st: terminalCommands.status }).from(terminalCommands).where(eq(terminalCommands.id, cmd.id)))[0]?.st === 'cancelled',
    });
    if (result.timedOut) append(`\n[projecthub] ${ctx.config.TERMINAL_COMMAND_TIMEOUT_MINUTES} dakika sınırı aşıldı, komut durduruldu.\n`);
    const cancelled = result.cancelled;
    let commitSha: string | null = null;
    let syncNote: string | null = null;
    if (s.autoSync && !cancelled) ({ commitSha, syncNote, head } = await syncBack(ctx, s, dir, head, `Terminal: ${cmd.command.split('\n')[0]!.slice(0, 120)}`));
    clearInterval(ticker);
    await db
      .update(terminalCommands)
      .set({ status: cancelled ? 'cancelled' : result.exitCode === 0 ? 'done' : 'failed', exitCode: result.exitCode, output, commitSha, syncNote, finishedAt: new Date() })
      .where(eq(terminalCommands.id, cmd.id));
    await db.update(terminalSessions).set({ headCommit: head, lastActivityAt: new Date() }).where(eq(terminalSessions.id, s.id));
    await tell(ctx, s);
    return { exitCode: result.exitCode, commitSha };
  } catch (e) {
    clearInterval(ticker);
    logger.error({ err: e, sessionId: s.id }, 'terminal command failed');
    append(`\n[projecthub] ${(e as Error).message}\n`);
    await db.update(terminalCommands).set({ status: 'failed', output, finishedAt: new Date() }).where(eq(terminalCommands.id, cmd.id));
    await tell(ctx, s);
    return { failed: true };
  }
}

/**
 * The terminal image ships Corepack but no pnpm/yarn commands ("pnpm: not found"), and its file system is read-only:
 * the shims go into the session's writable home on first use. The user's command still decides the exit code.
 */
const PACKAGE_MANAGER_SHIMS =
  'mkdir -p "$HOME/bin"; [ -x "$HOME/bin/pnpm" ] || corepack enable --install-directory "$HOME/bin" pnpm yarn >/dev/null 2>&1; export PATH="$HOME/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0';

async function pullRemote(ctx: WorkerCtx, s: Session, dir: string, append: (t: string) => void): Promise<string | null> {
  await git(ctx, dir, ['fetch', '--quiet', 'origin', `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`]);
  const local = (await git(ctx, dir, ['rev-parse', 'HEAD'])).trim();
  const remote = (await git(ctx, dir, ['rev-parse', `origin/${s.branch}`])).trim();
  if (local === remote) return local;
  if ((await git(ctx, dir, ['status', '--porcelain'])).trim()) {
    append(`[projecthub] ${s.branch} başka bir yerde değişti, ancak burada kaydedilmemiş dosyalar var; uzak değişiklikler alınmadı.\n`);
    return local;
  }
  await git(ctx, dir, ['merge', '--ff-only', '--quiet', `origin/${s.branch}`]);
  append(`[projecthub] Başka yerde yapılan değişiklikler alındı (${remote.slice(0, 7)}).\n`);
  return remote;
}

/** Commits what the command changed to the branch (compare-and-swap on the session head), like a push. */
async function syncBack(ctx: WorkerCtx, s: Session, dir: string, head: string | null, message: string): Promise<{ commitSha: string | null; syncNote: string | null; head: string | null }> {
  const status = await git(ctx, dir, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = status.split('\0').filter(Boolean);
  if (!entries.length) return { commitSha: null, syncNote: null, head };
  const project = await loadProject(ctx, s.projectId);
  if (isProtectedBranch(project.settings, s.branch)) return { commitSha: null, syncNote: `"${s.branch}" korumalı; değişiklikler kaydedilmedi. Korumasız bir branch ile yeni oturum açın.`, head };
  const changes: FileChange[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const code = e.slice(0, 2);
    const file = e.slice(3);
    if (code.startsWith('R')) i++; // renames carry the old path as the next entry
    if (code.includes('D')) {
      changes.push({ action: 'delete', path: file });
      continue;
    }
    const abs = path.join(dir, file);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    if (stat.size > MAX_SYNC_FILE) {
      skipped.push(file);
      continue;
    }
    changes.push({ action: 'upsert', path: file, content: await fs.readFile(abs) });
  }
  if (!changes.length) return { commitSha: null, syncNote: skipped.length ? `${skipped.length} büyük dosya kaydedilmedi (5 MB üstü).` : null, head };
  const user = (await ctx.db.select().from(users).where(eq(users.id, s.userId)))[0]!;
  const { git: bare, repo } = await openRepo(ctx, s.projectId);
  let sha: string;
  try {
    sha = await bare.commitChanges({ branch: s.branch, baseCommit: head, message, author: { name: user.displayName, email: user.email }, changes });
  } catch (e) {
    return { commitSha: null, syncNote: `Kaydedilemedi: ${(e as Error).message} (branch başka bir yerde değişti; sonraki komutta uzak değişiklikler alınır).`, head };
  }
  // The working copy now matches the new commit: move HEAD and index without touching files.
  await git(ctx, dir, ['fetch', '--quiet', 'origin', `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`]);
  await git(ctx, dir, ['reset', '--quiet', '--mixed', sha]);
  const actor = { type: 'user' as const, id: user.id, label: user.displayName };
  await ctx.db.transaction(async (tx) => {
    const isDefault = s.branch === project.defaultBranch;
    await tx.update(repositories).set({ lastPushedAt: new Date(), ...(isDefault ? { headCommit: sha } : {}) }).where(eq(repositories.id, repo.id));
    await audit(tx, { organizationId: s.organizationId, projectId: s.projectId, actor, action: 'repository.commit', resourceType: 'commit', resourceId: sha, metadata: { branch: s.branch, message, files: changes.length, via: 'terminal' } });
    await timeline(tx, { organizationId: s.organizationId, projectId: s.projectId, kind: 'commit', title: `${sha.slice(0, 7)} ${message.slice(0, 120)}`, description: `${user.displayName} · ${s.branch} · ${changes.length} dosya · terminal`, refType: 'commit', refId: sha, actorLabel: user.displayName });
    if (isDefault) {
      await enqueue(tx, { queue: QUEUES.index, type: 'code.index', projectId: s.projectId, organizationId: s.organizationId, dedupeKey: `index:${s.projectId}`, payload: { projectId: s.projectId, branch: s.branch } });
      await enqueue(tx, { queue: QUEUES.security, type: 'security.scan', projectId: s.projectId, organizationId: s.organizationId, dedupeKey: `scan:${s.projectId}`, runAt: new Date(Date.now() + 5_000), payload: { projectId: s.projectId, branch: s.branch, trigger: 'push' } });
    }
    await publish(tx, { type: 'repository.updated', organizationId: s.organizationId, projectId: s.projectId, data: { branch: s.branch, sha, message, actor: `${user.displayName} (terminal)`, actorId: user.id, files: changes.length } });
  });
  const names = changes.map((c) => c.path);
  return { commitSha: sha, syncNote: `${changes.length} dosya kaydedildi → ${s.branch} (${sha.slice(0, 7)}): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}${skipped.length ? ` · ${skipped.length} büyük dosya atlandı` : ''}`, head: sha };
}

/** `terminal.close`: removes the working copy. Also used for idle sessions. */
export async function closeTerminal(ctx: WorkerCtx, { job }: JobContext) {
  const { sessionId } = job.payload as { sessionId: string };
  const s = (await ctx.db.select().from(terminalSessions).where(eq(terminalSessions.id, sessionId)))[0];
  if (!s) return { skipped: true };
  await fs.rm(workDir(ctx, s.id), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await ctx.db.update(terminalSessions).set({ status: 'closed', closedAt: s.closedAt ?? new Date() }).where(eq(terminalSessions.id, s.id));
  await tell(ctx, s);
  return { closed: true };
}

/** Closes sessions nobody used for TERMINAL_IDLE_MINUTES (called from the maintenance tick). */
export async function closeIdleTerminals(ctx: WorkerCtx) {
  const idle = await ctx.db
    .select({ id: terminalSessions.id, organizationId: terminalSessions.organizationId, projectId: terminalSessions.projectId })
    .from(terminalSessions)
    .where(and(sql`${terminalSessions.status} in ('starting', 'ready')`, lt(terminalSessions.lastActivityAt, new Date(Date.now() - ctx.config.TERMINAL_IDLE_MINUTES * 60_000))));
  for (const s of idle) {
    await ctx.db.update(terminalSessions).set({ status: 'closed', closedAt: new Date() }).where(eq(terminalSessions.id, s.id));
    await enqueue(ctx.db, { queue: QUEUES.terminal, type: 'terminal.close', organizationId: s.organizationId, projectId: s.projectId, payload: { sessionId: s.id } });
  }
  return idle.length;
}

registerPeriodic({
  name: 'close-idle-terminals',
  everyMinutes: 5,
  run: (ctx) => (ctx.config.TERMINAL_ENABLED ? closeIdleTerminals(ctx) : Promise.resolve(0)),
});
