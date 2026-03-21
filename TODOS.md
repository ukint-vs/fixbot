# TODOs

## P1: Resume from existing artifacts when reporter fails

**What:** When a job completes successfully (result JSON + workspace with commits exist) but the reporter fails to push/create PR, the daemon should retry the report step instead of re-running the entire agent job from scratch.

**Why:** Agent runs cost money and time (~5 min per job). If the reporter fails (e.g., `git commit` on clean tree, push auth error, API rate limit), the work is already done — just the delivery failed. Re-triggering currently discards the completed work and starts fresh.

**Context:** The runner writes `result.json` and keeps the workspace with the agent's commits. The reporter (`github-reporter.ts`) needs: workspace dir, result JSON, and envelope. On re-trigger, the daemon could detect existing artifacts for the job ID, skip the agent run, and retry only the reporter step. Key check: `result.json` exists + `status: success` + `changedFileCount > 0` + no PR exists for the branch.

**Effort:** M (human: ~6hr / CC: ~30min)

## P2: Set up GitHub Actions release pipeline

**What:** Create CI workflow to build binary artifacts and cut GitHub releases for ukint-vs/fixbot.

**Why:** The install scripts download pre-built binaries from GitHub Releases. Without releases, the binary install path 404s. Source install works but requires Bun.

**Context:** Upstream has CI at `.github/workflows/ci.yml` that builds binaries for linux/darwin x64/arm64. Adapt for ukint-vs/fixbot. Binary names are now `fixbot-{platform}-{arch}` (changed from `omp-`). Native addon names remain `pi_natives.{platform}-{arch}.node`.

**Effort:** M (human: ~4hr / CC: ~20min)
**Depends on:** Rebrand PR landed (binary names must be fixbot-*)

## P3: Rebrand docs/*.md files

**What:** Update 50+ markdown files in `docs/` directory to replace `omp` with `fixbot` and `.omp/` with `.fixbot/`.

**Why:** Internal developer docs still reference the upstream naming. Won't confuse end users but will confuse contributors.

**Context:** Files cover architecture, hooks, extensions, TUI, configuration, etc. Mostly find-and-replace. Check for hardcoded paths in code examples.

**Effort:** M (human: ~2hr / CC: ~15min)
**Depends on:** Rebrand PR landed
