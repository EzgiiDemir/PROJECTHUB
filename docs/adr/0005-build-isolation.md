# 0005 — Build and preview isolation (deviation from the spec)

**Status:** amended 2026-10-09; constrained container runner available for trusted builds

**Context.** The spec asks for every build to run in a throwaway container. The first deployment target is a single
8 GB server, and the hub must also work on hosts without a container runtime.

**Decision.** Builds and app previews run as child processes of the worker, each in its own workspace directory
that is deleted afterwards, with a scrubbed environment (the hub's database URL, encryption key, AI keys, SMTP and
other settings are removed; only the project's own secrets for that scope are added), a timeout per command,
process-tree kill on cancel/timeout, previews bound to 127.0.0.1 and reachable only through the authenticated
preview gateway. In the container deployment the worker runs as an unprivileged user in its own container.

A standalone worker may now opt into `BUILD_EXECUTOR=container`. Each install/build/test command then runs in an
ephemeral container with a read-only root filesystem, non-root UID, dropped capabilities, no-new-privileges,
CPU/RAM/PID/time limits and no Docker socket. Install steps may use the bridge network; build and test steps use
`--network none`. Image pulling is forbidden during jobs (`--pull never`), so an operator must pre-pull the pinned
image. Project-scoped variables are passed by name and hub process secrets are not forwarded. Containers are
removed on success, failure, timeout and cancellation; a heartbeat/status reconciler removes managed leftovers
after a worker crash.

**Consequences.** Host mode still runs project code with the worker's operating-system user and is allowed only for
explicitly trusted projects. Container mode materially reduces accidental and compromised-build impact, but a
shared-kernel container is not a complete boundary for arbitrary hostile code. Imported Git/ZIP sources therefore
remain blocked until an authorized operator marks them trusted. A future hostile-code tier must use a dedicated
rootless runner host or microVM, with no Project Hub data mount and no daemon socket exposed to the job.

**Amendment 2026-10-19.** `deploy/build-image` provides the container runtime for PHP/Laravel + Node projects (PHP 8.4,
Composer 2, Node 22, Laravel extensions); package caches live on a per-project Docker volume mounted at `/cache`, so
one project cannot poison another's cache and the 256 MB `/tmp` tmpfs is not exhausted. Measured on the Windows
workstation with Docker Desktop: the bind-mounted workspace makes Composer/npm extraction impractically slow (Form's
install did not finish in 8 minutes), so container mode is the recommended setting for Linux workers and host mode
remains the workstation default. Host-mode logs, AI check output and preview logs mask secret values.

**Amendment 2026-10-19 (later).** The workspace of a container build (and of the AI's checks) now lives in a Docker
volume (`ContainerWorkspace`): copied in as one tar stream, chowned to UID 1000 by a root step that runs no project
code, worked on at native VM disk speed, copied back as one tar stream before the artifact is made, removed afterwards
(a reconciler removes volumes of crashed runs). Measured with Form on the Windows workstation: install 106 s, build
15 s, tests 62 s (host, uncached: 1383 s install). On Windows the copy-back dereferences symlinks (no symlink privilege)
and drops links that leave /workspace. A Linux-built Next.js app starts on the Windows host for previews. Container
mode is therefore the recommended default everywhere; production refuses host mode unless `ALLOW_HOST_BUILDS=true`.
The bundled Compose worker is NOT a per-project isolation boundary: it holds Hub credentials and shared storage.
Host opt-in is only for trusted-code evaluation, not a multi-project production deployment.

**Amendment 2026-10-20.** Server previews run in containers too (`PREVIEW_EXECUTOR=container`, `PreviewContainer`):
one container per preview from the build image, UID 1000, read-only root filesystem, all capabilities dropped,
no-new-privileges, CPU/RAM/PID limits, ports published on the host's 127.0.0.1 only. The artifact is streamed into a
Docker volume per artifact (marker file written last; a worker restart reuses a complete copy instead of copying
again). Apps that bind 127.0.0.1 inside the container are reached through a small in-container TCP forwarder; each
app/service command runs with `docker exec`, so health checks, log masking and exit handling are unchanged. Secrets
pointing at 127.0.0.1/localhost are rewritten to `host.docker.internal` (the hub's databases on this machine). Port
cleanup never kills Docker's own port proxy (com.docker.backend/wslrelay/vpnkit/docker-proxy). If Docker is not
available the preview fails with a reason; it never falls back to the host. Production refuses host previews unless
`ALLOW_HOST_BUILDS=true`. Residual risk: the preview container uses the bridge network and can reach services on the
host via host.docker.internal (it needs the database); the container is still a shared-kernel boundary.
