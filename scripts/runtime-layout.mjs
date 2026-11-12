import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(sourceRoot, '.env'))) process.loadEnvFile(path.join(sourceRoot, '.env'));
const runtimeRoot = path.resolve(sourceRoot, process.env.PROJECTHUB_RUNTIME_DIR ?? path.join('..', 'PROJECTHUB_RUNTIME'));
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
const rel = path.relative(sourceRoot, runtimeRoot);

if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  throw new Error(`Runtime dizini kaynak kodun dışında olmalı: ${runtimeRoot}`);
}

const legacyData = path.join(sourceRoot, '.data');
const legacyScratch = path.join(sourceRoot, '.tmp');
const rootLogs = fs.readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.log(?:\..+)?$/i.test(entry.name))
  .map((entry) => path.join(sourceRoot, entry.name));

if (mode === 'check') {
  const legacy = [legacyData, legacyScratch, ...rootLogs].filter(fs.existsSync);
  if (legacy.length) {
    console.error('Kaynak dizinde runtime/geçici veri bulundu:');
    for (const item of legacy) console.error(`  - ${path.relative(sourceRoot, item)}`);
    console.error('Taşımak için: pnpm runtime:migrate');
    process.exitCode = 1;
  } else {
    console.log(`Kaynak/runtime sınırı temiz. Runtime: ${runtimeRoot}`);
  }
} else {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  if (fs.existsSync(legacyData)) moveChildren(legacyData, runtimeRoot);
  if (fs.existsSync(legacyScratch)) moveEntry(legacyScratch, path.join(runtimeRoot, 'scratch', 'legacy-tmp'));
  if (rootLogs.length) {
    const logDir = path.join(runtimeRoot, 'scratch', 'root-logs');
    fs.mkdirSync(logDir, { recursive: true });
    for (const log of rootLogs) moveEntry(log, path.join(logDir, path.basename(log)));
  }
  normalizeRuntimeRoot();
  for (const dir of ['storage', 'postgres', 'tools', 'operator-backups', 'scratch', 'run']) fs.mkdirSync(path.join(runtimeRoot, dir), { recursive: true });
  removeIfEmpty(legacyData);
  console.log(`Runtime verisi kaynak koddan ayrıldı: ${runtimeRoot}`);
}

function normalizeRuntimeRoot() {
  const readiness = path.join(runtimeRoot, 'readiness-backups');
  if (fs.existsSync(readiness)) moveEntry(readiness, path.join(runtimeRoot, 'operator-backups', 'readiness'));
  const legacyPid = path.join(runtimeRoot, 'dev.pid');
  if (fs.existsSync(legacyPid)) moveEntry(legacyPid, path.join(runtimeRoot, 'run', 'legacy-dev.pid'));
  const legacyLogs = fs.readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.log(?:\..+)?$/i.test(entry.name));
  for (const entry of legacyLogs) {
    moveEntry(path.join(runtimeRoot, entry.name), path.join(runtimeRoot, 'scratch', 'legacy-runtime-logs', entry.name));
  }
}

function moveChildren(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) moveEntry(path.join(from, entry), path.join(to, entry));
}

function moveEntry(from, to) {
  if (fs.existsSync(to)) throw new Error(`Hedef zaten var; üzerine yazılmadı: ${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  console.log(`Taşındı: ${path.relative(sourceRoot, from)} -> ${to}`);
}

function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
