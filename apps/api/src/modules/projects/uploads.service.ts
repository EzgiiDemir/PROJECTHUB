import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { AppError, detectProject, prettifyName, slugify, walkFiles } from '@projecthub/core';
import { uploads } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { extractProjectZip } from './zip.js';

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
/**
 * Large projects arrive as one or more ZIP volumes (the browser splits huge folders; a single ZIP without ZIP64 is
 * capped at 4 GB / 65k files), each sent in parts well below proxy body limits and appended on disk.
 */
const MAX_CHUNKED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_VOLUMES = 500;
const volumeFile = (volume: number) => (volume ? `source-${volume}.zip` : 'source.zip');
/** The uploaded volumes in order (source.zip, source-1.zip, ...). */
async function volumesIn(dir: string): Promise<string[]> {
  const names = (await fs.promises.readdir(dir)).filter((n) => /^source(-\d+)?\.zip$/.test(n));
  const index = (n: string) => Number(/-(\d+)\.zip$/.exec(n)?.[1] ?? 0);
  return names.sort((a, b) => index(a) - index(b)).map((n) => path.join(dir, n));
}
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const PARTIAL = 'partial.json';

@Injectable()
export class UploadsService {
  constructor(private readonly ctx: Ctx) {}

  /**
   * Receives a project archive (raw application/zip body), extracts it into storage and runs Smart Import
   * detection. The upload is consumed by project creation; unused uploads expire after 24 h.
   */
  async receive(auth: AuthInfo, req: Request, fileName: string) {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > MAX_UPLOAD_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Dosya en fazla 300 MB olabilir');
    const id = crypto.randomUUID();
    const dirKey = this.ctx.storage.uploadKey(id);
    const dir = await this.ctx.storage.ensureDir(dirKey);
    const zipPath = path.join(dir, 'source.zip');
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) cb(new AppError('PAYLOAD_TOO_LARGE', 'Dosya en fazla 300 MB olabilir'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(zipPath));
      return await this.finalize(auth, id, dirKey, fileName, received);
    } catch (e) {
      await this.ctx.storage.remove(dirKey).catch(() => undefined);
      throw aborted(e);
    }
  }

  /** Starts a chunked upload (large projects): parts are appended with appendChunk, then completeChunked. */
  async startChunked(auth: AuthInfo) {
    await this.pruneAbandoned(auth);
    const id = crypto.randomUUID();
    const dir = await this.ctx.storage.ensureDir(this.ctx.storage.uploadKey(id));
    await fs.promises.writeFile(path.join(dir, PARTIAL), JSON.stringify({ userId: auth.user.id, createdAt: new Date().toISOString() }));
    await fs.promises.writeFile(path.join(dir, 'source.zip'), '');
    return { uploadId: id, chunkBytes: MAX_CHUNK_BYTES, maxBytes: MAX_CHUNKED_BYTES };
  }

  /** Appends one part at `offset` (must equal the bytes received so far, so a retried part is never doubled). */
  async appendChunk(auth: AuthInfo, id: string, offset: number, req: Request, volume = 0): Promise<{ received: number }> {
    const dir = await this.partial(auth, id);
    if (!Number.isInteger(volume) || volume < 0 || volume >= MAX_VOLUMES) throw new AppError('VALIDATION_ERROR', 'Geçersiz arşiv parçası');
    const zipPath = path.join(dir, volumeFile(volume));
    const size = await fs.promises.stat(zipPath).then((st) => st.size, () => -1);
    if (size < 0) {
      // A new volume starts only after the previous one exists.
      if (volume > 0 && !(await fs.promises.stat(path.join(dir, volumeFile(volume - 1))).then(() => true, () => false))) throw new AppError('CONFLICT', 'Önceki arşiv parçası eksik', { received: 0 });
      if (offset !== 0) throw new AppError('CONFLICT', 'Parça sırası uyuşmuyor; sunucuda 0 bayt var', { received: 0 });
      await fs.promises.writeFile(zipPath, '');
      return this.appendChunk(auth, id, 0, req, volume);
    }
    if (offset !== size) throw new AppError('CONFLICT', `Parça sırası uyuşmuyor; sunucuda ${size} bayt var`, { received: size });
    let n = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        n += chunk.length;
        if (n > MAX_CHUNK_BYTES || size + n > MAX_CHUNKED_BYTES) cb(new AppError('PAYLOAD_TOO_LARGE', 'Bir arşiv parçası en fazla 8 GB olabilir'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(zipPath, { flags: 'a' }));
    } catch (e) {
      // Drop a partly written part so the client can resend it from the same offset.
      await fs.promises.truncate(zipPath, size).catch(() => undefined);
      throw aborted(e);
    }
    return { received: size + n };
  }

  async completeChunked(auth: AuthInfo, id: string, fileName: string) {
    const dir = await this.partial(auth, id);
    const dirKey = this.ctx.storage.uploadKey(id);
    let size = 0;
    for (const v of await volumesIn(dir)) size += (await fs.promises.stat(v)).size;
    await fs.promises.rm(path.join(dir, PARTIAL), { force: true });
    try {
      return await this.finalize(auth, id, dirKey, fileName, size);
    } catch (e) {
      // Keep the reason so a browser whose request dropped during the (long) extraction can still read it.
      await fs.promises.rm(path.join(dir, 'files'), { recursive: true, force: true }).catch(() => undefined);
      for (const v of await volumesIn(dir).catch(() => [] as string[])) await fs.promises.rm(v, { force: true }).catch(() => undefined);
      const message = e instanceof AppError ? e.message : 'Arşiv açılırken beklenmeyen bir hata oluştu.';
      if (!(e instanceof AppError)) this.ctx.logger.error({ err: e, uploadId: id }, 'upload extraction failed');
      await fs.promises.writeFile(path.join(dir, 'error.json'), JSON.stringify({ userId: auth.user.id, message })).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Outcome of a chunked upload, for a browser whose "complete" request was cut off while the server kept
   * extracting: ready (same result as complete), processing, or failed with the reason.
   */
  async result(auth: AuthInfo, id: string) {
    const row = (await this.ctx.db.select().from(uploads).where(eq(uploads.id, id)))[0];
    if (row) {
      if (row.userId !== auth.user.id) throw new AppError('NOT_FOUND', 'Yükleme bulunamadı');
      const paths = await walkFiles(this.ctx.storage.resolve(`${row.storageKey}/files`)).catch(() => [] as string[]);
      const detection = row.detection as Awaited<ReturnType<typeof detectProject>>;
      return {
        status: 'ready' as const,
        result: { uploadId: row.id, fileCount: row.fileCount, skipped: 0, bytes: row.sizeBytes, detection, suggested: { name: prettifyName(detection.name), slug: slugify(detection.name), description: detection.description ?? '' }, sample: paths.slice(0, 200) },
      };
    }
    const dir = this.ctx.storage.resolve(this.ctx.storage.uploadKey(id));
    const failed = await fs.promises.readFile(path.join(dir, 'error.json'), 'utf8').then((t) => JSON.parse(t) as { userId: string; message: string }, () => null);
    if (failed?.userId === auth.user.id) return { status: 'failed' as const, message: failed.message };
    if (await fs.promises.stat(dir).then(() => true, () => false)) return { status: 'processing' as const };
    throw new AppError('NOT_FOUND', 'Yükleme bulunamadı');
  }

  private async partial(auth: AuthInfo, id: string): Promise<string> {
    const dir = this.ctx.storage.resolve(this.ctx.storage.uploadKey(id));
    const meta = await fs.promises.readFile(path.join(dir, PARTIAL), 'utf8').then((t) => JSON.parse(t) as { userId: string }, () => null);
    if (!meta || meta.userId !== auth.user.id) throw new AppError('NOT_FOUND', 'Yükleme bulunamadı');
    return dir;
  }

  /** Removes this user's chunked uploads that were never completed (older than 6 hours). */
  private async pruneAbandoned(auth: AuthInfo) {
    const base = this.ctx.storage.resolve('uploads');
    const dirs = await fs.promises.readdir(base).catch(() => [] as string[]);
    for (const d of dirs) {
      const meta = await fs.promises.readFile(path.join(base, d, PARTIAL), 'utf8').then((t) => JSON.parse(t) as { userId: string; createdAt: string }, () => null);
      if (meta?.userId === auth.user.id && Date.now() - Date.parse(meta.createdAt) > 6 * 3600_000) await this.ctx.storage.remove(this.ctx.storage.uploadKey(d)).catch(() => undefined);
    }
  }

  /** Validates the archive volume(s), extracts every file into one folder and runs Smart Import detection. */
  private async finalize(auth: AuthInfo, id: string, dirKey: string, fileName: string, received: number) {
    const dir = this.ctx.storage.resolve(dirKey);
    const extractDir = path.join(dir, 'files');
    {
      await fs.promises.mkdir(extractDir, { recursive: true });
      const extracted = { files: 0, skipped: 0, bytes: 0, root: '' };
      for (const zipPath of await volumesIn(dir)) {
        const magic = Buffer.alloc(4);
        const fd = await fs.promises.open(zipPath, 'r');
        await fd.read(magic, 0, 4, 0);
        await fd.close();
        if (magic.readUInt32LE(0) !== 0x04034b50) throw new AppError('VALIDATION_ERROR', 'Yüklenen dosya ZIP biçiminde değil');
        const r = await extractProjectZip(zipPath, extractDir);
        extracted.files += r.files;
        extracted.skipped += r.skipped;
        extracted.bytes += r.bytes;
        extracted.root ||= r.root;
        await fs.promises.rm(zipPath, { force: true });
      }
      if (!extracted.files) throw new AppError('VALIDATION_ERROR', 'Arşivde içe aktarılabilecek dosya bulunamadı');
      const paths = await walkFiles(extractDir);
      const baseName = fileName.replace(/\.zip$/i, '') || extracted.root || 'proje';
      const detection = await detectProject(
        {
          paths,
          read: async (p) => {
            try {
              const full = path.join(extractDir, p);
              const st = await fs.promises.stat(full);
              if (st.size > 512 * 1024) return null;
              return await fs.promises.readFile(full, 'utf8');
            } catch {
              return null;
            }
          },
        },
        extracted.root || baseName,
      );
      await this.ctx.db.insert(uploads).values({
        id,
        organizationId: auth.organizationId,
        userId: auth.user.id,
        fileName: fileName.slice(0, 255),
        storageKey: dirKey,
        sizeBytes: received,
        detection,
        fileCount: extracted.files,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      });
      return {
        uploadId: id,
        fileCount: extracted.files,
        skipped: extracted.skipped,
        bytes: extracted.bytes,
        detection,
        suggested: { name: prettifyName(detection.name), slug: slugify(detection.name), description: detection.description ?? '' },
        sample: paths.slice(0, 200),
      };
    }
  }

  async get(auth: AuthInfo, id: string) {
    const row = (await this.ctx.db.select().from(uploads).where(eq(uploads.id, id)))[0];
    if (!row || row.userId !== auth.user.id) throw new AppError('NOT_FOUND', 'Yükleme bulunamadı');
    return row;
  }
}

function aborted(e: unknown) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message === 'aborted') {
    return new AppError('VALIDATION_ERROR', 'Yükleme yarıda kesildi; bağlantıyı kontrol edip tekrar deneyin.');
  }
  return e;
}
