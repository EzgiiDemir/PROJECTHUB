'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { FINDING_TYPE } from '@/lib/labels';
import type { Finding } from '@/lib/types';
import { Async, Empty, Kpi, PageHeader, Panel, ScoreBar, scoreColor, StatusBadge } from '@/components/ui';
import { AutofixStatus } from '@/components/autofix';
import { useMe } from '@/lib/hooks';
import { useToast } from '@/components/toast';

interface Center {
  score: number | null;
  counts: Record<string, number>;
  projects: { id: string; name: string; slug: string; score: number | null }[];
  findings: Finding[];
}

/** Organization security center (spec §101): open findings across every project the user can see. */
export default function SecurityCenterPage() {
  const router = useRouter();
  const [severity, setSeverity] = useState('');
  const q = useQuery({ queryKey: ['securityCenter'], queryFn: () => api<Center>('/security/center') });
  const qc = useQueryClient();
  const toast = useToast();
  const canFix = !!useMe().data?.permissions.includes('ai.execute');
  // One click: every project's planned fixes start (package upgrades run the real package manager on an AI branch,
  // are verified by build + tests + re-scan, and low-risk ones merge themselves).
  const fixAll = useMutation({
    mutationFn: () => api<{ created: number; projects: { name: string; created: number; error?: string }[] }>('/security/autofix', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      const failed = r.projects.filter((p) => p.error);
      toast(r.created ? `${r.created} düzeltme başladı; ilerlemeyi aşağıda canlı izleyebilirsiniz` : 'Yeni düzeltme yok: açık bulgular için düzeltmeler zaten sürüyor veya otomatik düzeltilemiyor', failed.length ? 'bad' : 'info');
      void qc.invalidateQueries({ queryKey: ['autofix'] });
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <div className="page">
      <PageHeader
        title="Güvenlik merkezi"
        sub="Tüm projelerdeki açık bulgular. Kritik bulgusu olan projeler production'a çıkamaz."
        actions={
          canFix ? (
            <button className="btn pri" onClick={() => fixAll.mutate()} disabled={fixAll.isPending}>
              {fixAll.isPending ? <span className="spinner" /> : <Sparkles />} Tümünü AI ile düzelt
            </button>
          ) : undefined
        }
      />
      <Async q={q} rows={6}>
        {(c) => {
          const rows = severity ? c.findings.filter((f) => f.severity === severity) : c.findings;
          return (
            <>
              <div className="grid g6" style={{ marginBottom: 14 }}>
                <Kpi value={c.score ?? '—'} color={scoreColor(c.score)} label="Ortalama skor" />
                <Kpi value={c.counts.critical ?? 0} label="Kritik" tone={c.counts.critical ? 'bad' : undefined} />
                <Kpi value={c.counts.high ?? 0} label="Yüksek" tone={c.counts.high ? 'bad' : undefined} />
                <Kpi value={c.counts.medium ?? 0} label="Orta" tone={c.counts.medium ? 'warn' : undefined} />
                <Kpi value={c.counts.low ?? 0} label="Düşük" />
                <Kpi value={c.projects.length} label="Proje" />
              </div>
              <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px', alignItems: 'start' }}>
                <div>
                  <div className="row" style={{ marginBottom: 10 }}>
                    {[
                      ['', 'Tümü'],
                      ['critical', 'Kritik'],
                      ['high', 'Yüksek'],
                      ['medium', 'Orta'],
                      ['low', 'Düşük'],
                    ].map(([k, l]) => (
                      <button key={k} className={`chip ${severity === k ? 'on' : ''}`} onClick={() => setSeverity(k!)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  {rows.length ? (
                    <Panel flush>
                      <div className="tbl">
                        <table>
                          <thead>
                            <tr>
                              <th>Önem</th>
                              <th>Bulgu</th>
                              <th>Proje</th>
                              <th>Tür</th>
                              <th>Son görülme</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((f) => (
                              <tr key={f.id} className="click" onClick={() => router.push(`/projects/${f.projectSlug}/security?finding=${f.id}`)}>
                                <td>
                                  <StatusBadge status={f.severity} />
                                </td>
                                <td style={{ maxWidth: 420 }}>
                                  <div className="ellipsis">
                                    <span className="mono small muted">{f.key}</span> {f.title}
                                  </div>
                                  <div className="small muted mono ellipsis">{f.packageName ? `${f.packageName}@${f.packageVersion}${f.fixedVersion ? ` → ${f.fixedVersion}` : ''}` : f.filePath ? `${f.filePath}${f.line ? `:${f.line}` : ''}` : ''}</div>
                                </td>
                                <td className="small">{f.projectName}</td>
                                <td className="small">{FINDING_TYPE[f.type]}</td>
                                <td className="small muted">{ago(f.lastSeenAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  ) : (
                    <Empty title="Açık bulgu yok" />
                  )}
                </div>
                <div>
                  <Panel title="Proje skorları">
                    {[...c.projects]
                      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))
                      .map((p) => (
                        <Link key={p.id} href={`/projects/${p.slug}/security`} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
                          <ScoreBar label={p.name} value={p.score} />
                        </Link>
                      ))}
                  </Panel>
                  {c.projects.map((p) => (
                    <div key={p.id}>
                      {c.projects.length > 1 && <div className="small muted" style={{ margin: '14px 0 -6px' }}>{p.name}</div>}
                      <AutofixStatus slug={p.slug} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}
