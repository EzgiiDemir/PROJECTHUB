import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { OPEN_FEEDBACK_STATUSES, type AiSettings } from '@projecthub/contracts';
import {
  aiRuns,
  aiMemories,
  builds,
  codeFiles,
  codeChunks,
  deployments,
  environments,
  feedback,
  projectEvents,
  projectManifests,
  projects,
  repositories,
  securityFindings,
  versions,
  type AiCitation,
  type Executor,
} from '@projecthub/database';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { latestManifest } from '../project-manifest.js';
import { getOrgSettings } from '../settings.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import { compactConversation, getOllamaRuntimeStatus, OllamaEmbeddingClient, OllamaProvider, parseTextToolCalls } from './ollama.js';
import type { AiProvider, AiToolDef, AiToolResult, AiUsage } from './provider.js';

export * from './provider.js';
export type { OllamaMessage, OllamaRuntimeStatus } from './ollama.js';
export { AnthropicProvider, OpenAiProvider, OllamaEmbeddingClient, OllamaProvider, getOllamaRuntimeStatus, parseTextToolCalls, compactConversation, DEFAULT_ANTHROPIC_MODEL };

export interface ResolvedAi {
  provider: AiProvider;
  settings: AiSettings;
  /** Set when the configured local model is not installed and another installed model is used instead. */
  fallbackFrom?: string;
}

/**
 * Installed local models from strongest to weakest for agentic coding on this class of hardware (tool calling
 * required). Used only when the configured model is missing, so a task runs on the best model that is actually there.
 */
export const LOCAL_MODEL_PREFERENCE = ['qwen3-coder:30b', 'gpt-oss:20b', 'qwen3:30b', 'qwen2.5-coder:32b', 'qwen2.5-coder:14b', 'qwen3:14b', 'qwen3:8b', 'qwen2.5-coder:7b', 'qwen3:4b'];

const installedCache = new Map<string, { at: number; names: string[] }>();
async function installedLocalModels(baseUrl: string): Promise<string[] | null> {
  const hit = installedCache.get(baseUrl);
  if (hit && Date.now() - hit.at < 30_000) return hit.names;
  const status = await getOllamaRuntimeStatus(baseUrl, 3_000);
  if (!status.reachable) return null;
  const names = status.models.map((m) => m.name).filter((n) => !/embed/i.test(n));
  installedCache.set(baseUrl, { at: Date.now(), names });
  return names;
}

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;

/** The model to run: the requested one when installed, else the server default, else the strongest installed one. */
export async function pickLocalModel(baseUrl: string, requested: string, serverDefault: string): Promise<{ model: string; fallbackFrom?: string }> {
  const installed = await installedLocalModels(baseUrl);
  // Unreachable runtime: keep the requested model; the request itself reports the real error.
  if (!installed || installed.some((n) => sameModel(n, requested))) return { model: requested };
  const pick =
    installed.find((n) => sameModel(n, serverDefault)) ??
    LOCAL_MODEL_PREFERENCE.map((p) => installed.find((n) => sameModel(n, p))).find(Boolean) ??
    installed[0];
  if (!pick) throw new AppError('AI_NOT_CONFIGURED', `Ollama'da hiç sohbet modeli yüklü değil. Sunucuda \`ollama pull ${requested}\` çalıştırın.`);
  return { model: pick, fallbackFrom: requested };
}

/** Which providers have credentials (keys only come from the server environment, never from the database). */
export function availableProviders(config: AppConfig) {
  return { ollama: !!config.OLLAMA_BASE_URL, anthropic: !!config.ANTHROPIC_API_KEY, openai: !!config.OPENAI_API_KEY };
}

