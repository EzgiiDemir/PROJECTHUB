#!/usr/bin/env node
// Project Hub Sync — keeps a folder on this computer and a Project Hub repository in step, both ways.
//
//   PH_TOKEN=<editor token> node projecthub-sync.mjs --url <clone URL> --user <e-mail> [--dir <folder>] [--branch <name>]
//
// Requires Node.js 20+ and Git. No other dependencies. The token is never written to disk: every Git command gets it
// as a one-off HTTP header. Local edits are committed and pushed a moment after you save; changes pushed from
// anywhere else (the web editor, a teammate, a terminal session, an AI merge) are pulled within a few seconds.
// On a conflict nothing is overwritten: your commits are pushed to a separate branch and syncing pauses.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    user: { type: 'string' },
    token: { type: 'string' },
    dir: { type: 'string' },
    branch: { type: 'string' },
    interval: { type: 'string', default: '4' },
    once: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help || !opts.url || !opts.user) {
  console.log('Kullanım: PH_TOKEN=<token> node projecthub-sync.mjs --url <klon adresi> --user <e-posta> [--dir <klasör>] [--branch <branch>] [--interval <sn>]');
  process.exit(opts.help ? 0 : 2);
}
const token = process.env.PH_TOKEN || opts.token;
if (!token) {
  console.error('PH_TOKEN ortam değişkeni (veya --token) gerekli.');
  process.exit(2);
}

const url = opts.url.replace(/\/$/, '');
const dir = path.resolve(opts.dir ?? path.basename(url).replace(/\.git$/, ''));
const intervalMs = Math.max(2, Number(opts.interval) || 4) * 1000;
const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30) || 'pc';
const auth = ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${opts.user}:${token}`).toString('base64')}`];
// Kept out of commits even when the project has no .gitignore. Only affects untracked files.
const DEFAULT_EXCLUDES = ['node_modules/', 'vendor/', '.venv/', '__pycache__/', '.next/', 'dist/', 'build/', '.DS_Store', 'Thumbs.db', '.env', '.env.*', '!.env.example'];

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`);
const git = (args, { withAuth = false, cwd = dir } = {}) => run('git', [...(withAuth ? auth : []), ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).then((r) => r.stdout.trim());
const tryGit = (args, o) => git(args, o).then((out) => ({ ok: true, out }), (e) => ({ ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message }));

let branch = opts.branch;
let paused = false;
let busy = false;

async function setup() {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} boş değil ve bir Git deposu değil. Boş bir klasör seçin.`);
    log(`Klonlanıyor → ${dir}`);
    await git(['clone', '--quiet', ...(branch ? ['--branch', branch] : []), url, dir], { withAuth: true, cwd: process.cwd() });
  } else {
    const remote = await tryGit(['remote', 'get-url', 'origin']);
    if (!remote.ok) await git(['remote', 'add', 'origin', url]);
    else if (remote.out.replace(/\/$/, '') !== url) throw new Error(`Bu klasörün origin adresi farklı (${remote.out}). Başka bir klasör seçin.`);
  }
  branch ??= (await git(['rev-parse', '--abbrev-ref', 'HEAD'])) || 'main';
  const info = path.join(dir, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  const excludeFile = path.join(info, 'exclude');
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  if (!current.includes('# projecthub-sync')) fs.appendFileSync(excludeFile, `\n# projecthub-sync\n${DEFAULT_EXCLUDES.join('\n')}\n`);
  if (!(await tryGit(['config', 'user.email'])).ok) await git(['config', 'user.email', opts.user]);
  if (!(await tryGit(['config', 'user.name'])).ok) await git(['config', 'user.name', opts.user.split('@')[0]]);
  log(`Senkronizasyon hazır: ${dir} ⇄ ${branch}`);
}

