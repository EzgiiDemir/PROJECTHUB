'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { Environment } from '@/lib/types';
import { Drawer, Field } from '@/components/ui';
import { useToast } from '@/components/toast';

interface ImportItem {
  name: string;
  action: 'create' | 'update' | 'skip';
  length: number;
  generated: boolean;
  note?: string;
}
interface ImportResult {
  origin: { kind: 'text' } | { kind: 'history'; commit: string; date: string; removed: boolean };
  items: ImportItem[];
  issues: { line: number; name?: string; reason: string }[];
  external: string[];
  saved: number;
  hasAppKey: boolean;
}

const ACTION: Record<ImportItem['action'], [string, string]> = { create: ['Eklenecek', 'var(--ok)'], update: ['Güncellenecek', 'var(--warn)'], skip: ['Atlanacak', 'var(--muted)'] };

/**
 * One-step .env import: paste the file (or take the .env that was in the repository), the server parses it and
 * shows what will be stored (names only), and nothing is saved until "Kaydet".
 */
export function EnvImportDrawer({ slug, source: initial = 'text', onClose }: { slug: string; source?: 'text' | 'history'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const [source, setSource] = useState(initial);
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<'all' | 'runtime' | 'build' | 'deploy'>('all');
  const [environmentId, setEnvironmentId] = useState('');
  const [rotate, setRotate] = useState(initial === 'history');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 400);
    return () => clearTimeout(t);
  }, [text]);
  const body = { source, text: source === 'text' ? debounced : undefined, scope, environmentId: environmentId || null, rotateAppKey: rotate, overwrite: true };
  const preview = useQuery({
    queryKey: ['env-import', slug, body],
    queryFn: () => api<ImportResult>(`/projects/${slug}/secrets/import`, { method: 'POST', body: { ...body, dryRun: true } }),
    enabled: source === 'history' || debounced.trim().length > 0,
    retry: false,
    gcTime: 0,
  });
  const save = useMutation({
    mutationFn: () => api<ImportResult>(`/projects/${slug}/secrets/import`, { method: 'POST', body: { ...body, text: source === 'text' ? text : undefined, dryRun: false } }),
    onSuccess: (r) => {
      toast(`${r.saved} ayar Secret olarak kaydedildi`);
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      void qc.invalidateQueries({ queryKey: ['assistant'] });
      onClose();
    },
  });
  const r = preview.data;
  const count = r?.items.filter((i) => i.action !== 'skip').length ?? 0;
  const stale = source === 'text' && text !== debounced;
  return (
    <Drawer
      wide
      title=".env içe aktar"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!count || stale || preview.isFetching || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <span className="spinner" /> : null} {count ? `${count} ayarı kaydet` : 'Kaydet'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className={`btn sm ${source === 'text' ? 'pri' : ''}`} onClick={() => setSource('text')}>
          Yapıştır
        </button>
        <button
          className={`btn sm ${source === 'history' ? 'pri' : ''}`}
          onClick={() => {
            setSource('history');
            setRotate(true);
          }}
        >
          Repodaki / kaldırılan .env’den al
        </button>
      </div>
      {source === 'text' ? (
        <Field label=".env içeriği" id="env-text" hint="Dosyanın tamamını yapıştırın. Yorumlar, tırnaklar, çok satırlı değerler ve ${APP_NAME} gibi referanslar doğru çözülür.">
          <textarea id="env-text" className="in mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'APP_NAME="Uygulamam"\nAPP_KEY=base64:...\nDB_PASSWORD=...'} autoComplete="off" spellCheck={false} />
        </Field>
      ) : (
        <p className="small muted">Değerler, repodaki .env dosyasından ya da repodan kaldırılmadan önceki son sürümünden okunur; kopyalayıp yapıştırmanız gerekmez.</p>
      )}
      <div className="grid g2">
        <Field label="Kullanım" id="env-scope" hint="Tümü: build, ön izleme ve deployment">
          <select id="env-scope" className="in" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">Tümü</option>
            <option value="runtime">Çalışma (ön izleme)</option>
            <option value="build">Build</option>
            <option value="deploy">Deployment</option>
          </select>
        </Field>
        <Field label="Ortam" id="env-env">
          <select id="env-env" className="in" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
            <option value="">Tüm ortamlar</option>
            {envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {r?.hasAppKey && (
        <label className="row small" style={{ gap: 8, margin: '4px 0 12px', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />
          <span>
            <b>APP_KEY’i yenile</b> (önerilir: eski anahtar Git’te açık kaldı). Eskisi APP_PREVIOUS_KEYS’e konur; Laravel 11+ önceden şifrelenmiş verileri okumaya devam eder.
          </span>
        </label>
      )}
      {preview.isFetching && (
        <p className="muted small">
          <span className="spinner" /> Ayrıştırılıyor…
        </p>
      )}
      {preview.error && <div className="badbox">{errorMessage(preview.error)}</div>}
      {r && !preview.isFetching && (
        <>
          {r.origin.kind === 'history' && (
            <p className="small muted">
              Kaynak: {r.origin.removed ? 'repodan kaldırılmadan önceki .env' : 'repodaki .env'} · {r.origin.commit.slice(0, 7)}
            </p>
          )}
          <div className="tbl" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Değer</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.name}>
                    <td className="mono small">{i.name}</td>
                    <td className="small muted">{i.generated ? 'yeni üretilecek' : `•••• (${i.length} karakter)`}</td>
                    <td className="small" style={{ color: ACTION[i.action][1] }}>
                      {ACTION[i.action][0]}
                      {i.note ? ` · ${i.note}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.issues.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="small">{r.issues.length} uyarı</summary>
              {r.issues.map((i, n) => (
                <div key={n} className="small muted">
                  Satır {i.line}
                  {i.name ? ` (${i.name})` : ''}: {i.reason}
                </div>
              ))}
            </details>
          )}
          {r.origin.kind === 'history' && r.external.length > 0 && (
            <div className="ai-note small" style={{ marginTop: 10 }}>
              Bu değerler Git geçmişinde açık kaldı ve Project Hub dışındaki servislerde tanımlı; ilgili serviste (veritabanı, mail, bulut) yenileyip burada güncelleyin: <span className="mono">{r.external.join(', ')}</span>
            </div>
          )}
        </>
      )}
      {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
    </Drawer>
  );
}
