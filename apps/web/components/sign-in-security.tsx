'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { Fingerprint, Mail, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { Async, Badge, CopyButton, Field, Modal, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Security {
  totpEnabled: boolean;
  totpEnabledAt: string | null;
  recoveryCodesLeft: number;
  emailCode: boolean;
  passkeys: { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null }[];
  rpId: string;
}

/** Account > sign-in security: authenticator app, recovery codes, passkeys and the e-mail code. */
export function SignInSecurity() {
  const q = useQuery({ queryKey: ['auth-security'], queryFn: () => api<Security>('/auth/security') });
  const [dialog, setDialog] = useState<null | 'totp' | 'totp-off' | 'recovery' | { delete: string }>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['auth-security'] });
  const addPasskey = useMutation({
    mutationFn: async () => {
      const r = await api<{ ticket: string; options: PublicKeyCredentialCreationOptionsJSON }>('/auth/passkeys/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON: r.options });
      return api('/auth/passkeys', { method: 'POST', body: { ticket: r.ticket, response, name: deviceName() } });
    },
    onSuccess: () => (toast('Passkey eklendi; artık parmak izi / Face ID ile giriş yapabilirsiniz'), refresh()),
    onError: (e) => toast((e as { name?: string }).name === 'NotAllowedError' ? 'Passkey ekleme iptal edildi' : errorMessage(e), 'bad'),
  });

  return (
    <Panel title="Giriş güvenliği" className="mt">
      <Async q={q} rows={3}>
        {(s) => {
          const strong = s.totpEnabled || s.passkeys.length > 0;
          return (
            <>
              <p className="small" style={{ marginTop: 0 }}>
                {strong ? (
                  <>
                    <ShieldCheck size={14} style={{ color: 'var(--ok)', verticalAlign: -2 }} /> Girişte şifreden sonra ikinci doğrulama isteniyor.
                  </>
                ) : s.emailCode ? (
                  <>
                    <Mail size={14} style={{ verticalAlign: -2 }} /> Şu an her girişte e-postanıza kod gönderiliyor. Daha hızlı ve güvenli giriş için doğrulayıcı uygulama veya passkey ekleyin.
                  </>
                ) : (
                  <span style={{ color: 'var(--bad)' }}>İkinci doğrulama yok: yalnızca şifre ile giriş yapılıyor. Aşağıdan doğrulayıcı uygulama veya passkey ekleyin.</span>
                )}
              </p>

              <div className="list-item" style={{ padding: '10px 0' }}>
                <Fingerprint size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>Passkey · parmak izi, Face ID, Windows Hello</b>
                  <div className="small muted">Şifresiz ve oltalamaya dayanıklı giriş. Bu cihazın biyometrik doğrulaması veya PIN&apos;i kullanılır; bilgiler cihazdan çıkmaz.</div>
                </div>
                <button className="btn sm" disabled={addPasskey.isPending || !browserSupportsWebAuthn()} onClick={() => addPasskey.mutate()} title={browserSupportsWebAuthn() ? undefined : 'Bu tarayıcı passkey desteklemiyor'}>
                  {addPasskey.isPending && <span className="spinner" />} Passkey ekle
                </button>
              </div>
              {s.passkeys.map((k) => (
                <div key={k.id} className="list-item" style={{ padding: '6px 0 6px 28px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span>{k.name}</span> {k.backedUp && <Badge tone="ok">senkronize</Badge>}
                    <div className="small muted">
                      Eklendi {dateTime(k.createdAt)} · {k.lastUsedAt ? `son kullanım ${ago(k.lastUsedAt)}` : 'henüz kullanılmadı'}
                    </div>
                  </div>
                  <button className="btn sm ghost" aria-label={`${k.name} passkey'ini sil`} onClick={() => setDialog({ delete: k.id })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <div className="list-item" style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <Smartphone size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>Doğrulayıcı uygulama</b> {s.totpEnabled && <Badge tone="ok">açık</Badge>}
                  <div className="small muted">
                    Microsoft Authenticator, Google Authenticator vb. 30 saniyede bir değişen 6 haneli kod.
                    {s.totpEnabled && ` ${s.recoveryCodesLeft} kurtarma kodu kaldı.`}
                  </div>
                </div>
                {s.totpEnabled ? (
                  <>
                    <button className="btn sm ghost" onClick={() => setDialog('recovery')}>
                      Yeni kurtarma kodları
                    </button>
                    <button className="btn sm ghost" onClick={() => setDialog('totp-off')}>
                      Kapat
                    </button>
                  </>
                ) : (
                  <button className="btn sm" onClick={() => setDialog('totp')}>
                    Kur
                  </button>
                )}
              </div>

              <div className="list-item" style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <Mail size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>E-posta kodu</b> {s.emailCode ? <Badge tone="ok">açık</Badge> : <Badge>kapalı</Badge>}
                  <div className="small muted">{s.emailCode ? 'Başka yöntem yoksa her girişte, varsa yedek olarak e-postanıza tek kullanımlık kod gönderilir.' : 'Sunucuda SMTP ayarlı değil; e-posta ile doğrulama kullanılamıyor.'}</div>
                </div>
              </div>
            </>
          );
        }}
      </Async>
      {dialog === 'totp' && <TotpSetup onClose={() => setDialog(null)} onDone={(c) => (setDialog(null), setCodes(c), refresh())} />}
      {(dialog === 'totp-off' || dialog === 'recovery' || (dialog && typeof dialog === 'object')) && (
        <ConfirmWithPassword
          title={dialog === 'totp-off' ? 'Doğrulayıcı uygulamayı kapat' : dialog === 'recovery' ? 'Yeni kurtarma kodları' : "Passkey'i sil"}
          action={dialog === 'totp-off' ? 'Kapat' : dialog === 'recovery' ? 'Kodları oluştur' : 'Sil'}
          run={async (password) => {
            if (dialog === 'totp-off') await api('/auth/totp/disable', { method: 'POST', body: { password } });
            else if (dialog === 'recovery') setCodes((await api<{ recoveryCodes: string[] }>('/auth/recovery-codes', { method: 'POST', body: { password } })).recoveryCodes);
            else await api(`/auth/passkeys/${(dialog as { delete: string }).delete}/delete`, { method: 'POST', body: { password } });
            setDialog(null);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
    </Panel>
  );
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : 'Cihaz';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
  return `${os} · ${browser}`;
}

function TotpSetup({ onClose, onDone }: { onClose: () => void; onDone: (codes: string[]) => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const start = useMutation({ mutationFn: () => api<{ secret: string; uri: string }>('/auth/totp/setup', { method: 'POST', body: { password } }), onSuccess: setSetup });
  const enable = useMutation({ mutationFn: () => api<{ recoveryCodes: string[] }>('/auth/totp/enable', { method: 'POST', body: { code } }), onSuccess: (r) => onDone(r.recoveryCodes) });
  useEffect(() => {
    if (setup) void QRCode.toDataURL(setup.uri, { margin: 1, width: 200 }).then(setQr);
  }, [setup]);
  return (
    <Modal title="Doğrulayıcı uygulama kur" onClose={onClose}>
      {!setup ? (
        <form onSubmit={(e) => (e.preventDefault(), start.mutate())}>
          <Field label="Mevcut parola" id="totp-pw" hint="Güvenlik için parolanızı doğrulayın">
            <input id="totp-pw" className="in" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          {start.error && <div className="badbox">{errorMessage(start.error)}</div>}
          <button className="btn pri" disabled={!password || start.isPending}>
            Devam
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), enable.mutate())}>
          <p className="small" style={{ marginTop: 0 }}>
            1. Telefonunuzdaki doğrulayıcı uygulamada <b>QR kodu tara</b>&apos;yı seçip bu kodu okutun.
          </p>
          <div style={{ textAlign: 'center', margin: '8px 0' }}>{qr ? <img src={qr} alt="Doğrulayıcı uygulama QR kodu" width={200} height={200} style={{ background: '#fff', padding: 6, borderRadius: 8 }} /> : <span className="spinner" />}</div>
          <p className="small muted">
            QR okutamıyorsanız anahtarı elle girin: <span className="mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span> <CopyButton text={setup.secret} />
          </p>
          <Field label="2. Uygulamada görünen 6 haneli kod" id="totp-code">
            <input id="totp-code" className="in mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="123456" />
          </Field>
          {enable.error && <div className="badbox">{errorMessage(enable.error)}</div>}
          <button className="btn pri" disabled={code.trim().length !== 6 || enable.isPending}>
            Doğrula ve aç
          </button>
        </form>
      )}
    </Modal>
  );
}

function ConfirmWithPassword({ title, action, run, onClose }: { title: string; action: string; run: (password: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const go = useMutation({ mutationFn: () => run(password) });
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), go.mutate())}>
        <Field label="Mevcut parola" id="sec-pw" hint="Güvenlik ayarını değiştirmek için parolanızı doğrulayın">
          <input id="sec-pw" className="in" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {go.error && <div className="badbox">{errorMessage(go.error)}</div>}
        <button className="btn pri" disabled={!password || go.isPending}>
          {action}
        </button>
      </form>
    </Modal>
  );
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  return (
    <Modal title="Kurtarma kodlarınız" onClose={onClose}>
      <p className="small" style={{ marginTop: 0 }}>
        Telefonunuza erişemezseniz bu kodlardan biriyle giriş yapabilirsiniz. Her kod <b>bir kez</b> kullanılır. Kodlar şu an bir kez gösteriliyor; güvenli bir yere kaydedin.
      </p>
      <pre className="mono" style={{ columns: 2, background: 'var(--sunk)', padding: 12, borderRadius: 8, margin: '8px 0' }}>{codes.join('\n')}</pre>
      <div className="row">
        <CopyButton text={codes.join('\n')} />
        <button className="btn pri" onClick={onClose}>
          Kaydettim
        </button>
      </div>
    </Modal>
  );
}
