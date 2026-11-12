import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiMemories, codeChunks, codeFiles, organizations, projects, repositories, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import { answerIsGrounded, buildProjectContext, explicitCitations } from '../src/ai/index.js';

let h: DatabaseHandle;

beforeAll(async () => {
  h = await freshDatabase();
});

afterAll(async () => {
  await h?.close();
});

describe('persistent project context retrieval', () => {
  it('accepts only explicitly cited evidence as grounded', () => {
    const citations = [
      { type: 'file' as const, ref: 'src/payment.ts', label: 'src/payment.ts:10', line: 10 },
      { type: 'memory' as const, ref: 'memory-1', label: 'Hafıza: Ödeme kararı' },
    ];
    const used = explicitCitations('Hesap src/payment.ts:10 içindedir.', citations);
    expect(used).toEqual([citations[0]]);
    expect(answerIsGrounded('Hesap src/payment.ts:10 içindedir.', citations, used)).toBe(true);
    expect(answerIsGrounded('Hesap başka bir dosyadadır.', citations, [])).toBe(false);
    expect(answerIsGrounded('Bu bilgi proje bağlamında bulunamadı.', citations, [])).toBe(true);
  });

  it('combines lexical code retrieval with verified memory and never crosses project boundaries', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'O', slug: 'o' }).returning())[0]!;
    const [project, other] = await h.db.insert(projects).values([
      { organizationId: org.id, name: 'Ödeme', slug: 'odeme', technologies: ['TypeScript'] },
      { organizationId: org.id, name: 'Gizli', slug: 'gizli', technologies: ['Go'] },
    ]).returning();
    await h.db.insert(codeChunks).values({ projectId: project!.id, path: 'src/payment.ts', startLine: 10, endLine: 12, content: 'export function calculatePaymentTotal(items: Item[]) { return sum(items); }' });
    await h.db.insert(aiMemories).values([
      { organizationId: org.id, projectId: project!.id, category: 'decision', title: 'Ödeme yuvarlama kararı', content: 'Tutarlar ödeme sağlayıcısına gönderilmeden önce kuruş cinsine çevrilir.', verification: 'verified', sourceType: 'user', sourceLabel: 'ADR-12', createdByType: 'user' },
      { organizationId: org.id, projectId: other!.id, category: 'fact', title: 'Gizli ödeme anahtarı', content: 'Bu başka projeye ait bilgi yanıtta görünmemeli.', verification: 'verified', sourceType: 'user', createdByType: 'user' },
    ]);

    const context = await buildProjectContext(h.db, project!.id, 'ödeme payment tutarı nasıl hesaplanır');
    expect(context.text).toContain('Ödeme yuvarlama kararı');
    expect(context.text).toContain('src/payment.ts:10-12');
    expect(context.text).not.toContain('Gizli ödeme anahtarı');
    expect(context.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'memory', label: 'Hafıza: Ödeme yuvarlama kararı' }),
      expect.objectContaining({ type: 'file', ref: 'src/payment.ts', line: 10 }),
    ]));
  });

  it('uses local semantic vectors when words do not overlap and keeps unrelated chunks out', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'Semantic', slug: 'semantic' }).returning())[0]!;
    const project = (await h.db.insert(projects).values({ organizationId: org.id, name: 'Oturum', slug: 'oturum', technologies: ['TypeScript'] }).returning())[0]!;
    await h.db.insert(codeChunks).values([
      {
        projectId: project.id,
        path: 'src/session.ts',
        startLine: 4,
        endLine: 8,
        content: 'export function rotateSessionCredential() { return issueReplacementCredential(); }',
        embedding: [1, 0, 0],
        embeddingModel: 'test-local-embedding',
      },
      {
        projectId: project.id,
        path: 'src/invoice.ts',
        startLine: 2,
        endLine: 4,
        content: 'export function calculateInvoiceSubtotal() { return 42; }',
        embedding: [0, 1, 0],
        embeddingModel: 'test-local-embedding',
      },
    ]);

    const context = await buildProjectContext(h.db, project.id, 'müşterinin kimlik doğrulamasını kesintisiz devam ettir', {
      embedding: { model: 'test-local-embedding', embed: async () => [[1, 0, 0]] },
    });

    expect(context.text).toContain('src/session.ts:4-8');
    expect(context.text).not.toContain('src/invoice.ts');
    expect(context.citations).toContainEqual(expect.objectContaining({ type: 'file', ref: 'src/session.ts', line: 4 }));
  });

  it('refuses to present stale indexed code as current project evidence', async () => {
    const org = (await h.db.insert(organizations).values({ name: 'Stale', slug: 'stale' }).returning())[0]!;
    const project = (await h.db.insert(projects).values({ organizationId: org.id, name: 'Stale Project', slug: 'stale-project' }).returning())[0]!;
    await h.db.insert(repositories).values({ projectId: project.id, storageKey: 'repos/stale.git', status: 'ready', headCommit: 'b'.repeat(40) });
    await h.db.insert(codeFiles).values({ projectId: project.id, path: 'src/old.ts', blobSha: 'c'.repeat(40), language: 'TypeScript', lines: 1, indexedCommit: 'a'.repeat(40) });
    await h.db.insert(codeChunks).values({ projectId: project.id, path: 'src/old.ts', startLine: 1, endLine: 1, content: 'export const obsoletePaymentRule = true;' });
    await h.db.insert(aiMemories).values({ organizationId: org.id, projectId: project.id, category: 'architecture', title: 'Eski repository özeti', content: 'obsoletePaymentRule geçerli mimarinin parçasıdır.', verification: 'verified', sourceType: 'repository_index', sourceRef: 'a'.repeat(40), createdByType: 'system' });

    const context = await buildProjectContext(h.db, project.id, 'obsoletePaymentRule');
    expect(context.text).toContain('GÜNCEL DEĞİL');
    expect(context.text).not.toContain('export const obsoletePaymentRule');
    expect(context.text).not.toContain('Eski repository özeti');
    expect(context.citations).not.toContainEqual(expect.objectContaining({ type: 'file', ref: 'src/old.ts' }));
  });
});
