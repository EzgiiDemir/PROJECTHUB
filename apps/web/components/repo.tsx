'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ago, dateTime, shortSha } from '@/lib/format';
import type { Branches, Commit, CommitDetail, Comparison, FileStat } from '@/lib/types';
import { Async, DiffView, Drawer, Empty, Panel } from '@/components/ui';

/** Repository views shared by the project's Git page and the Team workspace. */

export function FileStats({ files }: { files: FileStat[] }) {
  return (
    <div className="small" style={{ marginBottom: 10 }}>
      {files.map((f) => (
        <div key={f.path} className="mono">
          <span style={{ color: 'var(--ok)' }}>+{f.additions}</span> <span style={{ color: 'var(--bad)' }}>−{f.deletions}</span> {f.path}
          {f.binary && ' (ikili)'}
        </div>
      ))}
    </div>
  );
}

export function CommitDrawer({ slug, sha, onClose }: { slug: string; sha: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['repo', slug, 'commit', sha],
    queryFn: () => api<CommitDetail>(`/projects/${slug}/repo/commits/${sha}`),
  });
  return (
    <Drawer title={<span className="mono">{shortSha(sha)}</span>} onClose={onClose} wide>
      <Async q={q}>
        {(c) => (
          <>
            <h3 style={{ margin: '0 0 4px' }}>{c.subject}</h3>
            {c.body && (
              <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>
                {c.body}
              </pre>
            )}
            <p className="small muted">
              {c.authorName} &lt;{c.authorEmail}&gt; · {dateTime(c.date)} · <span className="mono">{c.sha}</span>
            </p>
            <div className="row" style={{ marginBottom: 10 }}>
              <Link className="btn sm" href={`/projects/${slug}/code?ref=${c.sha}`}>
                Bu commit&apos;teki kodu gör
              </Link>
            </div>
            <FileStats files={c.files} />
            <DiffView patch={c.patch} maxHeight={900} />
            {c.truncated && <p className="small muted">Fark çok büyük; ilk kısmı gösteriliyor.</p>}
          </>
        )}
      </Async>
    </Drawer>
  );
}

export function CommitRow({ c, onOpen }: { c: Commit; onOpen: (sha: string) => void }) {
  return (
    <button
      className="list-item"
      style={{
        width: '100%',
        background: 'none',
        border: 0,
        borderBottom: '1px solid var(--line)',
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit',
      }}
      onClick={() => onOpen(c.sha)}
    >
      <span className="mono small muted" style={{ minWidth: 60 }}>
        {shortSha(c.sha)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ellipsis">{c.subject}</div>
        <div className="small muted">
          {c.authorName} · <span title={dateTime(c.date)}>{ago(c.date)}</span>
          {c.filesChanged > 0 && ` · ${c.filesChanged} dosya`}
          {c.parents.length > 1 && ' · birleştirme'}
        </div>
      </div>
      <span className="mono small">
        <span style={{ color: 'var(--ok)' }}>+{c.additions}</span> <span style={{ color: 'var(--bad)' }}>−{c.deletions}</span>
      </span>
    </button>
  );
}

export function CommitLog({ slug, data, refName, onRef, onOpen }: { slug: string; data: Branches; refName: string; onRef: (r: string) => void; onOpen: (sha: string) => void }) {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [limit, setLimit] = useState(40);
  const q = useQuery({
    queryKey: ['repo', slug, 'commits', refName, submitted, limit],
    queryFn: () => api<Commit[]>(`/projects/${slug}/repo/commits?ref=${encodeURIComponent(refName)}&limit=${limit}${submitted ? `&search=${encodeURIComponent(submitted)}` : ''}`),
  });
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select className="in" style={{ width: 'auto' }} value={refName} onChange={(e) => onRef(e.target.value)} aria-label="Branch">
          {data.branches.map((b) => (
            <option key={b.name}>{b.name}</option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(search.trim());
          }}
          style={{ flex: 1, maxWidth: 360 }}
        >
          <input className="in" placeholder="Commit mesajında ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </div>
      <Async q={q} rows={6}>
        {(rows) =>
          rows.length ? (
            <Panel flush>
              {rows.map((c) => (
                <CommitRow key={c.sha} c={c} onOpen={onOpen} />
              ))}
              {rows.length >= limit && (
                <div style={{ padding: 10, textAlign: 'center' }}>
                  <button className="btn sm" onClick={() => setLimit((l) => Math.min(100, l + 30))} disabled={limit >= 100}>
                    {limit >= 100 ? 'Daha eskisi için Git istemcisini kullanın' : 'Daha fazla'}
                  </button>
                </div>
              )}
            </Panel>
          ) : (
            <Empty title="Commit bulunamadı" />
          )
        }
      </Async>
    </>
  );
}

/** What a branch changes against another one, read-only: commits, touched files and the combined diff. */
export function BranchChanges({ slug, base, head, onOpen }: { slug: string; base: string; head: string; onOpen: (sha: string) => void }) {
  const q = useQuery({
    queryKey: ['repo', slug, 'compare', base, head],
    queryFn: () => api<Comparison>(`/projects/${slug}/repo/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`),
    enabled: base !== head,
  });
  if (base === head) return <Empty title="Aynı branch seçili">Değişiklikleri görmek için varsayılan branch dışında bir branch seçin.</Empty>;
  return (
    <Async q={q} rows={4}>
      {(c) =>
        !c.commits.length && !c.files.length ? (
          <Empty title="Fark yok">{`${head}, ${base} ile aynı.`}</Empty>
        ) : (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              <span className="tag">{head}</span> → <span className="tag">{base}</span> · {c.ahead} commit önde, {c.behind} geride · {c.files.length} dosya (+
              {c.files.reduce((n, f) => n + f.additions, 0)} −{c.files.reduce((n, f) => n + f.deletions, 0)})
            </p>
            <Panel title="Commit'ler" flush>
              {c.commits.map((x) => (
                <CommitRow key={x.sha} c={x} onOpen={onOpen} />
              ))}
            </Panel>
            <Panel title="Dosyalar ve fark" className="mt">
              <FileStats files={c.files} />
              <DiffView patch={c.patch} maxHeight={900} />
              {c.truncated && <p className="small muted">Fark çok büyük; ilk kısmı gösteriliyor.</p>}
            </Panel>
          </>
        )
      }
    </Async>
  );
}
