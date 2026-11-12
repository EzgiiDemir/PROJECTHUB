import type { AgentConversation, AiProvider, AiToolDef, AiToolResult, AiTurn, ChatMessage } from './provider.js';

export interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
  prompt_eval_count?: number;
  error?: string;
}

export interface OllamaRuntimeStatus {
  reachable: boolean;
  baseUrl: string;
  version: string | null;
  models: { name: string; size: number; parameterSize: string | null; quantization: string | null }[];
  loadedModels: { name: string; sizeVram: number | null; expiresAt: string | null }[];
  error: string | null;
}

/**
 * Tool calls a model wrote into its text instead of the structured field. Ollama's parser misses them when a model's
 * template does not declare them (qwen3-coder's `<function=name><parameter=key>value</parameter></function>`, qwen3's
 * `<tool_call>{"name": …, "arguments": …}</tool_call>`); the agent then saw a turn without a call and the task was
 * lost. Only names of the offered tools are accepted.
 */
export function parseTextToolCalls(text: string, toolNames: ReadonlySet<string>): OllamaToolCall[] {
  const calls: OllamaToolCall[] = [];
  for (const m of text.matchAll(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
    if (!toolNames.has(m[1]!)) continue;
    const args: Record<string, string> = {};
    for (const p of m[2]!.matchAll(/<parameter=([\w.-]+)>\r?\n?([\s\S]*?)\r?\n?(?:<\/parameter>|(?=<parameter=)|$)/g)) args[p[1]!] = p[2]!;
    calls.push({ function: { name: m[1]!, arguments: args } });
  }
  if (calls.length) return calls;
  for (const m of text.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)) {
    try {
      const call = JSON.parse(m[1]!) as { name?: unknown; arguments?: unknown };
      if (typeof call.name === 'string' && toolNames.has(call.name)) calls.push({ function: { name: call.name, arguments: call.arguments ?? {} } });
    } catch {
      /* not a call */
    }
  }
  return calls;
}

/**
 * Keeps an agent conversation inside the context window. Ollama silently drops the start of a prompt that does not
 * fit — the system prompt and the task first — after which a small model no longer knows what it was doing and
 * repeats its searches until the loop guard stops it. Before that, the oldest tool results and then the oldest
 * tool-call arguments are shortened to a note; the system prompt, the task and the latest exchanges stay whole.
 * Returns how many messages were shortened.
 */
