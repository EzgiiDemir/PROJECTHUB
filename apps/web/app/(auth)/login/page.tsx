'use client';

import { useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, Mail, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { ArucadLogo } from '@/components/brand/logo';
import { Field } from '@/components/ui';

type Method = 'totp' | 'email' | 'passkey' | 'recovery';
interface Step {
  mfaRequired: true;
  ticket: string;
  methods: Method[];
  emailSent: boolean;
  email: string;
}

const METHOD_LABEL: Record<Method, string> = { passkey: 'Parmak izi / Face ID', totp: 'Doğrulayıcı uygulama', email: 'E-posta kodu', recovery: 'Kurtarma kodu' };
const METHOD_ICON: Record<Method, React.ReactNode> = { passkey: <Fingerprint size={15} />, totp: <Smartphone size={15} />, email: <Mail size={15} />, recovery: <KeyRound size={15} /> };

/** Passkey ceremonies fail with DOMExceptions whose text means nothing to people; say what happened instead. */
function passkeyError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Passkey doğrulaması iptal edildi veya zaman aşımına uğradı.';
  if (name === 'SecurityError') return 'Passkey bu adreste kullanılamıyor (HTTPS veya localhost gerekir).';
  return errorMessage(e);
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<Step | null>(null);
  const [method, setMethod] = useState<Method>('totp');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => setPasskeys(browserSupportsWebAuthn()), []);

  const done = () => {
    qc.clear();
    const next = params.get('next');
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<Step | { user: unknown }>('/auth/login', { method: 'POST', body: { email, password } });
      if ('mfaRequired' in r) {
        setStep(r);
        setMethod(r.methods[0]!);
        setCode('');
        setInfo(r.emailSent ? `${r.email} adresine 6 haneli bir kod gönderildi.` : null);
        return;
      }
      done();
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!step) return;
    void run(async () => {
      await api('/auth/mfa/verify', { method: 'POST', body: { ticket: step.ticket, method, code } });
      done();
    });
  };

  const sendEmail = () =>
    run(async () => {
      const r = await api<{ email: string }>('/auth/mfa/email', { method: 'POST', body: { ticket: step!.ticket } });
      setInfo(`${r.email} adresine 6 haneli bir kod gönderildi.`);
    });

  const secondFactorPasskey = () =>
    run(async () => {
      const options = await api<PublicKeyCredentialRequestOptionsJSON>('/auth/mfa/passkey/options', { method: 'POST', body: { ticket: step!.ticket } });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/auth/mfa/passkey/verify', { method: 'POST', body: { ticket: step!.ticket, response } });
      done();
    });

  const passwordless = () =>
    run(async () => {
      const r = await api<{ ticket: string; options: PublicKeyCredentialRequestOptionsJSON }>('/auth/passkey/options', { method: 'POST', body: {} });
      const response = await startAuthentication({ optionsJSON: r.options });
      await api('/auth/passkey/verify', { method: 'POST', body: { ticket: r.ticket, response } });
      done();
    });

  const choose = (m: Method) => {
    setMethod(m);
    setCode('');
    setError(null);
    if (m === 'email' && step && !info) void sendEmail();
    if (m === 'passkey') void secondFactorPasskey();
  };

  const header = (
    <div className="auth-brand">
      <ArucadLogo height={38} priority />
      <span>Project Hub</span>
    </div>
  );
  const alert = error && (
    <div className="badbox" role="alert" style={{ marginBottom: 12 }}>
      {error}
    </div>
  );
  const wide = { width: '100%', justifyContent: 'center', padding: 10 } as const;

  if (step) {
    return (
      <form className="card" onSubmit={submitCode}>
        {header}
        <h1 style={{ marginBottom: 6 }}>İki adımlı doğrulama</h1>
        <p className="sub" style={{ marginBottom: 14 }}>Şifreniz doğru. Girişi tamamlamak için kimliğinizi bir kez daha doğrulayın.</p>
        {step.methods.length > 1 && (
          <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {step.methods.map((m) => (
              <button key={m} type="button" className={`chip ${method === m ? 'on' : ''}`} onClick={() => choose(m)}>
                {METHOD_ICON[m]} {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        {method === 'passkey' ? (
          <button type="button" className="btn pri" style={wide} disabled={busy} onClick={() => void secondFactorPasskey()}>
            {busy ? <span className="spinner" /> : <Fingerprint size={16} />} Parmak izi / Face ID ile doğrula
          </button>
        ) : (
          <>
            <Field id="code" label={method === 'totp' ? 'Doğrulayıcı uygulamadaki 6 haneli kod' : method === 'email' ? 'E-postanıza gelen 6 haneli kod' : 'Kurtarma kodlarınızdan biri'}>
              <input id="code" className="in mono" inputMode={method === 'recovery' ? 'text' : 'numeric'} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder={method === 'recovery' ? 'abcd-efgh-ijkl' : '123456'} maxLength={method === 'recovery' ? 20 : 6} />
            </Field>
            {method === 'email' && (
              <p className="small muted" style={{ marginTop: -4 }}>
                {info ?? 'Kod e-posta adresinize gönderilecek.'}{' '}
                <button type="button" className="linklike" onClick={() => void sendEmail()} disabled={busy}>
                  Yeniden gönder
                </button>
              </p>
            )}
            {alert}
            <button className="btn pri" style={wide} disabled={busy || code.trim().length < 6}>
              {busy && <span className="spinner" />} Doğrula ve giriş yap
            </button>
          </>
        )}
        {method === 'passkey' && alert}
        <p className="small muted" style={{ marginTop: 14, textAlign: 'center' }}>
          <button type="button" className="linklike" onClick={() => (setStep(null), setPassword(''), setError(null), setInfo(null))}>
            Farklı hesapla giriş yap
          </button>
        </p>
      </form>
    );
  }

  return (
    <form className="card" onSubmit={submitPassword}>
      {header}
      <h1 style={{ marginBottom: 6 }}>Giriş yapın</h1>
      <p className="sub" style={{ marginBottom: 18 }}>Şirket hesabınızla devam edin.</p>
      <Field id="email" label="E-posta">
        <input id="email" className="in" type="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field id="password" label="Şifre">
        <input id="password" className="in" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {alert}
      <button className="btn pri" style={wide} disabled={busy}>
        {busy && <span className="spinner" />} Giriş yap
      </button>
      {passkeys && (
        <button type="button" className="btn" style={{ ...wide, marginTop: 10 }} disabled={busy} onClick={() => void passwordless()}>
          <Fingerprint size={16} /> Parmak izi / Face ID / Windows Hello ile giriş
        </button>
      )}
      <p className="small muted" style={{ marginTop: 14, textAlign: 'center' }}>
        <Link href="/forgot-password">Şifremi unuttum</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="auth">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
