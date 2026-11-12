'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Zip, ZipPassThrough } from 'fflate';
import { FileArchive, FolderUp, GitBranch, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { assertImportFileCount, createImportFilter, importRuleFiles, retryUploadRequest, type DetectionResult, type ProjectTemplateId } from '@projecthub/contracts';
import { api, ApiError, errorMessage } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import type { ProjectSummary } from '@/lib/types';
import { Field, KeyValue, PageHeader, Panel } from '@/components/ui';

type Source = 'upload' | 'git' | 'empty';
interface TemplateInfo {
  id: ProjectTemplateId;
  name: string;
  description: string;
  technologies: string[];
  requires: string;
}
interface UploadResult {
  uploadId: string;
  fileCount: number;
  skipped: number;
  bytes: number;
  detection: DetectionResult;
  suggested: { name: string; slug: string; description: string };
  sample: string[];
}

/** Archives up to this size go in one request; anything larger is uploaded in resumable parts. */
const SINGLE_UPLOAD_BYTES = 64 * 1024 * 1024;
/**
 * Huge source folders are split into several ZIP volumes because a ZIP written in the browser is limited to
 * 4 GB / 65,535 entries; generated, ignored, runtime and secret files are excluded before upload.
 */
const VOLUME_BYTES = 1536 * 1024 * 1024;
const VOLUME_FILES = 60_000;
/** Version-control internals are not project files and cannot be stored inside a Git repository. */
const VCS = /(^|\/)(\.git|\.svn|\.hg)(\/|$)/;

/**
 * Streams the folder into a ZIP one file (and one chunk) at a time. Output is folded into Blobs every 32 MB so the
 * browser can keep it outside the JavaScript heap; large projects no longer exhaust memory.
 */
async function zipFolder(list: File[], onProgress: (done: number) => void): Promise<Blob> {
  const blobs: Blob[] = [];
  let parts: Uint8Array[] = [];
  let pending = 0;
  const flush = () => {
    if (!parts.length) return;
    blobs.push(new Blob(parts as BlobPart[]));
    parts = [];
    pending = 0;
  };
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const archive = new Zip((err, chunk, final) => {
    if (err) return rejectDone(err);
    parts.push(chunk);
    pending += chunk.length;
    if (pending > 32 * 1024 * 1024) flush();
    if (final) resolveDone();
  });
  for (let i = 0; i < list.length; i++) {
    const f = list[i]!;
    // Files are stored, not deflated: packing is near-instant, and fflate's streaming deflate (0.8.x) produces
    // corrupt data for some inputs ("invalid distance too far back" when the server unpacks the archive).
    const entry = new ZipPassThrough(f.webkitRelativePath);
    entry.mtime = f.lastModified;
    archive.add(entry);
    const reader = f.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      entry.push(value);
    }
    entry.push(new Uint8Array(0), true);
    onProgress(i + 1);
  }
  archive.end();
  await finished;
  flush();
  return new Blob(blobs, { type: 'application/zip' });
}

/** Path inside the selected folder (the browser prefixes the folder name). */
const inFolder = (f: File) => f.webkitRelativePath.slice(f.webkitRelativePath.indexOf('/') + 1);

/** Splits the files into ZIP volumes below the size and entry limits. */
function volumes(list: File[]): File[][] {
  const out: File[][] = [[]];
  let size = 0;
  for (const f of list) {
    const cur = out.at(-1)!;
    if (cur.length && (cur.length >= VOLUME_FILES || size + f.size > VOLUME_BYTES)) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(f);
    size += f.size;
  }
  return out;
}

const COLORS = ['#234E8C', '#1F7A55', '#B5541C', '#7A3EA8', '#2E6F7E', '#9C2F4F', '#5B6772'];

