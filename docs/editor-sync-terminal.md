# Opening projects anywhere, real-time sync, browser terminal and "fix all with AI"

## 1. Real-time synchronization

### The model: the Project Hub repository is the single source of truth

Every place that edits code — the web editor, a desktop IDE, a folder on someone's PC, the browser terminal, an AI
merge — ends in a commit on the project's Git repository hosted by Project Hub. Synchronization is therefore "make
every change a commit quickly" plus "tell everyone who looks at the repository the moment a ref moves".

```text
 VS Code / Cursor / JetBrains ──git push (HTTPS, project token)──┐
 PC folder + projecthub-sync ──auto commit+push (≈2 s)───────────┤
 Web editor ──commit API (compare-and-swap)───────────────────────┼──► Git repository ──► repository.updated
 Browser terminal ──commit after each command─────────────────────┤        (PostgreSQL NOTIFY → API → SSE)
 AI auto-fix / approved AI change ──merge─────────────────────────┘                 │
                                                                                     ▼
                                     open browser tabs (code view, history, branches, toast "X → main: …")
                                     sync agents (poll every 4 s, pull fast-forward / rebase)
                                     terminal sessions (fast-forward before the next command)
```

- **Server → browsers.** Every ref change (`recordPush`: Git push, web commit, merge; terminal commits; AI merges;
  branch create/delete) publishes `repository.updated` with `{branch, sha, message, actor}` inside the same database
  transaction. The SSE stream forwards that allow-listed summary only to users who can see the project. The web app
  refreshes repository queries; the code editor reloads files that have no unsaved edits and shows a conflict banner
  ("Uzak sürümü yükle / Benim değişikliğimi koru") for files that do — nothing is overwritten silently, and committing
  is blocked until the conflict is resolved.
- **PC → server.** `projecthub-sync` (served at `/api/v1/tools/projecthub-sync.mjs`, Node.js + Git, no dependencies)
  watches the folder, commits 1.5 s after the last save and pushes. `node_modules`, build output and `.env` files are
  excluded even without a `.gitignore`.
- **Server → PC.** The agent checks the branch every 4 s with `git ls-remote` (one small request) and pulls; local
  commits are rebased on top. On a real conflict it aborts the rebase, pushes the local work to
  `sync-cakisma/<pc>-<time>`, keeps the folder untouched and pauses — both versions survive.
- **IDE users without the agent** get the same through normal Git: push from the editor's Git panel; the web app
  updates instantly. (Pulling is the IDE's own fetch/auto-fetch.)

### Why this design (and the alternatives)

| Approach | How it works | Why not (or when) |
| --- | --- | --- |
| **Git as the sync protocol + server events (chosen)** | Commits are the unit of change; SSE tells browsers; a small agent automates commit/push/pull on PCs | Works with every editor, keeps history and audit, conflicts are explicit and recoverable, no new protocol to secure |
| Filesystem watcher that uploads raw files (Dropbox-style) | Agent sends file contents on every save | Loses history and authorship, last-writer-wins silently overwrites, binary/huge files and `node_modules` floods |
| Git hooks / webhooks only | Server reacts to pushes | Still needs someone to push; does nothing for "I saved a file" |
| WebSocket instead of SSE | Bidirectional socket | SSE already carries server → browser events through the existing proxy and auth; browser → server goes through normal API calls |
| Shared network drive / SMB mount of the repository | Everyone edits the same files | No isolation, no review, breaks on network loss, a single bad save affects everyone |
| CRDT / operational transform (Google Docs-style co-editing, e.g. Yjs + VS Code Live Share) | Keystroke-level merging inside one document | Excellent for pair programming in one file, but does not cover builds, terminals or many files; can be added later on top of this model for the web editor |
| Remote development (VS Code Remote-SSH / Dev Containers / code-server) | The editor works directly on the server's copy | Strong option for teams; needs per-user server sandboxes. The browser terminal is the first step in that direction |

Polling every 4 s from the agent is deliberate: it needs only the project-scoped Git token (which cannot call the REST
API or SSE). A push channel for agents can be added later without changing the model.

## 2. "Projeyi nerede açmak istersiniz?"

Project header → **Aç**:

- Creates an **editor token**: valid only for Git over HTTPS on this one project (`api_tokens.scope = 'git'`), refused
  by the REST API, revocable under *Hesabım*. The user's own project permissions still apply (read-only users can
  clone but not push).
