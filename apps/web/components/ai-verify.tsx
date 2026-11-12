'use client';

import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Modal } from '@/components/ui';

interface VerifyResult {
  passed: boolean;
  score: number;
  model: string;
  totalMs: number;
  firstTokenMs: number | null;
  checks: { id: string; label: string; passed: boolean; points: number; detail: string }[];
  questions: { q: string; answer: string; ms: number }[];
  error: string | null;
}

/**
 * "Doğruluğu test et": asks the project AI questions whose correct answer is known from this project's own data
 * (and one it must admit not knowing), through the same pipeline as the chat, and shows the evidence.
 */
export function AiVerifyButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const run = useMutation({ mutationFn: () => api<VerifyResult>(`/projects/${slug}/ai/verify`, { method: 'POST', body: {} }) });
  const r = run.data;
  return (
    <>
      <button
        className="btn"
        onClick={() => {
          setOpen(true);
          run.mutate();
        }}
        title="Projenin gerçek verisiyle cevabı bilinen sorular sorar ve AI'nın doğru, uydurmadan yanıt verdiğini ölçer"
      >
        <ShieldCheck /> Doğruluğu test et
      </button>
      {open && (
        <Modal title="AI doğruluk testi (bu projenin gerçek verisiyle)" onClose={() => setOpen(false)} wide>
          {run.isPending ? (
            <p className="muted">
              <span className="spinner" /> Yerel model projeyle ilgili 5 soruyu yanıtlıyor; cevaplar veritabanındaki gerçek değerlerle karşılaştırılıyor…
            </p>
          ) : run.error ? (
            <div className="badbox">{errorMessage(run.error)}</div>
          ) : r ? (
            <>
              <div className="row" style={{ alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 30, fontWeight: 700, color: r.passed ? 'var(--ok)' : 'var(--bad)' }}>{r.score}/100</span>
                <span className="small muted">
                  {r.model} · toplam {(r.totalMs / 1000).toFixed(1)} sn{r.firstTokenMs != null ? ` · ilk yanıt ${(r.firstTokenMs / 1000).toFixed(1)} sn` : ''}
                </span>
              </div>
              {r.error && <div className="badbox">{r.error}</div>}
              {r.checks.map((c) => (
                <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <span style={{ color: c.passed ? 'var(--ok)' : 'var(--bad)', fontWeight: 700 }}>{c.passed ? '✓' : '✗'}</span>
                  <div style={{ flex: 1 }}>
                    <div>{c.label}</div>
                    <div className="small muted">{c.detail}</div>
                  </div>
                </div>
              ))}
              <details style={{ marginTop: 10 }}>
                <summary className="small">Sorulan sorular ve AI’nın cevapları</summary>
                {r.questions.map((q, i) => (
                  <div key={i} className="small" style={{ margin: '8px 0' }}>
                    <b>{q.q}</b> <span className="muted">({(q.ms / 1000).toFixed(1)} sn)</span>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{q.answer}</div>
                  </div>
                ))}
              </details>
              <p className="small muted" style={{ marginBottom: 0 }}>
                100/100, modelin bu proje hakkında şu an doğru veriyi kullandığını ve bilmediğini uydurmadığını gösterir; her gelecekteki cevap için garanti değildir. Kod değişiklikleri bu yüzden ayrıca build, test ve tarama ile doğrulanır.
              </p>
            </>
          ) : null}
        </Modal>
      )}
    </>
  );
}
