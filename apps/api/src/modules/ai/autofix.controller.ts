import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { AutofixService } from './autofix.service.js';

@Controller('projects/:id/autofix')
export class AutofixController {
  constructor(private readonly svc: AutofixService) {}

  /** What "Fix all with AI" would do now: fix tasks, their risk and whether they may merge themselves. */
  @Get('plan')
  plan(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.plan(a, id);
  }

  @Post()
  start(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.start(a, id, parse(z.object({ keys: z.array(z.string().max(600)).max(100).optional() }), body ?? {}), actor);
  }

  @Get()
  list(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.list(a, id);
  }

  @Post('approve-verified')
  approveVerified(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.svc.approveVerified(a, id, actor);
  }
}

/** The project assistant: ordered steps with explanations and one-click fixes. */
@Controller('projects/:id/assistant')
export class AssistantController {
  constructor(private readonly svc: AutofixService) {}

  @Get()
  get(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.assistant(a, id);
  }

  @Post('auto')
  auto(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.setAuto(a, id, parse(z.object({ enabled: z.boolean() }), body).enabled, actor);
  }
}

@Controller('ai/tasks/:taskId')
export class AutofixTaskController {
  constructor(private readonly svc: AutofixService) {}

  /** Re-run the verification build of a prepared fix (same commit), e.g. after the build machine was fixed. */
  @Post('reverify')
  reverify(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('taskId') taskId: string) {
    return this.svc.reverify(a, assertUuid(taskId, 'AI görevi'), actor);
  }
}

/** Security center: one click fixes every project's planned problems (each project's own plan and policies apply). */
@Controller('security/autofix')
export class SecurityAutofixController {
  constructor(private readonly svc: AutofixService) {}

  @Post()
  startAll(@Auth() a: AuthInfo, @CurrentActor() actor: Actor) {
    return this.svc.startAll(a, actor);
  }
}
