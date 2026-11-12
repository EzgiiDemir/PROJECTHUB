'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { Modal, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface PlanItem {
  key: string;
  title: string;
  kind: 'dependency' | 'secret' | 'code' | 'build' | 'docs';
  mode: 'dependency' | 'files' | 'agent';
  risk: 'low' | 'medium' | 'high';
  autoMerge: boolean;
  details: string[];
}
interface Plan {
  items: PlanItem[];
  skipped: { title: string; reason: string }[];
  autoMergeLowRisk: boolean;
  summary: { automatic: number; approval: number; skipped: number };
}
interface Fix {
  id: string;
  key: string;
  title: string;
  status: string;
  error: string | null;
  createdAt: string;
  buildId: string | null;
  autofix: { risk: 'low' | 'medium' | 'high'; kind: string; verdict?: { status: 'merged' | 'needs_approval' | 'failed'; reasons: string[] } };
}

const RISK: Record<string, string> = { low: 'Düşük risk', medium: 'Orta risk', high: 'Yüksek risk' };
const METHOD: Record<string, string> = {
  dependency: 'Paket yöneticisiyle güvenli sürüme yükseltme',
  files: 'Dosyaları repodan kaldırıp .gitignore’a ekleme',
  agent: 'Yerel AI kodu düzeltir',
};

/** "Tümünü AI ile düzelt": plan → start → live status, with one-click approval for proven fixes that need a person. */
export function AutofixButton({ slug, label = 'Tümünü AI ile düzelt' }: { slug: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn pri" onClick={() => setOpen(true)}>
        <Sparkles /> {label}
      </button>
      {open && <AutofixDialog slug={slug} onClose={() => setOpen(false)} />}
    </>
  );
}

function AutofixDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['autofixPlan', slug], queryFn: () => api<Plan>(`/projects/${slug}/autofix/plan`) });
  const start = useMutation({
    mutationFn: () => api<{ created: { key: string }[] }>(`/projects/${slug}/autofix`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      toast(`${r.created.length} düzeltme görevi başladı`);
      void qc.invalidateQueries({ queryKey: ['autofix', slug] });
      onClose();
    },
  });
  const p = plan.data;
  const auto = p?.items.filter((i) => i.autoMerge) ?? [];
  const manual = p?.items.filter((i) => !i.autoMerge) ?? [];
  return (
    <Modal
      title="Sorunları AI ile düzelt"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn pri" disabled={!p?.items.length || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? <span className="spinner" /> : <Sparkles />} Düzeltmeyi başlat ({p?.items.length ?? 0})
          </button>
        </>
      }
    >
      {plan.isLoading ? (
        <span className="spinner" />
      ) : plan.error ? (
        <div className="badbox">{errorMessage(plan.error)}</div>
      ) : !p?.items.length && !p?.skipped.length ? (
        <p className="muted">Şu an AI ile düzeltilecek açık sorun yok.</p>
      ) : (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            Her düzeltme ayrı bir AI branch&apos;inde hazırlanır, ardından projenin build&apos;i ve testleri çalışır ve proje yeniden taranır.{' '}
            {p?.autoMergeLowRisk ? 'Sorunun gerçekten gittiği kanıtlanan düşük riskli düzeltmeler kendiliğinden birleşir; diğerleri onayınızı bekler.' : 'Otomatik birleştirme kapalı; tüm düzeltmeler onayınızı bekler.'}
          </p>
          {auto.length > 0 && <PlanGroup title={`Doğrulanınca otomatik birleşecek · ${auto.length}`} items={auto} />}
          {manual.length > 0 && <PlanGroup title={`Doğrulandıktan sonra onayınıza sunulacak · ${manual.length}`} items={manual} />}
          {p!.skipped.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Otomatik düzeltilemeyenler · {p!.skipped.length}</h4>
              {p!.skipped.map((s, i) => (
                <div key={i} className="list-item small">
                  <span style={{ flex: 1 }}>{s.title}</span>
                  <span className="muted">{s.reason}</span>
                </div>
              ))}
            </>
          )}
          {start.error && <div className="badbox">{errorMessage(start.error)}</div>}
        </>
      )}
    </Modal>
  );
}

