import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  CAPABILITY_STATUSES,
  OBSERVATION_CONFIDENCE,
  POLICY_DECISIONS,
  VERIFICATION_STATUSES,
  WORKFLOW_STATUSES,
  WORKFLOW_STEP_STATUSES,
  type CapabilityMap,
  type CapabilityStatus,
  type ObservationConfidence,
  type PolicyDecisionResult,
  type VerificationStatus,
  type WorkflowStatus,
  type WorkflowStepStatus,
} from '@projecthub/contracts';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, teams, users } from './identity.js';
import { projects } from './projects.js';

/** Immutable machine-readable facts. Timeline rows remain the human-facing projection. */
export const eventRecords = pgTable(
  'event_records',
  {
    id: pk(),
    sequence: bigint({ mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    eventType: varchar({ length: 120 }).notNull(),
    schemaVersion: integer().notNull().default(1),
    correlationId: uuid().notNull(),
    causationId: uuid(),
    actorType: varchar({ length: 20 }),
    actorId: uuid(),
    actorLabel: varchar({ length: 200 }),
    sourceType: varchar({ length: 60 }),
    sourceId: varchar({ length: 255 }),
    revision: varchar({ length: 200 }),
    environmentId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('event_records_sequence_uq').on(t.sequence),
    index('event_records_org_sequence_idx').on(t.organizationId, t.sequence),
    index('event_records_project_sequence_idx').on(t.projectId, t.sequence),
    index('event_records_correlation_idx').on(t.correlationId, t.sequence),
    index('event_records_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    correlationId: uuid().notNull(),
    triggerEventId: uuid().references(() => eventRecords.id, { onDelete: 'set null' }),
    definitionKey: varchar({ length: 100 }).notNull(),
    definitionVersion: integer().notNull().default(1),
    title: varchar({ length: 300 }).notNull(),
    status: varchar({ length: 30 }).$type<WorkflowStatus>().notNull().default('pending'),
    phase: varchar({ length: 60 }),
    triggerType: varchar({ length: 40 }).notNull(),
    triggerRef: varchar({ length: 255 }),
    baseRevision: varchar({ length: 200 }),
    environmentId: uuid(),
    riskLevel: varchar({ length: 20 }).notNull().default('low'),
    requestedByType: varchar({ length: 20 }).notNull(),
    requestedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    idempotencyKey: varchar({ length: 255 }),
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
    startedAt: ts(),
    finishedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('workflow_runs_project_created_idx').on(t.projectId, t.createdAt),
    index('workflow_runs_status_idx').on(t.organizationId, t.status, t.createdAt),
    index('workflow_runs_correlation_idx').on(t.correlationId),
    uniqueIndex('workflow_runs_idempotency_uq')
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    check('workflow_runs_status_ck', oneOf('status', WORKFLOW_STATUSES)),
    check('workflow_runs_risk_ck', oneOf('risk_level', ['low', 'medium', 'high', 'critical'])),
  ],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: pk(),
    workflowRunId: uuid()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    parentStepId: uuid(),
    key: varchar({ length: 80 }).notNull(),
    name: varchar({ length: 160 }).notNull(),
    seq: integer().notNull(),
    status: varchar({ length: 30 }).$type<WorkflowStepStatus>().notNull().default('pending'),
    idempotencyKey: varchar({ length: 255 }),
    attempt: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(1),
    input: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb().$type<Record<string, unknown>>(),
    checkpoint: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    startedAt: ts(),
    finishedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workflow_steps_seq_uq').on(t.workflowRunId, t.seq),
    uniqueIndex('workflow_steps_key_uq').on(t.workflowRunId, t.key),
    index('workflow_steps_status_idx').on(t.status, t.updatedAt),
    check('workflow_steps_status_ck', oneOf('status', WORKFLOW_STEP_STATUSES)),
  ],
);

export const executionEvidence = pgTable(
  'execution_evidence',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    workflowRunId: uuid().references(() => workflowRuns.id, { onDelete: 'cascade' }),
    workflowStepId: uuid().references(() => workflowSteps.id, { onDelete: 'cascade' }),
    kind: varchar({ length: 60 }).notNull(),
    subjectType: varchar({ length: 60 }).notNull(),
    subjectId: varchar({ length: 255 }),
    sourceType: varchar({ length: 60 }).notNull(),
    sourceRef: varchar({ length: 500 }),
    environmentId: uuid(),
    revision: varchar({ length: 200 }),
    toolName: varchar({ length: 120 }),
    toolVersion: varchar({ length: 100 }),
    artifactId: uuid(),
    checksum: varchar({ length: 128 }),
    result: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    observedAt: ts().notNull().defaultNow(),
    validUntil: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('execution_evidence_run_idx').on(t.workflowRunId, t.createdAt),
    index('execution_evidence_subject_idx').on(t.subjectType, t.subjectId, t.createdAt),
    index('execution_evidence_revision_idx').on(t.projectId, t.revision),
  ],
);

export const verificationResults = pgTable(
  'verification_results',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    workflowRunId: uuid()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    workflowStepId: uuid().references(() => workflowSteps.id, { onDelete: 'set null' }),
    key: varchar({ length: 100 }).notNull(),
    status: varchar({ length: 20 }).$type<VerificationStatus>().notNull(),
    summary: text().notNull(),
    expected: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    observed: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    evidenceIds: jsonb().$type<string[]>().notNull().default([]),
    verifiedAt: ts().notNull().defaultNow(),
    validUntil: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('verification_results_key_uq').on(t.workflowRunId, t.key),
    index('verification_results_status_idx').on(t.projectId, t.status, t.verifiedAt),
    check('verification_results_status_ck', oneOf('status', VERIFICATION_STATUSES)),
  ],
);

