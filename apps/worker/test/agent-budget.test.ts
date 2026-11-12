import { describe, expect, it } from 'vitest';
import { agentBudget } from '../src/jobs/agent-budget.js';

describe('AI agent task budgets', () => {
  it('bounds precise one-file fixes without switching away from the strong model', () => {
    expect(agentBudget({
      title: 'FormRenderer güvenlik düzeltmesi',
      instruction: 'frontend/src/components/FormRenderer.tsx:477 satırındaki HTML enjeksiyonunu düzelt.',
      type: 'fix',
      configuredMaxSteps: 30,
    })).toMatchObject({ focused: true, maxSteps: 16, tokenLimit: 400_000, referencedFiles: ['frontend/src/components/FormRenderer.tsx'] });
  });

  it('keeps the configured depth for multi-file and architectural work but adds a runaway fuse', () => {
    expect(agentBudget({
      title: 'Sepet hatalarını düzelt',
      instruction: 'src/cart.mjs ve test/cart.test.mjs dosyalarını birlikte incele.',
      type: 'fix',
      configuredMaxSteps: 30,
    })).toMatchObject({ focused: false, maxSteps: 30, tokenLimit: 750_000 });
    expect(agentBudget({
      title: 'Mimariyi değerlendir',
      instruction: 'src/app.ts için tüm bağımlılık etkilerini incele.',
      type: 'architecture_review',
      configuredMaxSteps: 24,
    })).toMatchObject({ focused: false, maxSteps: 24 });
  });
});