export interface SemanticEmbedding {
  model: string;
  embed(input: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Returns the optional local-only semantic index client. Empty config deliberately keeps lexical fallback. */
export function localEmbedding(config: AppConfig): SemanticEmbedding | undefined {
  return config.OLLAMA_EMBEDDING_MODEL
    ? new OllamaEmbeddingClient(config.OLLAMA_BASE_URL, config.OLLAMA_EMBEDDING_MODEL, config.OLLAMA_REQUEST_TIMEOUT_SECONDS * 1000)
    : undefined;
}

/**
 * Resolves the AI provider for an organization from Admin > AI settings + server credentials.
 * Throws AI_NOT_CONFIGURED with an actionable message when AI cannot run.
 */
export async function resolveAi(db: Executor, config: AppConfig, organizationId: string, opts: { minLevel?: 'L1' | 'L2' | 'L3'; projectId?: string } = {}): Promise<ResolvedAi> {
  const { ai: orgAi } = await getOrgSettings(db, organizationId);
  if (orgAi.autonomyLevel === 'L0') throw new AppError('AI_NOT_CONFIGURED', 'AI bu organizasyonda kapalı (otonomi seviyesi L0). Yönetim > AI kontrol merkezinden açılabilir.');
  const order = ['L0', 'L1', 'L2', 'L3'];
  // projecthub.yml `ai.autonomy` can only lower the organization's level for one project, never raise it.
  let ai = orgAi;
  if (opts.projectId) {
    const cap = (await latestManifest(db, opts.projectId))?.ai.autonomy;
    if (cap && order.indexOf(cap) < order.indexOf(orgAi.autonomyLevel)) ai = { ...orgAi, autonomyLevel: cap };
    if (ai.autonomyLevel === 'L0') throw new AppError('POLICY_DENIED', 'Bu projede AI kapalı (projecthub.yml: ai.autonomy L0).');
  }
  if (opts.minLevel && order.indexOf(ai.autonomyLevel) < order.indexOf(opts.minLevel)) {
    throw new AppError('POLICY_DENIED', `Bu işlem için AI otonomi seviyesi en az ${opts.minLevel} olmalı (şu an ${ai.autonomyLevel}).`);
  }
  const keys = availableProviders(config);
  const name = ai.provider ?? 'ollama';
  if (!name || !keys[name]) {
    throw new AppError(
      'AI_NOT_CONFIGURED',
      name
        ? `${name === 'anthropic' ? 'ANTHROPIC_API_KEY' : name === 'openai' ? 'OPENAI_API_KEY' : 'OLLAMA_BASE_URL'} sunucu ortamında tanımlı değil. Sistem yöneticisi .env dosyasını güncelleyip servisleri yeniden başlatmalı.`
        : 'AI sağlayıcısı yapılandırılmamış.',
    );
  }
  if (name === 'ollama') {
    const { model, fallbackFrom } = await pickLocalModel(config.OLLAMA_BASE_URL, ai.model ?? config.OLLAMA_MODEL, config.OLLAMA_MODEL);
    const provider = new OllamaProvider(config.OLLAMA_BASE_URL, model, config.OLLAMA_REQUEST_TIMEOUT_SECONDS * 1000, ai.contextTokens ?? config.OLLAMA_CONTEXT_TOKENS, config.OLLAMA_THINKING, config.OLLAMA_GPU_LAYERS);
    return { provider, settings: ai, ...(fallbackFrom ? { fallbackFrom } : {}) };
  }
  if (name === 'anthropic') return { provider: new AnthropicProvider(config.ANTHROPIC_API_KEY, ai.model ?? DEFAULT_ANTHROPIC_MODEL, config.ANTHROPIC_BASE_URL || undefined), settings: ai };
  if (!ai.model) throw new AppError('AI_NOT_CONFIGURED', 'OpenAI için model adı seçilmemiş. Yönetim > AI kontrol merkezinden model belirleyin.');
  return { provider: new OpenAiProvider(config.OPENAI_API_KEY, ai.model, config.OPENAI_BASE_URL || undefined), settings: ai };
}

export async function monthlyTokenUsage(db: Executor, organizationId: string): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const r = await db
    .select({ n: sql<number>`coalesce(sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens}), 0)::bigint` })
    .from(aiRuns)
    .where(and(eq(aiRuns.organizationId, organizationId), gte(aiRuns.startedAt, start)));
  return Number(r[0]?.n ?? 0);
}

export async function assertBudget(db: Executor, organizationId: string, settings: AiSettings): Promise<void> {
  const used = await monthlyTokenUsage(db, organizationId);
  if (settings.monthlyTokenBudget > 0 && used >= settings.monthlyTokenBudget) {
    throw new AppError('AI_BUDGET_EXCEEDED', `Aylık AI token bütçesi doldu (${used.toLocaleString('tr-TR')} / ${settings.monthlyTokenBudget.toLocaleString('tr-TR')}). Yönetici bütçeyi artırabilir.`);
  }
}

/** Opens an ai_runs record; call the returned finish() with the usage (success or failure). */
export async function startRun(
  db: Executor,
  input: { organizationId: string; projectId: string | null; taskId?: string | null; purpose: string; provider: AiProvider; userId?: string | null },
) {
  const row = (
    await db
      .insert(aiRuns)
      .values({ organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId ?? null, purpose: input.purpose, provider: input.provider.name, model: input.provider.model, userId: input.userId ?? null })
      .returning({ id: aiRuns.id })
  )[0]!;
  return {
    id: row.id,
    finish: async (usage: AiUsage, error?: string) => {
      await db
        .update(aiRuns)
        .set({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, status: error ? 'failed' : 'completed', error: error?.slice(0, 2000) ?? null, finishedAt: new Date() })
        .where(eq(aiRuns.id, row.id));
    },
  };
}

/* ------------------------------------------------------------------ agent loop */

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  def: AiToolDef;
  schema: S;
  risk: 'low' | 'medium' | 'high';
  /** Verification may execute code without changing the agent's pending repository snapshot. */
  mutates?: boolean;
  run(input: z.infer<S>): Promise<string>;
}