/** Commits local edits and pushes them; on a rejected push, rebases onto the remote first. */
async function pushLocal() {
  const status = await git(['status', '--porcelain']);
  if (status) {
    const n = status.split('\n').length;
    await git(['add', '-A']);
    await git(['commit', '--quiet', '-m', `Sync: ${n} dosya (${host})`]);
    log(`Yerel değişiklik kaydedildi: ${n} dosya`);
  }
  const ahead = Number(await git(['rev-list', '--count', `origin/${branch}..HEAD`]).catch(() => '1'));
  if (!ahead) return;
  let push = await tryGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { withAuth: true });
  if (!push.ok && /rejected|non-fast-forward|fetch first/i.test(push.out)) {
    await pullRemote(true);
    if (paused) return;
    push = await tryGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { withAuth: true });
  }
  if (!push.ok) {
    paused = true;
    log(`Gönderilemedi, senkronizasyon duraklatıldı: ${push.out.split('\n').slice(-3).join(' ')}`);
    if (/korumal|protected/i.test(push.out)) log(`"${branch}" korumalı. Başka bir branch ile çalıştırın: --branch calisma/${host}`);
    return;
  }
  log(`Gönderildi → ${branch} (${(await git(['rev-parse', '--short', 'HEAD']))})`);
}

/** Brings remote commits in. Local commits are rebased on top; a conflict never overwrites anything. */
async function pullRemote(force = false) {
  const remote = await tryGit(['ls-remote', 'origin', `refs/heads/${branch}`], { withAuth: true });
  if (!remote.ok) return log(`Sunucuya ulaşılamadı: ${remote.out.split('\n')[0]}`);
  const sha = remote.out.split(/\s/)[0];
  if (!sha) return;
  const known = await tryGit(['rev-parse', `origin/${branch}`]);
  if (!force && known.ok && known.out === sha) return;
  await git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { withAuth: true });
  if ((await git(['status', '--porcelain'])) !== '') await pushLocalCommitOnly();
  const rebase = await tryGit(['rebase', '--quiet', `origin/${branch}`]);
  if (!rebase.ok) {
    await tryGit(['rebase', '--abort']);
    const safety = `sync-cakisma/${host}-${Date.now().toString(36)}`;
    await tryGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${safety}`], { withAuth: true });
    paused = true;
    log(`ÇAKIŞMA: aynı dosyalar iki yerde değişti. Sizin değişiklikleriniz "${safety}" branch'ine gönderildi, klasörünüz olduğu gibi duruyor.`);
    log('Project Hub > Git ekranından iki branch\'i birleştirin, sonra bu aracı yeniden başlatın.');
    return;
  }
  log(`Güncellendi ← ${branch} (${sha.slice(0, 7)})`);
}

async function pushLocalCommitOnly() {
  await git(['add', '-A']);
  await git(['commit', '--quiet', '-m', `Sync: yerel değişiklikler (${host})`]);
}

async function cycle(kind) {
  if (busy || paused) return;
  busy = true;
  try {
    if (kind === 'local') await pushLocal();
    else {
      await pullRemote();
      if (!paused) await pushLocal();
    }
  } catch (e) {
    log(`Hata: ${String(e.stderr || e.message).split('\n')[0]}`);
  } finally {
    busy = false;
  }
}

try {
  await setup();
} catch (e) {
  console.error(String(e.stderr || e.message));
  process.exit(1);
}
await cycle('remote');
if (opts.once) process.exit(paused ? 3 : 0);

let timer = null;
fs.watch(dir, { recursive: true }, (_event, file) => {
  const f = String(file ?? '').replaceAll('\\', '/');
  if (!f || f === '.git' || f.startsWith('.git/') || /(^|\/)(node_modules|\.next|dist|build|vendor|\.venv)\//.test(f)) return;
  clearTimeout(timer);
  timer = setTimeout(() => void cycle('local'), 1500);
});
setInterval(() => void cycle('remote'), intervalMs);
log(`Değişiklikler izleniyor (uzak kontrol: ${intervalMs / 1000} sn). Durdurmak için Ctrl+C.`);
