# fixbot

**Self-hosted AI coding agent and daemon for GitHub**

[github.com/ukint-vs/fixbot](https://github.com/ukint-vs/fixbot)

Fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) by [@mariozechner](https://github.com/mariozechner) and [@can1357](https://github.com/can1357)

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Daemon](#daemon)
  - [Commands](#daemon-commands)
  - [Running a Single Job](#running-a-single-job)
  - [Configuration](#daemon-configuration)
  - [Workflow](#daemon-workflow)
  - [How Workers Work](#how-workers-work)
- [Interactive Mode](#interactive-mode)
  - [Slash Commands](#slash-commands)
  - [Editor Features](#editor-features)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Bash Mode](#bash-mode)
  - [Image Support](#image-support)
- [Sessions](#sessions)
  - [Session Management](#session-management)
  - [Context Compaction](#context-compaction)
  - [Branching](#branching)
  - [Autonomous Memory](#autonomous-memory)
- [CLI Reference](#cli-reference)
  - [Subcommands](#subcommands)
  - [Options](#options)
  - [File Arguments](#file-arguments)
  - [Environment Variables](#environment-variables)
- [Configuration](#configuration)
  - [Project Context Files](#project-context-files)
  - [Custom System Prompt](#custom-system-prompt)
  - [Custom Models and Providers](#custom-models-and-providers)
  - [Settings File](#settings-file)
- [Extensions](#extensions)
  - [Themes](#themes)
  - [Custom Slash Commands](#custom-slash-commands)
  - [Skills](#skills)
  - [Hooks](#hooks)
  - [Custom Tools](#custom-tools)
- [Programmatic Usage](#programmatic-usage)
  - [SDK](#sdk)
  - [RPC Mode](#rpc-mode)
  - [HTML Export](#html-export)
- [Monorepo Packages](#monorepo-packages)
- [License](#license)

---

## Installation

### From source (recommended)

Requires [Bun](https://bun.sh) >= 1.3.7:

```bash
git clone https://github.com/ukint-vs/fixbot.git
cd fixbot
bun install
bun link --cwd packages/coding-agent
```

### Via installer script

Requires a GitHub release to be published.

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.ps1 | iex
```

Options:

- POSIX (`install.sh`): `--source`, `--binary`, `--ref <ref>`, `-r <ref>`
- PowerShell (`install.ps1`): `-Source`, `-Binary`, `-Ref <ref>`
- `--ref`/`-Ref` with binary mode must reference a release tag; branch/commit refs require source mode

Set custom install directory with `PI_INSTALL_DIR`.

---

## Quick Start

```bash
fixbot init
```

The interactive setup wizard walks you through:

1. **AI provider** -- configure API keys or OAuth login for your preferred provider (Anthropic, OpenAI, Google, etc.)
2. **GitHub token** -- personal access token for repo access and PR creation
3. **Repos to watch** -- select which repositories the daemon should monitor

After setup, launch the daemon with `fixbot daemon start` or drop into the interactive TUI with `fixbot`.

---

## Daemon

The fixbot daemon is a self-hosted service that watches your GitHub repositories for labeled issues and automatically opens pull requests with fixes.

### Daemon Commands

```bash
fixbot daemon start     # Start the daemon (foreground)
fixbot daemon stop      # Stop a running daemon
fixbot daemon status    # Show daemon status
fixbot daemon health    # Health check
fixbot daemon enqueue   # Manually enqueue a job
```

### Running a Single Job

Run a one-off job without starting the daemon:

```bash
fixbot run job.json
```

Validate a job specification before running:

```bash
fixbot validate-job job.json
```

### Daemon Configuration

The daemon reads its configuration from `~/.fixbot/daemon.yml` (or `PI_CONFIG_DIR`). Key sections:

```yaml
version: 1

paths:
  workDir: ~/.fixbot/work
  logsDir: ~/.fixbot/logs

github:
  repos:
    - owner: your-org
      name: your-repo
      triggerLabel: fixbot
      branches:
        - main

runtime:
  model: anthropic/claude-sonnet-4-20250514
  maxConcurrentJobs: 2
  timeoutMinutes: 30
```

### Daemon Workflow

1. Add the trigger label (e.g. `fixbot`) to a GitHub issue
2. The daemon picks up the issue and creates a job
3. An AI coding agent session works on the fix in a fresh clone
4. The daemon opens a PR with the proposed changes
5. Review and merge as usual

### How Workers Work

Each daemon job is executed by an **oh-my-pi coding agent session** -- the same engine that powers the interactive TUI. The daemon creates an isolated session per job using the SDK's `createAgentSession()`:

- Full tool suite (bash, read, edit, write, grep, find)
- All discovered skills (from host agent dir and project)
- Bundled fixbot task skill per task class (fix-ci, fix-lint, etc.)
- Injected job context (repo URL, issue details, constraints)
- Read-only GitHub access (no push/PR from within the agent)
- In-memory session (no state persistence between jobs)
- Extensions, MCP, and LSP disabled for reproducibility

The agent works in a fresh clone of the target repository, constrained to a single task with no user input.

```
  Daemon (service.ts)
       |
       v
  Runner (runner.ts)          --- clones repo, selects model
       |
       v
  Execution (execution.ts)    --- spawns child process or docker
       |
       v
  Internal Runner             --- creates agent session
       |
       v
  createAgentSession()        --- single SDK integration point
       |
       v
  session.prompt(skill)       --- agent executes the task
       |
       v
  Parse FIXBOT_RESULT markers --- extract results from output
```

---

## Interactive Mode

Launch the interactive coding agent TUI:

```bash
fixbot
```

This is a full-featured terminal coding agent with model role switching, session branching, subagents, LSP integration, and more. All features from the upstream oh-my-pi project are available.

### Slash Commands

In-chat commands (not CLI subcommands):

| Command | Description |
| ------- | ----------- |
| `/settings` | Open settings menu |
| `/plan` | Toggle plan mode |
| `/model` (`/models`) | Open model selector |
| `/export [path]` | Export session to HTML |
| `/dump` | Copy session transcript to clipboard |
| `/share` | Upload session as a secret gist |
| `/session` | Show session info and usage |
| `/usage` | Show provider usage and limits |
| `/hotkeys` | Show keyboard shortcuts |
| `/extensions` (`/status`) | Open Extension Control Center |
| `/changelog` | Show changelog entries |
| `/tree` | Navigate session tree |
| `/branch` | Open branch selector |
| `/fork` | Fork from a previous message |
| `/resume` | Open session picker |
| `/new` | Start a new session |
| `/compact [focus]` | Compact context manually |
| `/handoff [focus]` | Hand off context to a new session |
| `/browser [headless\|visible]` | Toggle browser mode |
| `/mcp ...` | Manage MCP servers |
| `/memory ...` | Inspect/clear/rebuild memory state |
| `/move <path>` | Move current session to a different cwd |
| `/background` (`/bg`) | Detach UI and continue in background |
| `/debug` | Open debug tools |
| `/copy` | Copy last agent message |
| `/login` / `/logout` | OAuth login/logout |
| `/review` | Interactive code review |
| `/exit` (`/quit`) | Exit interactive mode |

### Editor Features

**File reference (`@`):** Type `@` to fuzzy-search project files. Respects `.gitignore`.

**Path completion (Tab):** Complete relative paths, `../`, `~/`, etc.

**Drag & drop:** Drag files from your file manager into the terminal.

**Multi-line paste:** Pasted content is collapsed in preview but sent in full.

**Message queuing:** Submit messages while the agent is working; queue behavior is configurable in `/settings`.

### Keyboard Shortcuts

**Navigation:**

| Key | Action |
| --- | ------ |
| Arrow keys | Move cursor / browse history (Up when empty) |
| Option+Left/Right | Move by word |
| Ctrl+A / Home / Cmd+Left | Start of line |
| Ctrl+E / End / Cmd+Right | End of line |

**Editing:**

| Key | Action |
| --- | ------ |
| Enter | Send message |
| Shift+Enter / Alt+Enter | New line |
| Ctrl+W / Option+Backspace | Delete word backwards |
| Ctrl+U | Delete to start of line |
| Ctrl+K | Delete to end of line |

**Other:**

| Key | Action |
| --- | ------ |
| Tab | Path completion / accept autocomplete |
| Escape | Cancel autocomplete / abort streaming |
| Ctrl+C | Clear editor (first) / exit (second) |
| Ctrl+D | Exit (when editor is empty) |
| Ctrl+Z | Suspend to background (`fg` to resume) |
| Shift+Tab | Cycle thinking level |
| Ctrl+P / Shift+Ctrl+P | Cycle role models (slow/default/smol) |
| Alt+P | Select model temporarily |
| Ctrl+L | Open model selector |
| Alt+Shift+P | Toggle plan mode |
| Ctrl+R | Search prompt history |
| Ctrl+O | Toggle tool output expansion |
| Ctrl+T | Toggle todo list expansion |
| Ctrl+G | Edit message in external editor (`$VISUAL` or `$EDITOR`) |
| Alt+H | Toggle speech-to-text recording |

### Bash Mode

Prefix commands with `!` to execute them and include output in context:

```bash
!git status
!ls -la
```

Use `!!` to execute but exclude output from LLM context:

```bash
!!git status
```

### Image Support

Attach images by reference:

```text
What's in @/path/to/image.png?
```

Or paste/drop images directly (`Ctrl+V` or drag-and-drop).

Supported formats: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

---

## Sessions

Sessions are stored as JSONL with a tree structure for branching and replay.

### Session Management

Sessions auto-save to `~/.fixbot/agent/sessions/` (grouped by working directory).

```bash
fixbot --continue             # Continue most recent session
fixbot -c

fixbot --resume               # Open session picker
fixbot -r

fixbot --resume <id-prefix>   # Resume by session ID prefix
fixbot --resume <path>        # Resume by explicit .jsonl path
fixbot --session <value>      # Alias of --resume
fixbot --no-session           # Ephemeral mode (don't save)
```

### Context Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent context.

**Manual:** `/compact` or `/compact Focus on the API changes`

**Automatic:** Enable via `/settings`.

**Configuration** (`~/.fixbot/agent/config.yml`):

```yaml
compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000
  autoContinue: true
```

### Branching

**In-place navigation (`/tree`):** Navigate the session tree without creating new files.

**Create new session (`/branch` / `/fork`):** Branch to a new session file from a selected previous message.

### Autonomous Memory

When enabled, the agent extracts durable knowledge from past sessions and injects it at startup. Memory is isolated per project and stored under `~/.fixbot/agent/memories/`.

Manage via `/memory`:

- `/memory view` -- show current injection payload
- `/memory clear` -- delete all memory data
- `/memory enqueue` -- force consolidation at next startup

---

## CLI Reference

```bash
fixbot [options] [@files...] [messages...]
fixbot <command> [args] [flags]
```

### Subcommands

| Command | Description |
| ------- | ----------- |
| `fixbot init` | Interactive setup wizard |
| `fixbot daemon start\|stop\|status\|health\|enqueue` | Daemon management |
| `fixbot run <job.json>` | Run a single job |
| `fixbot validate-job <job.json>` | Validate a job spec |
| `fixbot commit` | AI-powered git commit |
| `fixbot config` | Manage settings from CLI |
| `fixbot grep` | Search file content |
| `fixbot jupyter` | Jupyter kernel management |
| `fixbot login` / `fixbot logout` | OAuth login/logout |
| `fixbot plugin` | Plugin management |
| `fixbot search` (alias: `q`) | Search |
| `fixbot setup` | Install optional dependencies |
| `fixbot shell` | Shell utilities |
| `fixbot ssh` | SSH host management |
| `fixbot stats` | Usage statistics dashboard |
| `fixbot update` | Update fixbot |

### Options

| Option | Description |
| ------ | ----------- |
| `--provider <name>` | Provider hint (legacy; prefer `--model`) |
| `--model <id>` | Model ID (supports fuzzy match) |
| `--smol <id>` | Override the `smol` role model |
| `--slow <id>` | Override the `slow` role model |
| `--plan <id>` | Override the `plan` role model |
| `--models <patterns>` | Comma-separated model patterns for role cycling |
| `--list-models [pattern]` | List available models |
| `--thinking <level>` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--api-key <key>` | API key (overrides environment/provider lookup) |
| `--system-prompt <text\|file>` | Replace system prompt |
| `--append-system-prompt <text\|file>` | Append to system prompt |
| `--mode <mode>` | Output mode: `text`, `json`, `rpc` |
| `--print`, `-p` | Non-interactive: process prompt and exit |
| `--continue`, `-c` | Continue most recent session |
| `--resume`, `-r [id\|path]` | Resume by ID prefix/path (or open picker) |
| `--session <value>` | Alias of `--resume` |
| `--session-dir <dir>` | Directory for session storage and lookup |
| `--no-session` | Don't save session |
| `--tools <tools>` | Restrict to comma-separated built-in tool names |
| `--no-tools` | Disable all built-in tools |
| `--no-lsp` | Disable LSP integration |
| `--no-pty` | Disable PTY-based interactive bash execution |
| `--extension <path>`, `-e` | Load extension file (repeatable) |
| `--hook <path>` | Load hook/extension file (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--no-skills` | Disable skills discovery |
| `--skills <patterns>` | Comma-separated glob patterns to filter skills |
| `--no-rules` | Disable rules discovery |
| `--allow-home` | Allow starting from home dir without auto-chdir |
| `--no-title` | Disable automatic session title generation |
| `--export <file> [output]` | Export session to HTML |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

### File Arguments

Include files with `@` prefix:

```bash
fixbot @prompt.md "Answer this"
fixbot @screenshot.png "What's in this image?"
fixbot @requirements.md @design.png "Implement this"
```

### Environment Variables

| Variable | Description |
| -------- | ----------- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. | Provider credentials |
| `PI_CODING_AGENT_DIR` | Override agent data directory (default: `~/.fixbot/agent`) |
| `PI_PACKAGE_DIR` | Override package directory resolution |
| `PI_CONFIG_DIR` | Override config directory |
| `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL` | Role-model overrides |
| `PI_NO_PTY` | Disable PTY-based bash execution |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Configuration

### Project Context Files

fixbot discovers project context from supported config directories (`.fixbot`, `.claude`, `.codex`, `.gemini`).

Common files:

- `AGENTS.md`
- `CLAUDE.md`

Use these for project instructions, architecture documentation, and coding conventions.

### Custom System Prompt

Replace the default system prompt by creating `SYSTEM.md`:

1. **Project-local:** `.fixbot/SYSTEM.md` (takes precedence)
2. **Global:** `~/.fixbot/agent/SYSTEM.md` (fallback)

`--system-prompt` overrides both files. Use `--append-system-prompt` to append.

### Custom Models and Providers

Add custom providers/models via `~/.fixbot/agent/models.yml`.

```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434/v1
    apiKey: OLLAMA_API_KEY
    api: openai-completions
    models:
      - id: llama-3.1-8b
        name: Llama 3.1 8B (Local)
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 32000
```

Supported APIs: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`

### Settings File

Global settings: `~/.fixbot/agent/config.yml`

Project overrides: `.fixbot/settings.json`

```yaml
theme:
  dark: titanium
  light: light

modelRoles:
  default: anthropic/claude-sonnet-4-20250514
  plan: anthropic/claude-opus-4-1:high
  smol: anthropic/claude-sonnet-4-20250514
defaultThinkingLevel: high

steeringMode: one-at-a-time
followUpMode: one-at-a-time
interruptMode: immediate

compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000

skills:
  enabled: true

retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000

terminal:
  showImages: true
```

---

## Extensions

### Themes

65+ built-in themes including Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, and more.

Automatic dark/light switching via Mode 2031 terminal detection, native macOS CoreFoundation FFI, or `COLORFGBG` fallback.

Select via `/settings` or set in `~/.fixbot/agent/config.yml`:

```yaml
theme:
  dark: titanium
  light: light
```

Custom themes: create `~/.fixbot/agent/themes/*.json`.

### Custom Slash Commands

Define reusable prompt commands as Markdown files:

- Global: `~/.fixbot/agent/commands/*.md`
- Project: `.fixbot/commands/*.md`

```markdown
---
description: Review staged git changes
---

Review the staged changes (`git diff --cached`). Focus on:

- Bugs and logic errors
- Security issues
- Error handling gaps
```

Filename (without `.md`) becomes the command name. Supports `$1`, `$2`, `$@` argument placeholders.

TypeScript custom commands are also supported:

- `~/.fixbot/agent/commands/<name>/index.ts`
- `.fixbot/commands/<name>/index.ts`

### Skills

Skills are capability packages loaded on-demand.

Locations:

- `~/.fixbot/agent/skills/*/SKILL.md`
- `.fixbot/skills/*/SKILL.md`
- `~/.claude/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`
- `~/.codex/skills/*/SKILL.md`, `.codex/skills/*/SKILL.md`

Disable with `fixbot --no-skills` or `skills.enabled: false`.

### Hooks

Hooks are TypeScript modules that subscribe to lifecycle events.

Locations:

- Global: `~/.fixbot/agent/hooks/pre/*.ts`, `~/.fixbot/agent/hooks/post/*.ts`
- Project: `.fixbot/hooks/pre/*.ts`, `.fixbot/hooks/post/*.ts`
- CLI: `--hook <path>`

```typescript
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

export default function (api: HookAPI) {
	api.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && /sudo/.test(event.input.command as string)) {
			const ok = await ctx.ui.confirm("Allow sudo?", event.input.command as string);
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
```

### Custom Tools

Custom tools extend the built-in toolset and are callable by the model.

Locations:

- Global: `~/.fixbot/agent/tools/*/index.ts`
- Project: `.fixbot/tools/*/index.ts`

```typescript
import { Type } from "@sinclair/typebox";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
const factory: CustomToolFactory = () => ({
	name: "greet",
	label: "Greeting",
	description: "Generate a greeting",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params) {
		const { name } = params as { name: string };
		return { content: [{ type: "text", text: `Hello, ${name}!` }] };
	},
});
export default factory;
```

---

## Programmatic Usage

### SDK

For embedding fixbot in Node.js/TypeScript applications:

```typescript
import { ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await session.prompt("What files are in the current directory?");
```

### RPC Mode

For embedding from other languages or process isolation:

```bash
fixbot --mode rpc --no-session
```

Send JSON commands on stdin:

```json
{"id":"req-1","type":"prompt","message":"List all .ts files"}
{"id":"req-2","type":"abort"}
```

### HTML Export

```bash
fixbot --export session.jsonl              # Auto-generated filename
fixbot --export session.jsonl output.html  # Custom filename
```

---

## Monorepo Packages

| Package | Description |
| ------- | ----------- |
| **[@oh-my-pi/pi-ai](packages/ai)** | Multi-provider LLM client with streaming |
| **[@oh-my-pi/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI and SDK |
| **[@oh-my-pi/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@oh-my-pi/pi-natives](packages/natives)** | N-API bindings (grep, shell, image, text, syntax highlighting) |
| **[@oh-my-pi/omp-stats](packages/stats)** | Local observability dashboard for AI usage |
| **[@oh-my-pi/pi-utils](packages/utils)** | Shared utilities (logging, streams, dirs/env helpers) |
| **[@oh-my-pi/swarm-extension](packages/swarm-extension)** | Swarm orchestration extension |
| **[@fixbot/fixbot](packages/fixbot)** ([arch](packages/fixbot/ARCHITECTURE.md)) | Self-hosted AI coding daemon with GitHub integration |

### Rust Crates

| Crate | Description |
| ----- | ----------- |
| **[pi-natives](crates/pi-natives)** | Core Rust native addon |
| **[brush-core-vendored](crates/brush-core-vendored)** | Vendored fork of brush-shell for embedded bash |
| **[brush-builtins-vendored](crates/brush-builtins-vendored)** | Vendored bash builtins |

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Boluk
