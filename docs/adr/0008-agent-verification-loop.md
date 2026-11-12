# 0008 — The coding agent verifies its own edits before committing

**Status:** accepted

**Context.** The fix agent (`apps/worker/src/jobs/ai.ts`) edited files in memory and committed them; the only
evidence that a change worked was the verification build that ran *after* the commit. Measured on 2026-10-13 with
the local model: tasks with two bugs were committed with one bug left, small models copied `read_file` line numbers
into files, rewrote whole files for one-line changes (minutes of output tokens on a local model), stopped after
describing a change without making it, and repeated the same search for 30 steps. Code search over a 4.5 GB import
took ~20 s per call because dependencies and build output were searched too.

**Decision.**
- `run_checks` tool (`apps/worker/src/jobs/agent-checks.ts`): a private working copy of the base commit receives the
  agent's pending edits; the project's real install (once), build and test commands run there with the same
  executor, scrubbed environment and network rules as builds (`BUILD_EXECUTOR`, no network after install in
  container mode). The model sees pass/fail, the extracted error and the output tail, and may fix and re-run (at most
  6 runs). Offered only when org policy `runBuilds` is on, the project is not `untrusted` and the manifest has a
  build or test command. The last outcome is written into the task result as evidence, never the model's claim.
- `edit_file` (exact, unique snippet replacement) next to `write_file`; echoed line numbers are stripped from all
  writes (`ai.stripEchoedLineNumbers`).
- The agent loop (`runToolAgent`) answers repeated identical read-only calls without re-running them and stops after
  six repeats; a turn that ends without tools gets two nudges before the task fails.
- Code search uses `git.grep({ sourceOnly: true })`, which skips `NON_SOURCE_DIRS` (imports still keep every file).
- After commit, a failed verification build in install/build/test reprepares the auto-fix once with the build log
  tail in the instruction (`verifyAutofix` self-correction); platform failures (checkout, manifest, artifact,
  undecryptable secrets) never go to the AI.

**Consequences.** Commits from the agent carry real check results; the independent verification build, re-scan and
human or policy approval stay unchanged. A check run costs a workspace export and an install per task (the npm and
Composer caches are shared). The model still cannot run arbitrary commands: only the manifest's commands, under the
build trust gate.
