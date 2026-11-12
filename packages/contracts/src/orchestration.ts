import { z } from 'zod';

/** Cross-module workflow states. Domain rows (builds, deployments, AI tasks) remain their own source of truth. */
export const WORKFLOW_STATUSES = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'partially_completed',
  'needs_reconciliation',
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_STEP_STATUSES = [
  'pending',
  'running',
  'waiting',
  'passed',
  'failed',
  'skipped',
  'cancelled',
  'unknown',
  'needs_reconciliation',
] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

export const VERIFICATION_STATUSES = ['passed', 'failed', 'inconclusive', 'expired'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const OBSERVATION_CONFIDENCE = ['verified', 'high', 'medium', 'low', 'inferred', 'unknown'] as const;
export type ObservationConfidence = (typeof OBSERVATION_CONFIDENCE)[number];

export const CAPABILITY_STATUSES = ['supported', 'unsupported', 'misconfigured', 'stale', 'unknown'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const POLICY_DECISIONS = ['allow', 'deny', 'requires_approval'] as const;
export type PolicyDecisionResult = (typeof POLICY_DECISIONS)[number];

export const eventRecordSchema = z.object({
  eventType: z.string().trim().min(3).max(120),
  schemaVersion: z.number().int().min(1).default(1),
  correlationId: z.uuid().optional(),
  causationId: z.uuid().nullable().optional(),
  organizationId: z.uuid(),
  projectId: z.uuid().nullable().optional(),
  sourceType: z.string().trim().max(60).nullable().optional(),
  sourceId: z.string().trim().max(255).nullable().optional(),
  revision: z.string().trim().max(200).nullable().optional(),
  environmentId: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export interface CapabilityValue {
  status: CapabilityStatus;
  reason?: string;
  source?: string;
}

export type CapabilityMap = Record<string, CapabilityValue>;
