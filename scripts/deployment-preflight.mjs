import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const placeholder = /change[-_ ]?me|example\.(com|org)|localhost|replace[-_ ]?me/i;
const environment = (service) => Object.fromEntries(
  Array.isArray(service?.environment)
    ? service.environment.map((entry) => { const at = entry.indexOf('='); return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)]; })
    : Object.entries(service?.environment ?? {}),
);

/** Validate effective Compose configuration. Never include configuration values in diagnostics. */
export function inspectDeployment(config) {
  const errors = [];
  const services = config?.services ?? {};
  for (const name of ['postgres', 'api', 'worker', 'web', 'traefik', 'ollama']) {
    if (!services[name]) errors.push(`Missing required service: ${name}.`);
  }
  const postgres = environment(services.postgres);
  if (!/^[A-Za-z0-9_-]{24,}$/.test(postgres.POSTGRES_PASSWORD ?? '') || placeholder.test(postgres.POSTGRES_PASSWORD ?? '')) {
    errors.push('PostgreSQL needs a non-placeholder password of at least 24 URL-safe characters.');
  }
  for (const name of ['api', 'worker']) {
    const service = services[name];
    const env = environment(service);
    if (env.NODE_ENV !== 'production' || String(env.COOKIE_SECURE) !== 'true') errors.push(`${name}: production mode and secure cookies are required.`);
    const key = env.APP_ENCRYPTION_KEY ?? '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32 || new Set(Buffer.from(key, 'base64')).size < 8) {
      errors.push(`${name}: a persistent random 32-byte base64 encryption key is required.`);
    }
    let appUrl;
    try { appUrl = new URL(env.APP_URL); } catch { /* Redacted failure below. */ }
    if (!appUrl || appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || placeholder.test(appUrl.hostname)) errors.push(`${name}: a real HTTPS application domain is required.`);
    try {
      const database = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== 'postgres'
        || decodeURIComponent(database.password) !== postgres.POSTGRES_PASSWORD || database.pathname !== '/projecthub') throw new Error();
    } catch { errors.push(`${name}: database connection must target the configured PostgreSQL service and password.`); }
    if (env.OLLAMA_MODEL !== 'qwen3-coder:30b') errors.push(`${name}: the approved coding model is qwen3-coder:30b.`);
    if (!env.SMTP_HOST || !env.SMTP_FROM || placeholder.test(env.SMTP_HOST)) errors.push(`${name}: working invitation/notification mail must be configured and tested.`);
    if (env.BUILD_EXECUTOR !== 'container' || env.PREVIEW_EXECUTOR !== 'container' || String(env.ALLOW_HOST_BUILDS) === 'true') {
      errors.push(`${name}: project builds and previews require isolated container executors; shared host execution is not production-safe.`);
    }
    if (!service?.healthcheck || service.healthcheck.disable) {
      // API inherits its readiness check from the Dockerfile; worker needs an explicit liveness policy.
      if (name === 'worker') errors.push('worker: an explicit liveness health check is required.');
    }
  }
  const api = environment(services.api);
  const worker = environment(services.worker);
  if (api.APP_ENCRYPTION_KEY !== worker.APP_ENCRYPTION_KEY) errors.push('API and worker encryption keys must match.');
  for (const name of ['postgres', 'ollama', 'api', 'worker', 'web']) {
    if (services[name]?.ports?.length) errors.push(`${name}: do not publish internal service ports.`);
  }
  for (const [name, service] of Object.entries(services)) {
    if (service.privileged || service.network_mode === 'host' || service.pid === 'host') errors.push(`${name}: privileged or host namespace access is forbidden.`);
    if (name !== 'traefik' && (service.volumes ?? []).some((mount) => /docker\.sock|containerd\.sock/.test(typeof mount === 'string' ? mount : `${mount.source}:${mount.target}`))) {
      errors.push(`${name}: do not mount a host container daemon socket; use a dedicated constrained execution service.`);
    }
  }
  return errors;
}

export function main(args = process.argv.slice(2), execute = spawnSync, report = console) {
  // Never load a live environment implicitly or print Compose output (which contains credentials).
  if (args.length !== 1 || args[0].startsWith('-')) {
    report.error('Usage: node scripts/deployment-preflight.mjs <production-env-file>');
    return 2;
  }
  const result = execute(process.env.DOCKER_BINARY || 'docker', ['compose', '-f', 'deploy/compose.yaml', '--env-file', args[0], 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    report.error('Deployment blocked: Compose configuration could not be resolved. Check the file and required variables locally; raw output is withheld because it can contain secrets.');
    return 1;
  }
  let config;
  try { config = JSON.parse(result.stdout); } catch {
    report.error('Deployment blocked: invalid Compose configuration response (redacted).');
    return 1;
  }
  const errors = inspectDeployment(config);
  if (errors.length) {
    report.error(`Deployment blocked (${errors.length} configuration gates):\n${errors.map((error) => `- ${error}`).join('\n')}`);
    return 1;
  }
  report.log('Configuration gates passed. This is NOT release approval: verify exact-commit tests, scans, live model/mail checks, restore, staging and rollback evidence separately. No services were started.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
