import { Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '@projecthub/core';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { AuthService } from '../auth/auth.service.js';

const AGENT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/projecthub-sync.mjs');

export interface EditorOpener {
  id: string;
  label: string;
  url: string;
}

/**
 * "Where do you want to open this?": desktop editors and the sync agent get a token that works only for Git over HTTPS
 * on this one project (never the REST API), on top of the user's own repository permissions.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
    private readonly authService: AuthService,
  ) {}

  async editorAccess(auth: AuthInfo, idOrSlug: string, input: { expiresInDays: number; embedToken: boolean }, actor: Actor) {
    const scope = await this.access.require(auth, idOrSlug, 'repository.read');
    const p = scope.project;
    const base = this.ctx.config.APP_URL.replace(/\/$/, '');
    const cloneUrl = `${base}/git/${p.id}.git`;
    const created = await this.authService.createToken(auth, { name: `Editör erişimi · ${p.slug}`.slice(0, 100), expiresInDays: input.expiresInDays, gitProjectId: p.id }, actor);
    // Embedding is opt-in: convenient (no credential prompt) but Git then stores the token in .git/config.
    const target = input.embedToken ? withCredentials(cloneUrl, auth.user.email, created.token) : cloneUrl;
    const enc = encodeURIComponent(target);
    const openers: EditorOpener[] = [
      { id: 'vscode', label: 'Visual Studio Code', url: `vscode://vscode.git/clone?url=${enc}` },
      { id: 'cursor', label: 'Cursor', url: `cursor://vscode.git/clone?url=${enc}` },
      { id: 'windsurf', label: 'Windsurf', url: `windsurf://vscode.git/clone?url=${enc}` },
      { id: 'jetbrains', label: 'JetBrains (IntelliJ, WebStorm, PhpStorm, PyCharm)', url: `jetbrains://idea/checkout/git?checkout.repo=${enc}&idea.required.plugins.id=Git4Idea` },
      { id: 'visualstudio', label: 'Visual Studio', url: `git-client://clone?repo=${enc}` },
      { id: 'github-desktop', label: 'GitHub Desktop', url: `x-github-client://openRepo/${target}` },
      { id: 'sourcetree', label: 'Sourcetree', url: `sourcetree://cloneRepo?type=custom&cloneUrl=${enc}` },
    ];
    const agentUrl = `${base}/api/v1/tools/projecthub-sync.mjs`;
    const args = `--url ${cloneUrl} --user ${auth.user.email} --dir "${p.slug}" --branch ${p.defaultBranch}`;
    return {
      project: { id: p.id, slug: p.slug, name: p.name, defaultBranch: p.defaultBranch },
      cloneUrl,
      username: auth.user.email,
      token: created.token,
      tokenId: created.id,
      expiresAt: created.expiresAt,
      canPush: scope.can('repository.push') && p.status !== 'archived',
      openers,
      sync: {
        agentUrl,
        powershell: `Invoke-WebRequest ${agentUrl} -OutFile projecthub-sync.mjs; $env:PH_TOKEN='${created.token}'; node projecthub-sync.mjs ${args}`,
        bash: `curl -fsSLo projecthub-sync.mjs ${agentUrl} && PH_TOKEN='${created.token}' node projecthub-sync.mjs ${args}`,
      },
    };
  }

  agentSource(): Promise<string> {
    return fs.readFile(AGENT_FILE, 'utf8');
  }
}

function withCredentials(url: string, user: string, token: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = token;
  return u.toString();
}
