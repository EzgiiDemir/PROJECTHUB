import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse, Public } from '../../infra/http.js';
import { TerminalService } from './terminal.service.js';
import { WorkspaceService } from './workspace.service.js';

const editorAccessSchema = z.object({
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30),
  embedToken: z.boolean().default(false),
});

@Controller()
export class WorkspaceController {
  constructor(private readonly svc: WorkspaceService) {}

  /** Creates a project-scoped Git token and the "open in…" links for desktop editors and the sync agent. */
  @Post('projects/:id/editor-access')
  editorAccess(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.editorAccess(a, id, parse(editorAccessSchema, body ?? {}), actor);
  }

  /** The sync agent script. Public on purpose: it contains no secrets and runs only with a token the user creates. */
  @Public()
  @Get('tools/projecthub-sync.mjs')
  async agent(@Res() res: Response) {
    res.type('text/javascript; charset=utf-8').setHeader('content-disposition', 'attachment; filename="projecthub-sync.mjs"');
    res.send(await this.svc.agentSource());
  }
}

const commandSchema = z.object({ command: z.string().trim().min(1, 'Komut boş olamaz').max(2000) });

/** Browser terminal (private per user; every command audited; commands run in a locked-down container). */
@Controller()
export class TerminalController {
  constructor(private readonly svc: TerminalService) {}

  @Get('projects/:id/terminal')
  current(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.current(a, id);
  }

  @Post('projects/:id/terminal')
  open(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.open(a, id, parse(z.object({ branch: z.string().trim().max(200).optional(), autoSync: z.boolean().default(true) }), body ?? {}), actor);
  }

  @Get('terminal/:sessionId')
  get(@Auth() a: AuthInfo, @Param('sessionId') sid: string) {
    return this.svc.get(a, assertUuid(sid, 'Terminal oturumu'));
  }

  @Post('terminal/:sessionId/commands')
  run(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('sessionId') sid: string, @Body() body: unknown) {
    return this.svc.run(a, assertUuid(sid, 'Terminal oturumu'), parse(commandSchema, body).command, actor);
  }

  @Post('terminal/:sessionId/commands/:commandId/cancel')
  cancel(@Auth() a: AuthInfo, @Param('sessionId') sid: string, @Param('commandId') cid: string) {
    return this.svc.cancel(a, assertUuid(sid, 'Terminal oturumu'), assertUuid(cid, 'Komut'));
  }

  @Post('terminal/:sessionId/auto-sync')
  autoSync(@Auth() a: AuthInfo, @Param('sessionId') sid: string, @Body() body: unknown) {
    return this.svc.setAutoSync(a, assertUuid(sid, 'Terminal oturumu'), parse(z.object({ autoSync: z.boolean() }), body).autoSync);
  }

  @Post('terminal/:sessionId/close')
  close(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('sessionId') sid: string) {
    return this.svc.close(a, assertUuid(sid, 'Terminal oturumu'), actor);
  }
}
