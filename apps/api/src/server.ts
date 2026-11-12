import 'reflect-metadata';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger, Storage, type AppConfig, type Logger } from '@projecthub/core';
import { auditEvents, createDatabase, migrateDatabase, type DatabaseHandle } from '@projecthub/database';
import { AppModule } from './app.module.js';
import { Ctx } from './infra/context.js';
import { ApiExceptionFilter, EnvelopeInterceptor, requestIdMiddleware, securityHeaders } from './infra/http.js';
import { RealtimeHub } from './infra/realtime.js';
import { gitHttpMiddleware } from './modules/repository/git-http.js';

export interface ApiServer {
  app: INestApplication;
  ctx: Ctx;
  handle: DatabaseHandle;
  close(): Promise<void>;
}

/** Builds the API application (used by main.ts and by integration tests). */
export async function createApiServer(config: AppConfig, opts: { logger?: Logger; migrate?: boolean } = {}): Promise<ApiServer> {
  const logger = opts.logger ?? createLogger('api', config.LOG_LEVEL);
  const handle = createDatabase(config.DATABASE_URL, { max: 15, applicationName: 'projecthub-api' });
  if (opts.migrate !== false) await migrateDatabase(handle.db);
  const storage = new Storage(config.storageDir);
  await storage.init();
  const ctx = new Ctx(config, handle.db, handle.pool, storage, logger);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(ctx), {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  const express = app.getHttpAdapter().getInstance();
  express.set('trust proxy', 'loopback, linklocal, uniquelocal');
  express.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(gitHttpMiddleware(app));
  app.use(securityHeaders);
  app.useBodyParser('json', { limit: '30mb' });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health/{*path}', method: RequestMethod.ALL }] });
  app.useGlobalFilters(
    new ApiExceptionFilter(logger, (e) => {
      if (!e.organizationId) return;
      void handle.db
        .insert(auditEvents)
        .values({ organizationId: e.organizationId, actorType: 'system', actorId: e.userId, actorLabel: e.userLabel ?? 'System', action: 'system.error', resourceType: 'request', resourceId: e.requestId, metadata: { method: e.method, path: e.path, message: e.message, stack: e.stack } })
        .catch((err: unknown) => logger.warn({ err }, 'could not record unhandled error'));
    }),
  );
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.enableShutdownHooks();
  await app.get(RealtimeHub).start();

  return {
    app,
    ctx,
    handle,
    async close() {
      await app.close();
      await handle.close();
    },
  };
}
