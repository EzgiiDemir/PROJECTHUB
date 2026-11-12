'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { bytes, dateTime, duration, shortSha } from '@/lib/format';
import { useMe, useProject, useProjectSlug } from '@/lib/hooks';
import { ADAPTER, ENV_TYPE } from '@/lib/labels';
import type { Deployment, DeploymentDetail } from '@/lib/types';
import { Async, ConfirmDialog, KeyValue, LogView, Modal, Panel, Pipeline, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function DeploymentDetailPage() {
  const { deploymentId } = useParams<{ deploymentId: string }>();
  const slug = useProjectSlug();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject().data;
  const me = useMe().data;
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [rollingBack, setRollingBack] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileOutcome, setReconcileOutcome] = useState<'confirmed_current' | 'confirmed_previous' | 'confirmed_failed'>('confirmed_current');
  const [reconcileComment, setReconcileComment] = useState('');
  const q = useQuery({
    queryKey: ['deployment', deploymentId],
    queryFn: () => api<DeploymentDetail>(`/deployments/${deploymentId}`),
    refetchInterval: (query) => (query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['deployment', deploymentId] });
    void qc.invalidateQueries({ queryKey: ['deployments'] });
  };
  const decide = useMutation({
    mutationFn: (kind: 'approve' | 'reject') => api(`/deployments/${deploymentId}/${kind}`, { method: 'POST', body: { comment: comment || undefined } }),
    onSuccess: (_, kind) => {
      toast(kind === 'approve' ? 'Onay kaydedildi' : 'Deployment reddedildi');
      setDecision(null);
      setComment('');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const cancel = useMutation({ mutationFn: () => api(`/deployments/${deploymentId}/cancel`, { method: 'POST' }), onSuccess: () => (toast('Deployment iptal edildi'), refresh()), onError: (e) => toast(errorMessage(e), 'bad') });
  const rollback = useMutation({
    mutationFn: () => api<Deployment>(`/deployments/${deploymentId}/rollback`, { method: 'POST' }),
    onSuccess: (d) => {
      setRollingBack(false);
      router.push(`/projects/${slug}/deployments/${d.id}`);
    },
    onError: (e) => {
      setRollingBack(false);
      toast(errorMessage(e), 'bad');
    },
  });
  const reconcile = useMutation({
    mutationFn: () => api<DeploymentDetail>(`/deployments/${deploymentId}/reconcile`, { method: 'POST', body: { outcome: reconcileOutcome, comment: reconcileComment } }),
    onSuccess: () => {
      setReconciling(false);
      setReconcileComment('');
      toast('Ortam durumu uzlaştırıldı');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  return (
    <Async q={q} rows={6}>
      {(d) => {
        const canDeploy = !!project?.permissions.includes(d.environment.type === 'production' ? 'deployment.production' : 'deployment.staging');
        const canReconcile = !!project?.permissions.includes('deployment.approve') && (d.environment.type !== 'production' || !!project?.permissions.includes('deployment.production'));
        const approvals = d.approvals.filter((a) => a.decision === 'approved').length;
        return (
          <>
            <div className="spread" style={{ marginBottom: 12 }}>
              <div>
                <div className="small muted">
                  <Link href={`/projects/${slug}/deployments`}>Deployment&apos;lar</Link> /
                </div>
                <h2 style={{ margin: '2px 0 4px' }} className="row">
                  {d.key} · {d.environment.name} · v{d.version.version} <StatusBadge status={d.status} />
                </h2>
                <p className="sub" style={{ margin: 0 }}>
                  {d.requestedByName ?? 'sistem'} · {dateTime(d.createdAt)}
                  {d.isRollback && ' · geri alma'}
                </p>
              </div>
              <div className="row">
                {d.status === 'pending_approval' && d.canApprove && (
                  <>
                    <button className="btn" onClick={() => setDecision('reject')}>
                      <X /> Reddet
                    </button>
                    <button className="btn pri" onClick={() => setDecision('approve')}>
                      <Check /> Onayla
                    </button>
                  </>
                )}
                {['pending_approval', 'queued'].includes(d.status) && (d.requestedBy === me?.user.id || project?.permissions.includes('deployment.approve')) && (
                  <button className="btn" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                    İptal et
                  </button>
                )}
                {d.status === 'succeeded' && canDeploy && !d.isRollback && (
                  <button className="btn" onClick={() => setRollingBack(true)}>
                    <RotateCcw /> Önceki sürüme dön
                  </button>
                )}
              </div>
            </div>
            {d.status === 'pending_approval' && (
              <div className="warnbox" style={{ marginBottom: 14 }}>
                Onay bekliyor: {approvals}/{d.environment.requiredApprovals}. İsteyen kişi kendi deployment&apos;ını onaylayamaz.
              </div>
            )}
            {d.error && <div className="badbox" style={{ marginBottom: 14 }}>{d.error}</div>}
            {d.workflow?.status === 'needs_reconciliation' && (
              <div className="warnbox spread" style={{ marginBottom: 14, gap: 16 }}>
                <div>
                  <b>Canlı ortamın gerçek durumu kesin değil.</b>
                  <div className="small" style={{ marginTop: 4 }}>Worker kesintisi hedefe dokunulduktan sonra gerçekleşmiş olabilir. Ortamı kontrol edip çalışan sürümü kayda geçirin.</div>
                </div>
                {canReconcile && <button className="btn" onClick={() => setReconciling(true)}>Durumu doğrula</button>}
              </div>
            )}
            {d.policyOverride && (
              <div className="warnbox" style={{ marginBottom: 14 }}>
                <b>Güvenlik politikası istisnası:</b> {d.policyOverride.by} — “{d.policyOverride.reason}”
              </div>
            )}
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
              <Panel title="Log">{d.log ? <LogView text={d.log} /> : <p className="small muted">{d.status === 'pending_approval' ? 'Onaydan sonra başlar.' : 'Log yok.'}</p>}</Panel>
              <div className="grid" style={{ gap: 14 }}>
                <Panel title="Adımlar">{d.steps.length ? <Pipeline steps={d.steps} /> : <p className="small muted">Henüz başlamadı.</p>}</Panel>
                {d.workflow && (
                  <Panel title="Workflow ve kanıt">
                    <KeyValue
                      items={[
                        ['Durum', <StatusBadge key="s" status={d.workflow.status} />],
                        ['Aşama', d.workflow.phase ?? '—'],
                        ['Kanıt', `${d.workflow.evidenceCount} kayıt`],
                        ['Korelasyon', <span key="c" className="mono small">{d.workflow.correlationId.slice(0, 8)}</span>],
                      ]}
                    />
                    {d.workflow.policyDecisions.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <b className="small">Policy kararları</b>
                        {d.workflow.policyDecisions.map((p) => (
                          <div key={p.id} className="spread small" style={{ padding: '7px 0', borderTop: '1px solid var(--line)', gap: 8 }} title={p.reasons.join(' · ')}>
                            <span className="mono">{p.policyKey}</span>
                            <StatusBadge status={p.decision} />
                          </div>
                        ))}
                      </div>
                    )}
                    {d.workflow.verifications.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        {d.workflow.verifications.map((v) => (
                          <div key={v.id} className="spread small" style={{ padding: '7px 0', borderTop: '1px solid var(--line)', gap: 8 }}>
                            <span>{v.summary}</span>
                            <StatusBadge status={v.status} />
                          </div>
                        ))}
                      </div>
                    )}
                  </Panel>
                )}
                <Panel title="Ayrıntılar">
                  <KeyValue
                    items={[
                      ['Ortam', `${d.environment.name} (${ENV_TYPE[d.environment.type] ?? d.environment.type})`],
                      ['Adres', d.environment.url ? <a key="u" href={d.environment.url} target="_blank" rel="noreferrer" className="mono small">{d.environment.url}</a> : '—'],
                      ['Versiyon', <Link key="v" href={`/projects/${slug}/versions`}>v{d.version.version}</Link>],
                      ['Commit', <span key="c" className="mono">{shortSha(d.version.commitSha)}</span>],
                      ['Yöntem', d.adapter ? ADAPTER[d.adapter] : '—'],
                      ['Başladı', dateTime(d.startedAt)],
                      ['Süre', d.startedAt && d.finishedAt ? duration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : '—'],
                    ]}
                  />
                </Panel>
                {d.approvals.length > 0 && (
                  <Panel title="Onaylar" flush>
                    {d.approvals.map((a) => (
                      <div key={a.id} className="list-item">
                        <div style={{ flex: 1 }}>
                          <b>{a.userName}</b> <StatusBadge status={a.decision} />
                          {a.comment && <div className="small muted">{a.comment}</div>}
                        </div>
                        <span className="small muted">{dateTime(a.createdAt)}</span>
                      </div>
                    ))}
                  </Panel>
                )}
                {d.backups.length > 0 && (
                  <Panel title="Yedekler" flush>
                    {d.backups.map((b) => (
                      <div key={b.id} className="list-item">
                        <span style={{ flex: 1 }}>
                          {b.type} · {bytes(b.sizeBytes)}
                        </span>
                        <StatusBadge status={b.status} />
                      </div>
                    ))}
                  </Panel>
                )}
                <Panel title="Sürüm notları">
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{d.version.releaseNotes || '—'}</div>
                </Panel>
              </div>
            </div>
            {decision && (
              <Modal
                title={decision === 'approve' ? 'Deployment onayı' : 'Deployment reddi'}
                onClose={() => setDecision(null)}
                footer={
                  <>
                    <button className="btn" onClick={() => setDecision(null)}>
                      Vazgeç
                    </button>
                    <button className={`btn ${decision === 'approve' ? 'pri' : 'danger solid'}`} disabled={decide.isPending} onClick={() => decide.mutate(decision)}>
                      {decision === 'approve' ? 'Onayla' : 'Reddet'}
                    </button>
                  </>
                }
              >
                <p style={{ marginTop: 0 }}>
                  <b>v{d.version.version}</b> → <b>{d.environment.name}</b>
                </p>
                <textarea className="in" placeholder="Yorum (isteğe bağlı)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
              </Modal>
            )}
            {rollingBack && (
              <ConfirmDialog
                title="Önceki sürüme dön"
                message={`${d.environment.name} ortamı bu deployment'tan önceki başarılı sürüme döndürülür. Veritabanı migration'ları geri alınmaz; gerekiyorsa yedekten dönün.`}
                actionLabel="Geri al"
                busy={rollback.isPending}
                onConfirm={() => rollback.mutate()}
                onClose={() => setRollingBack(false)}
              />
            )}
            {reconciling && (
              <Modal
                title="Canlı ortamı uzlaştır"
                onClose={() => setReconciling(false)}
                footer={
                  <>
                    <button className="btn" onClick={() => setReconciling(false)}>Vazgeç</button>
                    <button className="btn pri" disabled={reconcile.isPending || reconcileComment.trim().length < 10} onClick={() => reconcile.mutate()}>Doğrulamayı kaydet</button>
                  </>
                }
              >
                <p className="small muted" style={{ marginTop: 0 }}>Sunucuyu bağımsız olarak kontrol ettikten sonra gözlenen sonucu seçin. Bu işlem denetim izi ve insan doğrulama kanıtı oluşturur.</p>
                <label className="field">
                  <span>Gözlenen durum</span>
                  <select className="in" value={reconcileOutcome} onChange={(e) => setReconcileOutcome(e.target.value as typeof reconcileOutcome)}>
                    <option value="confirmed_current">Hedef sürüm çalışıyor (v{d.version.version})</option>
                    <option value="confirmed_previous">Önceki sürüm çalışıyor</option>
                    <option value="confirmed_failed">Çalışan sürüm doğrulanamadı</option>
                  </select>
                </label>
                <label className="field">
                  <span>Kontrol kanıtı / açıklama</span>
                  <textarea className="in" value={reconcileComment} onChange={(e) => setReconcileComment(e.target.value)} minLength={10} maxLength={2000} placeholder="Kontrol edilen URL, sürüm göstergesi ve sonuç…" />
                </label>
              </Modal>
            )}
          </>
        );
      }}
    </Async>
  );
}
