#!/usr/bin/env node
/**
 * Coordinated backup of the hub itself: the database, every project's Git repository and a manifest tying them to the
 * encryption key that protects the stored Secrets. A backup is only worth something if it restores, so `verify`
 * restores the dump into a scratch database and checks every repository bundle.
 *
 *   pnpm backup:create [--out <dir>] [--with-artifacts] [--key-file <file>]
 *       → <dir>/hub-<timestamp>/{database.dump, repos/*.bundle, artifacts/…, manifest.json}
 *       --with-artifacts: the build artifacts of the versions environments run now (redeploy/rollback without a build)
 *       --key-file: APP_ENCRYPTION_KEY encrypted with BACKUP_KEY_PASSPHRASE (scrypt + AES-256-GCM), kept apart
 *   pnpm backup:verify <backup dir>      → checksums, every bundle cloned, full pg_restore into a scratch database
 *   pnpm backup:key-decrypt <key file>   → prints APP_ENCRYPTION_KEY=… for a restore (needs BACKUP_KEY_PASSPHRASE)
 *
 * The APP_ENCRYPTION_KEY is never written into the backup (whoever holds both could decrypt every secret); only its
 * fingerprint is, so a restore can check that the right key is configured. Keep the key in a password manager/vault.
 * Build artifacts, previews, logs and caches are not included: they are regenerated from the repositories.
 */
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { postgresToolConnection } from './postgres-tool.js';

const run = promisify(execFile);
const config = loadConfig();
const [command, arg1, arg2] = process.argv.slice(2);

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
const keyFingerprint = () => createHash('sha256').update(config.encryptionKey).digest('hex').slice(0, 16);
const pgRestoreBinary = () => {
  const dump = config.PG_DUMP_BINARY;
  const dir = path.dirname(dump);
  return dir === '.' ? 'pg_restore' : path.join(dir, path.basename(dump).replace(/pg_dump/i, 'pg_restore'));
};

interface Manifest {
  createdAt: string;
  database: { file: string; sha256: string; bytes: number; name: string };
  repositories: { file: string; sha256: string; bytes: number; refs: number }[];
  artifacts?: { dir: string; storageKey: string; files: number; bytes: number; environments: string[] }[];
  encryptionKeyFingerprint: string;
  notes: string[];
}

async function filesIn(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files += 1;
    bytes += (await fs.promises.stat(path.join(e.parentPath, e.name))).size;
  }
  return { files, bytes };
}

/** Artifacts of the versions the environments run now: what a rollback or redeploy needs without rebuilding. */
async function backupArtifacts(dir: string): Promise<NonNullable<Manifest['artifacts']>> {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const rows = (
    await client.query(`SELECT a.storage_key, array_agg(DISTINCT p.slug || '/' || e.name) AS envs
      FROM environments e JOIN versions v ON v.id = e.current_version_id JOIN artifacts a ON a.build_id = v.build_id
      JOIN projects p ON p.id = e.project_id GROUP BY a.storage_key`)
  ).rows as { storage_key: string; envs: string[] }[];
  await client.end();
  const out: NonNullable<Manifest['artifacts']> = [];
  for (const r of rows) {
    const src = path.join(config.storageDir, r.storage_key);
    if (!fs.existsSync(src)) continue;
    const rel = `artifacts/${r.storage_key.replace(/[\\/]+/g, '_')}`;
    console.log(`Artifact: ${r.storage_key} (${r.envs.join(', ')})`);
    await fs.promises.cp(src, path.join(dir, rel), { recursive: true, verbatimSymlinks: true });
    out.push({ dir: rel, storageKey: r.storage_key, environments: r.envs, ...(await filesIn(path.join(dir, rel))) });
  }
  return out;
}

/** The encryption key, encrypted with a passphrase, for a vault: never stored next to the backup in plain form. */
function writeKeyFile(file: string) {
  const passphrase = process.env.BACKUP_KEY_PASSPHRASE ?? '';
  if (passphrase.length < 12) throw new Error('BACKUP_KEY_PASSPHRASE en az 12 karakter olmalı (anahtar dosyasını şifreler).');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(config.encryptionKey), cipher.final()]);
  const body = { kind: 'projecthub-encryption-key', kdf: 'scrypt-N32768-r8-p1', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), fingerprint: keyFingerprint() };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  console.log(`Şifreli anahtar dosyası: ${file} (parmak izi ${body.fingerprint}). Yedekten AYRI bir yerde saklayın.`);
}

