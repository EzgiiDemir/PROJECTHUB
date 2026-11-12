import { boolean, check, index, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, oneOf, pk, ts } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

export const TERMINAL_SESSION_STATUSES = ['starting', 'ready', 'closed', 'failed'] as const;
export const TERMINAL_COMMAND_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

/**
 * Browser terminal: a private working copy of one branch on the worker. Every command runs in a fresh, locked-down
 * container against it; changes are committed back to the branch so the app, editors and sync agents see them.
 */
export const terminalSessions = pgTable(
  'terminal_sessions',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    branch: varchar({ length: 200 }).notNull(),
    /** Commit the working copy is based on (moves with every sync). */
    headCommit: varchar({ length: 40 }),
    status: varchar({ length: 20 }).notNull().default('starting'),
    /** Commit changed files back to the branch after every command. */
    autoSync: boolean().notNull().default(true),
    error: text(),
    createdAt: createdAt(),
    lastActivityAt: ts().notNull().defaultNow(),
    closedAt: ts(),
  },
  (t) => [index('terminal_sessions_project_user_idx').on(t.projectId, t.userId), check('terminal_sessions_status_ck', oneOf('status', TERMINAL_SESSION_STATUSES))],
);

export const terminalCommands = pgTable(
  'terminal_commands',
  {
    id: pk(),
    sessionId: uuid()
      .notNull()
      .references(() => terminalSessions.id, { onDelete: 'cascade' }),
    command: text().notNull(),
    status: varchar({ length: 20 }).notNull().default('queued'),
    exitCode: integer(),
    /** Combined stdout/stderr, tail-capped. */
    output: text().notNull().default(''),
    /** Commit created by the automatic sync after this command, if files changed. */
    commitSha: varchar({ length: 40 }),
    syncNote: text(),
    createdAt: createdAt(),
    startedAt: ts(),
    finishedAt: ts(),
  },
  (t) => [index('terminal_commands_session_idx').on(t.sessionId, t.createdAt), check('terminal_commands_status_ck', oneOf('status', TERMINAL_COMMAND_STATUSES))],
);
