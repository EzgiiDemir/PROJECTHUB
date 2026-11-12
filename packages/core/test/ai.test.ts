import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startFakeAnthropic } from '../../../test/support/fake-anthropic.js';
import { AnthropicProvider, getOllamaRuntimeStatus, OllamaEmbeddingClient, OllamaProvider, OpenAiProvider, parseTextToolCalls, parseToolInput, compactConversation, type OllamaMessage, pickLocalModel, runToolAgent, stripEchoedLineNumbers, type AgentTool, type AiProvider, type AiTurn } from '../src/ai/index.js';

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

describe('Anthropic provider', () => {
  it('streams a Q&A answer token by token and reports usage', async () => {
    const fake = await startFakeAnthropic([{ text: 'Sepet toplamı `src/cart.mjs:2` içinde hesaplanır.', usage: { input: 900, output: 25 } }]);
    closers.push(fake.close);
    const p = new AnthropicProvider('sk-test', undefined, fake.url);
    const deltas: string[] = [];
    const r = await p.complete({ system: 'Proje asistanı', messages: [{ role: 'user', content: 'Sepet nerede hesaplanıyor?' }], onText: (d) => deltas.push(d) });
    expect(r.text).toBe('Sepet toplamı `src/cart.mjs:2` içinde hesaplanır.');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(r.text);
    expect(r).toMatchObject({ refused: false, usage: { inputTokens: 900, outputTokens: 25 } });
    expect(fake.requests[0]!.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, output_config: { effort: 'medium' } });
  });

  it('flags refusals', async () => {
    const fake = await startFakeAnthropic([{ text: '', stopReason: 'refusal' }]);
    closers.push(fake.close);
    const r = await new AnthropicProvider('sk-test', undefined, fake.url).complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.refused).toBe(true);
  });
});

/** Minimal Responses API stand-in (non-streaming create), scripted per call. */
async function startFakeOpenAi(script: ((body: Record<string, unknown>) => Record<string, unknown>)[]) {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const out = script[requests.length - 1]!(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `resp_${requests.length}`, object: 'response', status: 'completed', model: body.model, usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 }, ...out }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const call = (id: string, name: string, args: string) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: args, status: 'completed' });

describe('parseToolInput', () => {
  const finish = z.object({ summary: z.string(), explanation: z.array(z.string()).min(1), count: z.number().optional(), dry: z.boolean().optional() });
  it('repairs arguments that text-based tool formats send as strings, and nothing else', () => {
    expect(parseToolInput(finish, { summary: 's', explanation: '["a","b"]' })).toMatchObject({ success: true, data: { explanation: ['a', 'b'] } });
    expect(parseToolInput(finish, { summary: 's', explanation: '- birinci\n- ikinci' })).toMatchObject({ success: true, data: { explanation: ['birinci', 'ikinci'] } });
    expect(parseToolInput(finish, { summary: 's', explanation: ['x'], count: '3', dry: 'TRUE' })).toMatchObject({ success: true, data: { count: 3, dry: true } });
    expect(parseToolInput(finish, { summary: 's', explanation: ['x'], count: 'üç' }).success).toBe(false);
    expect(parseToolInput(finish, { explanation: ['x'] }).success).toBe(false);
  });
});