function decryptKeyFile(file: string): string {
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { salt: string; iv: string; tag: string; ciphertext: string };
  const kek = scryptSync(process.env.BACKUP_KEY_PASSPHRASE ?? '', Buffer.from(body.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(body.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(body.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body.ciphertext, 'base64')), decipher.final()]).toString('base64');
}

async function create(outDir: string, opts: { withArtifacts: boolean; keyFile?: string }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(outDir, `hub-${stamp}`);
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  const dbName = new URL(config.DATABASE_URL).pathname.slice(1);

  console.log(`Veritabanı yedekleniyor (${dbName})…`);
  const dumpFile = path.join(dir, 'database.dump');
  const dumpConnection = postgresToolConnection(config.DATABASE_URL);
  await run(config.PG_DUMP_BINARY, ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpFile}`, dumpConnection.connectionString], { env: dumpConnection.env, maxBuffer: 64 * 1024 * 1024 });

  const reposDir = path.join(config.storageDir, 'repos');
  const repos = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((n) => n.endsWith('.git')) : [];
  const repositories: Manifest['repositories'] = [];
  for (const name of repos) {
    const gitDir = path.join(reposDir, name);
    const refs = (await run(config.GIT_BINARY, ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)'])).stdout.split('\n').filter(Boolean).length;
    if (!refs) continue; // an empty repository has nothing to bundle
    const file = path.join(dir, 'repos', name.replace(/\.git$/, '.bundle'));
    console.log(`Repo: ${name} (${refs} ref)`);
    await run(config.GIT_BINARY, ['--git-dir', gitDir, 'bundle', 'create', file, '--all'], { maxBuffer: 16 * 1024 * 1024 });
    repositories.push({ file: path.relative(dir, file).replace(/\\/g, '/'), sha256: await sha256File(file), bytes: fs.statSync(file).size, refs });
  }

  const artifacts = opts.withArtifacts ? await backupArtifacts(dir) : undefined;
  if (opts.keyFile) writeKeyFile(path.resolve(opts.keyFile));

  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    database: { file: 'database.dump', sha256: await sha256File(dumpFile), bytes: fs.statSync(dumpFile).size, name: dbName },
    repositories,
    ...(artifacts ? { artifacts } : {}),
    encryptionKeyFingerprint: keyFingerprint(),
    notes: [
      'APP_ENCRYPTION_KEY bu yedekte YOK. Anahtar olmadan yedekteki Secrets değerleri çözülemez; anahtarı ayrı ve güvenli bir yerde saklayın.',
      "Build artifact'ları, ön izlemeler, loglar ve önbellekler dahil değildir; repolardan yeniden üretilir.",
    ],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nYedek hazır: ${dir}\n  veritabanı ${(manifest.database.bytes / 1024 / 1024).toFixed(1)} MB · ${repositories.length} repo · anahtar parmak izi ${manifest.encryptionKeyFingerprint}`);
  console.log('Doğrulamak için: pnpm backup:verify "' + dir + '"');
  return dir;
}

