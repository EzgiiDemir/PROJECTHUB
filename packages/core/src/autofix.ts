import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { aiTasks, securityFindings, type AiAutofix, type AutofixUpgrade, type Executor } from '@projecthub/database';
import { audit, nextNumber, publish, timeline, type Actor } from './activity.js';
import type { GitRepository } from './git.js';
import { enqueue, QUEUES } from './queue.js';

/**
 * "Fix all with AI" planning, shared by the API (user-triggered) and the worker (automatic mode): groups open problems
 * into fix tasks, picks the safest method for each and classifies risk. The worker proves every fix after its
 * verification build; only proven low-risk fixes merge without a human.
 */

export interface PlanFinding {
  id: string;
  number: number;
  type: string;
  ruleId: string;
  severity: string;
  title: string;
  description: string;
  filePath: string | null;
  line: number | null;
  packageName: string | null;
  packageVersion: string | null;
  fixedVersion: string | null;
}

export interface AutofixItem {
  key: string;
  title: string;
  kind: AiAutofix['kind'];
  mode: AiAutofix['mode'];
  risk: AiAutofix['risk'];
  /** Merged automatically once proven (build, tests, re-scan), otherwise a human decides. */
  autoMerge: boolean;
  findingIds: string[];
  details: string[];
  /** One sentence for non-developers: what will be done. */
  method: string;
  instruction?: string;
  upgrades?: AutofixUpgrade[];
  files?: AiAutofix['files'];
  sourceType: 'finding' | 'build' | 'manual';
  sourceId?: string;
}

export interface AutofixSkip {
  title: string;
  reason: string;
  findingIds: string[];
}

export interface PlanInput {
  findings: PlanFinding[];
  /** Findings already being fixed by an open auto-fix task. */
  busy: Set<string>;
  failedBuild: { id: string; number: number; error: { step?: string; message?: string } | null; aiAnalysis?: string | null } | null;
  docsMissing: boolean;
  aiReady: boolean;
  autoMergeOn: boolean;
  /** Background remediation should not compete with optional major-version migrations. Manual plans include them. */
  includeOptionalUpgrades?: boolean;
}

const MAX_FINDINGS_PER_AGENT_TASK = 5;
/** Build output and framework caches that should never be committed (fixed by removing them, not editing). */
export const GENERATED_PATH = /(^|\/)(storage\/framework\/(views|cache|sessions)|bootstrap\/cache|node_modules|vendor|dist|build|\.next|\.nuxt|out|coverage|__pycache__)\//i;
const ENV_FILE = /(^|\/)\.env($|\.(?!example$|sample$|dist$)[^/]*$)/i;

export const METHOD_LABEL: Record<AiAutofix['mode'], string> = {
  dependency: 'Paket yöneticisi güvenli sürüme yükseltir (AI modeli gerekmez)',
  files: 'Dosyalar repodan kaldırılır ve .gitignore’a eklenir (AI modeli gerekmez)',
  agent: 'Yerel AI kodu düzeltir',
};

