import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  addProjectMemberSchema,
  archiveProjectSchema,
  createProjectSchema,
  featureFlagOverrideSchema,
  featureFlagSchema,
  projectListQuerySchema,
  updateProjectSchema,
} from '@projecthub/contracts';
import { AppError, PROJECT_TEMPLATES, type Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse, RequirePermission } from '../../infra/http.js';
import { ProjectsService } from './projects.service.js';
import { UploadsService } from './uploads.service.js';

@Controller()
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly uploads: UploadsService,
  ) {}

  /** Starter templates offered by the project wizard (spec §129). */
  @Get('project-templates')
  templates() {
    return Object.values(PROJECT_TEMPLATES).map(({ files: _files, ...t }) => t);
  }

  @Get('projects')
  list(@Auth() a: AuthInfo, @Query() q: unknown) {
    return this.projects.list(a, parse(projectListQuerySchema, q));
  }

  @Post('projects')
  @RequirePermission('project.create')
  create(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.projects.create(a, parse(createProjectSchema, body), actor);
  }

  /** Raw ZIP upload for Smart Import: Content-Type application/zip, file name in X-File-Name. */
  @Post('uploads')
  @RequirePermission('project.create')
  upload(@Auth() a: AuthInfo, @Req() req: Request) {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/(zip|x-zip-compressed|octet-stream)/.test(type)) {
      throw new AppError('VALIDATION_ERROR', 'ZIP dosyası bekleniyor (Content-Type: application/zip)');
    }
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'proje.zip')).replace(/[\\/]/g, '_');
    return this.uploads.receive(a, req, name);
  }

  /** Large projects: start, append parts in order (raw body, X-Upload-Offset), then complete. */
  @Post('uploads/chunked')
  @RequirePermission('project.create')
  uploadStart(@Auth() a: AuthInfo) {
    return this.uploads.startChunked(a);
  }

  @Put('uploads/:id/chunk')
  @RequirePermission('project.create')
  uploadChunk(@Auth() a: AuthInfo, @Param('id') id: string, @Req() req: Request) {
    const offset = Number(req.headers['x-upload-offset']);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('VALIDATION_ERROR', 'X-Upload-Offset başlığı gerekli');
    return this.uploads.appendChunk(a, assertUuid(id, 'Yükleme'), offset, req, Number(req.headers['x-upload-volume'] ?? 0));
  }

  @Get('uploads/:id/result')
  @RequirePermission('project.create')
  uploadResult(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.uploads.result(a, assertUuid(id, 'Yükleme'));
  }

  @Post('uploads/:id/complete')
  @RequirePermission('project.create')
  uploadComplete(@Auth() a: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    const { fileName } = parse(z.object({ fileName: z.string().trim().min(1).max(255) }), body);
    return this.uploads.completeChunked(a, assertUuid(id, 'Yükleme'), fileName.replace(/[\\/]/g, '_'));
  }

  @Get('projects/:id')
  get(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.get(a, id);
  }

  @Get('projects/:id/overview')
  overview(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.overview(a, id);
  }

  @Get('projects/:id/intelligence')
  intelligence(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.intelligence(a, id);
  }

  @Get('projects/:id/feature-flags')
  featureFlags(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.featureFlags(a, id);
  }

  @Post('projects/:id/feature-flags')
  createFeatureFlag(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.createFeatureFlag(a, id, parse(featureFlagSchema, body), actor);
  }

  @Patch('feature-flags/:flagId')
  updateFeatureFlag(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('flagId') flagId: string, @Body() body: unknown) {
    const input = parse(featureFlagSchema.partial().extend({ status: z.enum(['active', 'archived']).optional() }), body);
    return this.projects.updateFeatureFlag(a, assertUuid(flagId, 'Feature flag'), input, actor);
  }

  @Put('feature-flags/:flagId/override')
  setFeatureFlagOverride(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('flagId') flagId: string, @Body() body: unknown) {
    return this.projects.setFeatureFlagOverride(a, assertUuid(flagId, 'Feature flag'), parse(featureFlagOverrideSchema, body), actor);
  }

  @Get('projects/:id/feature-flags/evaluate')
  evaluateFeatureFlag(@Auth() a: AuthInfo, @Param('id') id: string, @Query() query: unknown) {
    const q = parse(z.object({ key: z.string().min(2).max(100), environmentId: z.uuid().optional(), subject: z.string().max(500).optional(), attributes: z.string().max(5000).optional() }), query);
    let attributes: Record<string, string> = {};
    if (q.attributes) {
      try { attributes = z.record(z.string(), z.string()).parse(JSON.parse(q.attributes)); } catch { throw new AppError('VALIDATION_ERROR', 'attributes geçerli bir JSON nesnesi olmalı'); }
    }
    return this.projects.evaluateFeatureFlag(a, id, q.key, q.environmentId, q.subject, attributes);
  }

  @Patch('projects/:id')
  update(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.update(a, id, parse(updateProjectSchema, body), actor);
  }

  @Post('projects/:id/archive')
  archive(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.archive(a, id, parse(archiveProjectSchema, body).confirmSlug, actor);
  }

  @Post('projects/:id/unarchive')
  unarchive(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.projects.unarchive(a, id, actor);
  }

  @Get('projects/:id/members')
  members(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.members(a, id);
  }

  @Post('projects/:id/members')
  addMember(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.addMember(a, id, parse(addProjectMemberSchema, body), actor);
  }

  @Delete('projects/:id/members/:userId')
  removeMember(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('userId') userId: string) {
    return this.projects.removeMember(a, id, assertUuid(userId, 'Kullanıcı'), actor);
  }

  @Get('projects/:id/manifest')
  manifest(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.manifest(a, id);
  }

  @Put('projects/:id/manifest')
  saveManifest(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ yaml: z.string().min(1).max(100_000), commit: z.boolean().default(true) }), body);
    return this.projects.saveManifest(a, id, input.yaml, input.commit, actor);
  }

  @Post('projects/:id/detect')
  detect(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.projects.redetect(a, id, actor);
  }

  @Post('projects/:id/sync')
  sync(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.projects.syncUpstream(a, id, actor);
  }

  @Get('projects/:id/timeline')
  timeline(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const query = parse(z.object({ kind: z.string().max(20).optional(), cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), q);
    return this.projects.timeline(a, id, query);
  }
}
