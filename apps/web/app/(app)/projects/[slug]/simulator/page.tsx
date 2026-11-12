'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Camera, ExternalLink, Hand, Home, LayoutGrid, RefreshCw, RotateCw, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, time } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import { openPreview, previewAccessUrl } from '@/lib/preview';
import type { DeviceProfile, Preview, ResponsiveTest } from '@/lib/types';
import { DeviceFrame, useBridge, type BridgeMessage } from '@/components/device-frame';
import { Async, Badge, Drawer, Empty, ErrorState, Field, Loading, Panel, Segmented, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';

const CATEGORY: [DeviceProfile['category'], string][] = [
  ['phone', 'Telefon'],
  ['tablet', 'Tablet'],
  ['desktop', 'Masaüstü'],
];
const ISSUE: Record<string, string> = {
  horizontal_overflow: 'Yatay taşma',
  console_error: 'Konsol hatası',
  failed_request: 'Başarısız istek',
  page_error: 'Sayfa hatası',
  load_failed: 'Yüklenemedi',
  offscreen_cta: 'Görünmeyen buton',
};
const THROTTLE: [string, string][] = [
  ['', 'Ağ: sınırsız'],
  ['fast4g', 'Hızlı 4G'],
  ['slow3g', 'Yavaş 3G'],
  ['offline', 'Çevrimdışı'],
];
const ZOOM: [string, string][] = [
  ['fit', 'Sığdır'],
  ['0.5', '%50'],
  ['0.75', '%75'],
  ['1', '%100'],
];

type ConsoleLine = { level: 'error' | 'warn' | 'log' | 'info'; text: string; at: number; device: string };
type NetLine = { method: string; url: string; status: number; ms: number; size: number; kind: string; error?: string; at: number; device: string };
type Perf = Extract<BridgeMessage, { type: 'perf' }>;

/** A fresh signed URL per preview; navigation inside the frame keeps the preview cookie. */
function useSignedSrc(preview: Preview | null) {
  const toast = useToast();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!preview) return;
    let cancelled = false;
    previewAccessUrl(preview.id, '/')
      .then((u) => !cancelled && setSrc(u))
      .catch((e) => toast(errorMessage(e), 'bad'));
    return () => {
      cancelled = true;
    };
  }, [preview, toast]);
  return src;
}

/**
 * Device simulator (spec §44–53): the running preview at real CSS viewport sizes with navigation, network
 * conditions (latency/bandwidth/offline applied to the app's own requests), touch cursor, side-by-side devices,
 * and DevTools-style console, network and performance panels fed by the gateway bridge.
 */
