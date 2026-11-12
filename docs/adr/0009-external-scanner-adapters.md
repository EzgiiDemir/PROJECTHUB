# 0009 — External scanners as adapters that report whether they ran

**Status:** accepted

**Context.** The security scan used built-in rules (secrets, code risks, configuration, IaC) and OSV for
dependencies. It never looked at Git history, so a key deleted from the code but still in an earlier commit was
invisible — on 2026-10-13 the imported "form" project had an API key in `backend/.env` that the built-in rules
missed and that Gitleaks found. Mature tools (Gitleaks, Trivy, Semgrep, OSV-Scanner) cover far more rules, but a
missing or failing tool must never turn into a clean result.

**Decision.**
- `packages/core/src/scan/tools.ts`: each adapter returns `{ tool, version, status: ran | unavailable | failed,
  message, results }`. Binaries come from `SCANNER_TOOLS_DIR/<name>/<name>[.exe]` (default: `tools` next to
  `STORAGE_DIR`), else PATH. The worker image installs pinned, checksum-verified binaries.
- First adapter: Gitleaks over the history reachable from the scanned commit (`--log-opts=<commit>`, `--redact`,
  dependency/build folders allowlisted, `GIT_CONFIG_NOSYSTEM=1`). A leak still present in the scanned commit is a
  critical current finding unless the built-in scanner already reported that line; a leak only in history is high
  ("revoke and rotate"). Secret values never reach findings, logs or the API.
- Findings from a tool carry its name as the rule prefix (`gitleaks:<rule>`); no schema change. Auto-resolution
  of disappeared findings skips a tool's findings unless that tool ran in this scan. Whole-history scans run on
  manual/scheduled scans, not on every build.
- The scan summary notes say which tools ran and which did not; the UI shows "not run" notes as warnings.

**Consequences.** New tools are added as further adapters with the same contract (Trivy for IaC/containers and
OSV-Scanner or Semgrep are the next candidates). A history scan of a 4.5 GB repository takes about a minute.
