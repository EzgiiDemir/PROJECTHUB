import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { inspectDeployment, main } from './deployment-preflight.mjs';

function fixture() {
  const password = randomBytes(24).toString('hex');
  const env = { NODE_ENV: 'production', COOKIE_SECURE: 'true', APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    APP_URL: 'https://hub.arucad.edu.tr', DATABASE_URL: `postgres://projecthub:${password}@postgres:5432/projecthub`,
    OLLAMA_MODEL: 'qwen3-coder:30b', SMTP_HOST: 'mail.arucad.edu.tr', SMTP_FROM: 'hub@arucad.edu.tr',
    BUILD_EXECUTOR: 'container', PREVIEW_EXECUTOR: 'container', ALLOW_HOST_BUILDS: 'false' };
  return { services: { postgres: { environment: { POSTGRES_PASSWORD: password } }, api: { environment: { ...env } },
    worker: { environment: { ...env }, healthcheck: { test: ['CMD', 'check-worker'] } }, web: {}, traefik: {}, ollama: {} } };
}

test('accepts configuration-only gates without claiming runtime readiness', () => assert.deepEqual(inspectDeployment(fixture()), []));
test('rejects legacy shared worker even when the opt-in is enabled', () => {
  const config = fixture(); Object.assign(config.services.worker.environment, { BUILD_EXECUTOR: 'host', ALLOW_HOST_BUILDS: 'true' });
  assert.match(inspectDeployment(config).join('\n'), /shared host execution/);
});
test('rejects unisolated previews independently of builds', () => {
  const config = fixture(); config.services.api.environment.PREVIEW_EXECUTOR = 'host';
  assert.match(inspectDeployment(config).join('\n'), /isolated container executors/);
});
test('rejects placeholder/weak keys and passwords without reflecting their values', () => {
  const config = fixture(); config.services.postgres.environment.POSTGRES_PASSWORD = 'my-sensitive-example.com';
  config.services.api.environment.APP_ENCRYPTION_KEY = 'private-invalid-key';
  const report = inspectDeployment(config).join('\n');
  assert.match(report, /password/); assert.match(report, /encryption key/);
  assert.doesNotMatch(report, /my-sensitive|private-invalid/);
});
test('rejects key mismatches, public database, privileged worker and daemon socket', () => {
  const config = fixture(); config.services.worker.environment.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  config.services.postgres.ports = [{ published: '5432', target: 5432 }]; config.services.worker.privileged = true;
  config.services.worker.volumes = [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', read_only: true }];
  const report = inspectDeployment(config).join('\n');
  for (const expected of [/keys must match/, /publish internal/, /privileged/, /daemon socket/]) assert.match(report, expected);
});
test('rejects wrong database target, insecure URL, wrong model and absent mail/liveness', () => {
  const config = fixture(); Object.assign(config.services.worker.environment, { DATABASE_URL: 'postgres://secret@external/business', APP_URL: 'http://localhost', OLLAMA_MODEL: 'old', SMTP_HOST: '' });
  delete config.services.worker.healthcheck;
  const report = inspectDeployment(config).join('\n');
  for (const expected of [/database connection/, /HTTPS/, /approved coding model/, /mail must/, /liveness/]) assert.match(report, expected);
  assert.doesNotMatch(report, /secret@external/);
});
test('array-style Compose environments remain checked', () => {
  const config = fixture(); config.services.api.environment = Object.entries(config.services.api.environment).map(([key, value]) => `${key}=${value}`);
  assert.deepEqual(inspectDeployment(config), []);
});

test('CLI suppresses secret-bearing Docker stdout/stderr and malformed JSON', () => {
  for (const result of [
    { status: 1, stdout: 'secret-output', stderr: 'secret-error' },
    { status: 0, stdout: '{secret-output', stderr: 'secret-error' },
    { error: new Error('secret-error'), stdout: 'secret-output', stderr: '' },
  ]) {
    const messages = []; const report = { log: (text) => messages.push(text), error: (text) => messages.push(text) };
    assert.equal(main(['explicit.env'], () => result, report), 1);
    assert.doesNotMatch(messages.join('\n'), /secret-output|secret-error/);
  }
});
test('CLI only renders config, never starts services, and requires an explicit env file', () => {
  const calls = []; const messages = [];
  const report = { log: (text) => messages.push(text), error: (text) => messages.push(text) };
  const execute = (binary, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(fixture()) }; };
  assert.equal(main([], execute, report), 2); assert.equal(calls.length, 0);
  assert.equal(main(['explicit.env'], execute, report), 0);
  assert.deepEqual(calls, [['compose', '-f', 'deploy/compose.yaml', '--env-file', 'explicit.env', 'config', '--format', 'json']]);
  assert.match(messages.join('\n'), /NOT release approval/);
});