export interface AgentOutcome {
  status: 'finished' | 'done' | 'max_steps' | 'tool_error' | 'refused' | 'budget';
  finishInput: unknown;
  text: string;
  usage: AiUsage;
  steps: number;
}

/**
 * read_file shows numbered lines ("12\tcode"); smaller models sometimes write those numbers back into the file,
 * which would corrupt it. When nearly every line carries a consecutive number prefix, the prefixes are removed.
 */
export function stripEchoedLineNumbers(content: string): string {
  const lines = content.split('\n');
  const prefix = /^(\d+)(?:\t|[_|:] ?| {1,2}(?=\S|$)|(?=[^\w\s])|$)/;
  const numbered = lines.filter((l) => l !== '');
  if (numbered.length < 3) return content;
  let hits = 0;
  let expected = Number(prefix.exec(numbered[0]!)?.[1] ?? NaN);
  for (const l of lines) {
    const m = prefix.exec(l);
    if (m && Number(m[1]) === expected) hits++;
    if (m) expected = Number(m[1]) + 1;
    else if (l !== '') expected++;
  }
  if (hits < Math.max(3, numbered.length * 0.8)) return content;
  return lines.map((l) => l.replace(prefix, '')).join('\n');
}

/**
 * Validates tool input, repairing the type slips of tool formats that pass every argument as text (qwen3-coder's
 * XML calls send `["a","b"]` or a single sentence where a list is expected, "5" for a number). Only fields the schema
 * rejected for their type are converted, and the result is validated again, so nothing invalid gets through.
 */
