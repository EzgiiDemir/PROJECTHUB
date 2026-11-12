'use client';

import { useMutation } from '@tanstack/react-query';
import { Code2, ExternalLink, FolderSync, GitBranch, MonitorUp, SquareTerminal } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { CopyButton, Field, Modal } from '@/components/ui';

interface EditorAccess {
  cloneUrl: string;
  username: string;
  token: string;
  expiresAt: string | null;
  canPush: boolean;
  openers: { id: string; label: string; url: string }[];
  sync: { agentUrl: string; powershell: string; bash: string };
}

/**
 * "Projeyi nerede açmak istersiniz?" — desktop editors (they clone over HTTPS with a token limited to this project's
 * repository), the two-way sync agent for a folder on this computer, or the browser terminal.
 */
export function OpenInButton({ slug, canTerminal }: { slug: string; canTerminal: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <MonitorUp /> Aç
      </button>
      {open && <OpenInDialog slug={slug} canTerminal={canTerminal} onClose={() => setOpen(false)} />}
    </>
  );
}

function OpenInDialog({ slug, canTerminal, onClose }: { slug: string; canTerminal: boolean; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [embed, setEmbed] = useState(false);
  const [shell, setShell] = useState<'powershell' | 'bash'>(typeof navigator !== 'undefined' && /Win/i.test(navigator.platform) ? 'powershell' : 'bash');
  const access = useMutation({ mutationFn: () => api<EditorAccess>(`/projects/${slug}/editor-access`, { method: 'POST', body: { expiresInDays: days, embedToken: embed } }) });
  const a = access.data;

  return (
    <Modal title="Projeyi nerede açmak istersiniz?" onClose={onClose} wide>
      {!a ? (
        <>
          <div className="open-grid" style={{ marginBottom: 14 }}>
            <Link className="open-app" href={`/projects/${slug}/code`} onClick={onClose}>
              <Code2 size={16} />
              <span>Tarayıcı editöründe aç</span>
            </Link>
            {canTerminal && (
              <Link className="open-app" href={`/projects/${slug}/terminal`} onClick={onClose}>
                <SquareTerminal size={16} />
                <span>İzole terminali aç</span>
              </Link>
            )}
            <Link className="open-app" href={`/projects/${slug}/git`} onClick={onClose}>
              <GitBranch size={16} />
              <span>Branch ve commit&apos;leri yönet</span>
            </Link>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Bilgisayarınızdaki editör veya senkronizasyon aracı için yalnızca <b>bu projenin kod deposuna</b> erişebilen bir anahtar oluşturulur. Bu anahtar
            Project Hub API&apos;sinde ve diğer projelerde çalışmaz; Hesabım &gt; Erişim token&apos;ları ekranından istediğiniz an iptal edilir.
          </p>
          <div className="grid g2">
            <Field label="Geçerlilik" id="oi-days">
              <select id="oi-days" className="in" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={1}>1 gün</option>
                <option value={7}>7 gün</option>
                <option value={30}>30 gün</option>
                <option value={90}>90 gün</option>
              </select>
            </Field>
            <label className="check" style={{ alignItems: 'flex-start', marginTop: 22 }}>
              <input type="checkbox" checked={embed} onChange={(e) => setEmbed(e.target.checked)} />
              <span>
                Anahtarı bağlantıya ekle (şifre sorulmaz)
                <div className="small muted">Kolaydır ama Git anahtarı klasördeki .git/config dosyasına yazar.</div>
              </span>
            </label>
          </div>
          {access.error && <div className="badbox">{errorMessage(access.error)}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn pri" onClick={() => access.mutate()} disabled={access.isPending}>
              Masaüstü editör bağlantılarını hazırla
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="open-grid">
            <Link className="open-app" href={`/projects/${slug}/code`} onClick={onClose}>
              <Code2 size={16} />
              <span>Tarayıcı editörü</span>
            </Link>
            {a.openers.map((o) => (
              <a key={o.id} className="open-app" href={o.url}>
                <ExternalLink size={16} />
                <span>{o.label}</span>
              </a>
            ))}
            {canTerminal && (
              <Link className="open-app" href={`/projects/${slug}/terminal`} onClick={onClose}>
                <SquareTerminal size={16} />
                <span>Tarayıcı terminali</span>
              </Link>
            )}
          </div>
          <p className="small muted">
            Seçtiğiniz uygulama açılır ve projeyi klonlar. Şifre sorulursa aşağıdaki kullanıcı adı ve anahtarı girin. Kaydettiğiniz değişiklikleri editörün Git
            menüsünden gönderdiğiniz an Project Hub&apos;daki kod ekranı kendiliğinden güncellenir.
            {!a.canPush && <b> Bu projede yalnızca okuma yetkiniz var; değişiklik gönderemezsiniz.</b>}
          </p>
          <dl className="kv">
            <dt>Klon adresi</dt>
            <dd className="row"><code className="small ellipsis" style={{ maxWidth: 420 }}>{a.cloneUrl}</code><CopyButton text={a.cloneUrl} /></dd>
            <dt>Kullanıcı adı</dt>
            <dd className="row"><code className="small">{a.username}</code><CopyButton text={a.username} /></dd>
            <dt>Anahtar (bir kez gösterilir)</dt>
            <dd className="row"><code className="small ellipsis" style={{ maxWidth: 420 }}>{a.token}</code><CopyButton text={a.token} /></dd>
          </dl>

          <h4 style={{ margin: '18px 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <FolderSync size={16} /> Bilgisayarımdaki klasörle otomatik senkronize et
          </h4>
          <p className="small muted" style={{ marginTop: 0 }}>
            Hangi editörü kullanırsanız kullanın: klasördeki her kayıt birkaç saniye içinde Project Hub&apos;a gider, Project Hub&apos;daki değişiklikler klasöre gelir.
            Node.js ve Git kurulu olmalı. Çakışma olursa hiçbir değişiklik silinmez; sizinki ayrı bir branch&apos;e gönderilir.
          </p>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <button className={`btn sm ${shell === 'powershell' ? 'pri' : ''}`} onClick={() => setShell('powershell')}>Windows (PowerShell)</button>
            <button className={`btn sm ${shell === 'bash' ? 'pri' : ''}`} onClick={() => setShell('bash')}>macOS / Linux</button>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <pre className="log" style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, maxHeight: 120 }}>{a.sync[shell]}</pre>
            <CopyButton text={a.sync[shell]} />
          </div>
        </>
      )}
    </Modal>
  );
}