async function verify(dir: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const problems: string[] = [];
  for (const f of [{ file: manifest.database.file, sha256: manifest.database.sha256 }, ...manifest.repositories]) {
    if ((await sha256File(path.join(dir, f.file)).catch(() => 'missing')) !== f.sha256) problems.push(`Bozuk veya eksik dosya: ${f.file}`);
  }
  // Each repository is really restored: cloned from its bundle into a scratch directory, all refs present.
  // A short scratch path: a bundle's pack under a deep folder exceeds Windows' 260-character MAX_PATH.
  const scratchRepos = fs.mkdtempSync(path.join(os.tmpdir(), 'phr-'));
  try {
    for (const r of manifest.repositories) {
      const restore = (attempt: number) => {
        // Windows antivirus/indexers briefly lock a just-written pack ("unable to rename temporary '*.pack' file").
        const target = path.join(scratchRepos, `r${manifest.repositories.indexOf(r)}-${attempt}`);
        return run(config.GIT_BINARY, ['-c', 'core.longpaths=true', 'clone', '--mirror', '--quiet', path.join(dir, r.file), target], { maxBuffer: 16 * 1024 * 1024 })
          .then(() => run(config.GIT_BINARY, ['--git-dir', target, 'for-each-ref', '--format=%(refname)']))
          .then((o) => o.stdout.split('\n').filter(Boolean).length);
      };
      let refs: number | string = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        refs = await restore(attempt).catch((e: Error & { stderr?: string }) => (e.stderr || e.message).trim().split('\n').slice(-2).join(' '));
        if (typeof refs === 'number') break;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
      if (typeof refs === 'string') problems.push(`Git deposu paketten geri yüklenemedi: ${r.file} (${refs})`);
      else if (refs < r.refs) problems.push(`Geri yüklenen ${r.file} eksik: ${refs}/${r.refs} ref`);
    }
    console.log(`Repo geri yükleme testi: ${manifest.repositories.length} repo paketten klonlandı.`);
  } finally {
    fs.rmSync(scratchRepos, { recursive: true, force: true, maxRetries: 5 });
  }
  for (const a of manifest.artifacts ?? []) {
    const now = await filesIn(path.join(dir, a.dir)).catch(() => ({ files: -1, bytes: -1 }));
    if (now.files !== a.files || now.bytes !== a.bytes) problems.push(`Artifact eksik veya değişmiş: ${a.storageKey} (${now.files}/${a.files} dosya)`);
  }
  if (manifest.artifacts?.length) console.log(`Artifact kontrolü: ${manifest.artifacts.length} artifact eksiksiz.`);
  if (manifest.encryptionKeyFingerprint !== keyFingerprint()) problems.push('Bu sunucudaki APP_ENCRYPTION_KEY yedeğin anahtarıyla aynı değil: geri yüklenen Secrets çözülemez.');

  // The real test: restore the dump into a scratch database and read it.
  const scratch = `projecthub_restore_check_${Date.now()}`;
  const admin = new URL(config.DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${scratch}" TEMPLATE template0 ENCODING 'UTF8'`);
    const target = new URL(config.DATABASE_URL);
    target.pathname = `/${scratch}`;
    const restoreConnection = postgresToolConnection(target.href);
    await run(pgRestoreBinary(), ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${restoreConnection.connectionString}`, path.join(dir, manifest.database.file)], { env: restoreConnection.env, maxBuffer: 64 * 1024 * 1024 });
    const check = new pg.Client({ connectionString: target.href });
    await check.connect();
    const counts = (await check.query('SELECT (SELECT count(*) FROM organizations)::int AS orgs, (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM projects)::int AS projects')).rows[0] as { orgs: number; users: number; projects: number };
    await check.end();
    console.log(`Geri yükleme testi: ${counts.orgs} kurum, ${counts.users} kullanıcı, ${counts.projects} proje okundu.`);
    if (!counts.orgs) problems.push('Geri yüklenen veritabanında kurum yok.');
  } catch (e) {
    problems.push(`Veritabanı geri yüklenemedi: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await client.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => undefined);
    await client.end();
  }
  if (problems.length) {
    console.error(`\nYEDEK GEÇERSİZ:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log(`\nYedek doğrulandı: ${manifest.repositories.length} repo, veritabanı geri yüklenebiliyor (${manifest.createdAt}).`);
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
if (command === 'create') {
  await create(flag('--out') ?? path.resolve(config.storageDir, '..', 'hub-backups'), { withArtifacts: process.argv.includes('--with-artifacts'), keyFile: flag('--key-file') });
} else if (command === 'verify' && arg1) {
  await verify(path.resolve(arg1));
} else if (command === 'key-decrypt' && arg1) {
  console.log(`APP_ENCRYPTION_KEY=${decryptKeyFile(path.resolve(arg1))}`);
} else {
  console.error('Kullanım: pnpm backup:create [--out <klasör>] [--with-artifacts] [--key-file <dosya>]  |  pnpm backup:verify <yedek klasörü>  |  pnpm backup:key-decrypt <anahtar dosyası>');
  process.exitCode = 1;
}