export function compactConversation(messages: OllamaMessage[], budgetTokens: number, keepLast = 4): number {
  const size = (m: OllamaMessage) => m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  let total = messages.reduce((n, m) => n + Math.ceil(size(m) / 3) + 4, 0);
  let shortened = 0;
  const last = messages.length - keepLast;
  for (let i = 2; i < last && total > budgetTokens; i++) {
    const m = messages[i]!;
    if (m.role !== 'tool' || m.content.length <= 400 || m.content.startsWith('[kısaltıldı')) continue;
    const before = size(m);
    m.content = `[kısaltıldı: bağlam penceresine sığması için ${m.content.length} karakterlik ${m.tool_name ?? 'araç'} çıktısının başı. Gerekirse aracı yeniden çağır.]\n${m.content.slice(0, 300)}`;
    total -= Math.ceil((before - size(m)) / 3);
    shortened++;
  }
  for (let i = 2; i < last && total > budgetTokens; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const before = size(m);
    m.tool_calls = m.tool_calls.map((call) => ({
      function: {
        name: call.function.name,
        arguments: Object.fromEntries(Object.entries((call.function.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' && v.length > 400 ? `${v.slice(0, 200)}… [kısaltıldı]` : v])),
      },
    }));
    if (size(m) < before) {
      total -= Math.ceil((before - size(m)) / 3);
      shortened++;
    }
  }
  return shortened;
}

/** Per runtime+model: does it support thinking? Asked once per process. */
const THINKING_MODELS = new Map<string, Promise<boolean>>();

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * One local runtime (one GPU) answers one request at a time. Concurrent AI tasks used to wait inside Ollama, and the
 * request timeout ran out before their turn even started: 12 of the last Form tasks failed with "aborted due to
 * timeout". Requests to a runtime now queue here and their timeout starts when they actually run.
 */
const runtimeQueues = new Map<string, Promise<void>>();
export async function oneAtATime<T>(runtime: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const previous = runtimeQueues.get(runtime) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => turn);
  runtimeQueues.set(runtime, tail);
  try {
    await previous;
    signal?.throwIfAborted();
    return await run();
  } finally {
    release();
    if (runtimeQueues.get(runtime) === tail) runtimeQueues.delete(runtime);
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 1000);
  return new Error(`Ollama isteği başarısız (${response.status}): ${body || response.statusText}`);
}

/** Native Ollama `/api/chat` adapter. No cloud SDK, API key or external network call is involved. */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama' as const;
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly timeoutMs = 300_000,
    /** num_ctx sent with every request; never rely on the runtime's version-dependent default. */
    readonly contextTokens = 16_384,
    /** Allow hidden reasoning on models that support it; false sends think:false to them. */
    private readonly thinking = false,
    /** Layers offloaded to the GPU (num_gpu); 0 = Ollama decides. See OLLAMA_GPU_LAYERS. */
    private readonly gpuLayers = 0,
  ) {
    this.baseUrl = cleanBaseUrl(baseUrl);
  }

  private runOptions(numPredict: number, temperature: number) {
    return { num_ctx: this.contextTokens, num_predict: numPredict, temperature, ...(this.gpuLayers > 0 ? { num_gpu: this.gpuLayers } : {}) };
  }

  /** { think } for models whose /api/show lists the "thinking" capability; nothing for others (they reject it). */
  private async thinkOption(): Promise<{ think?: boolean }> {
    const key = `${this.baseUrl}|${this.model}`;
    let known = THINKING_MODELS.get(key);
    if (!known) {
      known = fetch(`${this.baseUrl}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model }), signal: AbortSignal.timeout(5_000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ capabilities?: string[] }>) : r.body?.cancel().then(() => null) ?? null))
        .then((j) => Array.isArray(j?.capabilities) && j.capabilities.includes('thinking'))
        .catch(() => false);
      THINKING_MODELS.set(key, known);
    }
    return (await known) ? { think: this.thinking } : {};
  }

  private async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<OllamaChatResponse> {
    const think = await this.thinkOption();
    return oneAtATime(this.baseUrl, signal, async () => {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, stream: false, keep_alive: '30m', ...think, ...body }),
        signal: requestSignal(signal, this.timeoutMs),
      });
      if (!response.ok) throw await responseError(response);
      const result = (await response.json()) as OllamaChatResponse;
      if (result.error) throw new Error(`Ollama: ${result.error}`);
      return result;
    });
  }

  complete(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }) {
    return oneAtATime(this.baseUrl, opts.signal, () => this.streamAnswer(opts));
  }

  private async streamAnswer(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        keep_alive: '30m',
        ...(await this.thinkOption()),
        messages: [{ role: 'system', content: opts.system }, ...opts.messages],
        options: this.runOptions(opts.maxTokens ?? 8000, 0),
      }),
      signal: requestSignal(opts.signal, this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('Ollama boş bir akış döndürdü.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as OllamaChatResponse;
      if (event.error) throw new Error(`Ollama: ${event.error}`);
      const delta = event.message?.content ?? '';
      if (delta) {
        text += delta;
        opts.onText?.(delta);
      }
      inputTokens = event.prompt_eval_count ?? inputTokens;
      outputTokens = event.eval_count ?? outputTokens;
    };
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
      if (done) break;
    }
    consume(buffer);
    return { text, usage: { inputTokens, outputTokens }, refused: false };
  }

  agent(opts: { system: string; tools: AiToolDef[]; maxTokens?: number; signal?: AbortSignal }): AgentConversation {
    const messages: OllamaMessage[] = [{ role: 'system', content: opts.system }];
    const names = new Map<string, string>();
    let turnNumber = 0;
    const tools = opts.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const toolNames = new Set(opts.tools.map((tool) => tool.name));
    // Prompt budget: the window minus the reply and the tool definitions, with a margin for the chat template.
    const budget = this.contextTokens - (opts.maxTokens ?? 4096) - Math.ceil(JSON.stringify(tools).length / 3) - 512;
    const turn = async (): Promise<AiTurn> => {
      turnNumber += 1;
      const compacted = compactConversation(messages, budget);
      // Ollama answers 500 when the model wrote a malformed tool call (e.g. an unclosed <parameter> in qwen3-coder's
      // XML format). Greedy decoding would repeat the same output, so the turn is retried with some sampling.
      let response: OllamaChatResponse | undefined;
      for (const temperature of [0, 0.3, 0.6]) {
        try {
          response = await this.chat({ messages, tools, options: this.runOptions(opts.maxTokens ?? 16000, temperature) }, opts.signal);
          break;
        } catch (e) {
          if (temperature === 0.6 || opts.signal?.aborted || !/\(500\).*(syntax error|parse|unexpected|invalid character|closed by|expected element type)/i.test((e as Error).message)) throw e;
        }
      }
      if (!response) throw new Error('Ollama yanıt vermedi.');
      const assistant = response.message ?? { role: 'assistant' as const, content: '' };
      if (!assistant.tool_calls?.length && assistant.content) {
        const recovered = parseTextToolCalls(assistant.content, toolNames);
        if (recovered.length) assistant.tool_calls = recovered;
      }
      messages.push(assistant);
      const toolCalls = (assistant.tool_calls ?? []).map((call, index) => {
        const id = `ollama-${turnNumber}-${index}`;
        names.set(id, call.function.name);
        let input = call.function.arguments;
        if (typeof input === 'string') {
          const raw = input;
          try {
            input = JSON.parse(raw);
          } catch {
            input = { __invalid_json: raw.slice(0, 200) };
          }
        }
        return { id, name: call.function.name, input };
      });
      return {
        text: assistant.content ?? '',
        toolCalls,
        done: toolCalls.length === 0,
        refused: false,
        truncated: response.done_reason === 'length',
        usage: { inputTokens: response.prompt_eval_count ?? 0, outputTokens: response.eval_count ?? 0 },
        ...(compacted ? { compacted } : {}),
      };
    };
    return {
      start: async (userText) => {
        messages.push({ role: 'user', content: userText });
        return turn();
      },
      continue: async (results: AiToolResult[]) => {
        for (const result of results) {
          messages.push({ role: 'tool', tool_name: names.get(result.id), content: result.isError ? `ERROR: ${result.output}` : result.output });
        }
        return turn();
      },
      say: async (userText) => {
        messages.push({ role: 'user', content: userText });
        return turn();
      },
    };
  }
}

/** Local embedding client used by the incremental index and semantic retrieval. */
export class OllamaEmbeddingClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly timeoutMs = 300_000,
  ) {
    this.baseUrl = cleanBaseUrl(baseUrl);
  }

  async embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!input.length) return [];
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Keep the tiny embedding model in system RAM. Loading it into GPU memory can evict the much larger chat
      // model; on the reference workstation that turned a sub-second answer into an 84-second model reload.
      body: JSON.stringify({ model: this.model, input: input.map((value) => value.slice(0, 12_000)), truncate: true, keep_alive: '30m', options: { num_gpu: 0 } }),
      signal: requestSignal(signal, this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    const result = (await response.json()) as OllamaEmbedResponse;
    if (result.error) throw new Error(`Ollama: ${result.error}`);
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== input.length) {
      throw new Error(`Ollama embedding sayısı eşleşmedi (${result.embeddings?.length ?? 0}/${input.length}).`);
    }
    const dimensions = result.embeddings[0]?.length ?? 0;
    if (!dimensions || result.embeddings.some((vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error('Ollama geçersiz embedding vektörü döndürdü.');
    }
    return result.embeddings;
  }
}

/** Short, read-only health probe for the AI control center. */
export async function getOllamaRuntimeStatus(baseUrl: string, timeoutMs = 5_000): Promise<OllamaRuntimeStatus> {
  const root = cleanBaseUrl(baseUrl);
  const get = async (path: string) => {
    const response = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    const version = await get('/api/version');
    const [tags, running] = await Promise.all([get('/api/tags'), get('/api/ps').catch(() => ({ models: [] }))]);
    // Ollama can list the same tag twice (e.g. a re-pulled model); keep one entry per name.
    const seen = new Set<string>();
    const models = (Array.isArray(tags.models) ? tags.models : []).filter((raw) => {
      const name = String((raw as Record<string, unknown>).name ?? (raw as Record<string, unknown>).model ?? '');
      return !seen.has(name) && !!seen.add(name);
    });
    const loaded = Array.isArray(running.models) ? running.models : [];
    return {
      reachable: true,
      baseUrl: root,
      version: typeof version.version === 'string' ? version.version : null,
      models: models.map((raw) => {
        const m = raw as Record<string, unknown>;
        const details = (m.details ?? {}) as Record<string, unknown>;
        return {
          name: String(m.name ?? m.model ?? ''),
          size: Number(m.size ?? 0),
          parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
          quantization: typeof details.quantization_level === 'string' ? details.quantization_level : null,
        };
      }),
      loadedModels: loaded.map((raw) => {
        const m = raw as Record<string, unknown>;
        return { name: String(m.name ?? m.model ?? ''), sizeVram: typeof m.size_vram === 'number' ? m.size_vram : null, expiresAt: typeof m.expires_at === 'string' ? m.expires_at : null };
      }),
      error: null,
    };
  } catch (error) {
    return { reachable: false, baseUrl: root, version: null, models: [], loadedModels: [], error: (error as Error).message };
  }
}
