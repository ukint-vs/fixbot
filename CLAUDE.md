# fixbot

Self-hosted AI coding agent and daemon for GitHub repositories.
Fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) with daemon automation added.

## Build

```bash
bun install
bun run build:native    # builds Rust native addons (requires Rust toolchain)
```

## Test

```bash
bun test                          # all tests
bun test --cwd packages/fixbot    # fixbot package only
bun test --cwd packages/coding-agent  # coding-agent tests
```

## Run locally

```bash
# Interactive coding agent
bun run packages/coding-agent/src/cli.ts

# Setup wizard
bun run packages/coding-agent/src/cli.ts init

# Daemon
bun run packages/coding-agent/src/cli.ts daemon start --config ~/.fixbot/daemon.config.json --foreground
```

## Project structure

- `packages/coding-agent/` — CLI entry point and interactive coding agent (upstream)
- `packages/fixbot/` — Daemon, runner, job queue, GitHub integration (fixbot-specific)
- `packages/ai/` — Multi-provider LLM client (upstream)
- `packages/agent/` — Agent runtime with tool calling (upstream)
- `packages/tui/` — Terminal UI (upstream)
- `packages/utils/` — Shared utilities (upstream)
- `packages/natives/` — Rust native addons (upstream)

## Package naming

Internal packages use `@oh-my-pi/pi-*` names for upstream sync compatibility.
The fixbot package uses `@fixbot/pi-fixbot`.
Do not rename `@oh-my-pi/` packages — they sync from upstream.

## Key constants

- **Binary name:** `fixbot` — set by `APP_NAME` in `packages/utils/src/dirs.ts`
- **Config directory:** `~/.fixbot/` — set by `CONFIG_DIR_NAME` in same file
- **Project config:** `.fixbot/` directory in any project root

## Upstream sync boundary

Only `packages/fixbot/` is fixbot-specific. Everything else can be synced from
the upstream oh-my-pi repository. The fixbot package depends on the coding-agent
SDK through a single integration point: `packages/fixbot/src/internal-runner.ts`.
