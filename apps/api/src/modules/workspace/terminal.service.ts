import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { audit, enqueue, isProtectedBranch, notFound, precondition, publish, QUEUES, type Actor } from '@projecthub/core';
import { terminalCommands, terminalSessions } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { Repos } from '../../infra/repos.js';

const OUTPUT_IN_LIST = 64 * 1024;

/**
 * Browser terminal sessions. Private to the user who opened them; every command is audited and runs on the worker in
 * a fresh locked-down container (see apps/worker/src/jobs/terminal.ts).
 */
@Injectable()
export class TerminalService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly repos: Repos,
  ) {}

  private ensureEnabled() {
    if (!this.ctx.config.TERMINAL_ENABLED) {
      throw precondition('Tarayıcı terminali bu sunucuda kapalı. Worker\'ın erişebildiği bir Docker motoru gerekir (TERMINAL_ENABLED=true). Bunun yerine "Aç" menüsünden projeyi kendi editörünüzde açabilirsiniz.');
    }
  }

  async current(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug, 'repository.read');
    const s = (
      await this.ctx.db
        .select()
        .from(terminalSessions)
        .where(and(eq(terminalSessions.projectId, scope.project.id), eq(terminalSessions.userId, auth.user.id), inArray(terminalSessions.status, ['starting', 'ready', 'failed'])))
        .orderBy(desc(terminalSessions.createdAt))
        .limit(1)
    )[0];
    return {
      enabled: this.ctx.config.TERMINAL_ENABLED,
      limits: { network: this.ctx.config.TERMINAL_NETWORK, timeoutMinutes: this.ctx.config.TERMINAL_COMMAND_TIMEOUT_MINUTES, idleMinutes: this.ctx.config.TERMINAL_IDLE_MINUTES, image: this.ctx.config.TERMINAL_IMAGE },
      session: s ? await this.present(s, isProtectedBranch(scope.project.settings, s.branch)) : null,
    };
  }

  async open(auth: AuthInfo, idOrSlug: string, input: { branch?: string; autoSync: boolean }, actor: Actor) {
    this.ensureEnabled();
    const scope = await this.access.requireWritable(auth, idOrSlug, 'repository.push');
    const branch = input.branch || scope.project.defaultBranch;
    const protectedBranch = isProtectedBranch(scope.project.settings, branch);
    const { git } = await this.repos.forProject(scope.project.id);
    if (!(await git.resolve(`refs/heads/${branch}`))) throw notFound(`"${branch}" branch'i`);
    // One live session per person and project; reopening returns it.
    const live = (await this.current(auth, scope.project.id)).session;
    if (live && live.status !== 'failed' && live.branch === branch) return live;
    if (live) await this.close(auth, live.id, actor);
    const s = await this.ctx.db.transaction(async (tx) => {
      const row = (await tx.insert(terminalSessions).values({ organizationId: auth.organizationId, projectId: scope.project.id, userId: auth.user.id, branch, autoSync: input.autoSync && !protectedBranch }).returning())[0]!;
      await enqueue(tx, { queue: QUEUES.terminal, type: 'terminal.open', organizationId: auth.organizationId, projectId: scope.project.id, maxAttempts: 1, payload: { sessionId: row.id } });
      await audit(tx, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'terminal.opened', resourceType: 'terminal_session', resourceId: row.id, metadata: { branch, autoSync: row.autoSync, protectedBranch } });
      return row;
    });
    return this.present(s, protectedBranch);
  }

  private async own(auth: AuthInfo, sessionId: string) {
    const s = (await this.ctx.db.select().from(terminalSessions).where(and(eq(terminalSessions.id, sessionId), eq(terminalSessions.organizationId, auth.organizationId))))[0];
    // Sessions are private: another user's session does not exist for you.
    if (!s || s.userId !== auth.user.id) throw notFound('Terminal oturumu');
    await this.access.require(auth, s.projectId, 'repository.read');
    return s;
  }

  async get(auth: AuthInfo, sessionId: string) {
    const s = await this.own(auth, sessionId);
    const scope = await this.access.require(auth, s.projectId, 'repository.read');
    return this.present(s, isProtectedBranch(scope.project.settings, s.branch));
  }

  async run(auth: AuthInfo, sessionId: string, command: string, actor: Actor) {
    this.ensureEnabled();
    const s = await this.own(auth, sessionId);
    await this.access.requireWritable(auth, s.projectId, 'repository.push');
    if (s.status !== 'ready') throw precondition(s.status === 'starting' ? 'Terminal hazırlanıyor, birkaç saniye sonra tekrar deneyin' : 'Terminal oturumu kapalı');
    const busy = (await this.ctx.db.select({ n: sql<number>`count(*)::int` }).from(terminalCommands).where(and(eq(terminalCommands.sessionId, s.id), inArray(terminalCommands.status, ['queued', 'running']))))[0]!.n;
    if (busy) throw precondition('Önceki komut hâlâ çalışıyor; bitmesini bekleyin veya iptal edin');
    const c = await this.ctx.db.transaction(async (tx) => {
      const row = (await tx.insert(terminalCommands).values({ sessionId: s.id, command }).returning())[0]!;
      await tx.update(terminalSessions).set({ lastActivityAt: new Date() }).where(eq(terminalSessions.id, s.id));
      await enqueue(tx, { queue: QUEUES.terminal, type: 'terminal.run', organizationId: s.organizationId, projectId: s.projectId, maxAttempts: 1, payload: { commandId: row.id } });
      await audit(tx, { organizationId: s.organizationId, projectId: s.projectId, actor, action: 'terminal.command', resourceType: 'terminal_session', resourceId: s.id, metadata: { command: command.slice(0, 300) } });
      await publish(tx, { type: 'terminal.updated', organizationId: s.organizationId, projectId: s.projectId, id: s.id });
      return row;
    });
    return { id: c.id };
  }

  async cancel(auth: AuthInfo, sessionId: string, commandId: string) {
    const s = await this.own(auth, sessionId);
    await this.ctx.db.update(terminalCommands).set({ status: 'cancelled', finishedAt: new Date() }).where(and(eq(terminalCommands.id, commandId), eq(terminalCommands.sessionId, s.id), eq(terminalCommands.status, 'queued')));
    // A running command is stopped by the worker within ~2 s once it sees the cancellation.
    await this.ctx.db.update(terminalCommands).set({ status: 'cancelled' }).where(and(eq(terminalCommands.id, commandId), eq(terminalCommands.sessionId, s.id), eq(terminalCommands.status, 'running')));
    await publish(this.ctx.db, { type: 'terminal.updated', organizationId: s.organizationId, projectId: s.projectId, id: s.id });
    return { ok: true };
  }

  async setAutoSync(auth: AuthInfo, sessionId: string, autoSync: boolean) {
    const s = await this.own(auth, sessionId);
    const scope = await this.access.require(auth, s.projectId, 'repository.read');
    const protectedBranch = isProtectedBranch(scope.project.settings, s.branch);
    if (autoSync && protectedBranch) throw precondition(`"${s.branch}" korumalı; otomatik kaydetme açılamaz. Korumasız bir branch ile yeni terminal oturumu başlatın.`);
    await this.ctx.db.update(terminalSessions).set({ autoSync }).where(eq(terminalSessions.id, s.id));
    return this.present({ ...s, autoSync }, protectedBranch);
  }

  async close(auth: AuthInfo, sessionId: string, actor: Actor) {
    const s = await this.own(auth, sessionId);
    if (s.status === 'closed') return { ok: true };
    await this.ctx.db.transaction(async (tx) => {
      await tx.update(terminalSessions).set({ status: 'closed', closedAt: new Date() }).where(eq(terminalSessions.id, s.id));
      await tx.update(terminalCommands).set({ status: 'cancelled' }).where(and(eq(terminalCommands.sessionId, s.id), inArray(terminalCommands.status, ['queued', 'running'])));
      await enqueue(tx, { queue: QUEUES.terminal, type: 'terminal.close', organizationId: s.organizationId, projectId: s.projectId, payload: { sessionId: s.id } });
      await audit(tx, { organizationId: s.organizationId, projectId: s.projectId, actor, action: 'terminal.closed', resourceType: 'terminal_session', resourceId: s.id });
      await publish(tx, { type: 'terminal.updated', organizationId: s.organizationId, projectId: s.projectId, id: s.id });
    });
    return { ok: true };
  }

  private async present(s: typeof terminalSessions.$inferSelect, protectedBranch = false) {
    const commands = await this.ctx.db
      .select({
        id: terminalCommands.id,
        command: terminalCommands.command,
        status: terminalCommands.status,
        exitCode: terminalCommands.exitCode,
        output: sql<string>`right(${terminalCommands.output}, ${OUTPUT_IN_LIST})`,
        commitSha: terminalCommands.commitSha,
        syncNote: terminalCommands.syncNote,
        createdAt: terminalCommands.createdAt,
        startedAt: terminalCommands.startedAt,
        finishedAt: terminalCommands.finishedAt,
      })
      .from(terminalCommands)
      .where(eq(terminalCommands.sessionId, s.id))
      .orderBy(asc(terminalCommands.createdAt))
      .limit(200);
    return { id: s.id, projectId: s.projectId, branch: s.branch, protectedBranch, headCommit: s.headCommit, status: s.status, autoSync: protectedBranch ? false : s.autoSync, error: s.error, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt, commands: commands.slice(-40) };
  }
}
