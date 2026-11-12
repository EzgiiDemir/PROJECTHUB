import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_URL: z.url(),
  REVIEW_BASE_URL: z.url(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  PREVIEW_BASE_DOMAIN: z.string().min(3),
  PREVIEW_PUBLIC_URL_TEMPLATE: z.string().includes('{slug}'),
  PREVIEW_PORT_RANGE: z
    .string()
    .regex(/^\d+-\d+$/)
    .default('41000-41999')
    .transform((v) => {
      const [a, b] = v.split('-').map(Number) as [number, number];
      return { from: a, to: b };
    }),
  DATABASE_URL: z.string().startsWith('postgres'),
  /** Runtime root (database, storage, tools and operator scratch); keep it outside the source checkout. */
  PROJECTHUB_RUNTIME_DIR: z.string().min(1).optional(),
  STORAGE_DIR: z.string().min(1),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, 'APP_ENCRYPTION_KEY is required (32 random bytes, base64)')
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY must decode to exactly 32 bytes'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  /**
   * Second sign-in step by e-mail: "required" asks every account that has no authenticator app or passkey for a code
   * sent to its address (needs SMTP). "off" only for installations without e-mail.
   */
  AUTH_EMAIL_CODE: z.enum(['required', 'off']).default('required'),
  /** Passkeys (fingerprint / Face ID / Windows Hello): the site they are bound to. Empty = the host of APP_URL. */
  WEBAUTHN_RP_ID: z.string().optional().default(''),
  COOKIE_SECURE: bool,
  BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Heavy jobs (build, preview, AI task, browser) wait while free memory is below this; 0 turns the guard off. */
  MIN_FREE_MEMORY_MB: z.coerce.number().int().min(0).max(1_000_000).default(1024),
  BUILD_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(180).default(20),
  /** A first, uncached dependency install of a large import (tens of thousands of packages files) takes longer. */
  BUILD_INSTALL_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(45),
  /** Optional defense-in-depth runner for trusted builds. Untrusted sources remain blocked. */
  BUILD_EXECUTOR: z.enum(['host', 'container']).default('host'),
  BUILD_CONTAINER_IMAGE: z.string().min(1).default('node:22-bookworm-slim'),
  BUILD_CONTAINER_CPUS: z.coerce.number().positive().max(16).default(2),
  BUILD_CONTAINER_MEMORY_MB: z.coerce.number().int().min(256).max(32768).default(2048),
  BUILD_CONTAINER_PIDS: z.coerce.number().int().min(32).max(4096).default(256),
  /** Server previews: `container` runs each one in its own locked-down container (BUILD_CONTAINER_IMAGE). */
  PREVIEW_EXECUTOR: z.enum(['host', 'container']).default('host'),
  PREVIEW_CONTAINER_CPUS: z.coerce.number().positive().max(16).default(2),
  PREVIEW_CONTAINER_MEMORY_MB: z.coerce.number().int().min(256).max(32768).default(2048),
  PREVIEW_CONTAINER_PIDS: z.coerce.number().int().min(32).max(4096).default(512),
  /**
   * Browser terminal: each command runs in a fresh locked-down container (same hardening as container builds) on the
   * worker host. Needs a Docker engine reachable by the worker; off by default.
   */
  TERMINAL_ENABLED: bool,
  /** Allow importing Git repositories from file paths, localhost and link-local addresses (tests / single-machine only). */
  GIT_IMPORT_ALLOW_LOCAL: bool,
  /** Explicit opt-in for BUILD_EXECUTOR=host when NODE_ENV=production (a dedicated build machine only). */
  ALLOW_HOST_BUILDS: bool,
  /** Comma-separated Git hosts (or parent domains) projects may be imported from; empty = any public or LAN host. */
  GIT_IMPORT_ALLOWED_HOSTS: z.string().optional().default(''),
  TERMINAL_IMAGE: z.string().min(1).default('node:22-bookworm-slim'),
  /** `bridge` lets commands reach package registries; `none` isolates them completely. */
  TERMINAL_NETWORK: z.enum(['bridge', 'none']).default('bridge'),
  TERMINAL_COMMAND_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  TERMINAL_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
  OPENAI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  /** Self-hosted Ollama runtime. It is never given an external provider key. */
  OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5-coder:7b'),
  /** Optional local embedding model. Empty keeps the PostgreSQL full-text fallback only. */
  OLLAMA_EMBEDDING_MODEL: z.string().optional().default(''),
  OLLAMA_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  /**
   * Context window requested from Ollama on every call (num_ctx). Ollama's own default depends on its version and
   * free VRAM and can be as small as 2–4k tokens, which silently truncates the system prompt and tool definitions.
   */
  OLLAMA_CONTEXT_TOKENS: z.coerce.number().int().min(2048).max(262_144).default(16_384),
  /**
   * Model layers on the GPU (num_gpu). 0 = Ollama decides. Set it when a larger context makes Ollama's estimate run
   * out of VRAM, or when it spills into slow shared memory (8 GB GPU + qwen3-coder:30b at 32k: 16 is fastest).
   */
  OLLAMA_GPU_LAYERS: z.coerce.number().int().min(0).max(999).default(0),
  /**
   * Let "thinking" models (qwen3, deepseek-r1, …) reason before answering. Off by default: on an 8 GB GPU the hidden
   * reasoning makes agent steps several times slower and can hit the request timeout on large projects.
   */
  OLLAMA_THINKING: bool,
  /** Optional API gateway / proxy in front of the provider (corporate LLM gateways). Empty = provider default. */
  ANTHROPIC_BASE_URL: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().optional().default(''),
  OSV_API_URL: z.string().optional().default(''),
  /** Package registries for latest-release lookups of direct dependencies (opt-in via .env; empty = skip, e.g. offline installs). */
  NPM_REGISTRY_URL: z.string().optional().default(''),
  PYPI_URL: z.string().optional().default(''),
  PACKAGIST_URL: z.string().optional().default(''),
  BROWSER_AUTOMATION: bool,
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default('Project Hub <noreply@localhost>'),
  GIT_BINARY: z.string().default('git'),
  /** Directories the "local" deploy adapter may write to (comma separated). Empty = STORAGE_DIR/deploy-local only. */
  DEPLOY_LOCAL_ROOTS: z.string().optional().default(''),
  PG_DUMP_BINARY: z.string().default('pg_dump'),
  /** External scanners (`<dir>/gitleaks/gitleaks[.exe]`, ...). Empty = `tools` next to STORAGE_DIR; else PATH. */
  SCANNER_TOOLS_DIR: z.string().optional().default(''),
});

