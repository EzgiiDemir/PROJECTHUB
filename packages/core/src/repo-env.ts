import type { GitRepository } from './git.js';

export interface RepositoryEnv {
  /** The files' contents joined, deepest first, so values from the root .env win when parsed. */
  text: string;
  commit: string;
  date: string;
  /** True when the files are gone from the branch and were read from the commit before their removal. */
  removed: boolean;
  paths: string[];
}

/**
 * The .env files committed on a branch — at the root or in an app folder one level down (backend/.env in a
 * backend/ + frontend/ repository) — or their last versions before they were removed.
 */
export async function readRepositoryEnv(git: GitRepository, branch: string): Promise<RepositoryEnv | null> {
  const head = await git.resolve(`refs/heads/${branch}`);
  if (!head) return null;
  const envFiles = async (commit: string) =>
    (await git.listFiles(commit))
      .map((f) => f.path)
      .filter((p) => /^([^/]+\/)?\.env$/.test(p))
      .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  const read = async (commit: string, paths: string[]) =>
    (await Promise.all(paths.map(async (p) => (await git.readFile(commit, p, 256 * 1024))?.content.toString('utf8') ?? ''))).join('\n');
  const present = await envFiles(head);
  if (present.length) return { text: await read(head, present), commit: head, date: (await git.commitInfo(head))?.date ?? '', removed: false, paths: present };
  const removedIn = (await git.text(['log', '-1', '--diff-filter=D', '--format=%H', head, '--', '.env', ':(glob)*/.env'])).trim();
  const last = removedIn ? (await git.log({ ref: removedIn, limit: 1 }))[0] : undefined;
  const parent = last?.parents[0];
  if (!last || !parent) return null;
  const before = await envFiles(parent);
  return before.length ? { text: await read(parent, before), commit: parent, date: last.date, removed: true, paths: before } : null;
}