export default function SimulatorPage() {
  const slug = useProjectSlug();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject().data;
  const previews = useQuery({ queryKey: ['previews', slug], queryFn: () => api<Preview[]>(`/projects/${slug}/previews`) });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceProfile[]>('/device-profiles'), staleTime: Infinity });
  const ready = (previews.data ?? []).filter((p) => p.status === 'ready');
  const previewId = params.get('preview') ?? ready[0]?.id ?? null;
  const preview = ready.find((p) => p.id === previewId) ?? null;
  const src = useSignedSrc(preview);
  const [mode, setMode] = useState<'single' | 'compare'>('single');
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  const [landscape, setLandscape] = useState(false);
  const [zoom, setZoom] = useState('fit');
  const [touch, setTouch] = useState(true);
  const [throttle, setThrottle] = useState('');
  const [path, setPath] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [title, setTitle] = useState('');
  const [consoleLog, setConsoleLog] = useState<ConsoleLine[]>([]);
  const [network, setNetwork] = useState<NetLine[]>([]);
  const [perf, setPerf] = useState<Record<string, Perf>>({});
  const [tab, setTab] = useState<'console' | 'network' | 'perf'>('console');
  const [testOpen, setTestOpen] = useState<string | null>(null);
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];
  const origin = useMemo(() => (preview ? new URL(preview.url).origin : null), [preview]);

  const list = devices.data ?? [];
  const single = list.find((d) => d.key === deviceKey) ?? list.find((d) => d.isDefault && d.category === 'phone') ?? list[0];
  const pick = (cat: DeviceProfile['category']) => list.find((d) => d.isDefault && d.category === cat) ?? list.find((d) => d.category === cat);
  const shown = (mode === 'single' ? [single] : [pick('phone'), pick('tablet'), pick('desktop')]).filter((d): d is DeviceProfile => !!d);

  useEffect(() => {
    setConsoleLog([]);
    setNetwork([]);
    setPerf({});
  }, [preview?.id]);

  const onMessage = (device: string, index: number) => (m: BridgeMessage) => {
    if (m.type === 'nav') {
      if (index === 0) {
        setPath(m.path);
        setPathInput(m.path);
        setTitle(m.title);
      }
    } else if (m.type === 'console') setConsoleLog((l) => [...l.slice(-299), { level: m.level, text: m.message, at: m.at, device }]);
    else if (m.type === 'network') setNetwork((l) => [...l.slice(-299), { method: m.method, url: m.url, status: m.status, ms: m.ms, size: m.size ?? 0, kind: m.kind ?? 'fetch', error: m.error, at: Date.now(), device }]);
    else if (m.type === 'perf') setPerf((p) => ({ ...p, [device]: m }));
    else if (m.type === 'throttle' && index === 0) setThrottle(m.profile ?? '');
  };
  const sends = [
    useBridge(frames[0]!, origin, onMessage(shown[0]?.name ?? '', 0)),
    useBridge(frames[1]!, origin, onMessage(shown[1]?.name ?? '', 1)),
    useBridge(frames[2]!, origin, onMessage(shown[2]?.name ?? '', 2)),
  ];
  const broadcast = useCallback((msg: Record<string, unknown>) => sends.slice(0, shown.length).forEach((s) => s(msg)), [sends, shown.length]);

  // The network condition lives in the frame's tab (survives reloads): read it back once the page is up.
  useEffect(() => {
    if (!src) return;
    const t = setTimeout(() => sends[0]!({ type: 'hello' }), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Compare mode keeps all devices on the page the first one shows.
  useEffect(() => {
    if (mode === 'compare') sends.slice(1).forEach((s) => s({ type: 'navigate', path }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, mode]);

  const shot = useMutation({
    mutationFn: () => api<ResponsiveTest>(`/projects/${slug}/responsive-tests`, { method: 'POST', body: { previewId: preview!.id, deviceKeys: shown.map((d) => d.key), paths: [path.split('#')[0] || '/'] } }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['responsiveTests'] });
      setTestOpen(t.id);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });

  if (previews.isLoading || devices.isLoading) return <Loading rows={5} />;
  if (previews.error) return <ErrorState error={previews.error} onRetry={() => void previews.refetch()} />;
  if (!ready.length || !preview)
    return (
      <Empty title="Çalışan ön izleme yok" action={<Link className="btn pri" href={`/projects/${slug}/previews`}>Ön izlemelere git</Link>}>
        Simülatör, çalışan bir ön izlemeyi farklı cihaz boyutlarında gösterir.
      </Empty>
    );

  const errors = consoleLog.filter((l) => l.level === 'error').length + network.filter((n) => n.status === 0 || n.status >= 400).length;
  const canTest = !!project?.permissions.includes('preview.create');
  const touchable = shown.some((d) => d.category !== 'desktop');
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Cihaz simülatörü</h2>
          <p className="sub">Gerçek viewport boyutları, ağ koşulları, dokunmatik imleç ve geliştirici araçları. Tarayıcı motoru Chromium&apos;dur; cihaz testi bunu gerçek tarayıcıda ekran görüntüsüyle doğrular.</p>
        </div>
        <div className="row">
          <Segmented value={mode} onChange={setMode} items={[['single', <span key="s" className="row" style={{ gap: 4 }}><Smartphone size={14} /> Tek cihaz</span>], ['compare', <span key="c" className="row" style={{ gap: 4 }}><LayoutGrid size={14} /> Karşılaştır</span>]]} />
          <select className="in" style={{ width: 'auto' }} value={preview.id} onChange={(e) => router.replace(`/projects/${slug}/simulator?preview=${e.target.value}`)} aria-label="Ön izleme">
            {ready.map((p) => (
              <option key={p.id} value={p.id}>
                Build #{p.buildNumber} · {p.sourceBranch}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="sim-toolbar">
        <button className="btn sm" title="Geri" onClick={() => broadcast({ type: 'back' })}>
          <ArrowLeft />
        </button>
        <button className="btn sm" title="İleri" onClick={() => broadcast({ type: 'forward' })}>
          <ArrowRight />
        </button>
        <button className="btn sm" title="Yenile" onClick={() => broadcast({ type: 'reload' })}>
          <RefreshCw />
        </button>
        <button className="btn sm" title="Ana sayfa" onClick={() => broadcast({ type: 'navigate', path: '/' })}>
          <Home />
        </button>
        <form
          className="sim-url"
          onSubmit={(e) => {
            e.preventDefault();
            const p = pathInput.startsWith('/') ? pathInput : `/${pathInput}`;
            broadcast({ type: 'navigate', path: p });
          }}
        >
          <span className="small muted ellipsis" style={{ maxWidth: 160 }} title={title}>
            {title || preview.slug}
          </span>
          <input className="mono" value={pathInput} onChange={(e) => setPathInput(e.target.value)} aria-label="Sayfa yolu" />
        </form>
        <select className="in sm" value={throttle} onChange={(e) => broadcast({ type: 'throttle', profile: e.target.value || null })} aria-label="Ağ koşulu" title="Uygulamanın kendi istekleri (fetch/XHR) bu gecikme ve hızla çalışır">
          {THROTTLE.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select className="in sm" value={zoom} onChange={(e) => setZoom(e.target.value)} aria-label="Yakınlaştırma">
          {ZOOM.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {touchable && (
          <button className={`btn sm ${touch ? 'pri' : ''}`} title="Dokunmatik imleç" onClick={() => setTouch((v) => !v)}>
            <Hand />
          </button>
        )}
        {mode === 'single' && single?.category !== 'desktop' && (
          <button className={`btn sm ${landscape ? 'pri' : ''}`} title="Yatay / dikey" onClick={() => setLandscape((v) => !v)}>
            <RotateCw />
          </button>
        )}
        {canTest && (
          <button className="btn sm" title="Bu sayfanın gerçek tarayıcıda ekran görüntüsü ve kontrolü" onClick={() => shot.mutate()} disabled={shot.isPending}>
            {shot.isPending ? <span className="spinner" /> : <Camera />}
          </button>
        )}
        <button className="btn sm" title="Yeni sekmede aç" onClick={() => openPreview(preview.id, path).catch((e) => toast(errorMessage(e), 'bad'))}>
          <ExternalLink />
        </button>
      </div>
      {throttle && <div className="warnbox small" style={{ margin: '0 0 8px' }}>Ağ koşulu: {THROTTLE.find(([k]) => k === throttle)?.[1]} — uygulamanın istekleri buna göre yavaşlatılıyor{throttle === 'offline' ? ' ve başarısız oluyor' : ''}.</div>}

      <div className="grid" style={{ gridTemplateColumns: mode === 'single' ? '220px minmax(0, 1fr)' : 'minmax(0, 1fr)', alignItems: 'start' }}>
        {mode === 'single' && (
          <Panel flush>
            <div className="dev-list" style={{ padding: 6 }}>
              {CATEGORY.map(([cat, label]) => (
                <div key={cat}>
                  <div className="small muted" style={{ padding: '8px 10px 4px', fontWeight: 600 }}>
                    {label}
                  </div>
                  {list
                    .filter((d) => d.category === cat)
                    .map((d) => (
                      <button key={d.key} className={single?.key === d.key ? 'on' : ''} onClick={() => setDeviceKey(d.key)}>
                        <span>{d.name}</span>
                        <span className="mono small muted">
                          {d.width}×{d.height}
                        </span>
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </Panel>
        )}
        <div style={{ minWidth: 0 }}>
          <div className={`sim-stage ${mode === 'compare' ? 'compare' : ''}`}>
            {shown.map((d, i) => (
              <DeviceFrame
                key={`${mode}-${d.key}`}
                device={d}
                landscape={mode === 'single' && landscape}
                src={src}
                frameRef={frames[i]!}
                title={`${preview.slug} · ${d.name}`}
                zoom={zoom === 'fit' ? 'fit' : Number(zoom)}
                touch={touch && d.category !== 'desktop'}
                maxWidth={mode === 'compare' ? (d.category === 'desktop' ? 640 : d.category === 'tablet' ? 380 : 260) : undefined}
                maxHeight={mode === 'compare' ? 560 : 720}
              />
            ))}
          </div>
          <DevTools tab={tab} setTab={setTab} consoleLog={consoleLog} network={network} perf={perf} errors={errors} onClear={() => (tab === 'console' ? setConsoleLog([]) : tab === 'network' ? setNetwork([]) : setPerf({}))} />
        </div>
      </div>
      <ResponsiveTests slug={slug} preview={preview} devices={list} canRun={canTest} onOpen={setTestOpen} />
      {testOpen && <TestDrawer id={testOpen} onClose={() => setTestOpen(null)} />}
    </>
  );
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url, 'http://x');
    return u.pathname + u.search;
  } catch {
    return url;
  }
};
const kb = (n: number) => (n ? (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '—');

/** Thresholds follow Web Vitals guidance: good / needs work / poor. */
function grade(v: number | null, good: number, poor: number) {
  if (v === null) return 'idle' as const;
  return v <= good ? ('ok' as const) : v <= poor ? ('warn' as const) : ('bad' as const);
}

function DevTools({
  tab,
  setTab,
  consoleLog,
  network,
  perf,
  errors,
  onClear,
}: {
  tab: 'console' | 'network' | 'perf';
  setTab: (t: 'console' | 'network' | 'perf') => void;
  consoleLog: ConsoleLine[];
  network: NetLine[];
  perf: Record<string, Perf>;
  errors: number;
  onClear: () => void;
}) {
  const [level, setLevel] = useState<'all' | 'error' | 'warn'>('all');
  const [failedOnly, setFailedOnly] = useState(false);
  const lines = consoleLog.filter((l) => level === 'all' || l.level === level);
  const reqs = network.filter((n) => !failedOnly || n.status === 0 || n.status >= 400);
  const multi = new Set([...consoleLog.map((l) => l.device), ...network.map((n) => n.device)]).size > 1;
  return (
    <Panel
      className="mt"
      title={
        <span className="row" style={{ gap: 6 }}>
          <Segmented
            value={tab}
            onChange={setTab}
            items={[
              ['console', `Konsol (${consoleLog.length})`],
              ['network', `Ağ (${network.length})`],
              ['perf', 'Performans'],
            ]}
          />
          {errors > 0 && <Badge tone="bad">{errors} hata</Badge>}
        </span>
      }
      actions={
        <span className="row" style={{ gap: 6 }}>
          {tab === 'console' && <Segmented value={level} onChange={setLevel} items={[['all', 'Tümü'], ['error', 'Hata'], ['warn', 'Uyarı']]} />}
          {tab === 'network' && (
            <label className="check small">
              <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Yalnız başarısız
            </label>
          )}
          <button className="btn sm ghost" onClick={onClear}>
            Temizle
          </button>
        </span>
      }
    >
      {tab === 'console' &&
        (lines.length ? (
          <div className="mono small devtools-log">
            {lines.map((l, i) => (
              <div key={i} className={`dl-${l.level}`}>
                <span className="muted">{time(l.at)}</span> {multi && <span className="muted">[{l.device}]</span>} {l.text}
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>Konsol boş. Uygulamanın console.log/info/warn/error çıktıları ve yakalanmamış hataları burada görünür.</p>
        ))}
      {tab === 'network' &&
        (reqs.length ? (
          <div className="tbl devtools-log">
            <table>
              <thead>
                <tr>
                  <th>Yöntem</th>
                  <th>Adres</th>
                  <th>Durum</th>
                  <th>Tür</th>
                  <th>Boyut</th>
                  <th>Süre</th>
                  {multi && <th>Cihaz</th>}
                </tr>
              </thead>
              <tbody>
                {[...reqs].reverse().map((n, i) => (
                  <tr key={i}>
                    <td className="mono small">{n.method}</td>
                    <td className="mono small ellipsis" style={{ maxWidth: 380 }} title={n.url}>
                      {pathOf(n.url)}
                    </td>
                    <td className="small" style={{ color: n.status === 0 || n.status >= 400 ? 'var(--bad)' : undefined }}>
                      {n.status || n.error || 'hata'}
                    </td>
                    <td className="small muted">{n.kind}</td>
                    <td className="small muted">{kb(n.size)}</td>
                    <td className="small" style={{ color: n.ms > 1000 ? 'var(--warn)' : undefined }}>
                      {n.ms} ms
                    </td>
                    {multi && <td className="small muted">{n.device}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>Henüz istek yok. Uygulamanın fetch/XHR istekleri (API, Livewire, axios) süre ve durumlarıyla burada listelenir.</p>
        ))}
      {tab === 'perf' &&
        (Object.keys(perf).length ? (
          <div className="grid g3">
            {Object.entries(perf).map(([device, p]) => (
              <div key={device} className="panel" style={{ padding: 12 }}>
                <b style={{ fontSize: 11 }}>{device}</b>
                {(
                  [
                    ['İlk bayt (TTFB)', p.ttfb, 800, 1800, 'ms'],
                    ['İlk içerik (FCP)', p.fcp, 1800, 3000, 'ms'],
                    ['DOM hazır', p.domReady, 2000, 4000, 'ms'],
                    ['Tam yükleme', p.load, 3000, 6000, 'ms'],
                    ['İstek sayısı', p.requests, 50, 100, ''],
                    ['Aktarılan veri', p.transferKb, 1600, 4000, 'KB'],
                    ['DOM düğümü', p.domNodes, 1500, 3000, ''],
                  ] as [string, number | null, number, number, string][]
                ).map(([label, v, good, poor, unit]) => (
                  <div key={label} className="spread small" style={{ padding: '3px 0' }}>
                    <span className="muted">{label}</span>
                    <Badge tone={grade(v, good, poor)} plain>
                      {v === null ? '—' : `${v.toLocaleString('tr-TR')} ${unit}`.trim()}
                    </Badge>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>Sayfa yüklendiğinde yükleme süreleri, istek sayısı ve aktarılan veri cihaz başına burada ölçülür.</p>
        ))}
    </Panel>
  );
}

function ResponsiveTests({ slug, preview, devices, canRun, onOpen }: { slug: string; preview: Preview; devices: DeviceProfile[]; canRun: boolean; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState<'default' | 'all'>('default');
  const [paths, setPaths] = useState('/');
  const [baseline, setBaseline] = useState('');
  const tests = useQuery({
    queryKey: ['responsiveTests', slug],
    queryFn: () => api<ResponsiveTest[]>(`/projects/${slug}/responsive-tests`),
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => t.status === 'queued' || t.status === 'running') ? 3000 : false),
  });
  const completed = (tests.data ?? []).filter((t) => t.status === 'completed');
  const run = useMutation({
    mutationFn: () =>
      api<ResponsiveTest>(`/projects/${slug}/responsive-tests`, {
        method: 'POST',
        body: {
          previewId: preview.id,
          deviceKeys: scope === 'all' ? devices.map((d) => d.key) : undefined,
          paths: paths
            .split(/[\s,]+/)
            .map((p) => p.trim())
            .filter((p) => p.startsWith('/'))
            .slice(0, 10),
          baselineTestId: baseline || undefined,
        },
      }),
    onSuccess: (t) => {
      toast('Test kuyruğa alındı');
      void qc.invalidateQueries({ queryKey: ['responsiveTests'] });
      onOpen(t.id);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Panel title="Tüm cihazlarda test" className="mt">
      {canRun && (
        <div className="grid g4" style={{ alignItems: 'end', marginBottom: 12 }}>
          <Field label="Cihazlar">
            <Segmented value={scope} onChange={setScope} items={[['default', 'Varsayılan set'], ['all', `Tümü (${devices.length})`]]} />
          </Field>
          <Field label="Sayfalar" id="rt-paths" hint="Boşlukla ayırın, en çok 10">
            <input id="rt-paths" className="in mono" value={paths} onChange={(e) => setPaths(e.target.value)} />
          </Field>
          <Field label="Görsel karşılaştırma" id="rt-base">
            <select id="rt-base" className="in" value={baseline} onChange={(e) => setBaseline(e.target.value)}>
              <option value="">Yok</option>
              {completed.map((t) => (
                <option key={t.id} value={t.id}>
                  Build #{t.buildNumber} · {ago(t.createdAt)}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <button className="btn pri" onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending && <span className="spinner" />} Testi başlat
            </button>
          </div>
        </div>
      )}
      <Async q={tests} rows={2}>
        {(rows) =>
          rows.length ? (
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Zaman</th>
                    <th>Ön izleme</th>
                    <th>Sayfalar</th>
                    <th>Durum</th>
                    <th>Sonuç</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className="click" onClick={() => onOpen(t.id)}>
                      <td className="small">{ago(t.createdAt)}</td>
                      <td className="small">Build #{t.buildNumber}</td>
                      <td className="mono small">{t.paths.join(' ')}</td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="small">
                        {t.summary ? (
                          <span className="row" style={{ gap: 4 }}>
                            <Badge tone="ok" plain>{t.summary.passed} geçti</Badge>
                            {t.summary.warning > 0 && <Badge tone="warn" plain>{t.summary.warning} uyarı</Badge>}
                            {t.summary.failed > 0 && <Badge tone="bad" plain>{t.summary.failed} hata</Badge>}
                          </span>
                        ) : (
                          (t.error ?? '—')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Test, ön izlemeyi her cihaz boyutunda gerçek bir tarayıcıda açar; taşma, konsol hatası, başarısız istek ve görünmeyen butonları raporlar, ekran görüntüsü alır.
            </p>
          )
        }
      </Async>
    </Panel>
  );
}

function TestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['responsiveTest', id],
    queryFn: () => api<ResponsiveTest>(`/responsive-tests/${id}`),
    refetchInterval: (query) => (query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2500 : false),
  });
  const [only, setOnly] = useState<'all' | 'issues'>('issues');
  return (
    <Drawer title="Cihaz testi sonucu" onClose={onClose} wide>
      <Async q={q}>
        {(t) => {
          const results = (t.results ?? []).filter((r) => only === 'all' || r.status !== 'passed');
          return (
            <>
              <div className="spread" style={{ marginBottom: 12 }}>
                <span className="row">
                  <StatusBadge status={t.status} />
                  {t.summary && (
                    <span className="small muted">
                      {t.summary.total} kontrol · {t.summary.passed} geçti · {t.summary.warning} uyarı · {t.summary.failed} hata
                    </span>
                  )}
                </span>
                <Segmented value={only} onChange={setOnly} items={[['issues', 'Sorunlular'], ['all', 'Tümü']]} />
              </div>
              {t.error && <div className="badbox">{t.error}</div>}
              {(t.status === 'queued' || t.status === 'running') && <Loading label="Cihazlar test ediliyor…" />}
              {!results.length && t.status === 'completed' && <Empty title="Sorun bulunmadı">Tüm cihaz ve sayfalarda kontroller geçti.</Empty>}
              <div className="grid g2">
                {results.map((r) => (
                  <div key={r.id} className="panel" style={{ padding: 12 }}>
                    <div className="spread">
                      <b style={{ fontSize: 11 }}>
                        {r.deviceName} <span className="mono small muted">{r.width}×{r.height}</span>
                      </b>
                      <StatusBadge status={r.status === 'warning' ? 'medium' : r.status} label={r.status === 'passed' ? 'Geçti' : r.status === 'warning' ? 'Uyarı' : 'Hata'} />
                    </div>
                    <div className="mono small muted">
                      {r.path}
                      {r.loadMs ? ` · ${r.loadMs} ms` : ''}
                      {r.diffRatio !== null ? ` · görsel fark %${(r.diffRatio * 100).toFixed(2)}` : ''}
                    </div>
                    {r.issues.map((i, k) => (
                      <div key={k} className="small" style={{ marginTop: 4 }}>
                        <b>{ISSUE[i.code] ?? i.code}:</b> {i.message}
                      </div>
                    ))}
                    <div className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
                      {r.screenshotArtifactId && (
                        <a href={`/api/v1/artifacts/${r.screenshotArtifactId}/content`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/v1/artifacts/${r.screenshotArtifactId}/content`} alt={`${r.deviceName} ${r.path}`} style={{ width: '100%', maxHeight: 260, objectFit: 'cover', objectPosition: 'top', border: '1px solid var(--line)', borderRadius: 6 }} />
                        </a>
                      )}
                      {r.diffArtifactId && (
                        <a href={`/api/v1/artifacts/${r.diffArtifactId}/content`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/v1/artifacts/${r.diffArtifactId}/content`} alt="Görsel fark" style={{ width: '100%', maxHeight: 260, objectFit: 'cover', objectPosition: 'top', border: '1px solid var(--line)', borderRadius: 6 }} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </Async>
    </Drawer>
  );
}