export function parseToolInput<T extends z.ZodType>(schema: T, input: unknown): ReturnType<T['safeParse']> {
  const first = schema.safeParse(input) as ReturnType<T['safeParse']>;
  if (first.success || !input || typeof input !== 'object' || Array.isArray(input)) return first;
  const fixed: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  let changed = false;
  for (const issue of first.error!.issues) {
    if (issue.code !== 'invalid_type' || issue.path.length !== 1) continue;
    const key = String(issue.path[0]);
    const value = fixed[key];
    if (typeof value !== 'string') continue;
    const expected = (issue as { expected?: string }).expected;
    const json = (() => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    })();
    if (expected === 'array') fixed[key] = Array.isArray(json) ? json : value.split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    else if (expected === 'object' && json && typeof json === 'object' && !Array.isArray(json)) fixed[key] = json;
    else if (expected === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) fixed[key] = Number(value);
    else if (expected === 'boolean' && /^(true|false)$/i.test(value.trim())) fixed[key] = value.trim().toLowerCase() === 'true';
    else continue;
    changed = true;
  }
  return changed ? (schema.safeParse(fixed) as ReturnType<T['safeParse']>) : first;
}

/**
 * Runs a tool-using agent. Every tool input is validated against its schema before execution (inputs may be
 * truncated or malformed), every call is reported to onAction for the audit trail, and the loop ends when the
 * model calls `finish`, stops asking for tools, refuses, exceeds maxSteps, or the token budget runs out.
 */
