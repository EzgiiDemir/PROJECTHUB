import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { createImportFilter, importRuleFiles } from '@projecthub/contracts';
import { AppError } from '@projecthub/core';

export interface ExtractResult {
  files: number;
  skipped: number;
  bytes: number;
  root: string;
}

/** Import limits stop absurd archives (zip bombs). Source filtering is applied separately below. */
const LIMITS = { maxEntries: 2_000_000, maxFiles: 2_000_000, maxBytes: 200 * 1024 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024 * 1024 };
/** Version-control internals are not project files and cannot be stored inside a Git repository. */
const VCS = /(^|\/)(\.git|\.svn|\.hg)(\/|$)/;

const open = (zipPath: string) =>
  new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (err, z) =>
      err || !z ? reject(new AppError('VALIDATION_ERROR', `ZIP dosyası okunamadı: ${err?.message ?? 'bilinmeyen hata'}`)) : resolve(z),
    ),
  );

/** Visits every entry in order; `visit` decides per entry and the next entry is read when it resolves. */
async function eachEntry(zipPath: string, visit: (entry: yauzl.Entry, zip: yauzl.ZipFile) => Promise<'next' | 'stop'>) {
  const zip = await open(zipPath);
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      visit(entry, zip).then(
        (r) => {
          if (r === 'stop') {
            zip.close();
            resolve();
          } else zip.readEntry();
        },
        (e) => {
          zip.close();
          reject(e);
        },
      );
    });
    zip.on('end', () => resolve());
    zip.on('error', (e: Error) => reject(new AppError('VALIDATION_ERROR', `ZIP okunamadı: ${e.message}`)));
    zip.readEntry();
  });
}

const readStream = (zip: yauzl.ZipFile, entry: yauzl.Entry) => new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))));

const readText = async (zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> => {
  if (entry.uncompressedSize > 1024 * 1024) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of await readStream(zip, entry)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Extracts source files into `dest`. Git ignore rules and default secret/runtime/dependency exclusions are enforced
 * server-side because a browser-created ZIP is untrusted. Protects against zip-slip and zip bombs, and strips a
 * single common root folder.
 */
export async function extractProjectZip(zipPath: string, dest: string): Promise<ExtractResult> {
  // 1. Names only.
  const names: string[] = [];
  await eachEntry(zipPath, async (e) => {
    const name = e.fileName.replace(/\\/g, '/');
    if (!name.endsWith('/')) names.push(name);
    if (names.length > LIMITS.maxEntries) throw new AppError('PAYLOAD_TOO_LARGE', 'ZIP çok fazla dosya içeriyor');
    return 'next';
  });
  const firstSegments = new Set(names.map((n) => n.split('/')[0]));
  const root = firstSegments.size === 1 && names.every((n) => n.includes('/')) ? [...firstSegments][0]! : '';
  const strip = (name: string) => (root && name.startsWith(`${root}/`) ? name.slice(root.length + 1) : name);

  // Read ignore rules before extraction. Nested repositories keep their own rules and are not dropped merely
  // because an outer repository ignores their directory.
  const strippedNames = names.map(strip);
  const ruleFiles = new Set(importRuleFiles(strippedNames));
  const ruleText: Record<string, string> = {};
  if (ruleFiles.size) {
    await eachEntry(zipPath, async (entry, zip) => {
      const name = strip(entry.fileName.replace(/\\/g, '/'));
      if (ruleFiles.has(name)) ruleText[name] = await readText(zip, entry);
      return 'next';
    });
  }
  const include = createImportFilter(strippedNames, ruleText);

  // 2. Extract.
  const result: ExtractResult = { files: 0, skipped: 0, bytes: 0, root };
  const destRoot = path.resolve(dest);
  await eachEntry(zipPath, async (entry, zip) => {
    const name = strip(entry.fileName.replace(/\\/g, '/'));
    const isDir = name.endsWith('/');
    const isSymlink = ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
    if (!name || isDir) return 'next';
    if (isSymlink || name.split('/').includes('..') || VCS.test(name) || !include(name) || entry.uncompressedSize > LIMITS.maxFileBytes) {
      result.skipped++;
      return 'next';
    }
    result.bytes += entry.uncompressedSize;
    if (result.bytes > LIMITS.maxBytes || result.files >= LIMITS.maxFiles) throw new AppError('PAYLOAD_TOO_LARGE', 'Arşiv olağan dışı büyük (en fazla 200 GB ve 2 milyon dosya)');
    const target = path.resolve(destRoot, name);
    if (!target.startsWith(destRoot + path.sep)) {
      result.skipped++;
      return 'next';
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    try {
      await pipeline(await readStream(zip, entry), fs.createWriteStream(target));
    } catch (e) {
      // Corrupt compressed data (e.g. "invalid distance too far back") is a broken archive, not a server error.
      throw new AppError('VALIDATION_ERROR', `ZIP dosyası bozuk, "${name}" açılamadı (${(e as Error).message}). Arşivi yeniden oluşturun veya klasörü doğrudan seçin.`);
    }
    result.files++;
    return 'next';
  });
  return result;
}
