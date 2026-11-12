#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { and, eq, isNull } from 'drizzle-orm';
import { createDatabase, projects, repositories, secrets } from '@projecthub/database';
import { audit } from '../activity.js';
import { loadConfig } from '../config.js';
import { parseDotenv } from '../dotenv.js';
import { GitRepository } from '../git.js';
import { readRepositoryEnv } from '../repo-env.js';
import { isSecretReadable, putSecret } from '../secrets.js';

/**
 * Operator tool: re-saves project secrets that no longer decrypt (stored under another APP_ENCRYPTION_KEY) from the
 * .env committed in the project's repository — the root or one app folder down, or the last version before removal.
 * Readable values are never touched, scope and kind are kept, and no value is printed. The change is audited.
 * Usage: pnpm secrets:repair --project <slug> [--dry-run]
 */
const { values: args } = parseArgs({ options: { project: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!args.project) {
  console.error('Usage: pnpm secrets:repair --project <slug> [--dry-run]');
  process.exit(1);
}

const config = loadConfig();
const handle = createDatabase(config.DATABASE_URL, { max: 2, applicationName: 'projecthub-secrets-cli' });
try {
  const project = (await handle.db.select().from(projects).where(eq(projects.slug, args.project)))[0];
  if (!project) throw new Error(`Proje bulunamadı: ${args.project}`);
  const repo = (await handle.db.select().from(repositories).where(eq(repositories.projectId, project.id)))[0];
  if (!repo) throw new Error('Projenin repository kaydı yok');
  const git = new GitRepository(path.resolve(config.storageDir, repo.storageKey), config.GIT_BINARY);
  const found = await readRepositoryEnv(git, project.defaultBranch);
  if (!found) throw new Error('Repoda ya da geçmişinde bir .env bulunamadı');
  const values = new Map(parseDotenv(found.text).entries.map((e) => [e.name, e.value]));

  const rows = await handle.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.projectId, project.id), isNull(secrets.environmentId), isNull(secrets.system)));
  const broken = rows.filter((r) => !isSecretReadable(config.encryptionKey, r));
  const repairable = broken.filter((r) => values.has(r.name));
  const missing = broken.filter((r) => !values.has(r.name)).map((r) => r.name);
  console.log(`Kaynak: ${found.paths.join(', ')} @ ${found.commit.slice(0, 7)}${found.removed ? ' (silinmeden önceki sürüm)' : ''}`);
  console.log(`Okunamayan: ${broken.length} · .env'den onarılabilir: ${repairable.length} · .env'de yok: ${missing.length}`);
  if (missing.length) console.log(`Elle kaydedilmesi gerekenler: ${missing.join(', ')}`);
  if (!args['dry-run'] && repairable.length) {
    await handle.db.transaction(async (tx) => {
      for (const r of repairable) {
        await putSecret(tx, config.encryptionKey, { organizationId: r.organizationId, projectId: project.id, environmentId: null, name: r.name, value: values.get(r.name)!, kind: r.kind, scope: r.scope, system: null, createdBy: r.createdBy });
      }
      await audit(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        actor: { type: 'system', id: null, label: 'secrets:repair (sunucu operatörü)' },
        action: 'secret.repaired',
        resourceType: 'project',
        resourceId: project.id,
        metadata: { names: repairable.map((r) => r.name), source: found.paths, commit: found.commit },
      });
    });
    console.log(`${repairable.length} değer yeniden şifrelendi.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await handle.close();
}
