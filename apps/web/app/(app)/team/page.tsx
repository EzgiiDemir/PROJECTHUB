'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, GitCommitHorizontal, GitPullRequest, MessageSquare, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type DragEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import { EVENT_KIND, PRIORITY } from '@/lib/labels';
import type { Branches } from '@/lib/types';
import { Async, Avatar, Drawer, Empty, Field, Modal, PageHeader, Panel, StatusBadge, Tabs } from '@/components/ui';
import { BranchChanges, CommitDrawer, CommitLog } from '@/components/repo';
import { useToast } from '@/components/toast';

type Status = 'todo' | 'in_progress' | 'in_review' | 'done';
interface Person {
  id: string;
  displayName: string;
  avatarColor: string;
  title?: string;
}
interface BoardTask {
  id: string;
  key: string;
  title: string;
  status: Status;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dueDate: string | null;
  labels: string[];
  overdue: boolean;
  comments: number;
  branch: string | null;
  project: { id: string; slug: string; name: string; color: string };
  assignee: Person | null;
}
interface Board {
  tasks: BoardTask[];
  projects: { id: string; name: string; slug: string; color: string }[];
  people: Person[];
}
interface TaskDetail extends Omit<BoardTask, 'comments' | 'project' | 'overdue'> {
  description: string;
  createdAt: string;
  createdByName: string | null;
  canEdit: boolean;
  canComment: boolean;
  project: BoardTask['project'] & { defaultBranch: string };
  events: { id: string; kind: string; actor: string; at: string; from: string | null; to: string | null }[];
  comments: { id: string; body: string; at: string; author: Person | null; mine: boolean }[];
  commits: { sha: string; subject: string; authorName: string; date: string; additions: number; deletions: number; source: 'branch' | 'mention' }[];
  pullRequest: { number: number; title: string; status: string } | null;
  work: { at: string; action: string; label: string; detail: string; actor: string; link: string | null; count: number }[];
  workPeriods: { from: string; to: string | null }[];
}

/** Total time a task spent in Doing / In review. */
function workedFor(periods: { from: string; to: string | null }[]): string {
  const ms = periods.reduce((t, p) => t + ((p.to ? +new Date(p.to) : Date.now()) - +new Date(p.from)), 0);
  const h = Math.floor(ms / 3600_000);
  const d = Math.floor(h / 24);
  return d ? `${d} gün ${h % 24} sa` : h ? `${h} sa ${Math.floor((ms % 3600_000) / 60_000)} dk` : `${Math.max(1, Math.floor(ms / 60_000))} dk`;
}

