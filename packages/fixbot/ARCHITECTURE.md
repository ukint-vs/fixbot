# fixbot Architecture

## Overview

fixbot is a self-hosted AI coding daemon that watches GitHub repositories, picks up labeled issues, and opens PRs with fixes. It is built on top of [oh-my-pi](https://github.com/can1357/oh-my-pi), an interactive coding agent engine.

## Relationship to oh-my-pi

The oh-my-pi codebase provides the coding agent engine:

- `packages/ai/` -- Multi-provider LLM client
- `packages/agent/` -- Agent runtime with tool calling
- `packages/coding-agent/` -- CLI application and SDK
- `packages/tui/` -- Terminal UI
- `packages/natives/` -- Rust native addons
- `packages/utils/` -- Shared utilities

fixbot adds daemon/automation on top:

- `packages/fixbot/` -- Daemon, runner, job queue, GitHub integration

## SDK Boundary

The fixbot package depends on the oh-my-pi SDK through a single integration point:

```
  packages/fixbot/src/internal-runner.ts
       |
       | imports only from @fixbot/pi-coding-agent (public SDK)
       |
       v
  createAgentSession()   -- the ONLY coupling to oh-my-pi internals
```

This is intentional. By using only the public `createAgentSession()` API, upstream syncs stay clean -- when oh-my-pi evolves, we update the upstream packages and fixbot's integration point stays the same.

**Do not** import internal oh-my-pi classes or modules from fixbot. Use only the public exports from `@fixbot/pi-coding-agent`.

## Job Worker Model

Each fixbot daemon job spawns an oh-my-pi coding agent session as its worker:

```
  ┌─────────────────────────────────────────────────┐
  │  createAgentSession() from @fixbot/pi-coding-agent  │
  │                                                 │
  │  skills: discovered oh-my-pi + fixbot task skill │
  │  contextFiles: [injected job context]           │
  │  disableExtensionDiscovery: true                │
  │  enableMCP: false                               │
  │  enableLsp: false                               │
  │  sessionManager: SessionManager.inMemory()      │
  │  settings: Settings.isolated()                  │
  │  model: pre-selected from execution plan        │
  │                                                 │
  │  Full oh-my-pi tool suite:                      │
  │  bash, read, edit, write, grep, find, etc.      │
  └─────────────────────────────────────────────────┘
```

The agent session is the same engine that powers the interactive TUI, but configured for headless automation:

- All discovered oh-my-pi skills plus a bundled fixbot task skill
- No extensions, MCP, or LSP
- In-memory session and settings (no persistence)
- Read-only GitHub access via a gh wrapper
- Constrained to a single repo clone

## Execution Flow

```
  Daemon (service.ts)
       |
       v
  Runner (runner.ts)
       |  - clones target repo
       |  - selects model from job spec
       |  - generates execution plan
       v
  Execution (execution.ts)
       |  - spawns child process or Docker container
       |  - passes execution plan as file
       v
  Internal Runner (internal-runner.ts)
       |  - loads bundled skill via loadSkillsFromDir()
       |  - reads injected context file
       |  - creates oh-my-pi agent session
       |  - prompts session with skill invocation
       |  - streams trace to JSONL file
       v
  Parse FIXBOT_RESULT markers from output
       |
       v
  Runner collects git diff, produces job result
```

## Package Structure

```
packages/fixbot/
  src/
    daemon/          -- daemon lifecycle, job store, GitHub polling
    commands/        -- CLI command handlers
    setup/           -- interactive setup wizard
    skills/          -- bundled SKILL.md files per task class
      fix-ci/
      fix-lint/
      fix-tests/
      fix-cve/
      solve-issue/
    internal-runner.ts  -- SDK integration point (createAgentSession)
    runner.ts           -- job orchestration
    execution.ts        -- process/Docker spawning
    host-agent.ts       -- model resolution, auth discovery
    contracts.ts        -- job spec validation
    config.ts           -- daemon configuration
    markers.ts          -- FIXBOT_RESULT marker parsing
    types.ts            -- shared type definitions
```
