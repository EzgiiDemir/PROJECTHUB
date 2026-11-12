import { z } from 'zod';
import { decryptFromString, encryptToString, sha256, type FileChange } from '@projecthub/core';

const checkpointSchema = z.object({
  version: z.literal(1), identity: z.string(),
  changes: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('delete'), path: z.string().min(1).max(500) }),
    z.object({ action: z.literal('upsert'), path: z.string().min(1).max(500), content: z.string() }),
  ])).max(30),
});

/** Bind a private draft to its exact task, project, instruction and source revision; never rebase it implicitly. */
export function checkpointIdentity(input: { taskId: string; projectId: string; base: string; baseBranch: string; instruction: string; title: string }): string {
  return sha256(JSON.stringify(input));
}

/** Kept in the existing PostgreSQL job payload, encrypted: operations/job viewers must not receive source text. */
export function encodeCheckpoint(key: Buffer, identity: string, changes: FileChange[]): string {
  const data = checkpointSchema.parse({ version: 1, identity, changes: changes.map((change) => change.action === 'delete' ? change : { ...change, content: change.content.toString() }) });
  return encryptToString(key, JSON.stringify(data));
}

export function decodeCheckpoint(key: Buffer, packed: string, identity: string): FileChange[] | null {
  const data = checkpointSchema.parse(JSON.parse(decryptFromString(key, packed)));
  if (data.identity !== identity) return null;
  return data.changes;
}
