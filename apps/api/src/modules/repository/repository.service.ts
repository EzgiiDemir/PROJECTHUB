import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audit, forbidden, invalid, isProtectedBranch, isSha, notFound, precondition, publish, timeline, type Actor, type FileChange } from '@projecthub/core';
import { repositories } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';
import { ProjectsService } from '../projects/projects.service.js';

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown',
  css: 'css', scss: 'scss', html: 'html', htm: 'html', yml: 'yaml', yaml: 'yaml', php: 'php', py: 'python', go: 'go', java: 'java',
  rs: 'rust', sql: 'sql', sh: 'shell', xml: 'xml', vue: 'vue', svelte: 'svelte', prisma: 'prisma', toml: 'toml', env: 'properties',
};

function languageFor(path: string): string {
  if (/(^|\/)Dockerfile$/.test(path)) return 'dockerfile';
  if (/(^|\/)\.env(\.|$)/.test(path)) return 'properties';
  return LANGS[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'text';
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

@Injectable()
export class RepositoryService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
    private readonly projects: ProjectsService,
  ) {}

  private async open(auth: AuthInfo, idOrSlug: string, perm: 'repository.read' | 'repository.push' = 'repository.read') {
    const scope = perm === 'repository.push' ? await this.access.requireWritable(auth, idOrSlug, perm) : await this.access.require(auth, idOrSlug, perm);
    const { git, repo } = await this.repos.forProject(scope.project.id);
    return { scope, git, repo };
  }

  private async resolveRef(git: Awaited<ReturnType<Repos['forProject']>>['git'], ref: string | undefined, fallback: string) {
    const r = ref || fallback;
    const sha = isSha(r) ? await git.resolve(r) : (await git.resolve(`refs/heads/${r}`)) ?? (await git.resolve(`refs/tags/${r}`)) ?? (await git.resolve(r));
    if (!sha) throw notFound(`"${r}" referansı`);
    return sha;
  }

  async branches(auth: AuthInfo, idOrSlug: string) {
    const { scope, git } = await this.open(auth, idOrSlug);
    const list = await git.branches();
    const def = scope.project.defaultBranch;
    const defSha = list.find((b) => b.name === def)?.sha;
    const out = [];
    for (const b of list) {
      const ab = defSha && b.name !== def ? await git.aheadBehind(defSha, b.sha) : { ahead: 0, behind: 0 };
      out.push({ ...b, ...ab, isDefault: b.name === def });
    }
    return { defaultBranch: def, branches: out, tags: await git.tags() };
  }

  async tree(auth: AuthInfo, idOrSlug: string, ref: string | undefined, dir: string) {
    const { scope, git } = await this.open(auth, idOrSlug);
    if (await git.isEmpty()) return { commit: null, entries: [], empty: true };
    const commit = await this.resolveRef(git, ref, scope.project.defaultBranch);
    const entries = await git.listTree(commit, dir);
    return { commit, path: dir, entries, empty: false };
  }

  /** Full recursive file list (for the editor's file tree and quick-open). */
  async files(auth: AuthInfo, idOrSlug: string, ref: string | undefined) {
    const { scope, git } = await this.open(auth, idOrSlug);
    if (await git.isEmpty()) return { commit: null, files: [] };
    const commit = await this.resolveRef(git, ref, scope.project.defaultBranch);
    const files = await git.listFiles(commit);
    return { commit, files: files.map((f) => ({ path: f.path, size: f.size, sha: f.sha })) };
  }

  async file(auth: AuthInfo, idOrSlug: string, ref: string | undefined, path: string) {
    const { scope, git } = await this.open(auth, idOrSlug);
    const commit = await this.resolveRef(git, ref, scope.project.defaultBranch);
    const f = await git.readFile(commit, path, 2 * 1024 * 1024);
    if (!f) throw notFound('Dosya');
    const tooLarge = f.content.length === 0 && f.size > 0;
    const binary = !tooLarge && isBinary(f.content);
    const last = (await git.log({ ref: commit, path, limit: 1 }))[0] ?? null;
    return {
      commit,
      path,
      sha: f.sha,
      size: f.size,
      language: languageFor(path),
      binary,
      tooLarge,
      content: binary || tooLarge ? null : f.content.toString('utf8'),
      lastCommit: last,
    };
  }

  async raw(auth: AuthInfo, idOrSlug: string, ref: string | undefined, path: string) {
    const { scope, git } = await this.open(auth, idOrSlug);
    const commit = await this.resolveRef(git, ref, scope.project.defaultBranch);
    const f = await git.readFile(commit, path, 50 * 1024 * 1024);
    if (!f) throw notFound('Dosya');
    return f.content;
  }

  /** Produces a Git-native ZIP snapshot. It is immutable, contains no server metadata and is removed after download. */
  async archive(auth: AuthInfo, idOrSlug: string, ref: string | undefined, actor: Actor) {
    const { scope, git } = await this.open(auth, idOrSlug);
    if (await git.isEmpty()) throw precondition('Repository henüz boş; indirilecek kaynak kodu yok');
    const commit = await this.resolveRef(git, ref, scope.project.defaultBranch);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-export-'));
    const safeSlug = scope.project.slug.replace(/[^a-z0-9._-]/gi, '-');
    const fileName = `${safeSlug}-${commit.slice(0, 7)}.zip`;
    const archivePath = path.join(tempDir, `${randomUUID()}.zip`);
    try {
      await git.run(['archive', '--format=zip', `--output=${archivePath}`, commit], { timeoutMs: 30 * 60_000, maxBuffer: 1024 * 1024 });
      await audit(this.ctx.db, {
        organizationId: auth.organizationId,
        projectId: scope.project.id,
        actor,
        action: 'repository.exported',
        resourceType: 'commit',
        resourceId: commit,
        metadata: { ref: ref ?? scope.project.defaultBranch, format: 'zip' },
      });
      return { path: archivePath, tempDir, fileName, commit };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async commits(auth: AuthInfo, idOrSlug: string, q: { ref?: string; path?: string; limit: number; skip: number; search?: string }) {
    const { scope, git } = await this.open(auth, idOrSlug);
    if (await git.isEmpty()) return [];
    const commit = await this.resolveRef(git, q.ref, scope.project.defaultBranch);
    return git.log({ ref: commit, path: q.path, limit: q.limit, skip: q.skip, grep: q.search });
  }

  async commit(auth: AuthInfo, idOrSlug: string, sha: string) {
    const { git } = await this.open(auth, idOrSlug);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw notFound('Commit');
    const info = await git.commitInfo(sha);
    if (!info) throw notFound('Commit');
    const parent = info.parents[0] ?? null;
    const files = await git.diffStat(parent, info.sha);
    const { patch, truncated } = await git.diffPatch(parent, info.sha);
    return { ...info, files, patch, truncated };
  }

  async compare(auth: AuthInfo, idOrSlug: string, base: string, head: string) {
    const { scope, git } = await this.open(auth, idOrSlug);
    const b = await this.resolveRef(git, base, scope.project.defaultBranch);
    const h = await this.resolveRef(git, head, scope.project.defaultBranch);
    // Review diff = what merging head would bring in (three-dot semantics), not a raw tree difference.
    const from = (await git.mergeBase(b, h)) ?? b;
    const files = await git.diffStat(from, h);
    const { patch, truncated } = await git.diffPatch(from, h);
    const ab = await git.aheadBehind(b, h);
    const commits = ab.ahead ? await git.log({ ref: `${b}..${h}`, limit: 100 }) : [];
    return { base: b, head: h, ...ab, files, patch, truncated, commits };
  }

  /** Web editor commit (spec: "manuel düzenleme"). Optimistic concurrency via baseCommit. */
  async commitFiles(auth: AuthInfo, idOrSlug: string, input: { branch: string; baseCommit: string; message: string; changes: FileChange[] }, actor: Actor) {
    const { scope, git, repo } = await this.open(auth, idOrSlug, 'repository.push');
    if (input.branch.startsWith('ai/') && actor.type === 'user') {
      // AI branches belong to their AI task; humans review/merge them rather than editing in place.
      throw forbidden('ai/ ile başlayan branch\'ler AI görevlerine aittir; değişiklik için kendi branch\'inizi açın');
    }
    if (isProtectedBranch(scope.project.settings, input.branch)) {
      throw forbidden(`"${input.branch}" korumalı bir branch; değişikliği yeni bir branch'e commit edip pull request açın`);
    }
    const sha = await git.commitChanges({
      branch: input.branch,
      baseCommit: input.baseCommit,
      message: input.message,
      author: { name: auth.user.displayName, email: auth.user.email },
      changes: input.changes,
    });
    await this.recordPush(scope.project.id, auth.organizationId, input.branch, sha, input.message, input.changes.length, actor, repo.id, scope.project.defaultBranch);
    return { commit: sha, branch: input.branch };
  }

  /** "3 dosya (+12 −4): a.ts, b.tsx" for the activity feed — what the team needs to see without opening the diff. */
  private async changeSummary(projectId: string, sha: string, fallbackCount: number): Promise<{ text: string; files: { path: string; additions: number; deletions: number }[] }> {
    try {
      const { git } = await this.repos.forProject(projectId);
      const parent = (await git.log({ ref: sha, limit: 1 }))[0]?.parents[0] ?? null;
      const stats = await git.diffStat(parent, sha);
      const add = stats.reduce((n, f) => n + (f.additions ?? 0), 0);
      const del = stats.reduce((n, f) => n + (f.deletions ?? 0), 0);
      const names = stats.slice(0, 5).map((f) => f.path).join(', ');
      return {
        text: `${stats.length} dosya (+${add} −${del})${names ? `: ${names}${stats.length > 5 ? ` ve ${stats.length - 5} dosya daha` : ''}` : ''}`,
        files: stats.slice(0, 50).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
      };
    } catch {
      return { text: `${fallbackCount} dosya`, files: [] };
    }
  }

  async recordPush(projectId: string, organizationId: string, branch: string, sha: string, message: string, fileCount: number, actor: Actor, repositoryId: string, defaultBranch: string) {
    const change = await this.changeSummary(projectId, sha, fileCount);
    await this.ctx.db.transaction(async (tx) => {
      const patch: Partial<typeof repositories.$inferInsert> = { lastPushedAt: new Date() };
      if (branch === defaultBranch) patch.headCommit = sha;
      await tx.update(repositories).set(patch).where(eq(repositories.id, repositoryId));
      await audit(tx, { organizationId, projectId, actor, action: 'repository.commit', resourceType: 'commit', resourceId: sha, metadata: { branch, message: message.slice(0, 200), files: fileCount, changed: change.files } });
      await timeline(tx, {
        organizationId,
        projectId,
        kind: 'commit',
        title: `${sha.slice(0, 7)} ${message.split('\n')[0]!.slice(0, 120)}`,
        description: `${actor.label} · ${branch} · ${change.text}`,
        refType: 'commit',
        refId: sha,
        actorLabel: actor.label,
      });
      if (branch === defaultBranch) await this.projects.afterPush(tx, projectId, organizationId, branch);
      // Every ref change reaches open browsers (code view, history, branches) no matter where it came from:
      // git push from a PC/IDE, the sync agent, the web editor, a terminal session or a merge. Sent on commit.
      await publish(tx, { type: 'repository.updated', organizationId, projectId, data: { branch, sha, message: message.split('\n')[0]!.slice(0, 120), actor: actor.label, actorId: actor.id, files: fileCount } });
    });
  }

  async createBranch(auth: AuthInfo, idOrSlug: string, input: { name: string; from: string }, actor: Actor) {
    const { scope, git } = await this.open(auth, idOrSlug, 'repository.push');
    const from = await this.resolveRef(git, input.from, scope.project.defaultBranch);
    await git.createBranch(input.name, from);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'repository.branch_created', resourceType: 'branch', resourceId: input.name, metadata: { from } });
    await timeline(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, kind: 'commit', title: `Branch oluşturuldu: ${input.name}`, description: `${from.slice(0, 7)} üzerinden`, actorLabel: actor.label });
    await publish(this.ctx.db, { type: 'repository.updated', organizationId: auth.organizationId, projectId: scope.project.id, data: { branch: input.name, sha: from, actor: actor.label, actorId: actor.id } });
    return { name: input.name, sha: from };
  }

  async deleteBranch(auth: AuthInfo, idOrSlug: string, name: string, actor: Actor) {
    const { scope, git } = await this.open(auth, idOrSlug, 'repository.push');
    if (name === scope.project.defaultBranch) throw forbidden('Varsayılan branch silinemez');
    if (isProtectedBranch(scope.project.settings, name)) throw forbidden(`"${name}" korumalı bir branch; silinemez`);
    const sha = await git.resolve(`refs/heads/${name}`);
    if (!sha) throw notFound('Branch');
    await git.deleteBranch(name, sha);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'repository.branch_deleted', resourceType: 'branch', resourceId: name, metadata: { sha } });
    await publish(this.ctx.db, { type: 'repository.updated', organizationId: auth.organizationId, projectId: scope.project.id, data: { branch: name, sha: null, deleted: true, actor: actor.label, actorId: actor.id } });
  }

  async merge(auth: AuthInfo, idOrSlug: string, input: { source: string; target: string; message?: string }, actor: Actor) {
    const { scope, git, repo } = await this.open(auth, idOrSlug, 'repository.push');
    if (input.source === input.target) throw invalid('Kaynak ve hedef branch aynı olamaz');
    if (isProtectedBranch(scope.project.settings, input.target)) throw forbidden(`"${input.target}" korumalı; birleştirme pull request üzerinden yapılır`);
    if (input.source.startsWith('ai/')) throw forbidden('AI branch\'leri AI görevi ekranından onaylanarak birleştirilir');
    const result = await git.merge({
      source: input.source,
      target: input.target,
      message: input.message || `Merge ${input.source} into ${input.target}`,
      author: { name: auth.user.displayName, email: auth.user.email },
    });
    await this.recordPush(scope.project.id, auth.organizationId, input.target, result.sha, input.message || `Merge ${input.source} into ${input.target}`, 0, actor, repo.id, scope.project.defaultBranch);
    return result;
  }

  async search(auth: AuthInfo, idOrSlug: string, ref: string | undefined, q: string) {
    const { scope, git } = await this.open(auth, idOrSlug);
    if (await git.isEmpty()) return [];
    const commit = await this.resolveRef(git, ref, scope.project.defaultBranch);
    if (q.trim().length < 2) throw invalid('En az 2 karakter girin');
    return git.grep(commit, q.trim(), { maxResults: 100, sourceOnly: true });
  }
}
