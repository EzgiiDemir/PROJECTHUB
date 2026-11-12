import { eq } from 'drizzle-orm';
import { aiSettingsSchema, automationSettingsSchema, retentionSettingsSchema, type AiSettings, type AutomationSettings, type RetentionSettings } from '@projecthub/contracts';
import { organizations, type Executor } from '@projecthub/database';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'ollama',
  model: null,
  // Spec: start at L2 — AI suggests and prepares changes on its own branch, humans approve.
  autonomyLevel: 'L2',
  // 0 = unlimited (owner decision 2026-10-13: AI usage is not capped; the local model has no per-token cost).
  monthlyTokenBudget: 0,
  maxAgentSteps: 30,
  contextTokens: null,
  policies: { createBranch: true, commitToAiBranch: true, runBuilds: true, createPreview: true },
  // Automatic remediation is opt-in and starts behind an emergency stop.
  selfHealing: { enabled: false, emergencyStop: true, autoRecheckHealth: false, maxAttemptsPerHour: 2 },
  // Owner decision 2026-10-12: proven low-risk fixes merge themselves; the rest needs approval.
  autoFix: { autoMergeLowRisk: true, maxAutoMergesPerHour: 5 },
};

/** Defaults sized for the initial 8 GB RAM / 200 GB disk server. */
export const DEFAULT_RETENTION: RetentionSettings = {
  previewBuildDays: 7,
  temporaryBuildDays: 3,
  screenshotDays: 30,
  rawLogDays: 14,
  healthCheckDays: 14,
  maxConcurrentBuilds: 1,
  maxRunningPreviews: 6,
};

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  emergencyStop: false,
  reason: null,
  pausedJobTypes: [],
};

export interface OrgSettings {
  ai: AiSettings;
  retention: RetentionSettings;
  automation: AutomationSettings;
}

export async function getOrgSettings(db: Executor, organizationId: string): Promise<OrgSettings> {
  const rows = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
  const s = (rows[0]?.settings ?? {}) as { ai?: unknown; retention?: unknown; automation?: unknown };
  const ai = aiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, ...(s.ai as object) });
  const retention = retentionSettingsSchema.safeParse({ ...DEFAULT_RETENTION, ...(s.retention as object) });
  const automation = automationSettingsSchema.safeParse({ ...DEFAULT_AUTOMATION_SETTINGS, ...(s.automation as object) });
  return {
    ai: ai.success ? ai.data : DEFAULT_AI_SETTINGS,
    retention: retention.success ? retention.data : DEFAULT_RETENTION,
    automation: automation.success ? automation.data : DEFAULT_AUTOMATION_SETTINGS,
  };
}
