'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { Async, Badge, Empty, Kpi, Loading, Panel, scoreColor, StatusBadge } from '@/components/ui';
import { BarChart, SplitBar } from '@/components/charts';
import { EVENT_KIND } from '@/lib/labels';

interface Home {
  kpis: { activeProjects: number; runningPreviews: number; failedBuilds24h: number; criticalFindings: number; openFeedback: number; activeReviews: number };
  attention: { kind: string; title: string; detail: string; link: string; tone: 'bad' | 'warn' | 'run' }[];
  projects: { id: string; name: string; slug: string; color: string; status: string; healthScore: number | null; securityScore: number | null; currentVersion: string | null; lastBuildStatus: string | null; productionStatus: string | null }[];
  recentDeployments: { id: string; key: string; status: string; createdAt: string; environment: string; version: string; projectSlug: string; projectName: string; by: string | null }[];
}

type Profile = 'admin' | 'manager' | 'developer' | 'member';

interface Sections {
  profile: Profile;
  today: {
    tasks: { id: string; number: number; title: string; status: string; priority: string; dueDate: string | null; isHotfix: boolean; slug: string; project: string; color: string }[];
    open: number;
    overdue: number;
    dueToday: number;
  };
  work: {
    myPullRequests: { number: number; title: string; slug: string; project: string }[];
    reviewRequests: { number: number; title: string; slug: string; project: string; author: string | null; createdAt: string }[];
    recentBuilds: { id: string; number: number; status: string; branch: string; slug: string; project: string; createdAt: string }[];
    recentAiTasks: { id: string; number: number; title: string; status: string; slug: string; project: string }[];
  } | null;
  management: {
    projectsAtRisk: { id: string; name: string; slug: string; reasons: string[] }[];
    upcomingReleases: { id: string; version: string; slug: string; project: string; createdAt: string; migrations: number; highRiskMigrations: number }[];
    customerReviews: { id: string; name: string; versionLabel: string; slug: string; project: string; expiresAt: string; lastAccessAt: string | null; openFeedback: number }[];
  } | null;
  security: {
    openCritical: number;
    projectsWithoutRecentScan: number;
    newSecrets: { id: string; number: number; title: string; filePath: string | null; slug: string; project: string }[];
    dependencyRisk: { slug: string; project: string; critical: number; high: number; total: number }[];
    exceptions: { id: string; number: number; title: string; status: string; severity: string; reason: string | null; by: string | null; slug: string; project: string }[];
    trend: { week: string; score: number; scans: number }[];
  } | null;
}

/** Every dashboard list shows at most this many rows; the rest is one click away ("Tümü"). */
const LIMIT = 5;
const KIND_LABEL: Record<string, string> = { feedback: 'Feedback', deployment: 'Onay', ai: 'AI', build: 'Build', security: 'Güvenlik', task: 'Görev' };
const PROFILE_LABEL: Record<Profile, string> = { admin: 'Sistem yöneticisi paneli', manager: 'Proje yönetimi paneli', developer: 'Geliştirici paneli', member: 'Çalışma paneli' };
const TASK_STATUS: Record<string, string> = { todo: 'Yapılacak', in_progress: 'Yapılıyor', in_review: 'İncelemede' };