export const softwareEntities = pgTable(
  'software_entities',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    kind: varchar({ length: 50 }).notNull(),
    externalKey: varchar({ length: 300 }).notNull(),
    name: varchar({ length: 200 }).notNull(),
    lifecycle: varchar({ length: 30 }).notNull().default('active'),
    refType: varchar({ length: 60 }),
    refId: varchar({ length: 255 }),
    ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    teamId: uuid().references(() => teams.id, { onDelete: 'set null' }),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('software_entities_key_uq').on(t.organizationId, t.kind, t.externalKey),
    index('software_entities_project_kind_idx').on(t.projectId, t.kind),
  ],
);

export const entityRelations = pgTable(
  'entity_relations',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    fromEntityId: uuid()
      .notNull()
      .references(() => softwareEntities.id, { onDelete: 'cascade' }),
    toEntityId: uuid()
      .notNull()
      .references(() => softwareEntities.id, { onDelete: 'cascade' }),
    kind: varchar({ length: 80 }).notNull(),
    status: varchar({ length: 20 }).notNull().default('active'),
    detectionMethod: varchar({ length: 80 }).notNull(),
    sourceType: varchar({ length: 60 }).notNull(),
    sourceRef: varchar({ length: 500 }),
    revision: varchar({ length: 200 }),
    confidence: varchar({ length: 20 }).$type<ObservationConfidence>().notNull().default('unknown'),
    validFrom: ts().notNull().defaultNow(),
    validUntil: ts(),
    lastVerifiedAt: ts(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('entity_relations_identity_uq').on(t.fromEntityId, t.toEntityId, t.kind, t.sourceType, t.sourceRef),
    index('entity_relations_from_idx').on(t.fromEntityId, t.kind),
    index('entity_relations_to_idx').on(t.toEntityId, t.kind),
    check('entity_relations_status_ck', oneOf('status', ['active', 'stale', 'disputed', 'expired'])),
    check('entity_relations_confidence_ck', oneOf('confidence', OBSERVATION_CONFIDENCE)),
  ],
);

export const observations = pgTable(
  'observations',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    entityId: uuid().references(() => softwareEntities.id, { onDelete: 'cascade' }),
    subjectType: varchar({ length: 60 }).notNull(),
    subjectId: varchar({ length: 255 }),
    key: varchar({ length: 120 }).notNull(),
    value: jsonb().$type<unknown>().notNull(),
    sourceType: varchar({ length: 60 }).notNull(),
    sourceRef: varchar({ length: 500 }),
    revision: varchar({ length: 200 }),
    environmentId: uuid(),
    confidence: varchar({ length: 20 }).$type<ObservationConfidence>().notNull().default('unknown'),
    evidenceId: uuid().references(() => executionEvidence.id, { onDelete: 'set null' }),
    observedAt: ts().notNull().defaultNow(),
    validUntil: ts(),
    supersededAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('observations_subject_idx').on(t.subjectType, t.subjectId, t.key, t.observedAt),
    index('observations_project_key_idx').on(t.projectId, t.key, t.observedAt),
    check('observations_confidence_ck', oneOf('confidence', OBSERVATION_CONFIDENCE)),
  ],
);

export const capabilityProfiles = pgTable(
  'capability_profiles',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: varchar({ length: 200 }).notNull(),
    status: varchar({ length: 20 }).$type<CapabilityStatus>().notNull(),
    capabilities: jsonb().$type<CapabilityMap>().notNull(),
    source: varchar({ length: 40 }).notNull(),
    observedAt: ts().notNull().defaultNow(),
    staleAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('capability_profiles_revision_uq').on(t.projectId, t.revision),
    index('capability_profiles_project_observed_idx').on(t.projectId, t.observedAt),
    check('capability_profiles_status_ck', oneOf('status', CAPABILITY_STATUSES)),
  ],
);

export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    workflowRunId: uuid().references(() => workflowRuns.id, { onDelete: 'cascade' }),
    workflowStepId: uuid().references(() => workflowSteps.id, { onDelete: 'set null' }),
    policyKey: varchar({ length: 100 }).notNull(),
    policyVersion: integer().notNull().default(1),
    decision: varchar({ length: 30 }).$type<PolicyDecisionResult>().notNull(),
    riskLevel: varchar({ length: 20 }).notNull(),
    reasons: jsonb().$type<string[]>().notNull().default([]),
    inputHash: varchar({ length: 128 }).notNull(),
    decidedByType: varchar({ length: 20 }).notNull(),
    decidedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('policy_decisions_run_idx').on(t.workflowRunId, t.createdAt),
    index('policy_decisions_policy_idx').on(t.policyKey, t.createdAt),
    check('policy_decisions_decision_ck', oneOf('decision', POLICY_DECISIONS)),
    check('policy_decisions_risk_ck', oneOf('risk_level', ['low', 'medium', 'high', 'critical'])),
  ],
);