describe('oneAtATime (one local runtime, one request)', () => {
  it('runs requests for the same runtime one after another, others in parallel', async () => {
    const { oneAtATime } = await import('../src/ai/ollama.js');
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}-`);
      return name;
    };
    const results = await Promise.all([oneAtATime('gpu', undefined, job('a', 30)), oneAtATime('gpu', undefined, job('b', 5)), oneAtATime('other', undefined, job('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log.indexOf('b+')).toBeGreaterThan(log.indexOf('a-'));
    expect(log.indexOf('c+')).toBeLessThan(log.indexOf('a-'));
    // A failed request releases the runtime for the next one.
    await expect(oneAtATime('gpu', undefined, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await oneAtATime('gpu', undefined, async () => 'next')).toBe('next');
  });
});

describe('compactConversation', () => {
  it('shortens the oldest tool results first and keeps the system prompt, the task and the latest steps whole', () => {
    const big = 'x'.repeat(9_000);
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'sistem' },
      { role: 'user', content: 'görev' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.ts', content: big } } }] },
      { role: 'tool', tool_name: 'read_file', content: big },
      { role: 'tool', tool_name: 'read_file', content: big },
      { role: 'assistant', content: 'son adım' },
      { role: 'tool', tool_name: 'read_file', content: big },
      { role: 'tool', tool_name: 'search_code', content: big },
      { role: 'assistant', content: 'devam' },
    ];
    expect(compactConversation(structuredClone(messages), 100_000)).toBe(0);
    const compacted = structuredClone(messages);
    expect(compactConversation(compacted, 7_000)).toBeGreaterThan(0);
    expect(compacted[0]!.content).toBe('sistem');
    expect(compacted[1]!.content).toBe('görev');
    expect(compacted[3]!.content).toMatch(/^\[kısaltıldı: .*9000 karakterlik read_file/);
    // The last four messages are untouched.
    expect(compacted.slice(-4)).toEqual(messages.slice(-4));
  });
});

describe('parseTextToolCalls', () => {
  const names = new Set(['read_file', 'write_file', 'finish']);
  it('recovers qwen3-coder XML and qwen3 JSON calls written as text, only for offered tools', () => {
    const xml = 'Okuyorum.\n<tool_call>\n<function=read_file>\n<parameter=path>\nfrontend/src/a.tsx\n</parameter>\n</function>\n</tool_call>\n<function=rm_rf>\n<parameter=path>\n/\n</parameter>\n</function>';
    expect(parseTextToolCalls(xml, names)).toEqual([{ function: { name: 'read_file', arguments: { path: 'frontend/src/a.tsx' } } }]);
    // A reply cut off before the closing tags still carries a usable call.
    expect(parseTextToolCalls('<function=write_file>\n<parameter=path>\na.ts\n</parameter>\n<parameter=content>\nconst a = 1;\n', names)).toEqual([{ function: { name: 'write_file', arguments: { path: 'a.ts', content: 'const a = 1;' } } }]);
    expect(parseTextToolCalls('<tool_call>\n{"name": "finish", "arguments": {"summary": "ok"}}\n</tool_call>', names)).toEqual([{ function: { name: 'finish', arguments: { summary: 'ok' } } }]);
    expect(parseTextToolCalls('Dosyayı read_file ile okuyacağım.', names)).toEqual([]);
  });
});

describe('stripEchoedLineNumbers', () => {
  it('removes read_file line numbers a model wrote back, and leaves real content alone', () => {
    expect(stripEchoedLineNumbers('1\timport x;\n2\n3\texport const a = 1;\n4\t  return a;')).toBe('import x;\n\nexport const a = 1;\n  return a;');
    expect(stripEchoedLineNumbers('1_import x;\n2\n3_/** doc */\n4_export f() {\n5  let s = 0;\n6}')).toBe('import x;\n\n/** doc */\nexport f() {\nlet s = 0;\n}');
    const yaml = 'steps:\n  - 1\n  - 2\n10 apples\n';
    expect(stripEchoedLineNumbers(yaml)).toBe(yaml);
  });
});

describe('OpenAI provider + agent loop', () => {
  it('chains turns with previous_response_id, validates tool input and stops on finish', async () => {
    const fake = await startFakeOpenAi([
      () => ({ output: [call('c1', 'add', '{"a":2,"b":"üç"}'), call('c2', 'nope', '{}')] }),
      () => ({ output: [call('c3', 'add', '{"a":2,"b":3}')] }),
      () => ({ output: [call('c4', 'finish', '{"summary":"Toplam 5"}')] }),
    ]);
    const tools: Record<string, AgentTool> = {
      add: {
        risk: 'low',
        schema: z.object({ a: z.number(), b: z.number() }),
        def: { name: 'add', description: 'adds', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
        run: async ({ a, b }) => String(a + b),
      },
      finish: {
        risk: 'low',
        schema: z.object({ summary: z.string() }),
        def: { name: 'finish', description: 'done', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
        run: async () => 'ok',
      },
    };
    const actions: string[] = [];
    const out = await runToolAgent({
      provider: new OpenAiProvider('sk-test', 'test-model', fake.url),
      system: 'calc',
      task: '2+3?',
      tools,
      maxSteps: 10,
      tokenLimit: 10_000,
      onAction: async (name, _input, r) => void actions.push(`${name}:${r.ok}`),
    });
    expect(out).toMatchObject({ status: 'finished', finishInput: { summary: 'Toplam 5' }, steps: 3, usage: { inputTokens: 150, outputTokens: 30 } });
    expect(actions).toEqual(['add:false', 'add:true', 'finish:true']);
    // Turn 2 continues turn 1 and returns both tool outputs (invalid input and unknown tool as errors).
    expect(fake.requests[1]).toMatchObject({ previous_response_id: 'resp_1' });
    const outputs = fake.requests[1]!.input as { call_id: string; output: string }[];
    expect(outputs.map((o) => o.call_id)).toEqual(['c1', 'c2']);
    expect(outputs[0]!.output).toMatch(/^ERROR: Geçersiz girdi: b:/);
    expect(outputs[1]!.output).toBe('ERROR: Bilinmeyen araç: nope');
    expect((fake.requests[2]!.input as { output: string }[])[0]!.output).toBe('5');
    expect((fake.requests[0]!.tools as { strict: boolean }[]).every((t) => t.strict)).toBe(true);
  });

  it('asks a model that only describes the change to use its tools, and answers repeated searches without rerunning them', async () => {
    const msg = (text: string) => ({ output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], output_text: text });
    const fake = await startFakeOpenAi([
      () => msg('add aracını kullanarak toplayacağım.'),
      () => ({ output: [call('a1', 'add', '{"a":2,"b":3}')] }),
      () => ({ output: [call('a2', 'add', '{"a":2,"b":3}')] }),
      () => ({ output: [call('f1', 'finish', '{"summary":"5"}')] }),
    ]);
    let runs = 0;
    const out = await runToolAgent({
      provider: new OpenAiProvider('sk-test', 'm', fake.url),
      system: 's',
      task: 't',
      tools: {
        add: { risk: 'low', schema: z.object({ a: z.number(), b: z.number() }), def: { name: 'add', description: '', parameters: {} }, run: async ({ a, b }) => String(a + b + 0 * ++runs) },
        finish: { risk: 'low', schema: z.object({ summary: z.string() }), def: { name: 'finish', description: '', parameters: {} }, run: async () => 'ok' },
      },
      maxSteps: 10,
      tokenLimit: 10_000,
    });
    expect(out).toMatchObject({ status: 'finished', finishInput: { summary: '5' } });
    expect((fake.requests[1]!.input as { role: string; content: string }[])[0]).toMatchObject({ role: 'user' });
    expect(runs).toBe(1);
    expect((fake.requests[3]!.input as { output: string }[])[0]!.output).toMatch(/zaten yaptın/);
  });

  it('stops at the step limit', async () => {
    const loop = () => ({ output: [call(String(Math.random()), 'add', '{"a":1,"b":1}')] });
    const fake = await startFakeOpenAi([loop, loop, loop, loop]);
    const out = await runToolAgent({
      provider: new OpenAiProvider('sk-test', 'm', fake.url),
      system: 's',
      task: 't',
      tools: {
        add: { risk: 'low', schema: z.object({ a: z.number(), b: z.number() }), def: { name: 'add', description: '', parameters: {} }, run: async () => '2' },
      },
      maxSteps: 2,
      tokenLimit: 10_000,
    });
    expect(out.status).toBe('max_steps');
    expect(out.steps).toBe(2);
    expect(fake.requests.length).toBe(2);
  });

  it('stops after the same failed tool call is repeated three times', async () => {
    const retry = () => ({ output: [call(String(Math.random()), 'write', '{"path":".env.example"}')] });
    const fake = await startFakeOpenAi([retry, retry, retry, retry]);
    const out = await runToolAgent({
      provider: new OpenAiProvider('sk-test', 'm', fake.url),
      system: 's',
      task: 't',
      tools: {
        write: {
          risk: 'medium',
          schema: z.object({ path: z.string() }),
          def: { name: 'write', description: '', parameters: {} },
          run: async () => {
            throw new Error('Önce dosyayı oku');
          },
        },
      },
      maxSteps: 10,
      tokenLimit: 10_000,
    });
    expect(out).toMatchObject({ status: 'tool_error', steps: 3, text: 'write: Önce dosyayı oku' });
    expect(fake.requests.length).toBe(3);
  });

  it('replays a compacted result (at most twice per call) and then stops three repeats in a row', async () => {
    const turn = (id: string, compacted?: number): AiTurn => ({
      text: '',
      toolCalls: [{ id, name: 'read', input: { path: 'src/a.ts' } }],
      done: false,
      refused: false,
      truncated: false,
      usage: { inputTokens: 10, outputTokens: 2 },
      compacted,
    });
    let index = 0;
    const turns = [turn('r1'), turn('r2', 1), turn('r3', 1), turn('r4', 1), turn('r5', 1), turn('r6', 1)];
    const provider: AiProvider = {
      name: 'ollama',
      model: 'local-test',
      complete: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, refused: false }),
      agent: () => ({
        start: async () => turns[index++]!,
        continue: async () => turns[index++]!,
        say: async () => turns[index++]!,
      }),
    };
    let reads = 0;
    const out = await runToolAgent({
      provider,
      system: 's',
      task: 't',
      tools: {
        read: {
          risk: 'low',
          schema: z.object({ path: z.string() }),
          def: { name: 'read', description: '', parameters: {} },
          run: async () => `content-${++reads}`,
        },
      },
      maxSteps: 10,
      tokenLimit: 10_000,
    });
    expect(out).toMatchObject({ status: 'tool_error', steps: 6, text: 'read: aynı çağrılar tekrar tekrar yapıldı, ilerleme yok' });
    expect(reads).toBe(1);
  });
});

describe('verification does not invalidate repository reads', () => {
  it('replays reads after checks and compaction, but refreshes them after a real edit', async () => {
    let index = 0;
    const steps = ['read', 'check', 'read', 'edit', 'read', 'finish'];
    const next = async (): Promise<AiTurn> => ({ text: '', toolCalls: [{ id: String(index), name: steps[index++]!, input: {} }], done: false, refused: false, truncated: false, compacted: index === 3 ? 1 : undefined, usage: { inputTokens: 1, outputTokens: 1 } });
    const provider: AiProvider = { name: 'ollama', model: 'test', complete: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, refused: false }), agent: () => ({ start: next, continue: next, say: next }) };
    let reads = 0;
    let edited = false;
    const outputs: string[] = [];
    const tools: Record<string, AgentTool> = Object.fromEntries(['read', 'check', 'edit', 'finish'].map((name) => [name, {
      risk: name === 'check' || name === 'edit' ? 'medium' : 'low',
      ...(name === 'check' ? { mutates: false } : {}),
      schema: z.object({}), def: { name, description: '', parameters: {} },
      run: async () => { if (name === 'edit') edited = true; if (name === 'read') { reads++; outputs.push(edited ? 'new' : 'old'); } return 'ok'; },
    }]));
    expect(await runToolAgent({ provider, system: 's', task: 't', tools, maxSteps: 8, tokenLimit: 1000 })).toMatchObject({ status: 'finished', steps: 6 });
    expect(reads).toBe(2);
    expect(outputs).toEqual(['old', 'new']);
  });
});

async function startFakeOllama(script: Record<string, unknown>[]) {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.12.3' }));
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'local-code:7b', size: 4_500_000_000, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } }] }));
      if (req.url === '/api/ps') return void res.end(JSON.stringify({ models: [{ name: 'local-code:7b', size_vram: 4_200_000_000, expires_at: '2026-10-08T18:00:00Z' }] }));
      res.statusCode = 404;
      return void res.end();
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      // Model capabilities: the fake model can think, so the provider must send think:false (thinking off by default).
      if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }));
      }
      requests.push(body);
      const out = script[requests.length - 1]!;
      res.writeHead(200, { 'content-type': body.stream ? 'application/x-ndjson' : 'application/json' });
      if (body.stream) {
        for (const part of out.parts as string[]) res.write(`${JSON.stringify({ message: { role: 'assistant', content: part }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 80, eval_count: 12 })}\n`);
      } else {
        res.end(JSON.stringify({ done: true, prompt_eval_count: 40, eval_count: 8, ...out }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url, requests };
}

describe('Ollama local provider', () => {
  it('runs on the configured model when installed, else on the server default or the strongest installed model', async () => {
    const fake = await startFakeOllama([]);
    expect(await pickLocalModel(fake.url, 'local-code:7b', 'x')).toEqual({ model: 'local-code:7b' });
    expect(await pickLocalModel(fake.url, 'qwen3-coder:30b', 'local-code:7b')).toEqual({ model: 'local-code:7b', fallbackFrom: 'qwen3-coder:30b' });
    expect(await pickLocalModel(fake.url, 'qwen3-coder:30b', 'missing:1b')).toEqual({ model: 'local-code:7b', fallbackFrom: 'qwen3-coder:30b' });
    // Unreachable runtime: keep the request; the call itself reports the real error.
    expect(await pickLocalModel('http://127.0.0.1:9', 'qwen3-coder:30b', 'x')).toEqual({ model: 'qwen3-coder:30b' });
  });

  it('generates local semantic vectors in one bounded batch', async () => {
    const fake = await startFakeOllama([{ model: 'local-embed', embeddings: [[1, 0, 0], [0, 1, 0]] }]);
    const vectors = await new OllamaEmbeddingClient(fake.url, 'local-embed').embed(['oturum yenileme', 'fatura toplamı']);
    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(fake.requests[0]).toMatchObject({ model: 'local-embed', input: ['oturum yenileme', 'fatura toplamı'], truncate: true, keep_alive: '30m', options: { num_gpu: 0 } });
  });

  it('streams chat locally and reports the runtime model inventory', async () => {
    const fake = await startFakeOllama([{ parts: ['Yerel ', 'yanıt'] }]);
    const deltas: string[] = [];
    const result = await new OllamaProvider(fake.url, 'local-code:7b').complete({
      system: 'Türkçe yanıtla',
      messages: [{ role: 'user', content: 'Mimariyi açıkla' }],
      onText: (part) => deltas.push(part),
    });
    expect(result).toEqual({ text: 'Yerel yanıt', usage: { inputTokens: 80, outputTokens: 12 }, refused: false });
    expect(deltas).toEqual(['Yerel ', 'yanıt']);
    // The context window is always explicit: Ollama's default varies by version/VRAM and truncates prompts silently.
    expect(fake.requests[0]).toMatchObject({ model: 'local-code:7b', stream: true, think: false, keep_alive: '30m', options: { num_ctx: 16_384 } });

    const health = await getOllamaRuntimeStatus(fake.url);
    expect(health).toMatchObject({ reachable: true, version: '0.12.3', models: [{ name: 'local-code:7b', parameterSize: '7B', quantization: 'Q4_K_M' }], loadedModels: [{ name: 'local-code:7b', sizeVram: 4_200_000_000 }] });
  });

  it('executes bounded multi-turn tools through Ollama chat', async () => {
    const fake = await startFakeOllama([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 2, b: 3 } } }] } },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'finish', arguments: { summary: 'Toplam 5' } } }] } },
    ]);
    const tools: Record<string, AgentTool> = {
      add: {
        risk: 'low',
        schema: z.object({ a: z.number(), b: z.number() }),
        def: { name: 'add', description: 'adds', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
        run: async ({ a, b }) => String(a + b),
      },
      finish: {
        risk: 'low',
        schema: z.object({ summary: z.string() }),
        def: { name: 'finish', description: 'done', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
        run: async () => 'ok',
      },
    };
    const result = await runToolAgent({ provider: new OllamaProvider(fake.url, 'local-code:7b'), system: 'calc', task: '2+3?', tools, maxSteps: 5, tokenLimit: 1000 });
    expect(result).toMatchObject({ status: 'finished', finishInput: { summary: 'Toplam 5' }, steps: 2, usage: { inputTokens: 80, outputTokens: 16 } });
    const secondMessages = fake.requests[1]!.messages as { role: string; tool_name?: string; content: string }[];
    expect(secondMessages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'add', content: '5' });
  });
});
