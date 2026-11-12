import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  ActorType,
  CapabilityMap,
  DetectionResult,
  Manifest,
  VerificationStatus,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@projecthub/contracts';
import {
  capabilityProfiles,
  entityRelations,
  eventRecords,
  executionEvidence,
  observations,
  policyDecisions,
  softwareEntities,
  verificationResults,
  workflowRuns,
  workflowSteps,
  type Executor,
} from '@projecthub/database';

export interface EventRecordInput {
  eventType: string;
  organizationId: string;
  projectId?: string | null;
  schemaVersion?: number;
  correlationId?: string;
  causationId?: string | null;
  actor?: { type: ActorType; id: string | null; label: string } | null;
  sourceType?: string | null;
  sourceId?: string | null;
  revision?: string | null;
  environmentId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Writes the durable fact before any realtime or webhook delivery is attempted. */
export async function recordEvent(db: Executor, input: EventRecordInput) {
  const correlationId = input.correlationId ?? crypto.randomUUID();
  const [row] = await db
    .insert(eventRecords)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion ?? 1,
      correlationId,
      causationId: input.causationId ?? null,
      actorType: input.actor?.type ?? null,
      actorId: input.actor?.id ?? null,
      actorLabel: input.actor?.label ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      revision: input.revision ?? null,
      environmentId: input.environmentId ?? null,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return row!;
}

export interface StartWorkflowInput {
  organizationId: string;
  projectId?: string | null;
  correlationId?: string;
  triggerEventId?: string | null;
  definitionKey: string;
  definitionVersion?: number;
  title: string;
  triggerType: string;
  triggerRef?: string | null;
  baseRevision?: string | null;
  environmentId?: string | null;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  requestedByType: ActorType;
  requestedBy?: string | null;
  idempotencyKey?: string | null;
  context?: Record<string, unknown>;
}

/** Starts once per organization/idempotency key and returns the existing run on a retry. */
export async function startWorkflow(db: Executor, input: StartWorkflowInput) {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.organizationId, input.organizationId), eq(workflowRuns.idempotencyKey, input.idempotencyKey)));
    if (existing) return existing;
  }
  const [row] = await db
    .insert(workflowRuns)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      correlationId: input.correlationId ?? crypto.randomUUID(),
      triggerEventId: input.triggerEventId ?? null,
      definitionKey: input.definitionKey,
      definitionVersion: input.definitionVersion ?? 1,
      title: input.title,
      triggerType: input.triggerType,
      triggerRef: input.triggerRef ?? null,
      baseRevision: input.baseRevision ?? null,
      environmentId: input.environmentId ?? null,
      riskLevel: input.riskLevel ?? 'low',
      requestedByType: input.requestedByType,
      requestedBy: input.requestedBy ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      context: input.context ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.organizationId, input.organizationId), eq(workflowRuns.idempotencyKey, input.idempotencyKey!)));
  return raced!;
}

