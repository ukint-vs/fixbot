# TODOs

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