export default function HomePage() {
  const me = useMe().data;
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<Home>('/home') });
  const sections = useQuery({ queryKey: ['home-sections'], queryFn: () => api<Sections>('/home/sections') });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Günaydın' : hour < 18 ? 'İyi günler' : 'İyi akşamlar';
  const profile = sections.data?.profile;

  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: 6 }}>
        <div>
          <h1>
            {greet}, {me?.user.displayName.split(' ')[0]}
          </h1>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            {new Intl.DateTimeFormat('tr-TR', { dateStyle: 'full' }).format(new Date())} · {me?.organization?.name}
            {profile && ` · ${PROFILE_LABEL[profile]}`}
          </p>
        </div>
        {me?.permissions.includes('project.create') && (
          <Link className="btn pri" href="/projects/new">
            <Plus /> Proje ekle
          </Link>
        )}
      </div>
      <Async q={home} rows={6}>
        {(h) => {
          const s = sections.data;
          if (!s) return sections.isError ? <Empty title="Panel yüklenemedi">Sayfayı yenileyin.</Empty> : <Loading rows={6} />;
          if (s.profile === 'developer') return <DeveloperHome h={h} s={s} />;
          if (s.profile === 'member') return <MemberHome h={h} s={s} />;
          return <LeadHome h={h} s={s} admin={s.profile === 'admin'} canCreate={!!me?.permissions.includes('project.create')} />;
        }}
      </Async>
    </div>
  );
}