- Deep links: `vscode://vscode.git/clone?url=…`, `cursor://…`, `windsurf://…`, JetBrains Toolbox
  (`jetbrains://idea/checkout/git?checkout.repo=…`), Visual Studio (`git-client://clone?repo=…`), GitHub Desktop
  (`x-github-client://openRepo/…`) and Sourcetree. The token is not put into the link unless the user ticks
  "Anahtarı bağlantıya ekle" (then Git stores it in `.git/config`).
- Copy-paste commands for the sync agent (PowerShell and bash). The token is passed as `PH_TOKEN` and given to Git as a
  one-off HTTP header; it is never written to disk.
- **Tarayıcı terminali** for people without a local setup.

## 3. Browser terminal

`/projects/<slug>/terminal`, for users with `repository.push`.

- A session is a private working copy of one branch on the worker. Each command runs in a **fresh container** with the
  same hardening as container builds: non-root user `1000`, all capabilities dropped, `no-new-privileges`, read-only
  image filesystem, CPU/RAM/process limits, a time limit (default 15 min), no Docker socket and no Project Hub
  environment. Git runs on the worker side, so the container never sees a token.
- Before each command, changes pushed elsewhere are fast-forwarded in (unless there are unsaved local files). After
  each command, changed files are committed to the branch ("Otomatik kaydet", on by default) and announced live.
  Protected branches are never written; `node_modules`, build output and `.env` files are never committed.
- Every command is recorded in the audit log. Sessions close after 60 idle minutes and their working copy is deleted.
- It is a command console (one command at a time, output streamed), not a full-screen TTY: `npm install`, `npm test`,
  `composer`, `pip` work; interactive programs such as `vim` or `top` do not.

Enable it only where the worker can reach a Docker engine:

```bash
TERMINAL_ENABLED=true
TERMINAL_IMAGE=node:22-bookworm-slim        # pull it once: docker pull node:22-bookworm-slim
TERMINAL_NETWORK=bridge                     # `none` blocks all network access (no package downloads)
DOCKER_BINARY=…/docker.exe                  # only if docker is not on PATH (Docker Desktop on Windows)
```

The production Compose stack keeps it **off**: the worker container deliberately has no Docker socket. Run a separate
worker on a host with a dedicated (ideally rootless) Docker engine to offer terminals. With `bridge`, commands can
reach the internet and the host's LAN; put that worker on an egress-filtered network.

## 4. "Tümünü AI ile düzelt" (security and project health)

Security page and the project overview's health panel. The plan groups open problems and picks the safest method:

| Problem | Method | Risk | After verification |
| --- | --- | --- | --- |
| Vulnerable npm / PyPI dependency, fix within the same major | Package manager, lockfile only, `--ignore-scripts` (no model) | low | **merges itself** |
| Same, but needs a new major version | same | medium | waits for approval |
| Hard-coded secret | Coding agent moves it to an environment variable | high | approval + key rotation reminder |
| Code / configuration / IaC findings | Coding agent, up to 5 findings per file | medium | approval |
| Failing default-branch build | Coding agent with the build failure context | medium | approval |
| Missing README | Coding agent, documentation files only | low | **merges itself** |

Every fix is committed to an `ai/…` branch and goes through the project's normal **verification build including its
tests**. Then the worker (`ai.autofix.verify`) re-scans the AI branch. A fix is *proven* only if the build passed, the
targeted findings are gone, no new high/critical finding appeared and only expected files changed (manifests/lockfiles
for dependencies, `.md` for docs). A proven low-risk fix merges automatically when *Yönetim → AI kontrol merkezi →
Kanıtlanan düşük riskli düzeltmeleri kendiliğinden birleştir* is on (default), autonomy is at least L2, the branch is
not protected and the per-project hourly limit (default 5) is not reached. Everything else waits; *Doğrulananları
onayla* approves all proven fixes in one click. Each automatic merge is audited as `ai.task.auto_merged`, and the
default-branch re-scan closes the findings.

Projects marked untrusted are not touched by the dependency upgrader (it runs the package manager). Yarn, Composer,
Go and Cargo upgrades are listed as "not automatic" with a reason.
