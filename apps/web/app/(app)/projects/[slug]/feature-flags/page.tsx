'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Environment } from '@/lib/types';
import { Async, Drawer, Empty, Field, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

interface FlagOverride { id: string; environmentId: string; environmentName: string; environmentType: string; enabled: boolean; rolloutPercentage: number }
interface Flag { id: string; key: string; name: string; description: string; status: string; defaultEnabled: boolean; tags: string[]; expiresAt: string | null; overrides: FlagOverride[] }

export default function FeatureFlagsPage() {
  const slug = useProjectSlug();
  const project = useProject().data;
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const flags = useQuery({ queryKey: ['featureFlags', slug], queryFn: () => api<Flag[]>(`/projects/${slug}/feature-flags`) });
  const envs = useQuery({ queryKey: ['environments', slug], queryFn: () => api<Environment[]>(`/projects/${slug}/environments`) });
  const canEdit = !!project?.permissions.includes('project.update') && project.status !== 'archived';
  const refresh = () => void qc.invalidateQueries({ queryKey: ['featureFlags', slug] });
  const archive = useMutation({ mutationFn: (id: string) => api(`/feature-flags/${id}`, { method: 'PATCH', body: { status: 'archived' } }), onSuccess: () => { toast('Feature flag arşivlendi'); refresh(); }, onError: (e) => toast(errorMessage(e), 'bad') });
  return <>
    <PageHeader title="Feature flag'ler" sub="Özellikleri yeniden deployment yapmadan ortam, hedefleme ve deterministik yüzde dağıtımıyla açın." actions={canEdit && <button className="btn pri" onClick={() => setCreating(true)}>Yeni flag</button>} />
    <Async q={flags} rows={4}>{(rows) => rows.length ? <div className="grid" style={{ gap: 14 }}>{rows.map((f) => <Panel key={f.id} title={<><span className="mono">{f.key}</span> · {f.name}</>} actions={<StatusBadge status={f.status} />}><p className="small muted" style={{ marginTop: 0 }}>{f.description || 'Açıklama yok'}</p><div className="small" style={{ marginBottom: 10 }}>Varsayılan: <StatusBadge status={f.defaultEnabled ? 'enabled' : 'disabled'} label={f.defaultEnabled ? 'Açık' : 'Kapalı'} /></div>{(envs.data ?? []).map((env) => <OverrideEditor key={env.id} flag={f} env={env} editable={canEdit} onSaved={refresh} />)}{canEdit && f.status === 'active' && <button className="btn sm mt" onClick={() => archive.mutate(f.id)}>Arşivle</button>}</Panel>)}</div> : <Empty title="Feature flag yok" action={canEdit && <button className="btn pri" onClick={() => setCreating(true)}>İlk flag'i oluştur</button>}>Canary ve kontrollü yayın için ilk flag&apos;i oluşturun.</Empty>}</Async>
    {creating && <CreateFlag slug={slug} onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); }} />}
  </>;
}

function OverrideEditor({ flag, env, editable, onSaved }: { flag: Flag; env: Environment; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const current = flag.overrides.find((x) => x.environmentId === env.id);
  const [enabled, setEnabled] = useState(current?.enabled ?? flag.defaultEnabled);
  const [percentage, setPercentage] = useState(current?.rolloutPercentage ?? 100);
  const save = useMutation({ mutationFn: () => api(`/feature-flags/${flag.id}/override`, { method: 'PUT', body: { environmentId: env.id, enabled, rolloutPercentage: percentage, rules: [] } }), onSuccess: () => { toast(`${env.name} flag ayarı kaydedildi`); onSaved(); }, onError: (e) => toast(errorMessage(e), 'bad') });
  return <div className="list-item"><div style={{ flex: 1 }}><b>{env.name}</b><div className="small muted">{current ? 'Ortam override' : 'Varsayılan değeri kullanıyor'}</div></div><label className="check" style={{ margin: 0 }}><input type="checkbox" checked={enabled} disabled={!editable} onChange={(e) => setEnabled(e.target.checked)} /><span>Açık</span></label><input className="in" style={{ width: 90 }} type="number" min={0} max={100} value={percentage} disabled={!editable || !enabled} onChange={(e) => setPercentage(Number(e.target.value))} aria-label="Yayın yüzdesi" /><span className="small muted">%</span>{editable && <button className="btn sm" disabled={save.isPending} onClick={() => save.mutate()}>Kaydet</button>}</div>;
}

function CreateFlag({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ key: '', name: '', description: '', defaultEnabled: false, tags: '', expiresAt: '' });
  const create = useMutation({ mutationFn: () => api(`/projects/${slug}/feature-flags`, { method: 'POST', body: { key: v.key, name: v.name, description: v.description, defaultEnabled: v.defaultEnabled, ownerId: null, tags: v.tags.split(',').map((x) => x.trim()).filter(Boolean), expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : null } }), onSuccess: () => { toast('Feature flag oluşturuldu'); onDone(); }, onError: (e) => toast(errorMessage(e), 'bad') });
  return <Drawer title="Yeni feature flag" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Vazgeç</button><button className="btn pri" disabled={!v.key || !v.name || create.isPending} onClick={() => create.mutate()}>Oluştur</button></>}><Field label="Anahtar" id="ff-key" hint="Kodda kullanılan değişmez anahtar"><input id="ff-key" className="in mono" value={v.key} onChange={(e) => setV({ ...v, key: e.target.value.toLowerCase() })} placeholder="new.checkout" /></Field><Field label="Ad" id="ff-name"><input id="ff-name" className="in" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field><Field label="Açıklama" id="ff-desc"><textarea id="ff-desc" className="in" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field><Field label="Etiketler" id="ff-tags" hint="Virgülle ayırın"><input id="ff-tags" className="in" value={v.tags} onChange={(e) => setV({ ...v, tags: e.target.value })} /></Field><Field label="Son kullanma" id="ff-exp"><input id="ff-exp" className="in" type="datetime-local" value={v.expiresAt} onChange={(e) => setV({ ...v, expiresAt: e.target.value })} /></Field><label className="check"><input type="checkbox" checked={v.defaultEnabled} onChange={(e) => setV({ ...v, defaultEnabled: e.target.checked })} /><span>Override olmayan ortamlarda varsayılan açık</span></label>{create.error && <div className="badbox mt">{errorMessage(create.error)}</div>}</Drawer>;
}