const COLUMNS: [Status, string, string][] = [
  ['todo', 'Yapılacak', 'var(--idle)'],
  ['in_progress', 'Yapılıyor', 'var(--run)'],
  ['in_review', 'İncelemede', 'var(--amber)'],
  ['done', 'Tamamlandı', 'var(--ok)'],
];
const STATUS_NAME = Object.fromEntries(COLUMNS.map(([k, l]) => [k, l])) as Record<string, string>;
const dateLabel = (d: string) => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00`));

/** Team work: board across projects, activity stream and people/assignments (GitLab-style). */
export default function TeamPage() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get('tab') as 'board' | 'projects' | 'activity' | 'people') ?? 'board';
  const taskId = params.get('task');
  const [creating, setCreating] = useState(false);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(`/team?${next.toString()}`);
  };
  return (
    <div className="page">
      <PageHeader
        title="Takım çalışması"
        sub="Görevler, ilerleme, commit'ler ve ekip — tüm projeler tek yerde."
        actions={
          <button className="btn pri" onClick={() => setCreating(true)}>
            <Plus /> Yeni görev
          </button>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => set({ tab: t === 'board' ? null : t, p: null, view: null, ref: null, head: null, commit: null })}
        items={[
          ['board', 'Pano'],
          ['projects', 'Projeler'],
          ['activity', 'Etkinlik'],
          ['people', 'Ekip ve projeler'],
        ]}
      />
      <div style={{ marginTop: 18 }}>
        {tab === 'board' && <BoardView params={params} set={set} onOpen={(id) => set({ task: id })} />}
        {tab === 'projects' && <ProjectsView params={params} set={set} />}
        {tab === 'activity' && <ActivityView />}
        {tab === 'people' && <PeopleView />}
      </div>
      {taskId && <TaskDrawer id={taskId} onClose={() => set({ task: null })} />}
      {creating && <NewTask onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), set({ task: id }))} />}
    </div>
  );
}

function BoardView({ params, set, onOpen }: { params: URLSearchParams; set: (p: Record<string, string | null>) => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const project = params.get('project') ?? '';
  const person = params.get('person') ?? '';
  const [search, setSearch] = useState('');
  const [dragOver, setDragOver] = useState<Status | null>(null);
  const qs = new URLSearchParams({ ...(project ? { projectId: project } : {}), ...(person === 'me' ? { mine: '1' } : person ? { assigneeId: person } : {}), ...(search.trim() ? { search: search.trim() } : {}) });
  const q = useQuery({ queryKey: ['team-board', qs.toString()], queryFn: () => api<Board>(`/team/board?${qs.toString()}`), placeholderData: (p) => p });
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) => api(`/tasks/${id}`, { method: 'PATCH', body: { status } }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['team-board', qs.toString()] });
      qc.setQueryData<Board>(['team-board', qs.toString()], (b) => (b ? { ...b, tasks: b.tasks.map((t) => (t.id === id ? { ...t, status } : t)) } : b));
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['team-board'] }),
  });
  const drop = (e: DragEvent, status: Status) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/task');
    const t = q.data?.tasks.find((x) => x.id === id);
    if (t && t.status !== status) move.mutate({ id, status });
  };
  return (
    <Async q={q} rows={6}>
      {(b) => (
        <>
          <div className="toolbar">
            <select className="in" value={project} onChange={(e) => set({ project: e.target.value || null })} aria-label="Proje">
              <option value="">Tüm projeler</option>
              {b.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="in" value={person} onChange={(e) => set({ person: e.target.value || null })} aria-label="Kişi">
              <option value="">Herkes</option>
              <option value="me">Bana atananlar</option>
              <option value="none">Atanmamış</option>
              {b.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <input className="in" placeholder="Görev ara (başlık veya PH-12)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Görev ara" />
          </div>
          <div className="kanban">
            {COLUMNS.map(([status, label, color]) => {
              const items = b.tasks.filter((t) => t.status === status);
              return (
                <section
                  key={status}
                  className={`kanban-col ${dragOver === status ? 'over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(status);
                  }}
                  onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
                  onDrop={(e) => drop(e, status)}
                  aria-label={label}
                >
                  <header style={{ borderTopColor: color }}>
                    <b>{label}</b> <span className="muted">{items.length}</span>
                    {status === 'done' && <span className="small muted"> · son 14 gün</span>}
                  </header>
                  <div className="kanban-list">
                    {items.map((t) => (
                      <article key={t.id} className="kanban-card" draggable onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)} onClick={() => onOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}>
                        <div className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span className="mono muted">{t.key}</span>
                          <span className="dotname">
                            <i style={{ background: t.project.color }} />
                            {t.project.name}
                          </span>
                        </div>
                        <div className="kc-title">{t.title}</div>
                        {t.labels.length > 0 && (
                          <div className="kc-labels">
                            {t.labels.map((l) => (
                              <span key={l} className="tag">
                                {l}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="kc-meta">
                          {t.assignee ? <Avatar name={t.assignee.displayName} color={t.assignee.avatarColor} size={22} /> : <span className="small muted">Atanmamış</span>}
                          {(t.priority === 'high' || t.priority === 'critical') && <StatusBadge status={t.priority} label={PRIORITY[t.priority]} />}
                          <span style={{ flex: 1 }} />
                          {t.comments > 0 && (
                            <span className="small muted">
                              <MessageSquare size={13} /> {t.comments}
                            </span>
                          )}
                          {t.dueDate && (
                            <span className="small" style={{ color: t.overdue ? 'var(--bad)' : 'var(--muted)' }}>
                              <CalendarDays size={13} /> {dateLabel(t.dueDate)}
                            </span>
                          )}
                        </div>
                      </article>
                    ))}
                    {!items.length && <div className="small muted kanban-empty">Görev yok. Kartları buraya sürükleyin.</div>}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </Async>
  );
}

function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const q = useQuery({ queryKey: ['task', id], queryFn: () => api<TaskDetail>(`/tasks/${id}`) });
  const people = useQuery({ queryKey: ['team-people'], queryFn: () => api<{ people: Person[] }>('/team/members').then((r) => r.people) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['task', id] });
    void qc.invalidateQueries({ queryKey: ['team-board'] });
  };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/tasks/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const post = useMutation({
    mutationFn: () => api(`/tasks/${id}/comments`, { method: 'POST', body: { body: comment } }),
    onSuccess: () => {
      setComment('');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remove = useMutation({ mutationFn: (cid: string) => api(`/task-comments/${cid}`, { method: 'DELETE' }), onSuccess: refresh });
  return (
    <Drawer title={q.data ? `${q.data.key} · ${q.data.title}` : 'Görev'} onClose={onClose} wide>
      <Async q={q} rows={6}>
        {(t) => {
          const history = [
            ...t.events.filter((e) => e.kind !== 'comment').map((e) => ({ at: e.at, kind: 'event' as const, e })),
            ...t.comments.map((c) => ({ at: c.at, kind: 'comment' as const, c })),
          ].sort((a, b) => +new Date(a.at) - +new Date(b.at));
          return (
            <div className="task-layout">
              <div>
                <p className="small muted" style={{ marginTop: 0 }}>
                  <Link href={`/projects/${t.project.slug}`}>{t.project.name}</Link> · {t.createdByName ?? '—'} oluşturdu, {ago(t.createdAt)}
                </p>
                {t.description ? <div className="task-desc">{t.description}</div> : <p className="small muted">Açıklama yok.</p>}

                <h3 className="sect">
                  Çalışma kaydı{' '}
                  {t.workPeriods.length > 0 && (
                    <span className="small muted" style={{ fontWeight: 400 }}>
                      · {t.status === 'in_progress' || t.status === 'in_review' ? 'sürüyor, ' : ''}toplam {workedFor(t.workPeriods)}
                    </span>
                  )}
                </h3>
                {t.work.length ? (
                  <ol className="history work-log">
                    {t.work.map((w, i) => (
                      <li key={i} className="history-event">
                        <span className="small">
                          <b>{w.actor}</b> {w.label.toLocaleLowerCase('tr-TR')}
                          {w.count > 1 && <span className="muted"> ×{w.count}</span>}
                          {w.detail && (
                            <>
                              {': '}
                              {w.link ? (
                                <Link href={w.link} className="mono">
                                  {w.detail}
                                </Link>
                              ) : (
                                <span className="mono">{w.detail}</span>
                              )}
                            </>
                          )}{' '}
                          <span className="muted" title={dateTime(w.at)}>
                            · {ago(w.at)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="small muted">
                    {t.workPeriods.length
                      ? 'Görev Yapılıyor/İncelemede iken bu projede yapılan commit, push, branch, AI onayı, build ve deployment gibi işler burada kendiliğinden listelenir. Henüz kayıt yok.'
                      : 'Görev "Yapılıyor" sütununa alındığında, atanan kişinin bu projedeki işleri (commit, push, branch, AI kararları, build, deployment) burada kendiliğinden toplanır.'}
                  </p>
                )}

                <h3 className="sect">Geçmiş ve yorumlar</h3>
                <ol className="history">
                  {history.map((h) =>
                    h.kind === 'event' ? (
                      <li key={h.e.id} className="history-event">
                        <span className="small">
                          <b>{h.e.actor}</b> {eventText(h.e)} <span className="muted">· {ago(h.at)}</span>
                        </span>
                      </li>
                    ) : (
                      <li key={h.c.id} className="history-comment">
                        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                          {h.c.author && <Avatar name={h.c.author.displayName} color={h.c.author.avatarColor} size={22} />}
                          <b className="small">{h.c.author?.displayName ?? 'Silinmiş kullanıcı'}</b>
                          <span className="small muted" title={dateTime(h.c.at)}>
                            {ago(h.c.at)}
                          </span>
                          <span style={{ flex: 1 }} />
                          {h.c.mine && (
                            <button className="btn sm ghost" onClick={() => remove.mutate(h.c.id)}>
                              Sil
                            </button>
                          )}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{h.c.body}</div>
                      </li>
                    ),
                  )}
                </ol>
                {t.canComment && (
                  <div style={{ marginTop: 12 }}>
                    <textarea className="in" rows={3} placeholder="Yorum yazın…" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} aria-label="Yorum" />
                    <button className="btn pri" style={{ marginTop: 8 }} disabled={!comment.trim() || post.isPending} onClick={() => post.mutate()}>
                      Yorum ekle
                    </button>
                  </div>
                )}
              </div>
              <aside className="task-side">
                <Field label="Durum" id="td-status">
                  <select id="td-status" className="in" value={t.status} disabled={!t.canEdit} onChange={(e) => patch.mutate({ status: e.target.value })}>
                    {COLUMNS.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Atanan kişi" id="td-assignee">
                  <select id="td-assignee" className="in" value={t.assignee?.id ?? ''} disabled={!t.canEdit} onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}>
                    <option value="">Atanmamış</option>
                    {(people.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Öncelik" id="td-priority">
                  <select id="td-priority" className="in" value={t.priority} disabled={!t.canEdit} onChange={(e) => patch.mutate({ priority: e.target.value })}>
                    {Object.entries(PRIORITY).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
                <TaskDueDate key={`${id}:${t.dueDate ?? ''}`} value={t.dueDate} disabled={!t.canEdit || patch.isPending} onSave={(dueDate) => patch.mutate({ dueDate })} />
                <Field label="Etiketler" id="td-labels" hint="Virgülle ayırın">
                  <input
                    id="td-labels"
                    className="in"
                    defaultValue={t.labels.join(', ')}
                    disabled={!t.canEdit}
                    onBlur={(e) => {
                      const labels = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
                      if (labels.join(',') !== t.labels.join(',')) patch.mutate({ labels });
                    }}
                  />
                </Field>
                {t.branch && (
                  <p className="small">
                    Branch: <span className="mono">{t.branch}</span>
                  </p>
                )}
                {t.pullRequest && (
                  <Link className="side-link" href={`/projects/${t.project.slug}/pull-requests/${t.pullRequest.number}`}>
                    <GitPullRequest size={15} /> PR #{t.pullRequest.number} · <StatusBadge status={t.pullRequest.status} />
                  </Link>
                )}
                <h3 className="sect">Commit&apos;ler</h3>
                {t.commits.length ? (
                  t.commits.map((c) => (
                    <Link key={c.sha} className="side-link" href={`/projects/${t.project.slug}/git?tab=commits&commit=${c.sha}`} title={c.source === 'branch' ? 'Görevin branch’inden' : `${t.key} geçen commit`}>
                      <GitCommitHorizontal size={15} />
                      <span style={{ minWidth: 0 }}>
                        <span className="ellipsis" style={{ display: 'block' }}>
                          {c.subject}
                        </span>
                        <span className="small muted">
                          <span className="mono">{shortSha(c.sha)}</span> · {c.authorName} · {ago(c.date)} · <span style={{ color: 'var(--ok)' }}>+{c.additions}</span> <span style={{ color: 'var(--bad)' }}>−{c.deletions}</span>
                        </span>
                      </span>
                    </Link>
                  ))
                ) : (
                  <p className="small muted">
                    Commit mesajına <span className="mono">{t.key}</span> yazın veya göreve bir branch bağlayın; commit&apos;ler burada görünür.
                  </p>
                )}
              </aside>
            </div>
          );
        }}
      </Async>
    </Drawer>
  );
}

/** Save a complete date once; partial typing must not issue overlapping PATCH requests. */
function TaskDueDate({ value, disabled, onSave }: { value: string | null; disabled: boolean; onSave: (value: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(draft || null); }}>
      <Field label="Teslim tarihi" id="td-due">
        <input id="td-due" className="in" type="date" value={draft} disabled={disabled} onInput={(e) => setDraft(e.currentTarget.value)} onChange={(e) => setDraft(e.target.value)} />
      </Field>
      <button className="btn sm" type="submit" disabled={disabled || draft === (value ?? '')}>Teslim tarihini kaydet</button>
    </form>
  );
}

function eventText(e: TaskDetail['events'][number]) {
  switch (e.kind) {
    case 'created':
      return 'görevi oluşturdu';
    case 'status':
      return `durumu ${STATUS_NAME[e.from ?? ''] ?? e.from} → ${STATUS_NAME[e.to ?? ''] ?? e.to} olarak değiştirdi`;
    case 'assigned':
      return e.to ? `görevi ${e.to} kişisine atadı` : 'atamayı kaldırdı';
    case 'due':
      return e.to ? `teslim tarihini ${dateLabel(e.to)} yaptı` : 'teslim tarihini kaldırdı';
    case 'priority':
      return `önceliği ${PRIORITY[e.to ?? ''] ?? e.to} yaptı`;
    default:
      return 'görevi düzenledi';
  }
}

function NewTask({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['team-board', ''], queryFn: () => api<Board>('/team/board') });
  const [v, setV] = useState({ project: '', title: '', description: '', assigneeId: '', priority: 'medium', dueDate: '', labels: '' });
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const slug = board.data?.projects.find((p) => p.id === v.project)?.slug;
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/projects/${slug}/tasks`, {
        method: 'POST',
        body: { title: v.title, description: v.description, priority: v.priority, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, labels: v.labels.split(',').map((x) => x.trim()).filter(Boolean) },
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['team-board'] });
      toast('Görev oluşturuldu');
      onCreated(t.id);
    },
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Modal
      title="Yeni görev"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn pri" disabled={!slug || !v.title.trim() || create.isPending} onClick={() => create.mutate()}>
            Oluştur
          </button>
        </>
      }
    >
      <Field label="Proje" id="nt-project">
        <select id="nt-project" className="in" value={v.project} onChange={(e) => set({ project: e.target.value })}>
          <option value="">Seçin</option>
          {(board.data?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Başlık" id="nt-title">
        <input id="nt-title" className="in" value={v.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Açıklama" id="nt-desc">
        <textarea id="nt-desc" className="in" rows={4} value={v.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="grid g2">
        <Field label="Atanan kişi" id="nt-assignee" hint="Yalnızca projeyi görebilen kişilere atanabilir">
          <select id="nt-assignee" className="in" value={v.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })}>
            <option value="">Atanmamış</option>
            {(board.data?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Öncelik" id="nt-priority">
          <select id="nt-priority" className="in" value={v.priority} onChange={(e) => set({ priority: e.target.value })}>
            {Object.entries(PRIORITY).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Teslim tarihi" id="nt-due">
          <input id="nt-due" className="in" type="date" value={v.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
        </Field>
        <Field label="Etiketler" id="nt-labels" hint="Virgülle ayırın, ör. frontend, acil">
          <input id="nt-labels" className="in" value={v.labels} onChange={(e) => set({ labels: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function ActivityView({ projectId }: { projectId?: string }) {
  const [chosen, setProject] = useState('');
  const project = projectId ?? chosen;
  const [kind, setKind] = useState('');
  const [pages, setPages] = useState<string[]>(['']);
  const board = useQuery({ queryKey: ['team-board', ''], queryFn: () => api<Board>('/team/board') });
  return (
    <>
      <div className="toolbar">
        {!projectId && (
        <select className="in" value={project} onChange={(e) => (setProject(e.target.value), setPages(['']))} aria-label="Proje">
          <option value="">Tüm projeler</option>
          {(board.data?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        )}
        <select className="in" value={kind} onChange={(e) => (setKind(e.target.value), setPages(['']))} aria-label="Tür">
          <option value="">Tüm işlemler</option>
          {Object.entries(EVENT_KIND).map(([k, [l]]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Panel flush>
        {pages.map((before, i) => (
          <ActivityPage key={`${project}-${kind}-${before}`} project={project} kind={kind} before={before} last={i === pages.length - 1} onMore={(next) => setPages((p) => [...p, next])} />
        ))}
      </Panel>
    </>
  );
}

function ActivityPage({ project, kind, before, last, onMore }: { project: string; kind: string; before: string; last: boolean; onMore: (next: string) => void }) {
  const qs = new URLSearchParams({ ...(project ? { projectId: project } : {}), ...(kind ? { kind } : {}), ...(before ? { before } : {}) });
  const q = useQuery({
    queryKey: ['team-activity', qs.toString()],
    queryFn: () => api<{ items: { id: string; kind: string; title: string; description: string; actorLabel: string; createdAt: string; project: { slug: string; name: string; color: string }; tasks: { id: string; key: string; title: string }[] }[]; next: string | null }>(`/team/activity?${qs.toString()}`),
  });
  return (
    <Async q={q} rows={4}>
      {(r) => (
        <>
          {!r.items.length && !before && <Empty title="Etkinlik yok" />}
          {r.items.map((a) => (
            <Link key={a.id} className="feed-item" href={`/projects/${a.project.slug}/timeline`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="dot" style={{ background: EVENT_KIND[a.kind]?.[1] ?? 'var(--idle)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{a.title}</div>
                {a.description && <div className="small muted ellipsis">{a.description}</div>}
                <div className="small muted">
                  <span className="tag">{EVENT_KIND[a.kind]?.[0] ?? a.kind}</span> {a.project.name} · {a.actorLabel} · <span title={dateTime(a.createdAt)}>{ago(a.createdAt)}</span>
                  {a.tasks.map((t) => (
                    <span key={t.id} className="tag task-chip" title={t.title}>
                      {t.key} · {t.title.slice(0, 40)}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
          {last && r.next && (
            <div style={{ padding: 14, textAlign: 'center' }}>
              <button className="btn" onClick={() => onMore(r.next!)}>
                Daha fazla göster
              </button>
            </div>
          )}
        </>
      )}
    </Async>
  );
}

type WorkView = 'activity' | 'commits' | 'changes' | 'branches' | 'tasks';

/** Projects the viewer works on; opening one gives developers its activity, commits, code changes, branches and tasks. */
function ProjectsView({ params, set }: { params: URLSearchParams; set: (p: Record<string, string | null>) => void }) {
  const board = useQuery({ queryKey: ['team-board', ''], queryFn: () => api<Board>('/team/board') });
  const slug = params.get('p');
  return (
    <Async q={board} rows={4}>
      {(b) => {
        const project = slug ? b.projects.find((x) => x.slug === slug) : undefined;
        if (project) return <ProjectWork project={project} tasks={b.tasks.filter((t) => t.project.id === project.id)} params={params} set={set} />;
        if (!b.projects.length) return <Empty title="Proje yok">Bir projeye üye olduğunuzda burada görünür.</Empty>;
        return (
          <div className="people-grid">
            {b.projects.map((p) => {
              const tasks = b.tasks.filter((t) => t.project.id === p.id);
              return (
                <Panel key={p.id}>
                  <button style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }} onClick={() => set({ p: p.slug, view: null })}>
                    <div className="row" style={{ gap: 10, marginBottom: 8 }}>
                      <span className="dot" style={{ background: p.color, width: 12, height: 12 }} />
                      <b>{p.name}</b>
                    </div>
                    <div className="small muted">
                      {tasks.filter((t) => t.status !== 'done').length} açık görev · {tasks.filter((t) => t.status === 'in_progress').length} yapılıyor · {tasks.filter((t) => t.status === 'in_review').length} incelemede
                    </div>
                    <div className="small" style={{ marginTop: 10 }}>
                      Etkinlik, commit&apos;ler, kod değişiklikleri ve branch&apos;ler →
                    </div>
                  </button>
                </Panel>
              );
            })}
          </div>
        );
      }}
    </Async>
  );
}

function ProjectWork({ project, tasks, params, set }: { project: Board['projects'][number]; tasks: BoardTask[]; params: URLSearchParams; set: (p: Record<string, string | null>) => void }) {
  const slug = project.slug;
  const view = (params.get('view') as WorkView | null) ?? 'activity';
  const commit = params.get('commit');
  const branches = useQuery({ queryKey: ['repo', slug, 'branches'], queryFn: () => api<Branches>(`/projects/${slug}/repo/branches`) });
  const open = (sha: string) => set({ commit: sha });
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn sm ghost" onClick={() => set({ p: null, view: null, ref: null, head: null, commit: null })}>
            ← Projeler
          </button>
          <span className="dot" style={{ background: project.color, width: 12, height: 12 }} />
          <h2 style={{ margin: 0 }}>{project.name}</h2>
        </div>
        <div className="row">
          <Link className="btn sm" href={`/projects/${slug}/code`}>
            Kod
          </Link>
          <Link className="btn sm" href={`/projects/${slug}/git`}>
            Git yönetimi
          </Link>
          <Link className="btn sm" href={`/projects/${slug}`}>
            Projeye git
          </Link>
        </div>
      </div>
      <Tabs
        value={view}
        onChange={(v) => set({ view: v === 'activity' ? null : v, ref: null, head: null })}
        items={[
          ['activity', 'Etkinlik'],
          ['commits', "Commit'ler"],
          ['changes', 'Kod değişiklikleri'],
          ['branches', "Branch'ler"],
          ['tasks', `Görevler (${tasks.filter((t) => t.status !== 'done').length})`],
        ]}
      />
      <div style={{ marginTop: 14 }}>
        {view === 'activity' && <ActivityView projectId={project.id} />}
        {view === 'tasks' && <ProjectTasks tasks={tasks} onOpen={(id) => set({ task: id })} />}
        {(view === 'commits' || view === 'changes' || view === 'branches') && (
          <Async q={branches} rows={4}>
            {(b) => {
              if (view === 'commits') return <CommitLog slug={slug} data={b} refName={params.get('ref') ?? b.defaultBranch} onRef={(ref) => set({ ref })} onOpen={open} />;
              if (view === 'branches') return <ProjectBranches data={b} onHistory={(ref) => set({ view: 'commits', ref })} onChanges={(head) => set({ view: 'changes', head })} />;
              const others = b.branches.filter((x) => !x.isDefault);
              const head = params.get('head') ?? others[0]?.name;
              if (!head)
                return (
                  <Empty title="Açık branch yok">
                    Tüm değişiklikler {b.defaultBranch} branch&apos;inde; her commit&apos;in farkı Commit&apos;ler sekmesinde açılır.
                  </Empty>
                );
              return (
                <>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <select className="in" style={{ width: 'auto' }} value={head} onChange={(e) => set({ head: e.target.value })} aria-label="Branch">
                      {others.map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.name} (↑{x.ahead} ↓{x.behind})
                        </option>
                      ))}
                    </select>
                    <span className="small muted">→ {b.defaultBranch} branch&apos;ine göre</span>
                  </div>
                  <BranchChanges slug={slug} base={b.defaultBranch} head={head} onOpen={open} />
                </>
              );
            }}
          </Async>
        )}
      </div>
      {commit && <CommitDrawer slug={slug} sha={commit} onClose={() => set({ commit: null })} />}
    </>
  );
}

function ProjectBranches({ data, onHistory, onChanges }: { data: Branches; onHistory: (ref: string) => void; onChanges: (head: string) => void }) {
  return (
    <Panel flush>
      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th>Branch</th>
              <th>Son commit</th>
              <th title={`${data.defaultBranch} branch'ine göre`}>Önde / geride</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.branches.map((b) => (
              <tr key={b.name}>
                <td>
                  <span className="tag">{b.name}</span> {b.isDefault && <span className="small muted">varsayılan</span>}
                  {b.name.startsWith('ai/') && <span className="small muted"> · AI görevi</span>}
                </td>
                <td style={{ maxWidth: 380 }}>
                  <div className="ellipsis small">
                    <span className="mono">{shortSha(b.sha)}</span> {b.subject}
                  </div>
                  <div className="small muted">
                    {b.author} · <span title={dateTime(b.date)}>{ago(b.date)}</span>
                  </div>
                </td>
                <td className="mono small">{b.isDefault ? '—' : `↑${b.ahead} ↓${b.behind}`}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm ghost" onClick={() => onHistory(b.name)}>
                    Commit&apos;ler
                  </button>
                  {!b.isDefault && (
                    <button className="btn sm ghost" onClick={() => onChanges(b.name)}>
                      Değişiklikler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ProjectTasks({ tasks, onOpen }: { tasks: BoardTask[]; onOpen: (id: string) => void }) {
  if (!tasks.length) return <Empty title="Görev yok" />;
  return (
    <Panel flush>
      {COLUMNS.flatMap(([status]) => tasks.filter((t) => t.status === status)).map((t) => (
        <button key={t.id} className="list-item" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => onOpen(t.id)}>
          <span className="mono small muted" style={{ minWidth: 70 }}>
            {t.key}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ellipsis">{t.title}</div>
            <div className="small muted">
              {STATUS_NAME[t.status]} · {t.assignee?.displayName ?? 'Atanmamış'}
              {t.branch && (
                <>
                  {' · '}
                  <span className="tag">{t.branch}</span>
                </>
              )}
              {t.overdue && <span style={{ color: 'var(--bad)' }}> · gecikmiş</span>}
            </div>
          </div>
          {(t.priority === 'high' || t.priority === 'critical') && <StatusBadge status={t.priority} label={PRIORITY[t.priority]} />}
        </button>
      ))}
    </Panel>
  );
}

interface Members {
  people: (Person & { projects: { id: string; slug: string; name: string; color: string; role: string | null }[]; open: Record<string, number>; overdue: number })[];
  unassigned: number;
  canManageMembers: boolean;
}

function PeopleView() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['team-people-full'], queryFn: () => api<Members>('/team/members') });
  const board = useQuery({ queryKey: ['team-board', ''], queryFn: () => api<Board>('/team/board') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team-people-full'] });
  const add = useMutation({
    mutationFn: ({ slug, userId }: { slug: string; userId: string }) => api(`/projects/${slug}/members`, { method: 'POST', body: { userId, roleId: null } }),
    onSuccess: () => (toast('Projeye eklendi'), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const remove = useMutation({
    mutationFn: ({ slug, userId }: { slug: string; userId: string }) => api(`/projects/${slug}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => (toast('Projeden çıkarıldı'), refresh()),
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  return (
    <Async q={q} rows={4}>
      {(m) => (
        <>
          {m.unassigned > 0 && (
            <p className="small" style={{ marginTop: 0 }}>
              <Link href="/team?person=none">{m.unassigned} atanmamış açık görev</Link> var.
            </p>
          )}
          <div className="people-grid">
            {m.people.map((p) => {
              const open = (p.open.todo ?? 0) + (p.open.in_progress ?? 0) + (p.open.in_review ?? 0);
              const candidates = (board.data?.projects ?? []).filter((x) => !p.projects.some((y) => y.id === x.id));
              return (
                <Panel key={p.id}>
                  <div className="row" style={{ gap: 12, marginBottom: 12 }}>
                    <Avatar name={p.displayName} color={p.avatarColor} size={40} />
                    <div style={{ minWidth: 0 }}>
                      <b>{p.displayName}</b>
                      <div className="small muted">{p.title || '—'}</div>
                    </div>
                  </div>
                  <div className="small" style={{ marginBottom: 6 }}>
                    <Link href={`/team?person=${p.id}`}>{open} açık görev</Link>
                    {p.overdue > 0 && <span style={{ color: 'var(--bad)' }}> · {p.overdue} gecikmiş</span>}
                  </div>
                  <div className="splitbar" style={{ marginBottom: 14 }}>
                    {(['todo', 'in_progress', 'in_review'] as const).map((s, i) =>
                      p.open[s] ? <span key={s} title={`${STATUS_NAME[s]}: ${p.open[s]}`} style={{ width: `${(p.open[s]! / open) * 100}%`, background: ['var(--idle)', 'var(--run)', 'var(--amber)'][i] }} /> : null,
                    )}
                  </div>
                  <div className="small muted" style={{ marginBottom: 6 }}>
                    Projeler
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {p.projects.map((x) => (
                      <span key={x.id} className="chip-project">
                        <i style={{ background: x.color }} />
                        <Link href={`/team?tab=projects&p=${x.slug}`}>{x.name}</Link>
                        {x.role && <span className="muted"> · {x.role}</span>}
                        {m.canManageMembers && (
                          <button aria-label={`${x.name} projesinden çıkar`} onClick={() => remove.mutate({ slug: x.slug, userId: p.id })}>
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {!p.projects.length && <span className="small muted">Henüz projeye atanmadı</span>}
                  </div>
                  {m.canManageMembers && candidates.length > 0 && (
                    <select className="in" style={{ marginTop: 12 }} value="" onChange={(e) => e.target.value && add.mutate({ slug: e.target.value, userId: p.id })} aria-label={`${p.displayName} için proje ata`}>
                      <option value="">+ Projeye ata…</option>
                      {candidates.map((x) => (
                        <option key={x.id} value={x.slug}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </Async>
  );
}
