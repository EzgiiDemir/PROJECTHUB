'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronDown, ChevronRight, CircleDot, ExternalLink, Info, Lock, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { remediationFor } from '@/lib/remediation';
import type { Finding as BaseFinding } from '@/lib/types';

type Finding = BaseFinding & { number: number };
import { CopyButton, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';
import { EnvImportDrawer } from '@/components/env-import';

type StepStatus = 'todo' | 'queued' | 'running' | 'verifying' | 'needs_approval' | 'failed' | 'done' | 'blocked' | 'info';
interface Step {
  id: string;
  phase: 'setup' | 'security' | 'quality' | 'release';
  title: string;
  explain: string;
  status: StepStatus;
  severity?: string;
  action?: { kind: 'autofix'; key: string; label: string } | { kind: 'trust'; label: string } | { kind: 'build'; label: string } | { kind: 'scan'; label: string } | { kind: 'link'; href: string; label: string } | { kind: 'reverify'; taskId: string; label: string } | { kind: 'envimport'; source: 'text' | 'history'; label: string };
  method?: string;
  risk?: 'low' | 'medium' | 'high';
  autoMerge?: boolean;
  details?: string[];
  findings?: Finding[];
  task?: { id: string; key: string; status: string; queuedAt?: string; startedAt?: string | null; verdict?: { status: string; reasons: string[] } | null; error?: string | null };
  reason?: string;
}
interface Assistant {
  steps: Step[];
  summary: { total: number; done: number; todo: number; queued?: number; inProgress: number; manual: number };
  fixAllKeys: string[];
  autoMode: boolean;
  autoMergeLowRisk: boolean;
  aiReady: boolean;
  canFix: boolean;
}

const PHASES: [Step['phase'], string][] = [
  ['setup', 'Kurulum'],
  ['security', 'Güvenlik'],
  ['quality', 'Kalite'],
  ['release', 'Yayın'],
];
const SEV: Record<string, [string, string]> = { critical: ['Kritik', 'failed'], high: ['Yüksek', 'failed'], medium: ['Orta', 'warning'], low: ['Düşük', 'queued'], info: ['Bilgi', 'queued'] };
const STATUS_TEXT: Record<StepStatus, string> = { todo: 'Yapılacak', queued: 'Sırada — henüz başlamadı', running: 'AI çalışıyor', verifying: 'Doğrulanıyor', needs_approval: 'Doğrulandı, onayınızı bekliyor', failed: 'Doğrulanamadı — nedenini görmek için açın', done: 'Tamam', blocked: 'Önce önceki adım', info: 'Elle yapılacak' };
const RISK: Record<string, string> = { low: 'düşük risk', medium: 'orta risk', high: 'yüksek risk' };

function taskDuration(step: Step): string {
  const since = step.status === 'queued' ? step.task?.queuedAt : step.status === 'running' ? step.task?.startedAt : undefined;
  if (!since) return '';
  const elapsed = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return '';
  const seconds = Math.floor(elapsed / 1000);
  return ` · ${seconds < 60 ? `${seconds} sn` : `${Math.floor(seconds / 60)} dk`}`;
}

/**
 * Project assistant: everything that needs doing for this project, in order, each with what it is, where it is and
 * the button that fixes it — so nobody has to hunt through security, dependency and build pages.
 */
export function ProjectAssistant({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['assistant', slug],
    queryFn: () => api<Assistant>(`/projects/${slug}/assistant`),
    refetchInterval: (query) => (query.state.data?.steps.some((s) => s.status === 'queued' || s.status === 'running' || s.status === 'verifying') ? 5000 : false),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [envImport, setEnvImport] = useState<'text' | 'history' | null>(null);
  const refresh = () => {
    for (const k of ['assistant', 'autofix', 'security', 'overview', 'project']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const fix = useMutation({
    mutationFn: (keys: string[]) => api<{ created: { key: string }[] }>(`/projects/${slug}/autofix`, { method: 'POST', body: { keys } }),
    onSuccess: (r) => {
      toast(r.created.length ? `${r.created.length} düzeltme başladı; ilerlemeyi bu listeden izleyebilirsiniz` : 'Başlatılacak düzeltme kalmadı');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const trust = useMutation({
    mutationFn: () => api(`/projects/${slug}`, { method: 'PATCH', body: { executionTrust: 'trusted' } }),
    onSuccess: () => {
      toast('Kaynak kod güvenilir olarak onaylandı');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const build = useMutation({
    mutationFn: () => api(`/projects/${slug}/builds`, { method: 'POST', body: { createPreview: true } }),
    onSuccess: () => {
      toast('Build başladı');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const scan = useMutation({
    mutationFn: () => api(`/projects/${slug}/security/scans`, { method: 'POST' }),
    onSuccess: () => {
      toast('Tarama başladı');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const reverify = useMutation({
    mutationFn: (taskId: string) => api(`/ai/tasks/${taskId}/reverify`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast('Doğrulama yeniden başladı: build, testler ve tarama çalışıyor');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const auto = useMutation({
    mutationFn: (enabled: boolean) => api(`/projects/${slug}/assistant/auto`, { method: 'POST', body: { enabled } }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const approve = useMutation({
    mutationFn: () => api<{ approved: string[]; failed: { reason: string }[] }>(`/projects/${slug}/autofix/approve-verified`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      toast(`${r.approved.length} düzeltme birleştirildi${r.failed.length ? ` · ${r.failed.length} birleştirilemedi: ${r.failed[0]!.reason}` : ''}`, r.failed.length ? 'bad' : 'info');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  if (q.error) {
    return (
      <section className="assistant" id="asistan">
        <div className="badbox">
          Proje Asistanı yüklenemedi: {errorMessage(q.error)}{' '}
          <button className="btn sm" onClick={() => void q.refetch()}>Tekrar dene</button>
        </div>
      </section>
    );
  }
  if (!q.data) return null;
  const a = q.data;
  const ordered = PHASES.flatMap(([p]) => a.steps.filter((s) => s.phase === p));
  const next = ordered.find((s) => s.status === 'todo' || s.status === 'needs_approval') ?? ordered.find((s) => s.status === 'blocked');
  const expanded = open ?? next?.id ?? null;
  const pct = a.summary.total ? Math.round((a.summary.done / a.summary.total) * 100) : 100;
  const approvals = a.steps.filter((s) => s.status === 'needs_approval').length;
  const run = (s: Step) => {
    const act = s.action!;
    if (act.kind === 'autofix') fix.mutate([act.key]);
    else if (act.kind === 'trust') {
      if (window.confirm('Bu projenin kaynak kodunu ve build betiklerini tanıyor musunuz? Onaydan sonra build, test ve paket güncellemeleri sunucuda çalışabilir.')) trust.mutate();
    } else if (act.kind === 'build') build.mutate();
    else if (act.kind === 'scan') scan.mutate();
    else if (act.kind === 'reverify') reverify.mutate(act.taskId);
    else if (act.kind === 'envimport') setEnvImport(act.source);
  };
  const busy = fix.isPending || trust.isPending || build.isPending || scan.isPending || reverify.isPending;
  let n = 0;

  return (
    <section className="assistant" id="asistan">
      <div className="assistant-head">
        <div>
          <h3>
            <Sparkles size={18} /> Proje Asistanı
          </h3>
          <p className="small muted" style={{ margin: '2px 0 0' }}>
            {a.summary.todo + (a.summary.queued ?? 0) + a.summary.inProgress + approvals === 0
              ? 'Her şey yolunda. Yeni bir sorun çıktığında burada sırayla göstereceğim.'
              : `${a.summary.todo} adım yapılacak${a.summary.queued ? `, ${a.summary.queued} iş sırada` : ''}${a.summary.inProgress ? `, ${a.summary.inProgress} iş çalışıyor` : ''}${approvals ? `, ${approvals} iş onay bekliyor` : ''}${a.summary.manual ? `, ${a.summary.manual} adım elle yapılacak` : ''}.`}
          </p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {a.canFix && approvals > 0 && (
            <button className="btn" onClick={() => approve.mutate()} disabled={approve.isPending}>
              <Check /> Doğrulananları onayla ({approvals})
            </button>
          )}
          {a.canFix && a.fixAllKeys.length > 0 && (
            <button className="btn pri" onClick={() => fix.mutate(a.fixAllKeys)} disabled={busy}>
              {fix.isPending ? <span className="spinner" /> : <Sparkles />} Hepsini sırayla düzelt ({a.fixAllKeys.length})
            </button>
          )}
        </div>
      </div>
      <div className="assistant-progress" title={`${a.summary.done}/${a.summary.total} adım tamam`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="row small muted" style={{ justifyContent: 'space-between', flexWrap: 'wrap', margin: '6px 0 4px' }}>
        <span>
          {a.summary.done}/{a.summary.total} adım tamam
        </span>
        {a.canFix && (
          <label className="check" title="AI her sorunu kendisi hazırlar ve build, test ve taramayla doğrular. Düşük riskliler kendiliğinden birleşir; diğerleri yalnızca son onayınızı bekler.">
            <input type="checkbox" checked={a.autoMode} onChange={(e) => auto.mutate(e.target.checked)} /> Otomatik: AI hepsini hazırlasın, ben yalnızca onaylayayım
          </label>
        )}
      </div>
      {!a.aiReady && <div className="warnbox small" style={{ margin: '6px 0' }}>Yerel AI modeli şu an hazır değil: paket ve dosya düzeltmeleri yine yapılır; kod düzeltmeleri model hazır olunca açılır.</div>}

      {PHASES.map(([phase, label]) => {
        const steps = a.steps.filter((s) => s.phase === phase);
        if (!steps.length) return null;
        return (
          <div key={phase} className="assistant-phase">
            <div className="assistant-phase-title">{label}</div>
            {steps.map((s) => {
              n++;
              const isOpen = expanded === s.id;
              return (
                <div key={s.id} className={`assistant-step st-${s.status}${isOpen ? ' open' : ''}`}>
                  <button className="assistant-row" onClick={() => setOpen(isOpen ? '__none' : s.id)} aria-expanded={isOpen}>
                    <span className="assistant-num">{s.status === 'done' ? <Check size={14} /> : s.status === 'running' || s.status === 'verifying' ? <span className="spinner" /> : s.status === 'blocked' ? <Lock size={13} /> : s.status === 'failed' ? <X size={13} /> : s.status === 'info' ? <Info size={14} /> : n}</span>
                    <span className="assistant-title">
                      {s.title}
                      <span className="small muted"> · {STATUS_TEXT[s.status]}{taskDuration(s)}</span>
                    </span>
                    {s.severity && <StatusBadge status={SEV[s.severity]?.[1] ?? 'queued'} label={SEV[s.severity]?.[0] ?? s.severity} />}
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  {isOpen && (
                    <div className="assistant-body">
                      <p style={{ marginTop: 0 }}>{s.explain}</p>
                      {s.method && (
                        <p className="small">
                          <b>Nasıl düzeltilecek:</b> {s.method}
                          {s.risk && ` · ${RISK[s.risk]}`}
                          {s.autoMerge !== undefined && (s.autoMerge ? ' · build, testler ve yeniden tarama geçince kendiliğinden birleşir' : ' · doğrulandıktan sonra onayınıza gelir')}
                        </p>
                      )}
                      {s.details && s.details.length > 0 && (
                        <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                          {s.details.map((d, i) => (
                            <li key={i}>{d}</li>
                          ))}
                        </ul>
                      )}
                      {s.reason && (
                        <div className="warnbox small" style={{ margin: '0 0 8px' }}>
                          {s.reason}
                        </div>
                      )}
                      {s.task?.verdict && s.task.verdict.reasons.length > 0 && (
                        <div className={s.task.verdict.status === 'failed' ? 'badbox small' : 'okbox small'} style={{ margin: '0 0 8px' }}>
                          {s.task.verdict.reasons.map((r, i) => (
                            <div key={i}>{r}</div>
                          ))}
                        </div>
                      )}
                      {s.task?.error && <div className="badbox small">{s.task.error}</div>}
                      {s.findings && s.findings.length > 0 && <FindingList slug={slug} findings={s.findings} manual={s.status === 'info'} />}
                      <div className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
                        {s.action && s.action.kind !== 'link' && (a.canFix || s.action.kind === 'envimport') && (s.status !== 'blocked' || s.action.kind === 'reverify') && (
                          <button className="btn pri" onClick={() => run(s)} disabled={busy}>
                            {s.action.kind === 'autofix' ? <Sparkles /> : <CircleDot />} {s.action.label}
                          </button>
                        )}
                        {s.action?.kind === 'link' && (
                          <Link className="btn pri" href={s.action.href}>
                            {s.action.label}
                          </Link>
                        )}
                        <Link className="btn" href={`/projects/${slug}/ai?ask=${encodeURIComponent(askFor(s))}`}>
                          <Bot /> AI&apos;ya sor
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {envImport && <EnvImportDrawer slug={slug} source={envImport} onClose={() => { setEnvImport(null); refresh(); }} />}
    </section>
  );
}

function FindingList({ slug, findings, manual }: { slug: string; findings: Finding[]; manual: boolean }) {
  const [how, setHow] = useState<string | null>(manual ? findings[0]?.id ?? null : null);
  return (
    <div className="assistant-findings">
      {findings.slice(0, 12).map((f) => {
        const r = remediationFor(f, slug);
        return (
          <div key={f.id} className="assistant-finding">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="mono small muted">SEC-{f.number}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small">{f.title}</div>
                {f.filePath && (
                  <Link className="small mono" href={`/projects/${slug}/code?path=${encodeURIComponent(f.filePath)}${f.line ? `&line=${f.line}` : ''}`}>
                    {f.filePath}
                    {f.line ? `:${f.line}` : ''}
                  </Link>
                )}
              </div>
              <button className="btn sm ghost" onClick={() => setHow(how === f.id ? null : f.id)}>
                {how === f.id ? 'Gizle' : 'Nasıl yapılır?'}
              </button>
            </div>
            {how === f.id && (
              <div className="assistant-how small">
                <ol style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {r.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
                {r.command && (
                  <div className="row" style={{ alignItems: 'center' }}>
                    <code className="small" style={{ flex: 1, overflowX: 'auto' }}>{r.command.text}</code>
                    <CopyButton text={r.command.text} />
                  </div>
                )}
                {r.links.length > 0 && (
                  <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                    {r.links.map((l) =>
                      l.external ? (
                        <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
                          {l.label} <ExternalLink size={11} />
                        </a>
                      ) : (
                        <Link key={l.href} href={l.href}>
                          {l.label}
                        </Link>
                      ),
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {findings.length > 12 && <div className="small muted">… ve {findings.length - 12} bulgu daha</div>}
    </div>
  );
}

/** A ready question for the project AI, grounded in this step. */
function askFor(s: Step): string {
  const items = (s.findings ?? []).slice(0, 5).map((f) => `SEC-${f.number} ${f.title}${f.filePath ? ` (${f.filePath}${f.line ? `:${f.line}` : ''})` : ''}`);
  return [`"${s.title}" adımını basit bir dille açıkla: sorun nedir, projemi nasıl etkiler ve nasıl düzeltirim?`, ...items].join('\n');
}


