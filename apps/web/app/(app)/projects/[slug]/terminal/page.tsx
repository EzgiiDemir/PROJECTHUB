'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Power, Square, SquareTerminal } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { shortSha } from '@/lib/format';
import { useProject, useProjectSlug } from '@/lib/hooks';
import type { Branches } from '@/lib/types';
import { Empty, ErrorState, Field, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Command {
  id: string;
  command: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  exitCode: number | null;
  output: string;
  commitSha: string | null;
  syncNote: string | null;
}
interface Session {
  id: string;
  branch: string;
  protectedBranch: boolean;
  headCommit: string | null;
  status: 'starting' | 'ready' | 'closed' | 'failed';
  autoSync: boolean;
  error: string | null;
  commands: Command[];
}
interface TerminalState {
  enabled: boolean;
  limits: { network: string; timeoutMinutes: number; idleMinutes: number; image: string };
  session: Session | null;
}

const QUICK = ['npm install', 'npm test', 'npm run build', 'npm outdated', 'pnpm install', 'ls -la', 'node --version'];
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export default function TerminalPage() {
  const slug = useProjectSlug();
  const project = useProject().data;
  const qc = useQueryClient();
  const toast = useToast();
  const state = useQuery({
    queryKey: ['terminal', slug],
    queryFn: () => api<TerminalState>(`/projects/${slug}/terminal`),
    refetchInterval: (q) => (q.state.data?.session?.status === 'starting' || q.state.data?.session?.commands.some((c) => c.status === 'queued' || c.status === 'running') ? 1500 : false),
    refetchIntervalInBackground: true,
  });
  const branches = useQuery({ queryKey: ['repo', slug, 'branches'], queryFn: () => api<Branches>(`/projects/${slug}/repo/branches`) });
  const [branch, setBranch] = useState('');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['terminal', slug] });

  const open = useMutation({ mutationFn: () => api(`/projects/${slug}/terminal`, { method: 'POST', body: { branch: branch || state.data?.session?.branch || undefined, autoSync: true } }), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'bad') });
  const s = state.data?.session;
  const run = useMutation({
    mutationFn: (command: string) => api(`/terminal/${s!.id}/commands`, { method: 'POST', body: { command } }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'bad'),
  });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/terminal/${s!.id}/commands/${id}/cancel`, { method: 'POST', body: {} }), onSuccess: refresh });
  const close = useMutation({ mutationFn: () => api(`/terminal/${s!.id}/close`, { method: 'POST', body: {} }), onSuccess: refresh });
  const autoSync = useMutation({ mutationFn: (v: boolean) => api(`/terminal/${s!.id}/auto-sync`, { method: 'POST', body: { autoSync: v } }), onSuccess: refresh });

  const lastOutput = s?.commands.at(-1)?.output.length ?? 0;
  // Block body: in current Chromium scrollIntoView returns a Promise, which React would treat as a cleanup function.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [s?.commands.length, lastOutput]);

  const busy = !!s?.commands.some((c) => c.status === 'queued' || c.status === 'running');
  const submit = (cmd: string) => {
    const c = cmd.trim();
    if (!c || busy || run.isPending) return;
    setHistory((h) => [...h.filter((x) => x !== c), c].slice(-50));
    setCursor(-1);
    setInput('');
    run.mutate(c);
  };

  if (state.isLoading) return <Loading />;
  if (state.error) return <ErrorState error={state.error} onRetry={() => void state.refetch()} />;
  const st = state.data!;
  return (
    <>
      <div className="spread" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <SquareTerminal size={20} /> Terminal
          </h2>
          <p className="sub" style={{ marginBottom: 0 }}>
            Komutlar sunucuda, her biri için yeni açılan kısıtlı bir container&apos;da çalışır ({st.limits.image}, {st.limits.network === 'none' ? 'internet kapalı' : 'paket kayıtlarına erişim açık'}, komut başına en fazla {st.limits.timeoutMinutes} dk).
            {s?.protectedBranch ? ` ${s.branch} korumalı olduğu için komutlar çalışır ancak dosya değişiklikleri kaydedilmez; kalıcı çalışma için korumasız bir branch seçin.` : ' Değişen dosyalar komut bitince branch\'e kaydedilir; kod ekranı ve bağlı editörler anında görür.'}
          </p>
        </div>
        {s && s.status !== 'closed' && (
          <div className="row">
            <button className="btn" onClick={refresh}>Durumu yenile</button>
            {s.status === 'failed' && <button className="btn pri" onClick={() => open.mutate()} disabled={open.isPending}>Yeniden dene</button>}
            <label className="check" title={s.protectedBranch ? 'Korumalı branch üzerinde değişiklik kaydedilemez' : "Her komuttan sonra değişen dosyaları branch'e kaydet"}>
              <input type="checkbox" checked={s.autoSync} disabled={s.protectedBranch} onChange={(e) => autoSync.mutate(e.target.checked)} /> {s.protectedBranch ? 'Korumalı branch · kayıt kapalı' : 'Otomatik kaydet'}
            </label>
            <button className="btn" onClick={() => close.mutate()} disabled={close.isPending}>
              <Power /> Oturumu kapat
            </button>
          </div>
        )}
      </div>

      {!st.enabled ? (
        <Empty title="Tarayıcı terminali bu sunucuda kapalı">
          Terminal komutları izole container&apos;larda çalıştırır ve worker&apos;ın erişebildiği bir Docker motoru gerektirir (yönetici: <code>TERMINAL_ENABLED=true</code>). Bu arada projeyi başlıktaki <b>Aç</b> menüsünden VS Code, Cursor veya JetBrains ile açıp kendi terminalinizi kullanabilirsiniz; değişiklikleriniz yine anında burada görünür.
        </Empty>
      ) : !s || s.status === 'closed' ? (
        <div className="panel" style={{ padding: 18, maxWidth: 560 }}>
          <Field label="Branch" id="t-branch" hint="Terminal bu branch'in özel bir çalışma kopyasında açılır. Korumalı branch'lerde değişiklik kaydedilmez.">
            <select id="t-branch" className="in" value={branch || project?.defaultBranch || ''} onChange={(e) => setBranch(e.target.value)}>
              {branches.data?.branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn pri" onClick={() => open.mutate()} disabled={open.isPending}>
            <SquareTerminal /> Terminali başlat
          </button>
        </div>
      ) : (
        <div className="term">
          <div className="term-head">
            <span>
              {s.branch} · {s.headCommit ? shortSha(s.headCommit) : '…'}
            </span>
            <span>{s.status === 'starting' ? 'hazırlanıyor…' : s.status === 'failed' ? `başlatılamadı: ${s.error ?? ''}` : 'hazır'}</span>
          </div>
          <div className="term-body">
            {!s.commands.length && s.status === 'ready' && <div className="term-dim">Bir komut yazın veya aşağıdaki kısayollardan birini seçin.</div>}
            {s.commands.map((c) => (
              <div key={c.id} className="term-cmd">
                <div className="term-line">
                  <span className="term-prompt">$</span> {c.command}
                  {(c.status === 'running' || c.status === 'queued') && (
                    <button className="term-cancel" onClick={() => cancel.mutate(c.id)} title="İptal">
                      <Square size={11} /> iptal
                    </button>
                  )}
                </div>
                {c.output && <pre className="term-out">{c.output.replace(ANSI, '')}</pre>}
                {c.status === 'running' && <div className="term-dim">çalışıyor…</div>}
                {c.status === 'queued' && <div className="term-dim">sırada…</div>}
                {(c.status === 'done' || c.status === 'failed' || c.status === 'cancelled') && (
                  <div className={c.status === 'done' ? 'term-ok' : 'term-bad'}>
                    {c.status === 'cancelled' ? 'iptal edildi' : `çıkış kodu ${c.exitCode ?? '?'}`}
                    {c.syncNote && <span className="term-dim"> · {c.syncNote}</span>}
                    {c.commitSha && (
                      <>
                        {' · '}
                        <Link href={`/projects/${slug}/git?commit=${c.commitSha}`}>commit&apos;i gör</Link>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form
            className="term-input"
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <span className="term-prompt">$</span>
            <input
              aria-label="Komut"
              value={input}
              disabled={s.status !== 'ready'}
              placeholder={busy ? 'Komut çalışıyor…' : 'Komut yazın ve Enter’a basın'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' && history.length) {
                  e.preventDefault();
                  const i = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
                  setCursor(i);
                  setInput(history[i]!);
                } else if (e.key === 'ArrowDown' && cursor >= 0) {
                  e.preventDefault();
                  const i = cursor + 1;
                  setCursor(i >= history.length ? -1 : i);
                  setInput(i >= history.length ? '' : history[i]!);
                }
              }}
              autoFocus
            />
            <button className="btn sm pri" type="submit" disabled={busy || s.status !== 'ready' || !input.trim()}>
              <Play size={13} /> Çalıştır
            </button>
          </form>
          <div className="term-quick">
            {QUICK.map((q) => (
              <button key={q} className="btn sm" disabled={busy || s.status !== 'ready'} onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