function PlanGroup({ title, items }: { title: string; items: PlanItem[] }) {
  return (
    <>
      <h4 style={{ margin: '14px 0 6px' }}>{title}</h4>
      {items.map((i) => (
        <div key={i.key} className="list-item" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{i.title}</b>
            <div className="small muted">{METHOD[i.mode]}</div>
            {i.details.slice(0, 4).map((d, n) => (
              <div key={n} className="small">· {d}</div>
            ))}
          </div>
          <StatusBadge status={i.risk === 'low' ? 'passed' : i.risk === 'medium' ? 'warning' : 'failed'} label={RISK[i.risk]} />
        </div>
      ))}
    </>
  );
}

/** Live list of auto-fix tasks with what verification decided; renders nothing until the first run. */
export function AutofixStatus({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['autofix', slug],
    queryFn: () => api<Fix[]>(`/projects/${slug}/autofix`),
    refetchInterval: (query) => (query.state.data?.some((f) => f.status === 'queued' || f.status === 'running' || (f.status === 'awaiting_approval' && !f.autofix.verdict)) ? 4000 : false),
  });
  const approve = useMutation({
    mutationFn: () => api<{ approved: string[]; failed: { reason: string }[] }>(`/projects/${slug}/autofix/approve-verified`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      toast(`${r.approved.length} düzeltme birleştirildi${r.failed.length ? ` · ${r.failed.length} birleştirilemedi: ${r.failed[0]!.reason}` : ''}`, r.failed.length ? 'bad' : 'info');
      void qc.invalidateQueries({ queryKey: ['autofix', slug] });
      void qc.invalidateQueries({ queryKey: ['security', slug] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const rows = (q.data ?? []).slice(0, 12);
  if (q.error) return <div className="badbox small">Otomatik düzeltme durumu alınamadı: {errorMessage(q.error)}</div>;
  if (!rows.length) return null;
  const verified = rows.filter((f) => f.status === 'awaiting_approval' && f.autofix.verdict?.status === 'needs_approval').length;
  return (
    <Panel
      title="AI ile otomatik düzeltme"
      flush
      className="mt"
      actions={
        verified > 0 ? (
          <button className="btn sm pri" onClick={() => approve.mutate()} disabled={approve.isPending}>
            Doğrulananları onayla ({verified})
          </button>
        ) : undefined
      }
    >
      {rows.map((f) => (
        <div key={f.id} className="list-item" style={{ alignItems: 'flex-start' }}>
          <span className="mono small">{f.key}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Link href={`/projects/${slug}/ai/tasks/${f.id}`}>{f.title}</Link>
            <div className="small muted">{phase(f)} · {ago(f.createdAt)}</div>
            {f.autofix.verdict && f.autofix.verdict.status !== 'merged' && f.autofix.verdict.reasons.map((r, i) => <div key={i} className="small">· {r}</div>)}
            {f.status === 'failed' && f.error && <div className="small" style={{ color: 'var(--bad)' }}>{f.error}</div>}
          </div>
          <StatusBadge status={badge(f)} label={badgeLabel(f)} />
        </div>
      ))}
    </Panel>
  );
}

function phase(f: Fix) {
  if (f.status === 'queued') return 'Sırada';
  if (f.status === 'running') return 'Düzeltme hazırlanıyor';
  if (f.status === 'awaiting_approval' && !f.autofix.verdict) return f.buildId ? 'Build, testler ve yeniden tarama çalışıyor' : 'Güvenlik taramasıyla doğrulanıyor (tam build gerekmedi)';
  return RISK[f.autofix.risk] ?? '';
}
function badge(f: Fix) {
  if (f.status === 'merged') return 'passed';
  if (f.status === 'failed' || f.autofix.verdict?.status === 'failed') return 'failed';
  if (f.status === 'rejected' || f.status === 'cancelled') return 'cancelled';
  return f.autofix.verdict?.status === 'needs_approval' ? 'warning' : 'running';
}
function badgeLabel(f: Fix) {
  if (f.status === 'merged') return f.autofix.verdict?.status === 'merged' ? 'Otomatik birleşti' : 'Birleşti';
  if (f.status === 'failed') return 'Başarısız';
  if (f.status === 'rejected') return 'Reddedildi';
  if (f.status === 'cancelled') return 'İptal';
  if (f.autofix.verdict?.status === 'failed') return 'Doğrulanamadı';
  if (f.autofix.verdict?.status === 'needs_approval') return 'Onay bekliyor';
  return 'Çalışıyor';
}