const TR: Record<string, string> = { ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c', Ğ: 'g', Ü: 'u', Ş: 's', İ: 'i', Ö: 'o', Ç: 'c' };
const slugify = (s: string) =>
  s
    .replace(/[ğüşıöçĞÜŞİÖÇ]/g, (c) => TR[c] ?? c)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Smart Import (spec §14–24): bring an existing project in from a folder, ZIP or Git URL, or start empty. */
export default function NewProjectPage() {
  const router = useRouter();
  const can = useCan();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ id: string; name: string }[]>('/admin/teams') });
  const [source, setSource] = useState<Source>('upload');
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState<{ phase: 'zip' | 'upload'; pct: number; label: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [git, setGit] = useState({ url: '', branch: '', token: '' });
  const [template, setTemplate] = useState<ProjectTemplateId>('static');
  const templates = useQuery({ queryKey: ['projectTemplates'], queryFn: () => api<TemplateInfo[]>('/project-templates'), staleTime: Infinity });
  const [form, setForm] = useState({ name: '', slug: '', description: '', customerName: '', teamId: '', color: COLORS[0]!, defaultBranch: 'main', createDefaultEnvironments: true });
  const [slugTouched, setSlugTouched] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const setName = (name: string) => setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));

  const xhrSend = <T,>(method: string, url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void) =>
    new Promise<T>((resolve, reject) => {
      // XHR (not fetch) for upload progress.
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('x-requested-with', 'projecthub');
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let json: { data?: T; error?: { message: string; details?: { received?: number } } } = {};
        try {
          json = JSON.parse(xhr.responseText || '{}');
        } catch {
          // A proxy or gateway answered with a non-JSON error page.
        }
        if (xhr.status >= 200 && xhr.status < 300 && json.data) resolve(json.data);
        else reject(Object.assign(new Error(json.error?.message ?? `Yükleme başarısız (HTTP ${xhr.status}). Lütfen tekrar deneyin.`), { status: xhr.status, received: json.error?.details?.received }));
      };
      xhr.onerror = () => reject(new Error('Sunucuya ulaşılamadı'));
      xhr.send(body);
    });

  /** Sends one ZIP volume of a chunked upload in parts; a dropped part is resent, a duplicate is skipped. */
  const sendVolume = async (uploadId: string, chunkBytes: number, volume: number, blob: Blob, show: (loaded: number) => void) => {
    let offset = 0;
    let retries = 0;
    while (offset < blob.size) {
      const part = blob.slice(offset, Math.min(offset + chunkBytes, blob.size));
      try {
        const r = await xhrSend<{ received: number }>('PUT', `/api/v1/uploads/${uploadId}/chunk`, part, { 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset), 'x-upload-volume': String(volume) }, (loaded) => show(offset + loaded));
        offset = r.received;
        retries = 0;
      } catch (e) {
        const err = e as Error & { status?: number; received?: number };
        if (err.status === 409 && typeof err.received === 'number') offset = err.received;
        else if ((err.status && err.status < 500 && err.status !== 408 && err.status !== 429) || ++retries > 8) throw e;
        else {
          // Connection dropped or the server is restarting: wait (2 s … ~2 min in total) and resume where it stopped.
          setProgress({ phase: 'upload', pct: Math.round((offset / blob.size) * 100), label: `Bağlantı bekleniyor, ${retries}. deneme…` });
          await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** (retries - 1))));
        }
      }
    }
  };

  /**
   * Finishes a chunked upload. Extracting a huge project can outlast the HTTP request; if the request drops, the
   * outcome is read from the server instead of reporting an error for an upload that actually succeeded.
   */
  const completeUpload = async (uploadId: string, fileName: string): Promise<UploadResult> => {
    setProgress({ phase: 'upload', pct: 100, label: 'Sunucuda açılıyor ve proje türü tespit ediliyor…' });
    try {
      return await api<UploadResult>(`/uploads/${uploadId}/complete`, { method: 'POST', body: { fileName } });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status < 500 && status !== 404) throw e;
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const r = await api<{ status: 'ready' | 'processing' | 'failed'; result?: UploadResult; message?: string }>(`/uploads/${uploadId}/result`).catch(() => null);
        if (r?.status === 'ready' && r.result) return r.result;
        if (r?.status === 'failed') throw new Error(r.message ?? 'Arşiv açılamadı');
      }
      throw e;
    }
  };

  /** Small archives in one request; large ones in parts that pass proxy limits and resume after a dropped part. */
  const startUploadSession = () => retryUploadRequest(
    () => api<{ uploadId: string; chunkBytes: number }>('/uploads/chunked', { method: 'POST', body: {} }),
    (attempt) => setProgress({ phase: 'upload', pct: 0, label: `Sunucu bağlantısı bekleniyor (${attempt}/15); hazırlanan dosyalar korunuyor…` }),
  );
  const sendZip = async (blob: Blob, fileName: string): Promise<UploadResult> => {
    const show = (loaded: number) => setProgress({ phase: 'upload', pct: Math.round((loaded / blob.size) * 100), label: `Yükleniyor · ${bytes(loaded)} / ${bytes(blob.size)}` });
    if (blob.size <= SINGLE_UPLOAD_BYTES) return retryUploadRequest(
      () => xhrSend<UploadResult>('POST', '/api/v1/uploads', blob, { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(fileName) }, show),
      (attempt) => setProgress({ phase: 'upload', pct: 0, label: `Bağlantı bekleniyor (${attempt}/15); arşiv yeniden hazırlanmadan gönderilecek…` }),
    );
    const session = await startUploadSession();
    await sendVolume(session.uploadId, session.chunkBytes, 0, blob, show);
    return completeUpload(session.uploadId, fileName);
  };

  const accept = (r: UploadResult, expectedFiles?: number) => {
    if (expectedFiles !== undefined) assertImportFileCount(expectedFiles, r.fileCount);
    setUpload(r);
    setForm((f) => ({ ...f, name: f.name || r.suggested.name, slug: slugTouched ? f.slug : r.suggested.slug, description: f.description || r.suggested.description }));
  };

  /** Imports the same source set as Git while excluding secrets, runtime data and generated dependencies. */
  const onFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);
    setUpload(null);
    try {
      const all = [...files];
      const root = all[0]?.webkitRelativePath.split('/')[0] ?? 'proje';
      const paths = all.map(inFolder);
      const wantedRules = new Set(importRuleFiles(paths));
      const ruleText = Object.fromEntries(await Promise.all(all.filter((f) => wantedRules.has(inFolder(f))).map(async (f) => [inFolder(f), await f.text()] as const)));
      const include = createImportFilter(paths, ruleText);
      const list = all.filter((f) => !VCS.test(inFolder(f)) && include(inFolder(f)));
      const clientSkipped = all.length - list.length;
      if (!list.length) throw new Error('Klasörde içe aktarılacak dosya bulunamadı.');
      const total = list.reduce((n, f) => n + f.size, 0);
      const parts = volumes(list);
      let zipped = 0;
      const zipProgress = (done: number) => {
        if (done % 25 === 0) setProgress({ phase: 'zip', pct: Math.round(((zipped + done) / list.length) * 100), label: `Sıkıştırılıyor · ${zipped + done}/${list.length} dosya · ${bytes(total)}` });
      };
      if (parts.length === 1) {
        const blob = await zipFolder(list, zipProgress);
        const result = await sendZip(blob, `${root}.zip`);
        accept({ ...result, skipped: result.skipped + clientSkipped }, list.length);
        return;
      }
      // Very large projects: zip and upload one volume at a time (only one volume is held in memory).
      const session = await startUploadSession();
      let uploaded = 0;
      for (let v = 0; v < parts.length; v++) {
        const blob = await zipFolder(parts[v]!, zipProgress);
        zipped += parts[v]!.length;
        const before = uploaded;
        await sendVolume(session.uploadId, session.chunkBytes, v, blob, (loaded) =>
          setProgress({ phase: 'upload', pct: Math.round(((before + loaded) / total) * 100), label: `Yükleniyor · parça ${v + 1}/${parts.length} · ${bytes(before + loaded)} gönderildi` }),
        );
        uploaded += blob.size;
      }
      const result = await completeUpload(session.uploadId, `${root}.zip`);
      accept({ ...result, skipped: result.skipped + clientSkipped }, list.length);
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const onZip = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setUpload(null);
    try {
      accept(await sendZip(file, file.name));
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api<ProjectSummary>('/projects', {
        method: 'POST',
        body: {
          name: form.name,
          slug: form.slug,
          description: form.description,
          customerName: form.customerName,
          teamId: form.teamId || null,
          color: form.color,
          defaultBranch: form.defaultBranch,
          createDefaultEnvironments: form.createDefaultEnvironments,
          source: source === 'upload' ? { type: 'upload', uploadId: upload!.uploadId } : source === 'git' ? { type: 'git', url: git.url.trim(), branch: git.branch.trim() || undefined, accessToken: git.token.trim() || undefined } : { type: 'empty', template },
        },
      }),
    onSuccess: (p) => router.push(`/projects/${p.slug}`),
  });
  const slugTaken = create.error instanceof ApiError && (create.error.details as { field?: string } | undefined)?.field === 'slug';
  const ready = form.name.trim() && /^[a-z0-9][a-z0-9-]*$/.test(form.slug) && (source === 'empty' || (source === 'git' && /^https?:\/\/.+/.test(git.url.trim())) || (source === 'upload' && upload));

  if (!can('project.create')) return <div className="page"><div className="badbox">Proje oluşturma yetkiniz yok.</div></div>;

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader title="Proje ekle / içe aktar" sub="Mevcut bir projeyi klasör, ZIP veya Git adresinden getirin; Project Hub teknolojiyi tanır, build ve ön izleme ayarlarını önerir." />
      <div className="grid g3" style={{ marginBottom: 14 }}>
        {(
          [
            ['upload', <FolderUp key="u" />, 'Klasör veya ZIP', 'Bilgisayarınızdaki proje klasörünü seçin'],
            ['git', <GitBranch key="g" />, 'Git deposu', 'GitHub, GitLab, Bitbucket veya herhangi bir Git adresi'],
            ['empty', <Sparkles key="e" />, 'Şablondan yeni proje', 'Next.js, React, Laravel, FastAPI, Node API veya statik site'],
          ] as [Source, React.ReactNode, string, string][]
        ).map(([k, icon, title, sub]) => (
          <button key={k} className="panel" style={{ padding: 16, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', outline: source === k ? '2px solid var(--primary)' : undefined }} onClick={() => setSource(k)}>
            <div className="row" style={{ gap: 8, fontWeight: 600 }}>
              {icon} {title}
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {sub}
            </div>
          </button>
        ))}
      </div>
      <div className="grid split" style={{ alignItems: 'start' }}>
        <div className="grid" style={{ gap: 14 }}>
          {source === 'upload' && (
            <Panel title="Kaynak">
              <div className="row">
                <button className="btn pri" onClick={() => folderInput.current?.click()} disabled={!!progress}>
                  <FolderUp /> Klasör seç
                </button>
                <button className="btn" onClick={() => zipInput.current?.click()} disabled={!!progress}>
                  <FileArchive /> ZIP seç
                </button>
              </div>
              {/* webkitdirectory is not in React's input typings */}
              <input ref={folderInput} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => void onFolder(e.target.files)} />
              <input ref={zipInput} type="file" hidden accept=".zip,application/zip" onChange={(e) => void onZip(e.target.files?.[0])} />
              <p className="small muted">Kaynak kodlar alınır; .gitignore kurallarına uyan dosyalar, gizli anahtar dosyaları, bağımlılıklar, derleme çıktıları ve çalışma verileri dışarıda bırakılır. Büyük projeler parça parça yüklenir.</p>
              {progress && (
                <div style={{ marginTop: 10 }}>
                  <div className="small">{progress.label}</div>
                  <div className="bar" style={{ marginTop: 4 }}>
                    <i style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
              )}
              {uploadError && <div className="badbox" style={{ marginTop: 10 }}>{uploadError}</div>}
              {upload && (
                <div className="okbox small" style={{ marginTop: 10 }}>
                  {upload.fileCount} dosya alındı ({bytes(upload.bytes)}){upload.skipped ? ` · ${upload.skipped} dosya atlandı` : ''}.
                </div>
              )}
            </Panel>
          )}
          {source === 'empty' && (
            <Panel title="Şablon">
              <div className="grid g2">
                {templates.data?.map((t) => (
                  <button key={t.id} type="button" className="panel" style={{ padding: 12, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', outline: template === t.id ? '2px solid var(--primary)' : undefined }} onClick={() => setTemplate(t.id)}>
                    <b>{t.name}</b>
                    <div className="small muted" style={{ marginTop: 4 }}>{t.description}</div>
                    {t.requires !== '—' && <div className="small" style={{ marginTop: 4 }}>Gerekli: {t.requires}</div>}
                  </button>
                ))}
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>Şablon; çalışan örnek kodu, testleri ve build/ön izleme/deployment ayarlarını (projecthub.yml) getirir.</p>
            </Panel>
          )}
          {source === 'git' && (
            <Panel title="Git deposu">
              <Field label="Depo adresi" id="np-url" hint="HTTPS adresi, ör. https://github.com/firma/proje.git">
                <input id="np-url" className="in mono" value={git.url} onChange={(e) => setGit((g) => ({ ...g, url: e.target.value }))} placeholder="https://github.com/…" />
              </Field>
              <div className="grid g2">
                <Field label="Branch (isteğe bağlı)" id="np-br" hint="Boşsa deponun varsayılan branch'i">
                  <input id="np-br" className="in mono" value={git.branch} onChange={(e) => setGit((g) => ({ ...g, branch: e.target.value }))} />
                </Field>
                <Field label="Erişim anahtarı (özel depolar)" id="np-tok" hint="Şifrelenerek saklanır, senkronizasyonda kullanılır">
                  <input id="np-tok" className="in" type="password" value={git.token} onChange={(e) => setGit((g) => ({ ...g, token: e.target.value }))} autoComplete="off" />
                </Field>
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>Depo arka planda klonlanır; teknoloji tespiti, kod indeksi ve güvenlik taraması ardından otomatik çalışır.</p>
            </Panel>
          )}
          <Panel title="Proje bilgileri">
            <div className="grid g2">
              <Field label="Proje adı" id="np-name">
                <input id="np-name" className="in" value={form.name} onChange={(e) => setName(e.target.value)} maxLength={150} />
              </Field>
              <Field label="Kısa ad" id="np-slug" hint="Adreslerde kullanılır; sonradan değişmez" error={slugTaken ? 'Bu kısa ad kullanılıyor' : form.slug && !/^[a-z0-9][a-z0-9-]*$/.test(form.slug) ? 'Küçük harf, rakam ve tire' : null}>
                <input
                  id="np-slug"
                  className="in mono"
                  value={form.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setForm((f) => ({ ...f, slug: e.target.value }));
                  }}
                  maxLength={80}
                />
              </Field>
            </div>
            <Field label="Açıklama" id="np-desc">
              <textarea id="np-desc" className="in" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={2000} />
            </Field>
            <div className="grid g3">
              <Field label="Kullanıcı" id="np-cust">
                <input id="np-cust" className="in" value={form.customerName} onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))} maxLength={150} />
              </Field>
              <Field label="Ekip" id="np-team">
                <select id="np-team" className="in" value={form.teamId} onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}>
                  <option value="">—</option>
                  {teams.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <label>Renk</label>
                <div className="row" style={{ gap: 6 }}>
                  {COLORS.map((c) => (
                    <button key={c} type="button" aria-label={c} onClick={() => setForm((f) => ({ ...f, color: c }))} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: form.color === c ? '2px solid var(--ink)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </div>
            </div>
            {source === 'empty' && (
              <Field label="Varsayılan branch" id="np-db">
                <input id="np-db" className="in mono" value={form.defaultBranch} onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))} style={{ maxWidth: 240 }} />
              </Field>
            )}
            <label className="check">
              <input type="checkbox" checked={form.createDefaultEnvironments} onChange={(e) => setForm((f) => ({ ...f, createDefaultEnvironments: e.target.checked }))} /> Development, Staging ve Production ortamlarını oluştur
            </label>
            {create.error && !slugTaken && <div className="badbox" style={{ marginTop: 10 }}>{errorMessage(create.error)}</div>}
            <div style={{ marginTop: 14 }}>
              <button className="btn pri" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
                {create.isPending && <span className="spinner" />} {source === 'empty' ? 'Projeyi oluştur' : 'İçe aktar'}
              </button>
            </div>
          </Panel>
        </div>
        <DetectionPanel source={source} upload={upload} />
      </div>
    </div>
  );
}