export type RawConfig = z.infer<typeof configSchema>;
export interface AppConfig extends RawConfig {
  runtimeDir: string;
  storageDir: string;
  /** External scanner binaries (see SCANNER_TOOLS_DIR). */
  toolsDir: string;
  deployLocalRoots: string[];
  encryptionKey: Buffer;
  isProduction: boolean;
}

/** Loads .env (development convenience) and validates the environment. Throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { cwd?: string } = {}): AppConfig {
  const cwd = options.cwd ?? findWorkspaceRoot(process.cwd());
  const envFile = path.join(cwd, '.env');
  if (env === process.env && fs.existsSync(envFile) && process.env.NODE_ENV !== 'production') {
    process.loadEnvFile(envFile);
  }
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const c = parsed.data;
  const runtimeDir = path.resolve(cwd, c.PROJECTHUB_RUNTIME_DIR ?? path.dirname(c.STORAGE_DIR));
  const storageDir = path.resolve(cwd, c.STORAGE_DIR);
  if (c.NODE_ENV === 'production' && isWithin(cwd, runtimeDir)) {
    throw new Error('Invalid configuration:\n  - PROJECTHUB_RUNTIME_DIR must be outside the application source directory in production. Mount a dedicated persistent data directory.');
  }
  if (!isWithin(runtimeDir, storageDir)) {
    throw new Error('Invalid configuration:\n  - STORAGE_DIR must be located inside PROJECTHUB_RUNTIME_DIR so persistent data has one explicit backup and access boundary.');
  }
  // Project code never runs on a production host by accident: host builds there need an explicit, auditable opt-in.
  if (c.NODE_ENV === 'production' && c.BUILD_EXECUTOR === 'host' && !c.ALLOW_HOST_BUILDS) {
    throw new Error('Invalid configuration:\n  - BUILD_EXECUTOR=host is refused in production (project install/build/test code would run on this server). Use BUILD_EXECUTOR=container, or set ALLOW_HOST_BUILDS=true for a dedicated, isolated build machine.');
  }
  if (c.NODE_ENV === 'production' && c.PREVIEW_EXECUTOR === 'host' && !c.ALLOW_HOST_BUILDS) {
    throw new Error('Invalid configuration:\n  - PREVIEW_EXECUTOR=host is refused in production (preview apps would run on this server). Use PREVIEW_EXECUTOR=container, or set ALLOW_HOST_BUILDS=true for a dedicated, isolated machine.');
  }
  return {
    ...c,
    runtimeDir,
    storageDir,
    toolsDir: c.SCANNER_TOOLS_DIR ? path.resolve(cwd, c.SCANNER_TOOLS_DIR) : path.join(runtimeDir, 'tools'),
    deployLocalRoots: [path.join(storageDir, 'deploy-local'), ...c.DEPLOY_LOCAL_ROOTS.split(',').map((x) => x.trim()).filter(Boolean).map((x) => path.resolve(cwd, x))],
    encryptionKey: Buffer.from(c.APP_ENCRYPTION_KEY, 'base64'),
    isProduction: c.NODE_ENV === 'production',
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Walks up from `start` to the directory containing pnpm-workspace.yaml (falls back to start). */
export function findWorkspaceRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