export function planAutofix(input: PlanInput): { items: AutofixItem[]; skipped: AutofixSkip[] } {
  const items: AutofixItem[] = [];
  const skipped: AutofixSkip[] = [];
  const open = input.findings.filter((f) => !input.busy.has(f.id));

  // 1. Vulnerable dependencies with a published fix: deterministic upgrades, split by semver risk.
  const byPkg = new Map<string, { findings: PlanFinding[]; to: string; ecosystem: string; source: string; from: string | null }>();
  for (const f of open.filter((x) => x.type === 'dependency')) {
    const ecosystem = ecosystemOf(f.filePath);
    if (f.ruleId === 'dependency/outdated-major') {
      if (input.includeOptionalUpgrades === false) {
        skipped.push({ title: f.title, reason: 'Güvenlik açığı olmayan ana sürüm yükseltmesi; Bağımlılıklar ekranından ayrıca başlatılabilir.', findingIds: [f.id] });
        continue;
      }
      // Not a vulnerability: a new major version. Prepared and verified like any upgrade (one package per task so
      // each can be judged on its own), never merged without a person.
      if (!ecosystem || !f.packageName || !f.fixedVersion) {
        skipped.push({ title: f.title, reason: 'Bu paket türü için otomatik yükseltme yok; güvenlik açığı değil, yalnızca yeni ana sürüm.', findingIds: [f.id] });
        continue;
      }
      items.push({
        key: `major-${f.packageName}`,
        title: `${f.packageName} paketini ${f.fixedVersion} ana sürümüne yükselt`,
        kind: 'dependency',
        mode: 'dependency',
        risk: 'high',
        autoMerge: false,
        findingIds: [f.id],
        details: [
          `${f.packageName} ${f.packageVersion ?? '?'} → ${f.fixedVersion}`,
          'Ana sürüm değişikliği kodu etkileyebilir: kurulum, build ve tarama doğrulanır; birleştirmeden önce sürüm notlarını ve ön izlemeyi kontrol edip onaylarsınız.',
        ],
        method: 'Paket yöneticisi yeni ana sürüme yükseltir; doğrulandıktan sonra onayınıza gelir (AI modeli gerekmez)',
        upgrades: [{ ecosystem, name: f.packageName, from: f.packageVersion, to: f.fixedVersion, source: f.filePath! }],
        sourceType: 'finding',
        sourceId: f.id,
      });
      continue;
    }
    if (!f.packageName || !f.fixedVersion) {
      skipped.push({ title: f.title, reason: 'Düzeltilmiş sürüm henüz yayımlanmamış; yayımlandığında otomatik önerilir.', findingIds: [f.id] });
      continue;
    }
    if (!ecosystem) {
      skipped.push({ title: f.title, reason: `${f.filePath ?? 'bilinmeyen dosya'} için otomatik güncelleme yok; Bağımlılıklar ekranındaki komutla elle yükseltin.`, findingIds: [f.id] });
      continue;
    }
    const k = `${ecosystem}|${f.filePath}|${f.packageName}`;
    const cur = byPkg.get(k);
    const to = cur && compareVersions(cur.to, f.fixedVersion) >= 0 ? cur.to : f.fixedVersion;
    byPkg.set(k, { findings: [...(cur?.findings ?? []), f], to, ecosystem, source: f.filePath!, from: f.packageVersion });
  }
  const low: { findings: PlanFinding[]; to: string; ecosystem: string; source: string; from: string | null }[] = [];
  const major: typeof low = [];
  for (const v of byPkg.values()) (sameMajor(v.from, v.to) ? low : major).push(v);
  for (const [group, risk] of [
    [low, 'low'],
    [major, 'medium'],
  ] as const) {
    if (!group.length) continue;
    const upgrades = group.map((g) => ({ ecosystem: g.ecosystem, name: g.findings[0]!.packageName!, from: g.from, to: g.to, source: g.source }));
    items.push({
      key: `dependency-${risk}`,
      title: risk === 'low' ? 'Açıklı paketleri güvenli sürüme yükselt (uyumlu sürümler)' : 'Açıklı paketleri güvenli sürüme yükselt (ana sürüm değişikliği)',
      kind: 'dependency',
      mode: 'dependency',
      risk,
      autoMerge: risk === 'low' && input.autoMergeOn,
      findingIds: group.flatMap((g) => g.findings.map((f) => f.id)),
      details: upgrades.map((u) => `${u.name} ${u.from ?? '?'} → ${u.to}`),
      method: METHOD_LABEL.dependency,
      upgrades,
      sourceType: 'finding',
      sourceId: group[0]!.findings[0]!.id,
    });
  }

  // 2. Secrets. Deterministic file cleanup is one verification batch; source secrets are grouped in small batches.
  //    This avoids repeating the same model startup + build + scan for every file while retaining a review boundary.
  const secrets = open.filter((x) => x.type === 'secret');
  const envFiles = secrets.filter((f) => ENV_FILE.test(f.filePath ?? ''));
  const generated = secrets.filter((f) => !ENV_FILE.test(f.filePath ?? '') && GENERATED_PATH.test(f.filePath ?? ''));
  const inSource = secrets.filter((f) => !envFiles.includes(f) && !generated.includes(f));
  if (envFiles.length || generated.length) {
    const envPaths = [...new Set(envFiles.map((f) => f.filePath!))];
    const generatedPaths = [...new Set(generated.map((f) => f.filePath!))];
    const dirs = [...new Set(generatedPaths.map((f) => f.slice(0, f.search(GENERATED_PATH) + (GENERATED_PATH.exec(f)?.[0].length ?? 0)).replace(/^\//, '')))];
    const ignore = [...(envPaths.length ? ['.env', '.env.*', '!.env.example'] : []), ...dirs.map((d) => `/${d}*`)];
    items.push({
      key: envPaths.length ? 'secret-env-files' : 'secret-generated',
      title: envPaths.length
        ? `Repoya eklenmiş gizli/üretilmiş dosyaları kaldır (${envPaths.length + generatedPaths.length})`
        : `Repoya eklenmiş derleme/önbellek dosyalarını kaldır (${generatedPaths.length})`,
      kind: 'secret',
      mode: 'files',
      risk: envPaths.length ? 'high' : 'medium',
      autoMerge: false,
      findingIds: [...envFiles, ...generated].map((f) => f.id),
      details: [
        ...(envPaths.length
          ? [`${envPaths.join(', ')} repodan silinir ve .gitignore’a eklenir; bilgisayarlardaki ve sunuculardaki kopyalar silinmez.`, 'Dosyadaki şifre ve anahtarlar Git geçmişinde kaldığı için YENİLENMELİ.', 'Sunucu ayarları için Project Hub > Secret’lar ekranını kullanın.']
          : []),
        ...(generatedPaths.length ? [...generatedPaths.slice(0, 4), 'Derleme/önbellek dosyaları uygulama çalışırken yeniden oluşur.'] : []),
      ],
      method: METHOD_LABEL.files,
      files: { delete: [...envPaths, ...generatedPaths], ignore },
      sourceType: 'finding',
      sourceId: (envFiles[0] ?? generated[0])!.id,
    });
  }
  for (let i = 0; i < inSource.length; i += MAX_FINDINGS_PER_AGENT_TASK) {
    const list = inSource.slice(i, i + MAX_FINDINGS_PER_AGENT_TASK);
    const files = [...new Set(list.map((f) => f.filePath).filter((file): file is string => !!file))];
    items.push({
      key: `secret-source-${i}`,
      title: `Koddaki gizli bilgileri ortam değişkenine taşı (${files.length || 1} dosya)`,
      kind: 'secret',
      mode: 'agent',
      risk: 'high',
      autoMerge: false,
      findingIds: list.map((f) => f.id),
      details: [...list.map((f) => `SEC-${f.number} ${f.title}${f.line ? ` (satır ${f.line})` : ''}`), 'Birleştirmeden sonra şifre/anahtar yenilenmeli; eski değer Git geçmişinde kalır.'],
      method: METHOD_LABEL.agent,
      instruction: [
        'Aşağıdaki dosyalardaki koda gömülü gizli değerleri en küçük doğru değişiklikle kaldır:',
        ...list.map((f) => `- SEC-${f.number} ${f.title}: ${f.filePath ?? '(proje)'}${f.line ? `:${f.line}` : ''}`),
        'Değeri ortam değişkeninden oku (ör. process.env.X, env(\'X\'), config(\'...\'), os.environ). Değişken adını .env.example dosyasına boş değerle ekle. Gizli değeri hiçbir dosyaya yazma, yanıtında da tekrar etme.',
      ].join('\n'),
      sourceType: 'finding',
      sourceId: list[0]!.id,
    });
  }

  // 3a. A missing npm lockfile: the package manager writes it (deterministic, no AI, scripts never run).
  const lockless = open.filter((x) => x.ruleId === 'config/missing-lockfile' && ecosystemOf(x.filePath) === 'npm');
  for (const f of lockless) {
    items.push({
      key: `lockfile-${f.filePath}`,
      title: 'Bağımlılık kilit dosyasını oluştur',
      kind: 'dependency',
      mode: 'dependency',
      risk: 'low',
      autoMerge: input.autoMergeOn,
      findingIds: [f.id],
      details: [`${f.filePath} için package-lock.json üretilir (npm install --package-lock-only; paket betikleri çalıştırılmaz).`],
      method: 'Paket yöneticisi kilit dosyasını üretir; build ve yeniden tarama doğrular (AI modeli gerekmez)',
      upgrades: [{ ecosystem: 'npm', name: '', from: null, to: 'lockfile', source: f.filePath! }],
      sourceType: 'finding',
      sourceId: f.id,
    });
  }

  // 3b. Code, configuration and infrastructure findings: the coding agent, grouped per file.
  const byFile = new Map<string, PlanFinding[]>();
  for (const f of open.filter((x) => (x.type === 'code' || x.type === 'config') && !lockless.includes(x))) byFile.set(f.filePath ?? '(proje)', [...(byFile.get(f.filePath ?? '(proje)') ?? []), f]);
  for (const [file, list] of byFile) {
    for (let i = 0; i < list.length; i += MAX_FINDINGS_PER_AGENT_TASK) {
      const chunk = list.slice(i, i + MAX_FINDINGS_PER_AGENT_TASK);
      items.push({
        key: `code-${file}-${i}`,
        title: `${file}: ${chunk.length} güvenlik/yapılandırma sorununu düzelt`,
        kind: 'code',
        mode: 'agent',
        risk: 'medium',
        autoMerge: false,
        findingIds: chunk.map((f) => f.id),
        details: chunk.map((f) => `SEC-${f.number} [${f.severity}] ${f.title}`),
        method: METHOD_LABEL.agent,
        instruction: [
          `Aşağıdaki güvenlik/yapılandırma bulgularını ${file} dosyasında düzelt. Davranışı değiştirme, yalnızca sorunu gider.`,
          ...chunk.map((f) => `- SEC-${f.number} (${f.ruleId}) ${f.title}${f.line ? ` · satır ${f.line}` : ''}: ${f.description.slice(0, 400)}`),
        ].join('\n'),
        sourceType: 'finding',
        sourceId: chunk[0]!.id,
      });
    }
  }

  // 4. Project health: a failing default-branch build and a missing README.
  if (input.failedBuild) {
    const b = input.failedBuild;
    items.push({
      key: `build-${b.id}`,
      title: `Başarısız build #${b.number}'i düzelt`,
      kind: 'build',
      mode: 'agent',
      risk: 'medium',
      autoMerge: false,
      findingIds: [],
      details: [`${b.error?.step ?? ''}: ${b.error?.message ?? ''}`.slice(0, 300)],
      method: METHOD_LABEL.agent,
      instruction: [`Build #${b.number} başarısız. Adım: ${b.error?.step ?? '?'}. Hata: ${b.error?.message ?? '?'}`, b.aiAnalysis ? `Analiz:\n${b.aiAnalysis}` : '', 'Build’i düzelt; testleri bozma.'].filter(Boolean).join('\n'),
      sourceType: 'build',
      sourceId: b.id,
    });
  }
  if (input.docsMissing) {
    items.push({
      key: 'docs-readme',
      title: 'README dosyası oluştur',
      kind: 'docs',
      mode: 'agent',
      risk: 'low',
      autoMerge: input.autoMergeOn,
      findingIds: [],
      details: ['Projenin ne yaptığı, kurulumu ve çalıştırılması için README.md (yalnızca dokümantasyon dosyası değişir).'],
      method: METHOD_LABEL.agent,
      instruction: 'Projenin kök dizinine README.md oluştur: projenin amacı, kullanılan teknolojiler, kurulum ve çalıştırma komutları, ortam değişkenleri (değer yazmadan). Yalnızca .md dosyası oluştur veya değiştir; kod dosyalarına dokunma.',
      sourceType: 'manual',
    });
  }

  if (!input.aiReady) {
    for (const i of items.filter((x) => x.mode === 'agent')) skipped.push({ title: i.title, reason: 'Yerel AI modeli hazır değil (Yönetim > AI kontrol merkezi). Model hazır olunca bu adım da otomatik yapılabilir.', findingIds: i.findingIds });
  }
  return { items: input.aiReady ? items : items.filter((i) => i.mode !== 'agent'), skipped };
}

/** Deterministic fixes run the package manager or remove files; only the rest needs the (single, slow) model queue. */
export function autofixQueue(autofix: { mode?: string } | null | undefined) {
  return autofix?.mode === 'dependency' || autofix?.mode === 'files' ? QUEUES.fix : QUEUES.ai;
}

/** Deterministic fixes (package upgrades, file removals) are simply redone on the current base branch. */
export function canReprepare(task: { autofix: AiAutofix | null }): boolean {
  return task.autofix?.mode === 'dependency' || task.autofix?.mode === 'files';
}

/**
 * Instead of resolving a merge conflict by hand, the task is prepared again on top of the current base branch (old
 * branch removed) and verified again; it comes back for approval when proven.
 */
export async function reprepareAutofix(db: Executor, git: GitRepository, task: typeof aiTasks.$inferSelect, actor: Actor, reason: string) {
  if (task.branch) {
    const head = await git.resolve(`refs/heads/${task.branch}`);
    if (head) await git.deleteBranch(task.branch, head);
  }
  await db.transaction(async (tx) => {
    await tx.update(aiTasks).set({ status: 'queued', branch: null, headCommit: null, baseCommit: null, buildId: null, result: null, error: null, completedAt: null, autofix: task.autofix ? { ...task.autofix, verdict: undefined } : null }).where(eq(aiTasks.id, task.id));
    await enqueue(tx, { queue: autofixQueue(task.autofix), type: 'ai.task.run', organizationId: task.organizationId, projectId: task.projectId, maxAttempts: 1, payload: { taskId: task.id } });
    await audit(tx, { organizationId: task.organizationId, projectId: task.projectId, actor, action: 'ai.task.reverify', resourceType: 'ai_task', resourceId: task.id, metadata: { reprepared: true, reason } });
    await timeline(tx, { organizationId: task.organizationId, projectId: task.projectId, kind: 'ai', tone: 'run', title: `AI-${task.number} güncel kod üzerinde yeniden hazırlanıyor`, description: reason, actorLabel: actor.label, refType: 'ai_task', refId: task.id });
    await publish(tx, { type: 'ai.task.updated', organizationId: task.organizationId, projectId: task.projectId, id: task.id });
  });
}

/** Creates the AI tasks for planned items (one transaction each) and queues them. */
export async function createAutofixTasks(
  db: Executor,
  input: { organizationId: string; projectId: string; defaultBranch: string; requestedBy: string | null; autonomyLevel: string; items: AutofixItem[]; actor: Actor },
) {
  const batchId = randomUUID();
  const created: { id: string; key: string; title: string; itemKey: string }[] = [];
  for (const item of input.items) {
    const fingerprints = item.findingIds.length ? (await db.select({ fp: securityFindings.fingerprint }).from(securityFindings).where(inArray(securityFindings.id, item.findingIds))).map((r) => r.fp) : [];
    const autofix: AiAutofix = { batchId, risk: item.risk, mode: item.mode, kind: item.kind, findingIds: item.findingIds, fingerprints, ...(item.upgrades ? { upgrades: item.upgrades } : {}), ...(item.files ? { files: item.files } : {}) };
    const row = await db.transaction(async (tx) => {
      const number = await nextNumber(tx, input.organizationId, 'ai_task');
      const t = (
        await tx
          .insert(aiTasks)
          .values({
            organizationId: input.organizationId,
            projectId: input.projectId,
            number,
            type: item.kind === 'docs' ? 'docs' : 'fix',
            title: item.title.slice(0, 200),
            instruction: item.instruction ?? item.details.join('\n'),
            autonomyLevel: input.autonomyLevel as 'L2',
            sourceType: item.sourceType,
            sourceId: item.sourceId ?? null,
            baseBranch: input.defaultBranch,
            requestedBy: input.requestedBy,
            autofix,
          })
          .returning()
      )[0]!;
      await enqueue(tx, { queue: autofixQueue(autofix), type: 'ai.task.run', organizationId: input.organizationId, projectId: input.projectId, maxAttempts: 1, payload: { taskId: t.id } });
      await audit(tx, { organizationId: input.organizationId, projectId: input.projectId, actor: input.actor, action: 'ai.autofix.started', resourceType: 'ai_task', resourceId: t.id, metadata: { batchId, kind: item.kind, risk: item.risk, findings: item.findingIds.length } });
      await timeline(tx, { organizationId: input.organizationId, projectId: input.projectId, kind: 'ai', tone: 'run', title: `Otomatik düzeltme AI-${number} başladı`, description: item.title, actorLabel: input.actor.label, refType: 'ai_task', refId: t.id });
      return t;
    });
    created.push({ id: row.id, key: `AI-${row.number}`, title: row.title, itemKey: item.key });
  }
  return { batchId, created };
}

/** Ecosystem from the manifest/lockfile a dependency finding points at; null when there is no automatic upgrader. */
/** Written by the worker when an npm upgrade failed on a conflict between packages nobody was upgrading. */
export const PRE_EXISTING_CONFLICT = 'projenin mevcut bağımlılıkları zaten çakışıyor';

/**
 * Open npm findings that wait because their folder's dependency tree is already broken. Every npm upgrade there fails
 * the same way until the conflict is fixed (Form, 2026-10-22: five security upgrades in three days, each blamed on its
 * own package), so they are not attempted again until the default branch changes (`changedSince`: its latest build).
 */
export function blockedByDependencyConflict<T extends { createdAt: Date; status: string; error: string | null; autofix: { mode?: string; upgrades?: { source: string }[] } | null }>(
  tasks: T[],
  findings: { id: string; filePath: string | null }[],
  changedSince?: Date | null,
): Map<string, { task: T; findingIds: string[] }> {
  const folder = (file: string) => path.posix.dirname(file.replace(/\\/g, '/'));
  const byFolder = new Map<string, { task: T; findingIds: string[] }>();
  for (const t of [...tasks].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (t.status !== 'failed' || t.autofix?.mode !== 'dependency' || !(t.error ?? '').includes(PRE_EXISTING_CONFLICT)) continue;
    if (changedSince && changedSince > t.createdAt) continue;
    for (const u of t.autofix.upgrades ?? []) if (!byFolder.has(folder(u.source))) byFolder.set(folder(u.source), { task: t, findingIds: [] });
  }
  for (const f of findings) if (f.filePath && ecosystemOf(f.filePath) === 'npm') byFolder.get(folder(f.filePath))?.findingIds.push(f.id);
  for (const [k, v] of byFolder) if (!v.findingIds.length) byFolder.delete(k);
  return byFolder;
}

export function ecosystemOf(file: string | null): 'npm' | 'PyPI' | 'Packagist' | null {
  const base = path.posix.basename(file ?? '');
  if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'].includes(base)) return 'npm';
  if (/^requirements[^/]*\.txt$/.test(base)) return 'PyPI';
  if (base === 'composer.lock' || base === 'composer.json') return 'Packagist';
  return null;
}

/** True when `to` keeps the public API of `from` under semver (same major; for 0.x the minor is the breaking part). */
export function sameMajor(from: string | null, to: string): boolean {
  if (!from) return false;
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return false;
  return a[0] !== 0 || a[1] === b[1];
}

export function compareVersions(x: string, y: string): number {
  const a = parseVersion(x) ?? [0, 0, 0];
  const b = parseVersion(y) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
