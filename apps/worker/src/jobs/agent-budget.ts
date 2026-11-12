import type { AiTaskType } from '@projecthub/contracts';

const FILE_REF = /(?:^|[\s`'"(])([\w@.-]+(?:\/[\w@.\[\]-]+)+\.(?:[cm]?[jt]sx?|php|py|go|java|cs|vue|svelte|json|ya?ml|md))(?:$|[\s`'":,)])/gim;
const BROAD_TASKS = new Set<AiTaskType>(['architecture_review', 'impact_analysis', 'database_review', 'deployment_review', 'project_plan']);

export interface AgentBudget {
  focused: boolean;
  maxSteps: number;
  tokenLimit: number;
  referencedFiles: string[];
}

/**
 * A precise one-file fix must not inherit the same 30-step / multi-million-token ceiling as an architecture task.
 * The strong model is retained; only runaway conversation depth is bounded. Broader work keeps the configured step
 * allowance, with a generous per-task token fuse so one broken loop cannot consume the month's capacity.
 */
export function agentBudget(input: { title: string; instruction: string; type: AiTaskType; configuredMaxSteps: number }): AgentBudget {
  const text = `${input.title}\n${input.instruction}`;
  const referencedFiles = [...new Set([...text.matchAll(FILE_REF)].map((match) => match[1]!))];
  const focused = !BROAD_TASKS.has(input.type) && referencedFiles.length === 1 && input.instruction.length <= 2_500;
  return {
    focused,
    // 16 turns: a long file read in parts, an edit or two, the checks and a fix after them. Eight ended Form tasks on
    // FormRenderer.tsx (1,186 lines) with "Adım sınırına ulaşıldı" before they could change anything.
    maxSteps: Math.min(input.configuredMaxSteps, focused ? 16 : input.configuredMaxSteps),
    tokenLimit: focused ? 400_000 : 750_000,
    referencedFiles,
  };
}

