import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { environments } from './deploy.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

export interface FeatureFlagRule {
  attribute: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'in';
  value: string | string[];
}

/** Provider-neutral feature flags. Evaluation is deterministic and can later be exposed through OpenFeature. */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
    key: varchar({ length: 100 }).notNull(),
    name: varchar({ length: 160 }).notNull(),
    description: text().notNull().default(''),
    status: varchar({ length: 20 }).notNull().default('active'),
    defaultEnabled: boolean().notNull().default(false),
    ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    tags: jsonb().$type<string[]>().notNull().default([]),
    expiresAt: ts(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('feature_flags_project_key_uq').on(t.projectId, t.key),
    index('feature_flags_project_status_idx').on(t.projectId, t.status),
    check('feature_flags_status_ck', oneOf('status', ['active', 'archived'])),
  ],
);

export const featureFlagOverrides = pgTable(
  'feature_flag_overrides',
  {
    id: pk(),
    flagId: uuid().notNull().references(() => featureFlags.id, { onDelete: 'cascade' }),
    environmentId: uuid().notNull().references(() => environments.id, { onDelete: 'cascade' }),
    enabled: boolean().notNull(),
    rolloutPercentage: integer().notNull().default(100),
    rules: jsonb().$type<FeatureFlagRule[]>().notNull().default([]),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('feature_flag_overrides_env_uq').on(t.flagId, t.environmentId),
    index('feature_flag_overrides_environment_idx').on(t.environmentId),
    check('feature_flag_overrides_percentage_ck', sql`${t.rolloutPercentage} >= 0 AND ${t.rolloutPercentage} <= 100`),
  ],
);