/** A clearly separated dashboard block with its own heading. */
function Section({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="dash-section">
      <div className="dash-head">
        <h2>{title}</h2>
        {sub && <span className="small muted">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/** A panel showing at most LIMIT rows, with the count of the rest and a link to all of them. */
function ListPanel<T>({ title, items, render, empty, href }: { title: string; items: T[]; render: (item: T) => ReactNode; empty: string; href?: string }) {
  const more = items.length - LIMIT;
  return (
    <Panel title={title} actions={href ? <Link className="btn sm ghost" href={href}>Tümü</Link> : undefined} flush>
      {items.length ? items.slice(0, LIMIT).map(render) : <None>{empty}</None>}
      {more > 0 && (
        <div className="small muted" style={{ padding: '6px 14px 10px' }}>
          +{more} kayıt daha{href ? ' · "Tümü" ile görün' : ''}
        </div>
      )}
    </Panel>
  );
}

function Item({ href, title, detail, badge }: { href: string; title: string; detail?: string; badge?: ReactNode }) {
  return (
    <Link className="list-item" href={href}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b style={{ fontSize: 11 }}>{title}</b>
        {detail && <div className="small muted ellipsis">{detail}</div>}
      </div>
      {badge}
    </Link>
  );
}

function None({ children }: { children: ReactNode }) {
  return (
    <div className="small muted" style={{ padding: '12px 14px' }}>
      {children}
    </div>
  );
}

function AttentionPanel({ items, title = 'Sizi bekleyenler' }: { items: Home['attention']; title?: string }) {
  return (
    <ListPanel
      title={title}
      items={items}
      empty="Onay, atanmış geri bildirim veya kritik bulgu yok."
      render={(a) => (
        <Link key={`${a.kind}-${a.link}-${a.title}`} className="list-item" href={a.link}>
          <Badge tone={a.tone} plain>
            {KIND_LABEL[a.kind] ?? a.kind}
          </Badge>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 11 }}>{a.title}</b>
            <div className="small muted ellipsis">{a.detail}</div>
          </div>
        </Link>
      )}
    />
  );
}

function dueText(due: string | null): { text: string; tone?: 'bad' | 'warn' } {
  if (!due) return { text: 'Teslim tarihi yok' };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  if (due < today) return { text: `Gecikti · ${new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(new Date(`${due}T12:00:00`))}`, tone: 'bad' };
  if (due === today) return { text: 'Bugün teslim', tone: 'warn' };
  return { text: `Teslim ${new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(new Date(`${due}T12:00:00`))}` };
}

function MyTasks({ today }: { today: Sections['today'] }) {
  return (
    <Panel title={`Görevlerim (${today.open})`} actions={<Link className="btn sm ghost" href="/team?person=me">Panoda gör</Link>} flush>
      {today.tasks.length ? (
        today.tasks.map((t) => {
          const due = dueText(t.dueDate);
          return (
            <Link key={t.id} className="list-item" href={`/team?task=${t.id}`}>
              <span className="dot" style={{ background: t.color }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <b style={{ fontSize: 11 }}>
                  PH-{t.number} {t.title}
                </b>
                <div className="small muted ellipsis">
                  {t.project} · {TASK_STATUS[t.status] ?? t.status}
                  {t.isHotfix && ' · hotfix'}
                </div>
              </div>
              {due.tone ? <Badge tone={due.tone}>{due.text}</Badge> : <span className="small muted">{due.text}</span>}
            </Link>
          );
        })
      ) : (
        <None>Size atanmış açık görev yok.</None>
      )}
    </Panel>
  );
}

function ProjectHealth({ h, canCreate }: { h: Home; canCreate: boolean }) {
  const router = useRouter();
  return (
    <Panel title="Proje sağlığı" actions={<Link className="btn sm ghost" href="/projects">Tümü</Link>} flush>
      {h.projects.length ? (
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Proje</th>
                <th>Sağlık</th>
                <th>Son build</th>
                <th>Güvenlik</th>
                <th>Production</th>
              </tr>
            </thead>
            <tbody>
              {h.projects.slice(0, LIMIT).map((p) => (
                <tr key={p.id} className="click" onClick={() => router.push(`/projects/${p.slug}`)}>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <span className="p-logo" style={{ background: p.color, width: 24, height: 24, fontSize: 9, borderRadius: 6 }}>
                        {p.name.slice(0, 2).toUpperCase()}
                      </span>
                      <b>{p.name}</b>
                    </div>
                  </td>
                  <td>
                    <b style={{ color: scoreColor(p.healthScore) }}>{p.healthScore ?? '—'}</b>
                  </td>
                  <td>{p.lastBuildStatus ? <StatusBadge status={p.lastBuildStatus} /> : <span className="muted small">—</span>}</td>
                  <td>
                    <span style={{ color: scoreColor(p.securityScore) }}>{p.securityScore ?? '—'}</span>
                  </td>
                  <td>{p.productionStatus ? <StatusBadge status={p.productionStatus} /> : <span className="muted small">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Henüz proje yok" action={canCreate ? <Link className="btn pri" href="/projects/new">İlk projeyi ekle</Link> : undefined}>
          Mevcut bir projeyi Git adresinden veya ZIP olarak içe aktarabilir ya da sıfırdan başlayabilirsiniz.
        </Empty>
      )}
    </Panel>
  );
}

function Deployments({ h }: { h: Home }) {
  return (
    <ListPanel
      title="Son deployment'lar"
      href="/deployments"
      items={h.recentDeployments}
      empty="Henüz deployment yapılmadı."
      render={(d) => (
        <Link key={d.id} className="list-item" href={`/projects/${d.projectSlug}/deployments/${d.id}`}>
          <span className="mono" style={{ minWidth: 44 }}>
            {d.key}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{d.projectName}</b> <span className="mono">v{d.version}</span> → {d.environment}
            <div className="small muted">
              {d.by ?? '—'} · {ago(d.createdAt)}
            </div>
          </div>
          <StatusBadge status={d.status} />
        </Link>
      )}
    />
  );
}

/** System administrators and project managers: the organization at a glance, then what needs a decision. */
function LeadHome({ h, s, admin, canCreate }: { h: Home; s: Sections; admin: boolean; canCreate: boolean }) {
  const m = s.management;
  const sec = s.security;
  return (
    <>
      <Section title="Genel durum">
        <div className="grid g6" style={{ marginBottom: 14 }}>
          <Kpi value={h.kpis.activeProjects} label="Aktif proje" href="/projects" />
          <Kpi value={h.kpis.runningPreviews} label="Çalışan ön izleme" />
          <Kpi value={h.kpis.failedBuilds24h} label="Başarısız build (24 sa)" tone={h.kpis.failedBuilds24h ? 'bad' : undefined} />
          <Kpi value={h.kpis.criticalFindings} label="Kritik güvenlik bulgusu" href="/security" tone={h.kpis.criticalFindings ? 'bad' : undefined} />
          <Kpi value={h.kpis.openFeedback} label="Açık kullanıcı geri bildirimi" />
          <Kpi value={h.kpis.activeReviews} label="Aktif kullanıcı linki" />
        </div>
        <Insights part="charts" />
      </Section>

      <Section title="Karar ve onay bekleyenler">
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <AttentionPanel items={h.attention} />
          <ListPanel title="Risk altındaki projeler" items={m?.projectsAtRisk ?? []} empty="Risk altında proje yok." render={(p) => <Item key={p.id} href={`/projects/${p.slug}`} title={p.name} detail={p.reasons.join(' · ')} />} />
        </div>
      </Section>

      <Section title="Projeler ve teslimat">
        <div className="grid split" style={{ alignItems: 'start' }}>
          <ProjectHealth h={h} canCreate={canCreate} />
          <Deployments h={h} />
        </div>
        {!admin && m && (
          <div className="grid g2 mt" style={{ alignItems: 'start' }}>
            <ListPanel
              title="Yaklaşan sürümler"
              items={m.upcomingReleases}
              empty="Production'a çıkmayı bekleyen sürüm yok."
              render={(v) => <Item key={v.id} href={`/projects/${v.slug}/versions`} title={`${v.project} v${v.version}`} detail={`${ago(v.createdAt)} oluşturuldu${v.migrations ? ` · ${v.migrations} migration${v.highRiskMigrations ? ` (${v.highRiskMigrations} yüksek riskli)` : ''}` : ''}`} />}
            />
            <ListPanel
              title="Kullanıcı incelemeleri"
              items={m.customerReviews}
              empty="Aktif kullanıcı linki yok."
              render={(r) => <Item key={r.id} href={`/projects/${r.slug}/reviews`} title={`${r.project} · ${r.name}`} detail={r.lastAccessAt ? `Son ziyaret ${ago(r.lastAccessAt)}` : 'Henüz açılmadı'} badge={r.openFeedback ? <Badge tone="warn">{r.openFeedback} açık</Badge> : undefined} />}
            />
          </div>
        )}
      </Section>

      {admin && sec && (
        <Section
          title="Güvenlik"
          sub={
            <>
              <b style={{ color: sec.openCritical ? 'var(--bad)' : 'var(--ok)' }}>{sec.openCritical}</b> açık kritik bulgu
              {sec.projectsWithoutRecentScan > 0 && ` · ${sec.projectsWithoutRecentScan} proje 7 gündür taranmadı`}
              {sec.trend.length > 1 && ` · skor trendi: ${sec.trend.map((t) => t.score).join(' → ')}`}
            </>
          }
        >
          <div className="grid g3" style={{ alignItems: 'start' }}>
            <ListPanel title="Yeni secret'lar · 7 gün" href="/security" items={sec.newSecrets} empty="Yeni secret yok." render={(f) => <Item key={f.id} href={`/projects/${f.slug}/security?finding=${f.id}`} title={`SEC-${f.number} ${f.title}`} detail={`${f.project}${f.filePath ? ` · ${f.filePath}` : ''}`} />} />
            <ListPanel title="Bağımlılık riski" items={sec.dependencyRisk} empty="Zafiyetli bağımlılık yok." render={(d) => <Item key={d.slug} href={`/projects/${d.slug}/dependencies`} title={d.project} detail={`${d.total} zafiyet · ${d.critical} kritik · ${d.high} yüksek`} />} />
            <ListPanel title="Kabul edilmiş riskler" items={sec.exceptions} empty="Kabul edilmiş risk yok." render={(f) => <Item key={f.id} href={`/projects/${f.slug}/security?finding=${f.id}`} title={`SEC-${f.number} ${f.title}`} detail={`${f.project} · ${f.by ?? '—'}: ${f.reason ?? 'gerekçe yok'}`} badge={<StatusBadge status={f.status} />} />} />
          </div>
        </Section>
      )}

      <Section title="Ekip ve operasyon">
        <Insights part="operations" />
      </Section>
    </>
  );
}

/** Developers: today's work first — own tasks, reviews waiting, own PRs, builds and AI tasks. */
function DeveloperHome({ h, s }: { h: Home; s: Sections }) {
  const w = s.work;
  const failedBuilds = w?.recentBuilds.filter((b) => b.status === 'failed').length ?? 0;
  return (
    <>
      <Section title="Bugün">
        <div className="grid g5" style={{ marginBottom: 14 }}>
          <Kpi value={s.today.open} label="Açık görevim" href="/team?person=me" />
          <Kpi value={s.today.dueToday} label="Bugün teslim" tone={s.today.dueToday ? 'warn' : undefined} />
          <Kpi value={s.today.overdue} label="Gecikmiş görev" tone={s.today.overdue ? 'bad' : undefined} />
          <Kpi value={w?.reviewRequests.length ?? 0} label="İncelememi bekleyen PR" tone={w?.reviewRequests.length ? 'warn' : undefined} />
          <Kpi value={failedBuilds} label="Başarısız build'im (7 gün)" tone={failedBuilds ? 'bad' : undefined} />
        </div>
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <MyTasks today={s.today} />
          <AttentionPanel items={h.attention.filter((a) => a.kind !== 'task')} title="Bana gelenler" />
        </div>
      </Section>

      {w && (
        <Section title="Kod ve inceleme">
          <div className="grid g2" style={{ alignItems: 'start' }}>
            <ListPanel title="İncelememi bekleyen PR'lar" items={w.reviewRequests} empty="Bekleyen inceleme yok." render={(p) => <Item key={`${p.slug}-${p.number}`} href={`/projects/${p.slug}/pull-requests/${p.number}`} title={`#${p.number} ${p.title}`} detail={`${p.project} · ${p.author ?? '—'} · ${ago(p.createdAt)}`} />} />
            <ListPanel title="Açık PR'larım" items={w.myPullRequests} empty="Açık PR yok." render={(p) => <Item key={`${p.slug}-${p.number}`} href={`/projects/${p.slug}/pull-requests/${p.number}`} title={`#${p.number} ${p.title}`} detail={p.project} />} />
            <ListPanel title="Son build'lerim · 7 gün" items={w.recentBuilds} empty="Son 7 günde build başlatmadınız." render={(b) => <Item key={b.id} href={`/projects/${b.slug}/builds/${b.id}`} title={`#${b.number} · ${b.branch}`} detail={`${b.project} · ${ago(b.createdAt)}`} badge={<StatusBadge status={b.status} />} />} />
            <ListPanel title="AI görevlerim" items={w.recentAiTasks} empty="AI görevi yok." render={(t) => <Item key={t.id} href={`/projects/${t.slug}/ai/tasks/${t.id}`} title={`AI-${t.number} ${t.title}`} detail={t.project} badge={<StatusBadge status={t.status} />} />} />
          </div>
        </Section>
      )}

      <Section title="Projelerim">
        <ProjectHealth h={h} canCreate={false} />
      </Section>
    </>
  );
}

/** Designers, QA and viewers: own tasks, feedback waiting for them and the projects they follow. */
function MemberHome({ h, s }: { h: Home; s: Sections }) {
  return (
    <>
      <Section title="Bugün">
        <div className="grid g4" style={{ marginBottom: 14 }}>
          <Kpi value={s.today.open} label="Açık görevim" href="/team?person=me" />
          <Kpi value={s.today.overdue} label="Gecikmiş görev" tone={s.today.overdue ? 'bad' : undefined} />
          <Kpi value={h.kpis.openFeedback} label="Açık kullanıcı geri bildirimi" />
          <Kpi value={h.kpis.runningPreviews} label="Çalışan ön izleme" />
        </div>
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <MyTasks today={s.today} />
          <AttentionPanel items={h.attention.filter((a) => a.kind !== 'task')} title="Bana gelenler" />
        </div>
      </Section>
      <Section title="Projelerim">
        <ProjectHealth h={h} canCreate={false} />
      </Section>
    </>
  );
}

interface InsightsData {
  series: {
    days: string[];
    builds: { passed: number[]; failed: number[]; other: number[] };
    deployments: { succeeded: number[]; failed: number[]; other: number[] };
    commits: number[];
    feedbackOpened: number[];
    feedbackResolved: number[];
  };
  delivery: { builds: number; buildSuccessRate: number | null; averageBuildMs: number | null; deployments: number; deploymentSuccessRate: number | null; productionReleases: number } | null;
  environments: Record<string, number>;
  tasks: Record<string, number>;
  contributors: { name: string; events: number; commits: number; builds: number; deploys: number }[];
  activity: { id: string; kind: string; tone: string; title: string; description: string; actor: string; at: string; slug: string; project: string; color: string }[];
  security: { averageScore: number | null; open: Record<string, number> };
}

const duration = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} sn` : `${(ms / 60_000).toFixed(1)} dk`);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Dashboard charts and operational overview computed from real project data (GET /home/insights). */
function Insights({ part }: { part: 'charts' | 'operations' }) {
  const q = useQuery({ queryKey: ['home-insights'], queryFn: () => api<InsightsData>('/home/insights'), refetchInterval: 60_000 });
  const d = q.data;
  if (!d) return null;
  if (part === 'charts') {
    const s = d.series;
    return (
      <>
        <div className="grid g4" style={{ marginBottom: 14, alignItems: 'stretch' }}>
          <Panel title="Build'ler · 14 gün">
            <BarChart
              days={s.days}
              series={[
                { label: 'Başarılı', color: 'var(--ok)', values: s.builds.passed },
                { label: 'Başarısız', color: 'var(--bad)', values: s.builds.failed },
                { label: 'Diğer', color: 'var(--idle)', values: s.builds.other },
              ]}
            />
          </Panel>
          <Panel title="Deployment'lar · 14 gün">
            <BarChart
              days={s.days}
              series={[
                { label: 'Tamamlandı', color: 'var(--ok)', values: s.deployments.succeeded },
                { label: 'Başarısız / geri alındı', color: 'var(--bad)', values: s.deployments.failed },
                { label: 'Diğer', color: 'var(--idle)', values: s.deployments.other },
              ]}
            />
          </Panel>
          <Panel title="Commit'ler · 14 gün">
            <BarChart days={s.days} series={[{ label: 'Commit', color: 'var(--primary)', values: s.commits }]} />
          </Panel>
          <Panel title="Geri bildirim · 14 gün">
            <BarChart
              days={s.days}
              series={[
                { label: 'Gelen', color: 'var(--amber)', values: s.feedbackOpened },
                { label: 'Çözülen', color: 'var(--ok)', values: s.feedbackResolved },
              ]}
            />
          </Panel>
        </div>
        {d.delivery && (
          <div className="stat-strip" style={{ marginBottom: 14 }}>
            <div>
              <div className="v" style={{ color: d.delivery.buildSuccessRate === null ? undefined : scoreColor(d.delivery.buildSuccessRate) }}>{d.delivery.buildSuccessRate === null ? '—' : `%${d.delivery.buildSuccessRate}`}</div>
              <div className="l">Build başarı oranı · {d.delivery.builds} build (30 gün)</div>
            </div>
            <div>
              <div className="v">{duration(d.delivery.averageBuildMs)}</div>
              <div className="l">Ortalama başarılı build süresi</div>
            </div>
            <div>
              <div className="v">{d.delivery.productionReleases}</div>
              <div className="l">Production yayını (30 gün)</div>
            </div>
            <div>
              <div className="v" style={{ color: d.delivery.deploymentSuccessRate === null ? undefined : scoreColor(d.delivery.deploymentSuccessRate) }}>{d.delivery.deploymentSuccessRate === null ? '—' : `%${d.delivery.deploymentSuccessRate}`}</div>
              <div className="l">Deployment başarı oranı · {d.delivery.deployments} deployment</div>
            </div>
            <div>
              <div className="v" style={{ color: scoreColor(d.security.averageScore) }}>{d.security.averageScore ?? '—'}</div>
              <div className="l">Ortalama güvenlik skoru</div>
            </div>
          </div>
        )}
      </>
    );
  }
  const e = d.environments;
  const t = d.tasks;
  const o = d.security.open;
  return (
    <div className="grid g3" style={{ marginBottom: 14, alignItems: 'start' }}>
      <Panel title="Son etkinlikler" actions={<span className="small muted">{sum(d.series.commits)} commit · 14 gün</span>} flush>
        {d.activity.length ? (
          d.activity.slice(0, LIMIT).map((a) => (
            <Link key={a.id} className="feed-item" href={`/projects/${a.slug}/timeline`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="dot" style={{ background: EVENT_KIND[a.kind]?.[1] ?? 'var(--idle)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600 }} className="ellipsis">
                  {a.title}
                </div>
                <div className="small muted ellipsis">
                  {a.project} · {a.actor} · {ago(a.at)}
                </div>
              </div>
            </Link>
          ))
        ) : (
          <Empty title="Henüz etkinlik yok" />
        )}
      </Panel>
      <div style={{ display: 'grid', gap: 14 }}>
        <Panel title="Production ortamları">
          <SplitBar
            parts={[
              { label: 'Sağlıklı', value: e.healthy ?? 0, color: 'var(--ok)' },
              { label: 'Yavaş / sorunlu', value: e.degraded ?? 0, color: 'var(--warn)' },
              { label: 'Erişilemiyor', value: e.down ?? 0, color: 'var(--bad)' },
              { label: 'İzlenmiyor', value: e.unknown ?? 0, color: 'var(--idle)' },
            ]}
          />
        </Panel>
        <Panel title="Görev panosu" actions={<Link className="btn sm ghost" href="/team">Takım çalışması</Link>}>
          <SplitBar
            parts={[
              { label: 'Yapılacak', value: t.todo ?? 0, color: 'var(--idle)' },
              { label: 'Yapılıyor', value: t.in_progress ?? 0, color: 'var(--run)' },
              { label: 'İncelemede', value: t.in_review ?? 0, color: 'var(--amber)' },
              { label: 'Tamamlandı', value: t.done ?? 0, color: 'var(--ok)' },
            ]}
          />
        </Panel>
        <Panel title="Açık güvenlik bulguları" actions={<Link className="btn sm ghost" href="/security">Güvenlik merkezi</Link>}>
          <SplitBar
            parts={[
              { label: 'Kritik', value: o.critical ?? 0, color: 'var(--bad)' },
              { label: 'Yüksek', value: o.high ?? 0, color: '#d9480f' },
              { label: 'Orta', value: o.medium ?? 0, color: 'var(--warn)' },
              { label: 'Düşük', value: (o.low ?? 0) + (o.info ?? 0), color: 'var(--idle)' },
            ]}
          />
        </Panel>
      </div>
      <Panel title="En aktif ekip üyeleri · 30 gün" flush>
        {d.contributors.length ? (
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Kişi</th>
                  <th>Commit</th>
                  <th>Build</th>
                  <th>Deploy</th>
                </tr>
              </thead>
              <tbody>
                {d.contributors.slice(0, LIMIT).map((c) => (
                  <tr key={c.name}>
                    <td>
                      <b>{c.name}</b>
                      <div className="small muted">{c.events} işlem</div>
                    </td>
                    <td>{c.commits}</td>
                    <td>{c.builds}</td>
                    <td>{c.deploys}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Son 30 günde etkinlik yok" />
        )}
      </Panel>
    </div>
  );
}