export async function setWorkflowStatus(
  db: Executor,
  workflowRunId: string,
  status: WorkflowStatus,
  detail: { phase?: string | null; error?: string | null } = {},
) {
  const terminal = ['succeeded', 'failed', 'cancelled', 'unknown', 'partially_completed', 'needs_reconciliation'].includes(status);
  const [row] = await db
    .update(workflowRuns)
    .set({
      status,
      ...(detail.phase !== undefined ? { phase: detail.phase } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
      ...(status === 'running' ? { startedAt: new Date() } : {}),
      ...(terminal ? { finishedAt: new Date() } : {}),
    })
    .where(eq(workflowRuns.id, workflowRunId))
    .returning();
  return row;
}

export async function ensureWorkflowStep(
  db: Executor,
  input: { workflowRunId: string; key: string; name: string; seq: number; maxAttempts?: number; input?: Record<string, unknown> },
) {
  const [row] = await db
    .insert(workflowSteps)
    .values({ ...input, maxAttempts: input.maxAttempts ?? 1, input: input.input ?? {} })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  return (await db.select().from(workflowSteps).where(and(eq(workflowSteps.workflowRunId, input.workflowRunId), eq(workflowSteps.key, input.key))))[0]!;
}

export async function setWorkflowStepStatus(
  db: Executor,
  stepId: string,
  status: WorkflowStepStatus,
  detail: { output?: Record<string, unknown> | null; checkpoint?: Record<string, unknown> | null; error?: string | null } = {},
) {
  const terminal = ['passed', 'failed', 'skipped', 'cancelled', 'unknown', 'needs_reconciliation'].includes(status);
  const [row] = await db
    .update(workflowSteps)
    .set({
      status,
      ...(status === 'running' ? { attempt: sql`${workflowSteps.attempt} + 1`, startedAt: new Date() } : {}),
      ...(detail.output !== undefined ? { output: detail.output } : {}),
      ...(detail.checkpoint !== undefined ? { checkpoint: detail.checkpoint } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
      ...(terminal ? { finishedAt: new Date() } : {}),
    })
    .where(eq(workflowSteps.id, stepId))
    .returning();
  return row;
}

export async function addEvidence(
  db: Executor,
  input: typeof executionEvidence.$inferInsert,
) {
  return (await db.insert(executionEvidence).values(input).returning())[0]!;
}

export async function recordVerification(
  db: Executor,
  input: Omit<typeof verificationResults.$inferInsert, 'status'> & { status: VerificationStatus },
) {
  return (
    await db
      .insert(verificationResults)
      .values(input)
      .onConflictDoUpdate({
        target: [verificationResults.workflowRunId, verificationResults.key],
        set: {
          status: input.status,
          summary: input.summary,
          expected: input.expected ?? {},
          observed: input.observed ?? {},
          evidenceIds: input.evidenceIds ?? [],
          verifiedAt: input.verifiedAt ?? new Date(),
          validUntil: input.validUntil ?? null,
        },
      })
      .returning()
  )[0]!;
}

/** Persists the exact policy outcome that authorized, blocked, or paused a workflow. */
export async function recordPolicyDecision(db: Executor, input: typeof policyDecisions.$inferInsert) {
  return (await db.insert(policyDecisions).values(input).returning())[0]!;
}

/** Derives what the platform can safely do for one immutable project revision. */
export function deriveCapabilityProfile(manifest: Manifest, detection?: DetectionResult | null): CapabilityMap {
  const value = (supported: boolean, source: string, reason?: string) => ({
    status: supported ? ('supported' as const) : ('unsupported' as const),
    source,
    ...(reason ? { reason } : {}),
  });
  return {
    install: value(!!manifest.install?.command, 'projecthub.yml'),
    build: value(!!manifest.build?.command || manifest.runtime.type === 'static', 'projecthub.yml'),
    test: value(!!manifest.test?.command, 'projecthub.yml', manifest.test?.command ? undefined : 'Test komutu tanımlı değil'),
    preview: value(manifest.preview.enabled && (!!manifest.start?.command || !!manifest.build?.output || manifest.runtime.type === 'static'), 'projecthub.yml'),
    database: value(manifest.database.type !== 'none', 'projecthub.yml'),
    migration: value(!!manifest.database.migrate?.command || !!manifest.database.migrate?.directory, 'projecthub.yml'),
    deployment: value(!!manifest.deploy || !!manifest.build?.output || manifest.runtime.type === 'static', 'projecthub.yml'),
    smoke: value(!!manifest.smoke?.paths.length, 'projecthub.yml'),
    dependency_scan: value(manifest.security.dependencyScan, 'projecthub.yml'),
    secret_scan: value(manifest.security.secretScan, 'projecthub.yml'),
    ai_indexing: value(manifest.ai.indexing, 'projecthub.yml'),
    source_detection: value(!!detection, detection ? 'smart-import' : 'none'),
  };
}

export async function saveCapabilityProfile(
  db: Executor,
  input: { projectId: string; revision: string; manifest: Manifest; detection?: DetectionResult | null; source: string },
) {
  const capabilities = deriveCapabilityProfile(input.manifest, input.detection);
  const statuses = Object.values(capabilities).map((c) => c.status);
  const status = statuses.includes('misconfigured') ? 'misconfigured' : statuses.includes('supported') ? 'supported' : 'unsupported';
  return (
    await db
      .insert(capabilityProfiles)
      .values({ projectId: input.projectId, revision: input.revision, status, capabilities, source: input.source })
      .onConflictDoUpdate({
        target: [capabilityProfiles.projectId, capabilityProfiles.revision],
        set: { status, capabilities, source: input.source, observedAt: new Date(), staleAt: null },
      })
      .returning()
  )[0]!;
}

export async function upsertSoftwareEntity(
  db: Executor,
  input: typeof softwareEntities.$inferInsert,
) {
  return (
    await db
      .insert(softwareEntities)
      .values(input)
      .onConflictDoUpdate({
        target: [softwareEntities.organizationId, softwareEntities.kind, softwareEntities.externalKey],
        set: {
          name: input.name,
          projectId: input.projectId ?? null,
          lifecycle: input.lifecycle ?? 'active',
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          ownerId: input.ownerId ?? null,
          teamId: input.teamId ?? null,
          metadata: input.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning()
  )[0]!;
}

export async function upsertEntityRelation(
  db: Executor,
  input: typeof entityRelations.$inferInsert,
) {
  return (
    await db
      .insert(entityRelations)
      .values(input)
      .onConflictDoUpdate({
        target: [entityRelations.fromEntityId, entityRelations.toEntityId, entityRelations.kind, entityRelations.sourceType, entityRelations.sourceRef],
        set: {
          status: input.status ?? 'active',
          detectionMethod: input.detectionMethod,
          revision: input.revision ?? null,
          confidence: input.confidence ?? 'unknown',
          validUntil: input.validUntil ?? null,
          lastVerifiedAt: input.lastVerifiedAt ?? new Date(),
          metadata: input.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning()
  )[0]!;
}

/** Appends an observation and marks the previous value stale without destroying its provenance. */
export async function recordObservation(
  db: Executor,
  input: typeof observations.$inferInsert,
) {
  const now = input.observedAt ?? new Date();
  await db
    .update(observations)
    .set({ supersededAt: now })
    .where(
      and(
        eq(observations.organizationId, input.organizationId),
        eq(observations.subjectType, input.subjectType),
        sql`${observations.subjectId} IS NOT DISTINCT FROM ${input.subjectId ?? null}`,
        eq(observations.key, input.key),
        isNull(observations.supersededAt),
      ),
    );
  return (await db.insert(observations).values({ ...input, observedAt: now }).returning())[0]!;
}