export async function runToolAgent(opts: {
  provider: AiProvider;
  system: string;
  task: string;
  tools: Record<string, AgentTool>;
  maxSteps: number;
  tokenLimit: number;
  signal?: AbortSignal;
  onAction?: (name: string, input: unknown, outcome: { ok: boolean; risk: string; output: string }) => Promise<void>;
}): Promise<AgentOutcome> {
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const convo = opts.provider.agent({
    system: opts.system,
    tools: Object.values(opts.tools).map((t) => t.def),
    maxTokens: Math.min(opts.tokenLimit, 4_096),
    signal: opts.signal,
  });
  const repeatedFailures = new Map<string, { count: number; message: string }>();
  const seenCalls = new Set<string>();
  const successfulCalls = new Map<string, { output: string; replays: number; epoch: number }>();
  let duplicateCalls = 0;
  /** How many times the conversation was compacted so far; results from an earlier epoch left the model's context. */
  let compactions = 0;
  let nudges = 0;
  let turn = await convo.start(opts.task);
  for (let step = 1; ; step++) {
    usage.inputTokens += turn.usage.inputTokens;
    if (turn.compacted) compactions += 1;
    usage.outputTokens += turn.usage.outputTokens;
    if (turn.refused) return { status: 'refused', finishInput: null, text: turn.text, usage, steps: step };
    if (turn.done) {
      // Local models often describe the change ("I will update X") and stop instead of calling the tools. When the
      // task expects a `finish` call, ask twice to actually do the work before giving up.
      if (opts.tools.finish && nudges < 2 && step < opts.maxSteps && !turn.truncated) {
        nudges += 1;
        turn = await convo.say('finish henüz çağrılmadı. Açıklama yerine gerekli araçları kullan: dosyayı read_file ile oku, mevcut dosyada edit_file ile kısa bir değişiklik yap (yeni dosyada write_file), varsa kontrolleri çalıştır, bitince finish çağır. Yapılacak değişiklik yoksa nedenini finish ile bildir.');
        continue;
      }
      return { status: 'done', finishInput: null, text: turn.text, usage, steps: step };
    }
    if (usage.inputTokens + usage.outputTokens > opts.tokenLimit) return { status: 'budget', finishInput: null, text: turn.text, usage, steps: step };
    const results: AiToolResult[] = [];
    let finishInput: unknown = undefined;
    for (const call of turn.toolCalls) {
      const tool = opts.tools[call.name];
      if (!tool) {
        results.push({ id: call.id, output: `Bilinmeyen araç: ${call.name}`, isError: true });
        continue;
      }
      if (turn.truncated) {
        results.push({ id: call.id, output: 'Çıktı token sınırında kesildi; araç çalıştırılmadı. Daha küçük adımlarla tekrar dene.', isError: true });
        continue;
      }
      const parsed = parseToolInput(tool.schema, call.input);
      if (!parsed.success) {
        const msg = `Geçersiz girdi: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        results.push({ id: call.id, output: msg, isError: true });
        await opts.onAction?.(call.name, call.input, { ok: false, risk: tool.risk, output: msg });
        continue;
      }
      // Small local models also loop on calls that succeed (the same search, again and again). A repeat gives no new
      // information: answer it without running the tool and stop once the agent clearly makes no progress.
      const callKey = `${call.name}:${JSON.stringify(parsed.data)}`;
      if (call.name !== 'finish' && seenCalls.has(callKey)) {
        const previous = successfulCalls.get(callKey);
        // Compaction removed the result from the model's context, not from our process: re-reading part of a long
        // file after that is legitimate (2026-10-19: AI-10 on a 1100-line component was stopped for it). Replay the
        // cached result without running the tool or counting it — once per compaction, at most twice per call.
        if (previous && previous.epoch !== compactions && previous.replays < 2) {
          previous.replays += 1;
          previous.epoch = compactions;
          results.push({ id: call.id, output: previous.output });
          continue;
        }
        duplicateCalls += 1;
        const msg = 'Bu çağrıyı aynı girdiyle zaten yaptın; sonuç değişmez. Farklı bir arama veya dosya dene; yeterli bilgin varsa değişikliği yap ve finish çağır.';
        results.push({ id: call.id, output: msg, isError: true });
        // Only consecutive repeats with no new result in between mean the agent is stuck.
        if (duplicateCalls >= 3) return { status: 'tool_error', finishInput: null, text: `${call.name}: aynı çağrılar tekrar tekrar yapıldı, ilerleme yok`, usage, steps: step };
        continue;
      }
      duplicateCalls = 0;
      try {
        const output = await tool.run(parsed.data);
        // An edit changes what reads return, so earlier reads may legitimately be repeated.
        if (tool.mutates ?? (tool.risk !== 'low')) {
          seenCalls.clear();
          successfulCalls.clear();
        } else {
          seenCalls.add(callKey);
          successfulCalls.set(callKey, { output, replays: 0, epoch: compactions });
        }
        results.push({ id: call.id, output });
        await opts.onAction?.(call.name, parsed.data, { ok: true, risk: tool.risk, output });
        if (call.name === 'finish') finishInput = parsed.data;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 2000);
        results.push({ id: call.id, output: msg, isError: true });
        await opts.onAction?.(call.name, parsed.data, { ok: false, risk: tool.risk, output: msg });
        const failureKey = `${call.name}:${JSON.stringify(parsed.data)}:${msg}`;
        const failure = repeatedFailures.get(failureKey) ?? { count: 0, message: `${call.name}: ${msg}` };
        failure.count += 1;
        repeatedFailures.set(failureKey, failure);
        // Small local models may ignore a tool error and repeat the exact same call for many expensive turns.
        // Three identical failures provide no new information, so stop with an actionable error immediately.
        if (failure.count >= 3) return { status: 'tool_error', finishInput: null, text: failure.message, usage, steps: step };
      }
    }
    if (finishInput !== undefined) return { status: 'finished', finishInput, text: turn.text, usage, steps: step };
    // Execute at most maxSteps model turns. The previous implementation made one unnecessary extra model call
    // before noticing the limit, which is especially expensive for local inference.
    if (step >= opts.maxSteps) return { status: 'max_steps', finishInput: null, text: turn.text, usage, steps: step };
    turn = await convo.continue(results);
  }
}

/* ------------------------------------------------------------------ project brain */

function searchTerms(text: string): string[] {
  const stop = new Set(['nedir', 'nasıl', 'neden', 'nerede', 'hangi', 'için', 'olan', 'with', 'what', 'where', 'does', 'this', 'that', 'the', 'and', 'bir', 'bu', 've', 'ile', 'mı', 'mi', 'mu', 'mü']);
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .flatMap((w) => [w, ...w.split(/(?=[A-Z])|_/)])
    .filter((w) => w.length >= 3 && !stop.has(w));
  return [...new Set(words)].slice(0, 12);
}

export interface ProjectContext {
  text: string;
  citations: AiCitation[];
}

/** Only sources the answer names explicitly count as evidence; retrieved context alone is not proof of a claim. */
export function explicitCitations(answer: string, citations: AiCitation[]): AiCitation[] {
  const normalized = answer.toLocaleLowerCase('tr-TR');
  return citations.filter((citation) => {
    const labels = [citation.label, citation.ref, citation.type === 'file' && citation.line ? `${citation.ref}:${citation.line}` : '']
      .filter(Boolean)
      .map((value) => String(value).toLocaleLowerCase('tr-TR'));
    return labels.some((value) => normalized.includes(value));
  });
}

/** A factual project answer is grounded only if it cites evidence or openly says the evidence is insufficient. */
export function answerIsGrounded(answer: string, available: AiCitation[], used = explicitCitations(answer, available)): boolean {
  if (used.length > 0) return true;
  return /(?:bağlam|kaynak|veri|bilgi|kayıt).{0,50}(?:yok|bulunamad|içermiyor|yetersiz|belirlenem)/iu.test(answer);
}

/**
 * Builds the grounding context for questions about a project: relevant source chunks (PostgreSQL full-text
 * search over the incremental code index) plus the project's recent history. Every item is cited.
 */
export async function buildProjectContext(
  db: Executor,
  projectId: string,
  question: string,
  opts: { filePath?: string; maxChars?: number; embedding?: SemanticEmbedding } = {},
): Promise<ProjectContext> {
  const maxChars = opts.maxChars ?? 40_000;
  const citations: AiCitation[] = [];
  const parts: string[] = [];
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
  if (!project) return { text: '', citations };
  const manifest = (await db.select({ content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0]?.content;
  parts.push(
    `# Proje\nAd: ${project.name}\nTür: ${project.projectType}\nTeknolojiler: ${project.technologies.join(', ')}\nKullanıcı: ${project.customerName}\nVarsayılan branch: ${project.defaultBranch}\nGüncel sürüm: ${project.currentVersion ?? '-'}\nAçıklama: ${project.description}`,
  );
  if (manifest) parts.push(`# projecthub.yml (özet)\n${JSON.stringify(manifest)}`);

  const [repository] = await db.select({ headCommit: repositories.headCommit }).from(repositories).where(eq(repositories.projectId, projectId));
  const [indexState] = await db
    .select({ indexedCommit: sql<string | null>`max(${codeFiles.indexedCommit})` })
    .from(codeFiles)
    .where(eq(codeFiles.projectId, projectId));
  const currentHead = repository?.headCommit ?? null;
  const indexedCommit = indexState?.indexedCommit ?? null;
  const staleIndex = !!currentHead && currentHead !== indexedCommit;
  if (staleIndex) {
    parts.push(
      `# Kaynak kod indeksi\nGÜNCEL DEĞİL: repository ${currentHead!.slice(0, 12)}, indeks ${indexedCommit?.slice(0, 12) ?? 'yok'}. Kaynak kod hakkında kesin iddia üretme; yeniden indeksleme tamamlanmalı.`,
    );
  }

  let budget = maxChars - parts.join('\n').length;
  const addChunk = (c: { path: string; startLine: number; endLine: number; content: string }) => {
    const block = `## ${c.path}:${c.startLine}-${c.endLine}\n\`\`\`\n${c.content}\n\`\`\``;
    if (block.length > budget) return;
    budget -= block.length;
    parts.push(block);
    citations.push({ type: 'file', ref: c.path, label: `${c.path}:${c.startLine}`, line: c.startLine });
  };
  if (opts.filePath && !staleIndex) {
    const own = await db.select().from(codeChunks).where(and(eq(codeChunks.projectId, projectId), eq(codeChunks.path, opts.filePath))).orderBy(codeChunks.startLine).limit(8);
    if (own.length) parts.push('# Seçili dosya');
    for (const c of own) addChunk(c);
  }
  const terms = searchTerms(question + (opts.filePath ? ` ${opts.filePath}` : ''));
  const memoryRows = terms.length
    ? (
        await db.execute<{ id: string; category: string; title: string; content: string; verification: string; source_label: string | null }>(sql`
          SELECT id, category, title, content, verification, source_label
          FROM ai_memories
          WHERE project_id = ${projectId}
            AND (source_type <> 'repository_index' OR source_ref = ${currentHead ?? ''})
            AND search_vector @@ to_tsquery('simple', ${terms.map((t) => `${t.replace(/[^\p{L}\p{N}_]/gu, '')}:*`).filter((t) => t.length > 2).join(' | ')})
          ORDER BY CASE verification WHEN 'verified' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END,
                   ts_rank_cd(search_vector, to_tsquery('simple', ${terms.map((t) => `${t.replace(/[^\p{L}\p{N}_]/gu, '')}:*`).filter((t) => t.length > 2).join(' | ')})) DESC,
                   updated_at DESC
          LIMIT 8`)
      ).rows
    : await db
        .select({ id: aiMemories.id, category: aiMemories.category, title: aiMemories.title, content: aiMemories.content, verification: aiMemories.verification, source_label: aiMemories.sourceLabel })
        .from(aiMemories)
        .where(and(eq(aiMemories.projectId, projectId), sql`${aiMemories.sourceType} <> 'repository_index' OR ${aiMemories.sourceRef} = ${currentHead ?? ''}`))
        .orderBy(desc(aiMemories.updatedAt))
        .limit(5);
  if (memoryRows.length) {
    parts.push(`# Proje hafızası\n${memoryRows.map((m) => `- [Hafıza: ${m.title}] [${m.verification}/${m.category}] ${m.content.slice(0, 1200)}${m.source_label ? ` (Kaynak/provenans: ${m.source_label})` : ''}`).join('\n')}`);
    for (const m of memoryRows) citations.push({ type: 'memory', ref: m.id, label: `Hafıza: ${m.title}` });
  }
  const relevantRows: { path: string; start_line: number; end_line: number; content: string }[] = [];
  const seenChunks = new Set<string>();
  if (opts.embedding && !staleIndex) {
    try {
      const [vector] = await opts.embedding.embed([`${question}${opts.filePath ? ` ${opts.filePath}` : ''}`]);
      if (vector?.length) {
        // Drizzle expands JavaScript arrays as SQL tuples; pass PostgreSQL's text array form as one bound value.
        const vectorLiteral = `{${vector.join(',')}}`;
        const semantic = await db.execute<{ path: string; start_line: number; end_line: number; content: string; similarity: number }>(sql`
          WITH ranked AS (
            SELECT path, start_line, end_line, content,
              (SELECT sum(pair.e::double precision * pair.q::double precision) /
                nullif(sqrt(sum(pair.e::double precision * pair.e::double precision)) * sqrt(sum(pair.q::double precision * pair.q::double precision)), 0)
               FROM unnest(embedding, ${vectorLiteral}::real[]) AS pair(e, q)) AS similarity
            FROM code_chunks
            WHERE project_id = ${projectId}
              AND embedding_model = ${opts.embedding.model}
              AND cardinality(embedding) = ${vector.length}
          )
          SELECT path, start_line, end_line, content, similarity
          FROM ranked WHERE similarity >= 0.15
          ORDER BY similarity DESC
          LIMIT 8`);
        for (const row of semantic.rows) {
          const key = `${row.path}:${row.start_line}`;
          if (!seenChunks.has(key)) {
            seenChunks.add(key);
            relevantRows.push(row);
          }
        }
      }
    } catch (error) {
      // Embeddings are an optional local enhancement; keyword/structural retrieval must remain available.
      if (process.env.NODE_ENV === 'test') throw error;
    }
  }
  if (terms.length && !staleIndex) {
    const query = terms.map((t) => `${t.replace(/[^\p{L}\p{N}_]/gu, '')}:*`).filter((t) => t.length > 2).join(' | ');
    const rows = await db.execute<{ path: string; start_line: number; end_line: number; content: string }>(sql`
      SELECT path, start_line, end_line, content
      FROM code_chunks
      WHERE project_id = ${projectId} AND search_vector @@ to_tsquery('simple', ${query})
      ORDER BY ts_rank_cd(search_vector, to_tsquery('simple', ${query})) DESC
      LIMIT 10`);
    for (const r of rows.rows) {
      const key = `${r.path}:${r.start_line}`;
      if (!seenChunks.has(key)) {
        seenChunks.add(key);
        relevantRows.push(r);
      }
    }
  }
  if (relevantRows.length) parts.push('# İlgili kaynak kod (semantik + anahtar kelime)');
  for (const r of relevantRows.slice(0, 12)) {
    if (opts.filePath && r.path === opts.filePath) continue;
    addChunk({ path: r.path, startLine: r.start_line, endLine: r.end_line, content: r.content });
  }

  const recentBuilds = await db.select().from(builds).where(eq(builds.projectId, projectId)).orderBy(desc(builds.createdAt)).limit(5);
  if (recentBuilds.length) {
    parts.push(`# Son build'ler\n${recentBuilds.map((b) => `- #${b.number} ${b.status} ${b.branch}@${b.commitSha.slice(0, 7)} ${b.createdAt.toISOString()}${b.error ? ` HATA [${b.error.step}] ${b.error.file ?? ''}:${b.error.line ?? ''} ${b.error.message}` : ''}`).join('\n')}`);
    for (const b of recentBuilds) citations.push({ type: 'build', ref: b.id, label: `Build #${b.number}` });
  }
  const recentDeploys = await db
    .select({ d: deployments, env: environments.name, v: versions.version })
    .from(deployments)
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .innerJoin(versions, eq(versions.id, deployments.versionId))
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.createdAt))
    .limit(5);
  if (recentDeploys.length) {
    parts.push(`# Son deployment'lar\n${recentDeploys.map((r) => `- D-${r.d.number} v${r.v} → ${r.env}: ${r.d.status} ${r.d.createdAt.toISOString()}${r.d.error ? ` (${r.d.error})` : ''}`).join('\n')}`);
    for (const r of recentDeploys) citations.push({ type: 'deployment', ref: r.d.id, label: `D-${r.d.number}` });
  }
  const openFb = await db.select().from(feedback).where(and(eq(feedback.projectId, projectId), inArray(feedback.status, OPEN_FEEDBACK_STATUSES))).orderBy(desc(feedback.createdAt)).limit(10);
  if (openFb.length) {
    parts.push(`# Açık kullanıcı geri bildirimleri\n${openFb.map((f) => `- FB-${f.number} [${f.status}/${f.priority}] ${f.title} — ${f.pageUrl}${f.domSelector ? ` (${f.domSelector})` : ''}: ${f.body.slice(0, 200)}`).join('\n')}`);
    for (const f of openFb) citations.push({ type: 'feedback', ref: f.id, label: `FB-${f.number}` });
  }
  const findings = await db.select().from(securityFindings).where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.status, 'open'))).orderBy(desc(securityFindings.createdAt)).limit(10);
  if (findings.length) {
    parts.push(`# Açık güvenlik bulguları\n${findings.map((f) => `- SEC-${f.number} [${f.severity}] ${f.title} ${f.filePath ?? ''}${f.line ? `:${f.line}` : ''}`).join('\n')}`);
    for (const f of findings) citations.push({ type: 'finding', ref: f.id, label: `SEC-${f.number}` });
  }
  const events = await db.select().from(projectEvents).where(eq(projectEvents.projectId, projectId)).orderBy(desc(projectEvents.createdAt)).limit(15);
  if (events.length) parts.push(`# Zaman akışı (en yeni önce)\n${events.map((e) => `- ${e.createdAt.toISOString()} [${e.kind}] ${e.title} ${e.description}`).join('\n')}`);
  return { text: parts.join('\n\n').slice(0, maxChars + 2000), citations };
}
