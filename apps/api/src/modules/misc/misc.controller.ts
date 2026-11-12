import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { searchQuerySchema } from '@projecthub/contracts';
import { getProjectAccess, type Actor } from '@projecthub/core';
import { eventRecords } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { openSse, RealtimeHub } from '../../infra/realtime.js';
import { MiscService } from './misc.service.js';

@Controller()
export class MiscController {
  constructor(
    private readonly svc: MiscService,
    private readonly hub: RealtimeHub,
    private readonly ctx: Ctx,
  ) {}

  /**
   * Realtime channel for the web app (spec §127). Events are filtered per connection: same organization,
   * projects the user can see, and user-targeted notifications only for that user.
   */
  @Get('stream')
  async stream(@Auth() a: AuthInfo, @Req() req: Request, @Res() res: Response) {
    const visible = new Map<string, { ok: boolean; at: number }>();
    const canSee = async (projectId: string) => {
      const hit = visible.get(projectId);
      if (hit && Date.now() - hit.at < 60_000) return hit.ok;
      const access = await getProjectAccess(this.ctx.db, { organizationId: a.organizationId, userId: a.user.id, projectId, orgPermissions: a.orgPermissions });
      visible.set(projectId, { ok: access.canSee, at: Date.now() });
      return access.canSee;
    };
    let unsubscribe: () => void = () => undefined;
    const send = openSse(res, () => unsubscribe());
    send('ready', { userId: a.user.id });
    const deliver = async (e: { type: string; organizationId?: string; projectId?: string; id?: string; data?: Record<string, unknown> }) => {
      if (e.organizationId && e.organizationId !== a.organizationId) return;
      const target = (e.data as { userId?: string } | undefined)?.userId;
      if (e.type === 'notification') {
        if (target === a.user.id) send('notification', e.data);
        return;
      }
      if (e.projectId && !(await canSee(e.projectId))) return;
      // Payloads stay server-side except an allow-listed, non-sensitive summary of repository changes
      // (so open editors can tell who changed which branch).
      const d = e.type === 'repository.updated' ? (e.data as Record<string, unknown> | undefined) : undefined;
      const data = d ? { branch: d.branch, sha: d.sha, message: d.message, actor: d.actor, actorId: d.actorId, files: d.files } : undefined;
      const sequence = e.type === 'domain.event' && typeof e.data?.sequence === 'number' ? e.data.sequence : undefined;
      const domain = e.type === 'domain.event' ? { eventType: e.data?.eventType } : undefined;
      send('event', { type: e.type, projectId: e.projectId, id: e.id, ...(data ? { data } : {}), ...(domain ? { data: domain } : {}) }, sequence);
    };

    // Subscribe before replaying so an event committed during the query cannot fall into the gap.
    let replaying = true;
    const buffered: Parameters<typeof deliver>[0][] = [];
    unsubscribe = this.hub.subscribe(async (e) => {
      if (replaying && e.type === 'domain.event') {
        buffered.push(e);
        return;
      }
      await deliver(e);
    });

    const rawLast = req.headers['last-event-id'];
    const last = Number(Array.isArray(rawLast) ? rawLast[0] : rawLast ?? 0);
    let highWater = Number.isSafeInteger(last) && last > 0 ? last : 0;
    if (highWater) {
      const missed = await this.ctx.db
        .select({ id: eventRecords.id, sequence: eventRecords.sequence, projectId: eventRecords.projectId, eventType: eventRecords.eventType, occurredAt: eventRecords.occurredAt })
        .from(eventRecords)
        .where(and(eq(eventRecords.organizationId, a.organizationId), gt(eventRecords.sequence, highWater)))
        .orderBy(asc(eventRecords.sequence))
        .limit(500);
      for (const e of missed) {
        if (e.projectId && !(await canSee(e.projectId))) continue;
        highWater = Math.max(highWater, e.sequence);
        send('event', { type: 'domain.event', projectId: e.projectId ?? undefined, id: e.id, data: { eventType: e.eventType, occurredAt: e.occurredAt, replayed: true } }, e.sequence);
      }
    }
    replaying = false;
    for (const e of buffered.sort((a, b) => Number(a.data?.sequence ?? 0) - Number(b.data?.sequence ?? 0))) {
      const sequence = Number(e.data?.sequence ?? 0);
      if (!sequence || sequence > highWater) await deliver(e);
    }
  }

  @Get('notifications')
  notifications(@Auth() a: AuthInfo) {
    return this.svc.notifications(a);
  }

  @Post('notifications/read')
  async read(@Auth() a: AuthInfo, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(200).nullable().default(null) }), body);
    await this.svc.markRead(a, ids);
    return { ok: true };
  }

  @Get('home')
  home(@Auth() a: AuthInfo) {
    return this.svc.home(a);
  }

  @Get('search')
  search(@Auth() a: AuthInfo, @Query() q: unknown) {
    const query = parse(searchQuerySchema, q);
    return this.svc.search(a, query.q, query.limit);
  }

  @Get('projects/:id/incidents')
  incidents(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.incidents(a, id);
  }

  @Post('projects/:id/incidents')
  openIncident(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ title: z.string().trim().min(3).max(300), severity: z.enum(['critical', 'high', 'medium', 'low']), environmentId: z.uuid().nullable().optional() }), body);
    return this.svc.openIncident(a, id, input, actor);
  }

  @Get('incidents/:incidentId')
  incident(@Auth() a: AuthInfo, @Param('incidentId') incidentId: string) {
    return this.svc.incident(a, assertUuid(incidentId, 'Olay'));
  }

  @Patch('incidents/:incidentId')
  updateIncident(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('incidentId') incidentId: string, @Body() body: unknown) {
    const input = parse(z.object({ status: z.enum(['open', 'resolved']).optional(), rootCause: z.string().max(5000).optional(), postmortem: z.string().max(50000).optional() }), body);
    return this.svc.updateIncident(a, assertUuid(incidentId, 'Olay'), input, actor);
  }

  @Post('incidents/:incidentId/postmortem-draft')
  postmortem(@Auth() a: AuthInfo, @Param('incidentId') incidentId: string) {
    return this.svc.draftPostmortem(a, assertUuid(incidentId, 'Olay'));
  }

  @Post('incidents/:incidentId/remediations')
  remediation(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('incidentId') incidentId: string) {
    return this.svc.requestRemediation(a, assertUuid(incidentId, 'Olay'), actor);
  }

  @Get('projects/:id/environments/:envId/health-checks')
  health(@Auth() a: AuthInfo, @Param('id') id: string, @Param('envId') envId: string) {
    return this.svc.healthChecks(a, id, assertUuid(envId, 'Ortam'));
  }
}
