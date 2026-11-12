'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AutomationSettings, RetentionSettings } from '@projecthub/contracts';
import { api, errorMessage } from '@/lib/api';
import { Field, Loading, PageHeader, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

const DAYS: [keyof RetentionSettings, string, string][] = [
  ['previewBuildDays', 'Ön izleme build çıktıları', 'Ön izlemesi biten build artifact’ları'],
  ['temporaryBuildDays', 'Geçici build çıktıları', 'Versiyona dönüşmeyen build artifact’ları'],
  ['screenshotDays', 'Ekran görüntüleri', 'Cihaz testi ve geri bildirim ekran görüntüleri; geri bildirimin kendisi silinmez'],
  ['rawLogDays', 'Ham build logları', 'Build ve deployment log dosyaları'],
  ['healthCheckDays', 'Sağlık kontrolü geçmişi', 'Ortam izleme kayıtları'],
];

const PAUSABLE_JOBS: [string, string][] = [
  ['deployment.execute', 'Deployment çalıştırma'],
  ['build.execute', 'Build çalıştırma'],
  ['database.restore', 'Veritabanı geri yükleme'],
  ['ai.task.run', 'AI görevleri'],
  ['autofix.auto', 'Otomatik düzeltme'],
  ['ai.remediation.run', 'Otomatik iyileştirme'],
  ['terminal.run', 'Tarayıcı terminal komutları'],
  ['repository.sync', 'Repository eşitleme'],
];

/** Retention and capacity (spec §20–22): keeps a single 8 GB / 200 GB server healthy. Versions are never deleted. */
export default function RetentionPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['adminSettings'], queryFn: () => api<{ retention: RetentionSettings; automation: AutomationSettings }>('/admin/settings') });
  const [v, setV] = useState<RetentionSettings | null>(null);
  const [automation, setAutomation] = useState<AutomationSettings | null>(null);
  useEffect(() => {
    if (q.data && !v) setV(q.data.retention);
    if (q.data && !automation) setAutomation(q.data.automation);
  }, [automation, q.data, v]);
  const save = useMutation({
    mutationFn: () => api('/admin/settings/retention', { method: 'PUT', body: v }),
    onSuccess: () => {
      toast('Saklama ayarları kaydedildi');
      void qc.invalidateQueries({ queryKey: ['adminSettings'] });
    },
  });
  const saveAutomation = useMutation({
    mutationFn: () => api('/admin/settings/automation', { method: 'PUT', body: automation }),
    onSuccess: () => {
      toast('Operasyon güvenliği ayarları kaydedildi');
      void qc.invalidateQueries({ queryKey: ['adminSettings'] });
    },
  });
  if (!v || !automation) return <div className="page"><Loading /></div>;
  const num = (k: keyof RetentionSettings, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) });
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <PageHeader title="Saklama ve kapasite" sub="Geçici veriler bu sürelerden sonra saatlik bakımda silinir. Kaynak kod, versiyonlar, yayınlanmış artifact’lar ve denetim kayıtları silinmez." />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Panel title="Saklama süreleri (gün)">
          {DAYS.map(([k, label, hint]) => (
            <Field key={k} label={label} id={`rt-${k}`} hint={hint}>
              <input id={`rt-${k}`} className="in" type="number" min={1} max={365} value={v[k]} onChange={num(k, 1, 365)} style={{ maxWidth: 140 }} />
            </Field>
          ))}
        </Panel>
        <Panel title="Kapasite">
          <Field label="Eşzamanlı build" id="rt-builds" hint="8 GB sunucuda 1–2 önerilir. Sınırdaki build'ler sırada bekler (worker'ın BUILD_CONCURRENCY değeri üst sınırdır)">
            <input id="rt-builds" className="in" type="number" min={1} max={8} value={v.maxConcurrentBuilds} onChange={num('maxConcurrentBuilds', 1, 8)} style={{ maxWidth: 140 }} />
          </Field>
          <Field label="Aynı anda çalışan ön izleme" id="rt-previews" hint="Sınıra ulaşıldığında yeni uygulama ön izlemesi açılırken en eski çalışan durdurulur (statik ön izlemeler sınırsızdır)">
            <input id="rt-previews" className="in" type="number" min={1} max={50} value={v.maxRunningPreviews} onChange={num('maxRunningPreviews', 1, 50)} style={{ maxWidth: 140 }} />
          </Field>
          {save.error && <div className="badbox">{errorMessage(save.error)}</div>}
          <button className="btn pri" onClick={() => save.mutate()} disabled={save.isPending}>
            Kaydet
          </button>
        </Panel>
      </div>
      <Panel title="Operasyon güvenliği" className="mt">
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <div>
            <label className="check" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={automation.emergencyStop} onChange={(e) => setAutomation({ ...automation, emergencyStop: e.target.checked })} />
              <span><b>Organizasyon acil durdurması</b><span className="small muted" style={{ display: 'block' }}>Yeni deployment, build, restore, terminal ve AI otomasyonları başlamaz; işler kaybolmadan kuyrukta bekler. Çalışan kritik adım yarıda kesilmez.</span></span>
            </label>
            <Field label="Durdurma gerekçesi" id="automation-reason" hint="Kuyrukta bekleyen işlerin kayıtlarında görünür">
              <input id="automation-reason" className="in" maxLength={500} value={automation.reason ?? ''} onChange={(e) => setAutomation({ ...automation, reason: e.target.value || null })} placeholder="Örn. canlı ortam incelemesi sürüyor" />
            </Field>
          </div>
          <div>
            <b className="small">İş türü bazında duraklat</b>
            <div className="grid" style={{ gap: 8, marginTop: 10 }}>
              {PAUSABLE_JOBS.map(([type, label]) => (
                <label className="check" key={type}>
                  <input
                    type="checkbox"
                    checked={automation.pausedJobTypes.includes(type)}
                    onChange={(e) => setAutomation({ ...automation, pausedJobTypes: e.target.checked ? [...automation.pausedJobTypes, type] : automation.pausedJobTypes.filter((x) => x !== type) })}
                  />
                  <span>{label} <span className="mono small muted">{type}</span></span>
                </label>
              ))}
            </div>
          </div>
        </div>
        {(saveAutomation.error || q.error) && <div className="badbox" style={{ marginTop: 12 }}>{errorMessage(saveAutomation.error ?? q.error)}</div>}
        <button className="btn pri" style={{ marginTop: 14 }} onClick={() => saveAutomation.mutate()} disabled={saveAutomation.isPending}>Operasyon ayarlarını kaydet</button>
      </Panel>
    </div>
  );
}