function DetectionPanel({ source, upload }: { source: Source; upload: UploadResult | null }) {
  if (source !== 'upload' || !upload)
    return (
      <Panel title="Akıllı tespit">
        <p className="small muted" style={{ margin: 0 }}>
          {source === 'empty'
            ? 'Şablon projecthub.yml ile gelir; oluşturulduktan sonra ilk build’i başlatıp ön izleme açabilirsiniz.'
            : source === 'git'
              ? 'Depo klonlandıktan sonra teknoloji, build komutları ve veritabanı otomatik tespit edilir; sonucu proje ayarlarında görürsünüz.'
              : 'Klasörü seçtiğinizde proje türü, build komutları, port, veritabanı ve testler burada gösterilir.'}
        </p>
      </Panel>
    );
  const d = upload.detection;
  return (
    <Panel title="Akıllı tespit">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {d.projectType} {d.technologies.length > 0 && <span className="small muted">· {d.technologies.join(', ')}</span>}
      </div>
      <KeyValue
        items={[
          ['Çalışma ortamı', `${d.runtime.type}${d.runtime.version ? ` ${d.runtime.version}` : ''}`],
          ['Kurulum', <span key="i" className="mono small">{d.installCommand ?? '—'}</span>],
          ['Build', <span key="b" className="mono small">{d.buildCommand ?? '—'}</span>],
          ['Test', <span key="t" className="mono small">{d.testCommand ?? '—'}</span>],
          ['Ön izleme', d.previewMode === 'process' ? `Uygulama sunucusu${d.port ? ` · port ${d.port}` : ''}` : d.previewMode === 'static' ? `Statik${d.buildOutput ? ` · ${d.buildOutput}` : ''}` : 'yok'],
          ['Veritabanı', d.database === 'none' ? 'yok' : d.database],
          ['Ortam değişkenleri', d.envVars.length ? <span key="e" className="mono small">{d.envVars.join(', ')}</span> : '—'],
        ]}
      />
      {d.checks.length > 0 && (
        <div className="small" style={{ marginTop: 10 }}>
          {d.checks.map((c) => (
            <div key={c} style={{ color: 'var(--ok)' }}>
              ✓ {c}
            </div>
          ))}
        </div>
      )}
      {d.warnings.length > 0 && (
        <div className="warnbox small" style={{ marginTop: 10 }}>
          {d.warnings.map((w) => (
            <div key={w}>• {w}</div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        {d.hasManifest ? 'Projedeki projecthub.yml kullanılacak.' : 'Bu tespitten bir manifest oluşturulup kullanılır; Ayarlar › projecthub.yml ekranında düzenleyip repository’ye kaydedebilirsiniz.'}
      </p>
    </Panel>
  );
}
