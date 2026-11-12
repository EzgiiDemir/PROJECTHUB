import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { USER_STATUSES, type UserStatus } from '@projecthub/contracts';
import { createdAt, inet, oneOf, pk, ts, updatedAt } from './_helpers.js';

export const organizations = pgTable('organizations', {
  id: pk(),
  name: varchar({ length: 150 }).notNull(),
  slug: varchar({ length: 100 }).notNull().unique(),
  status: varchar({ length: 30 }).notNull().default('active'),
  /** Organization-wide settings: ai, retention, branding. Validated by the API before write. */
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: varchar({ length: 255 }).notNull(),
    passwordHash: text(),
    displayName: varchar({ length: 150 }).notNull(),
    title: varchar({ length: 120 }).notNull().default(''),
    avatarColor: varchar({ length: 9 }).notNull().default('#234E8C'),
    status: varchar({ length: 30 }).$type<UserStatus>().notNull().default('invited'),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: ts(),
    /** Per category: { inApp, email }. Missing categories use the defaults (both on). */
    notificationPreferences: jsonb().$type<Record<string, { inApp?: boolean; email?: boolean }>>().notNull().default({}),
    emailVerifiedAt: ts(),
    /** Authenticator app (TOTP, RFC 6238) secret, encrypted with APP_ENCRYPTION_KEY. Set while setting up too. */
    totpSecret: text(),
    /** When the authenticator app was confirmed with a valid code; null = not in use. */
    totpEnabledAt: ts(),
    /** sha256 of the unused one-time recovery codes. */
    recoveryCodes: jsonb().$type<string[]>().notNull().default([]),
    lastLoginAt: ts(),
    lastActivityAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`), check('users_status_ck', oneOf('status', USER_STATUSES))],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar({ length: 30 }).notNull().default('active'),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index('org_members_user_idx').on(t.userId)],
);

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    /** NULL = built-in system role shared by every organization. */
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    key: varchar({ length: 100 }).notNull(),
    name: varchar({ length: 100 }).notNull(),
    description: text().notNull().default(''),
    isSystem: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_org_key_uq').on(sql`coalesce(${t.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key)],
);

export const permissions = pgTable('permissions', {
  key: varchar({ length: 150 }).primaryKey(),
  groupName: varchar({ length: 100 }).notNull(),
  description: text().notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: varchar({ length: 150 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const organizationMemberRoles = pgTable(
  'organization_member_roles',
  {
    organizationId: uuid().notNull(),
    userId: uuid().notNull(),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.roleId] }),
    index('org_member_roles_user_idx').on(t.userId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar({ length: 100 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('teams_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** sha256 of the raw cookie token. The raw token is never stored. */
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    ipAddress: inet(),
    userAgent: text(),
    expiresAt: ts().notNull(),
    lastSeenAt: ts().notNull().defaultNow(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Passkeys (WebAuthn): fingerprint, Face ID, Windows Hello or a security key bound to this site. */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** base64url credential id from the authenticator. */
    credentialId: text().notNull().unique(),
    /** base64url COSE public key. */
    publicKey: text().notNull(),
    counter: integer().notNull().default(0),
    transports: jsonb().$type<string[]>().notNull().default([]),
    deviceType: varchar({ length: 20 }).notNull().default('singleDevice'),
    backedUp: boolean().notNull().default(false),
    name: varchar({ length: 100 }).notNull(),
    lastUsedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('webauthn_credentials_user_idx').on(t.userId)],
);

/**
 * Short-lived sign-in steps: the second factor after a correct password ("mfa"), a passkey sign-in ("passkey") and
 * adding a passkey ("passkey_register"). The raw ticket goes to the browser; only its sha256 is stored.
 */
export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: pk(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar({ length: 20 }).$type<'mfa' | 'passkey' | 'passkey_register'>().notNull(),
    ticketHash: varchar({ length: 64 }).notNull().unique(),
    /** WebAuthn challenge (base64url), when a passkey ceremony is running. */
    challenge: text(),
    /** sha256 of the e-mailed code, when one was sent. */
    emailCodeHash: varchar({ length: 64 }),
    emailSentAt: ts(),
    attempts: integer().notNull().default(0),
    expiresAt: ts().notNull(),
    consumedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('login_challenges_user_idx').on(t.userId), check('login_challenges_kind_ck', sql`${t.kind} IN ('mfa', 'passkey', 'passkey_register')`)],
);

/** One-time tokens for invitations and password resets. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    purpose: varchar({ length: 30 }).notNull(),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [check('user_tokens_purpose_ck', oneOf('purpose', ['invite', 'password_reset']))],
);

/** Personal access tokens for Git over HTTP and API automation. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar({ length: 100 }).notNull(),
    prefix: varchar({ length: 16 }).notNull(),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    /** 'full' = the user's own API/Git access; 'git' = Git over HTTPS for `projectId` only (editor / sync agent). */
    scope: varchar({ length: 20 }).notNull().default('full'),
    /** Project a 'git' token is limited to. No FK (identity must not import projects); checked on every request. */
    projectId: uuid(),
    lastUsedAt: ts(),
    expiresAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('api_tokens_user_idx').on(t.userId),
    check('api_tokens_scope_ck', sql`${t.scope} in ('full', 'git') and (${t.scope} = 'full' or ${t.projectId} is not null)`),
  ],
);
