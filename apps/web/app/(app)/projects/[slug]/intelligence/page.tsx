'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useProjectSlug } from '@/lib/hooks';
import { Async, Empty, Kpi, PageHeader, Panel, StatusBadge } from '@/components/ui';

interface Intelligence {
  revision: string | null;
  capability: null | { revision: string; status: string; capabilities: Record<string, { status: string; reason?: string }>; observedAt: string };
  entities: { id: string; kind: string; name: string; lifecycle: string; externalKey: string; metadata: Record<string, unknown> }[];
  relations: { id: string; fromEntityId: string; toEntityId: string; kind: string; status: string; confidence: string; detectionMethod: string; lastVerifiedAt: string | null }[];
  observations: { id: string; subjectType: string; key: string; value: unknown; sourceType: string; revision: string | null; confidence: string; observedAt: string; validUntil: string | null }[];
  drift: { kind: string; severity: string; message: string }[];
}

export default function IntelligencePage() {
  const slug = useProjectSlug();
  const q = useQuery({ queryKey: ['intelligence', slug], queryFn: () => api<Intelligence>(`/projects/${slug}/intelligence`) });
  return (
    <>
      <PageHeader title="Mimari, yetenekler ve kanıt" sub="Repository, ortam ve çalışma zamanı hakkında hangi bilginin nereden geldiğini ve hâlâ geçerli olup olmadığını gösterir." />
      <Async q={q} rows={6}>
        {(d) => {
          const names = new Map(d.entities.map((e) => [e.id, e.name]));
          return <>
            <div className="grid g4" style={{ marginBottom: 14 }}>
              <Kpi value={d.entities.length} label="Katalog varlığı" />
              <Kpi value={d.relations.length} label="Doğrulanabilir ilişki" />
              <Kpi value={d.observations.length} label="Güncel gözlem" />
              <Kpi value={d.drift.length} label="Sapma / eskime" tone={d.drift.length ? 'warn' : 'ok'} />
            </div>
            {d.drift.length > 0 && <Panel title="Yeniden doğrulanması gerekenler" flush>{d.drift.map((x, i) => <div className="list-item" key={`${x.kind}-${i}`}><StatusBadge status={x.severity} /><span>{x.message}</span></div>)}</Panel>}
            <div className="grid g2 mt" style={{ alignItems: 'start' }}>
              <Panel title="Software catalog" flush>{d.entities.length ? d.entities.map((e) => <div className="list-item" key={e.id}><div style={{ flex: 1 }}><b>{e.name}</b><div className="small muted mono">{e.kind} · {e.externalKey}</div></div><StatusBadge status={e.lifecycle} /></div>) : <Empty title="Katalog henüz oluşmadı">Repository indekslemesi tamamlandığında proje ve repository varlıkları kaydedilir.</Empty>}</Panel>
              <Panel title="Capability profile">
                {d.capability ? <><div className="spread small" style={{ marginBottom: 10 }}><span className="mono">{d.capability.revision.slice(0, 12)}</span><span className="muted">{ago(d.capability.observedAt)}</span></div>{Object.entries(d.capability.capabilities).map(([key, value]) => <div className="list-item" key={key}><div style={{ flex: 1 }}><b>{key}</b>{value.reason && <div className="small muted">{value.reason}</div>}</div><StatusBadge status={value.status} /></div>)}</> : <Empty title="Yetenek profili yok">Projeyi yeniden analiz ederek profil oluşturun.</Empty>}
              </Panel>
            </div>
            <Panel title="Bileşen ilişkileri" flush className="mt">{d.relations.length ? <div className="tbl"><table><thead><tr><th>Kaynak</th><th>İlişki</th><th>Hedef</th><th>Kanıt</th><th>Durum</th></tr></thead><tbody>{d.relations.map((r) => <tr key={r.id}><td>{names.get(r.fromEntityId) ?? r.fromEntityId.slice(0, 8)}</td><td className="mono small">{r.kind}</td><td>{names.get(r.toEntityId) ?? r.toEntityId.slice(0, 8)}</td><td className="small">{r.detectionMethod} · {r.confidence}</td><td><StatusBadge status={r.status} /></td></tr>)}</tbody></table></div> : <Empty title="İlişki yok">Kod, manifest ve ortam keşfi ilerledikçe ilişkiler burada görünür.</Empty>}</Panel>
            <Panel title="Son geçerli gözlemler" flush className="mt">{d.observations.length ? <div className="tbl"><table><thead><tr><th>Bilgi</th><th>Değer</th><th>Kaynak</th><th>Güven</th><th>Gözlem</th></tr></thead><tbody>{d.observations.slice(0, 50).map((o) => <tr key={o.id}><td><b>{o.key}</b><div className="small muted">{o.subjectType}</div></td><td className="mono small">{typeof o.value === 'string' ? o.value : JSON.stringify(o.value)}</td><td className="small">{o.sourceType}{o.revision ? ` · ${o.revision.slice(0, 8)}` : ''}</td><td><StatusBadge status={o.confidence} /></td><td className="small muted">{ago(o.observedAt)}</td></tr>)}</tbody></table></div> : <Empty title="Gözlem yok" />}</Panel>
          </>;
        }}
      </Async>
    </>
  );
}
