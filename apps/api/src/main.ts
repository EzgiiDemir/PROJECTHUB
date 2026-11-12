import { createLogger, loadConfig } from '@projecthub/core';
import { createPreviewGateway } from './modules/gateway/gateway.js';
import { createApiServer } from './server.js';

const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL);
const server = await createApiServer(config, { logger });
await server.app.listen(config.API_PORT, '0.0.0.0');
// Importing a very large project (extracting and detecting hundreds of thousands of files) can take longer than
// Node's default 5-minute request timeout.
server.app.getHttpServer().requestTimeout = 60 * 60_000;
logger.info({ port: config.API_PORT }, 'Project Hub API listening');
const gateway = createPreviewGateway(server.ctx);
gateway.listen(config.PREVIEW_PORT, '0.0.0.0', () => logger.info({ port: config.PREVIEW_PORT, domain: config.PREVIEW_BASE_DOMAIN }, 'Preview gateway listening'));

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    gateway.close();
    await server.close();
    process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal); });
}
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'projecthub.shutdown') void shutdown('development restart');
});
