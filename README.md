# @agentrq/acp-gateway

ACP+MCP Bridge brings Experimentation Claude Notification Channels feature to all agents that supports Agent Client Protocol.

> [!WARNING]
> **Pre-Alpha**: This project is in early development. APIs, configurations, and behaviors are subject to change without notice.
>
> **Note**: `claude/notifications` is an experimental feature of Claude Code. `@agentrq/acp-gateway` extends this same capability to any `--acp` compatible agent (e.g., Gemini CLI).

## Overview

`@agentrq/acp-gateway` bridges the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) with the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) to connect ACP-compatible AI agents (e.g., Gemini) to an agentrq MCP server.

It automates task execution by:

1. Loading your workspace's `.mcp.json` configuration.
2. Connecting to the agentrq MCP server.
3. Spawning an ACP-compatible agent subprocess.
4. Bridging MCP notifications (tasks, permission requests) to ACP prompts and vice versa.
5. Providing file read/write capabilities through the ACP protocol.
6. Auto-reconnecting the MCP transport on disconnection.

## Prerequisites

- **Node.js** >= 24
- **npm** or **yarn**
- An [ACP-compatible agent](https://agentclientprotocol.com) (e.g., Gemini CLI)
- An [agentrq](https://agentrq.com/?utm_source=github) workspace with an HTTP MCP server

## Installation

```bash
cd acp-gateway
npm install
```

To use globally:

```bash
npm install -g @agentrq/acp-gateway
```

## Current Version

`0.2.8`

## Usage

### Quick Start

Run `acp-gateway` from your agentrq workspace root (the directory containing `.mcp.json`):

```bash
# From workspace root
acp-gateway -- gemini --acp
```

Or with a custom command:

```bash
acp-gateway -- your-acp-agent --flag1 --flag2
```

### CLI Options

You can specify gateway options before the `--` separator:

- `--max-concurrency` / `--maxConcurrency` `<number>`: Sets the maximum number of concurrent tasks allowed to prompt the ACP agent at once. Defaults to `2`.
- `--agent <registry-id>`: Runs an agent from the ACP registry instead of a command you supply yourself.
- `--list-agents`: Prints every agent in the registry and how each one can run on this machine, then exits.
- `--list-models`: Prints the models supported by the agent, then exits.
- `--model <model-id>`: Selects a specific model for the session.
- `--allow-unverified-agent`: Installs a registry binary that publishes no checksum. Off by default.
- `--registry-url <url>`: Reads a different registry index (for pinning, or for testing).
- `--auth-method <id>`: The authentication method to use when the agent asks for a login. Defaults to picking one automatically.
- `--help` / `-h`: Explains every option, with examples. Also shown when `acp-gateway` is run with nothing to do.
- `--list-auth-methods`: Prints the login methods the agent advertises, then exits.
- `--login [method-id]`: Logs in to the agent, then exits.
- `--logout`: Ends the agent's authenticated state, then exits (only for agents that support logout).

Example:
```bash
acp-gateway --max-concurrency 4 -- gemini --acp
```

### Running an Agent from the Registry

The [ACP registry](https://github.com/agentclientprotocol/registry) lists agents that implement the
protocol, and `acp-gateway` can run one by name — no installing or wiring up by hand:

```bash
acp-gateway --list-agents          # see what's published
acp-gateway --agent gemini         # run one
```

Registry entries are distributed in three ways, and the gateway prefers them in this order:

| Distribution | How it runs | Downloads anything? |
|---|---|---|
| `npx` | `npx -y <package> <args>` | No — npm fetches and verifies the package |
| `uvx` | `uvx <package> <args>` | No — uv fetches and verifies the package |
| `binary` | Archive is downloaded, checked, unpacked and cached | Yes |

Package distributions come first because npm and PyPI verify what they serve. A binary is only used
when it is the agent's only distribution.

**Binaries are verified before they run.** The registry's `sha256` for the archive is optional, and
roughly half of the published binary targets omit it. Where there is no checksum the gateway refuses
to install rather than run something it cannot vouch for:

```
The ACP registry publishes no sha256 for "antigravity-acp" on this platform, so the download
cannot be verified. Re-run with --allow-unverified-agent to install it anyway, or install the
agent yourself and pass it after --.
```

Downloads are cached per agent, version and platform, so each build is fetched once:

| Platform | Cache location |
|---|---|
| macOS / Linux | `$XDG_CACHE_HOME/acp-gateway/agents`, else `~/.cache/acp-gateway/agents` |
| Windows | `%LOCALAPPDATA%\acp-gateway\agents` |

All six platforms the registry publishes for are supported — macOS, Linux and Windows on both x86_64
and arm64. Archives are unpacked with the system's own `tar` (and `unzip` for zips on Linux, whose
`tar` cannot read them), so no archive libraries are added as dependencies.

### Authentication

Agents that require a login advertise their login methods during the ACP handshake, and refuse to open a
session until one has been used. `acp-gateway` handles that the same way an editor such as Zed does.

List what an agent offers:

```bash
acp-gateway --list-auth-methods -- gemini --acp
```

Log in ahead of time — with no method id, you are asked to pick one:

```bash
acp-gateway --login -- gemini --acp
acp-gateway --login oauth-personal -- gemini --acp   # or name the method directly
```

Log out again:

```bash
acp-gateway --logout -- gemini --acp
```

Nothing has to be done up front, though: if an agent refuses the first session because it needs a login,
`acp-gateway` logs in and retries by itself.

There are two kinds of method:

- **Agent** methods — the agent runs the login itself (a browser flow, an API key it already holds). These
  need nobody present, so they are chosen first and work in an unattended gateway.
- **Terminal** methods — the agent's own binary is re-run interactively so you can log in at a TUI.
  `acp-gateway` only offers to run these when it has a real terminal to hand over.

Credentials are never stored by the gateway; the agent keeps its own, exactly as it does under an editor.

### Configuration

`acp-gateway` searches for `.mcp.json` starting in the current working directory and up to 3 parent directories.

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "agentrq": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

`acp-gateway` prefers servers with `agentrq` in the name; it falls back to the first HTTP server with a `url`.

## How It Works

```
┌─────────────┐       ACP (JSON-RPC)       ┌──────────────────┐
│  ACP Agent  │ ◄─────────────────────────► │                  │
│  (Gemini)   │                               │   acp-gateway    │
└─────────────┘                               │                  │
                                              │  MCP Bridge      │
                                              │                  │
┌─────────────────────────────────────────────┤                  │
│                                             │                  │
│                                             │                  │
│                                             ▼                  │
│                              ┌──────────────────────────┐     │
│                              │  agentrq MCP Server      │     │
│                              │  (HTTP / StreamableHTTP) │     │
│                              └──────────────────────────┘     │
└────────────────────────────────────────────────────────────────┘
```

### Flow

1. **Config Loading** — Reads `.mcp.json` to find the agentrq MCP server.
2. **MCP Connection** — Establishes a `StreamableHTTPClientTransport` to the MCP server with automatic retry and reconnection.
3. **Agent Spawning** — Launches the specified ACP agent as a subprocess with stdio piping.
4. **ACP Handshake** — Initializes the ACP connection.
5. **Task Bridge & Multi-Session Isolation** — When a task is received from the MCP server:
    - `acp-gateway` extracts the `chat_id` (Task ID).
    - It checks if the task content is a duplicate of the last processed task for this Task ID. If it is repetitive, the task is dropped to prevent redundant processing.
    - If not repetitive, the task is added to a concurrency-limiting queue (honoring the `--max-concurrency` limit).
    - It ensures a dedicated ACP session for that specific task.
    - If the task belongs to a different session than the current one, a new ACP session is initialized, providing clean state isolation between concurrent or sequential tasks.
6. **Permission Bridge** — Permission requests from the ACP agent are forwarded to the MCP server; verdicts are sent back.
7. **Recursive Execution** — After each task completes, `acp-gateway` checks for the next pending task automatically.

### Key Components

| File | Description |
|---|---|
| `src/index.ts` | Entry point; orchestrates config loading, MCP connection, agent spawning, and ACP session lifecycle. |
| `src/acpClient.ts` | Implements the ACP `Client` interface — routes permission requests, handles session updates, and provides file operations. |
| `src/mcpClient.ts` | `EventEmitter`-based MCP client with auto-reconnection, notification handling, and tool call dispatch. |
| `src/config.ts` | Parses `.mcp.json` from the current directory tree up to 3 levels deep. |
| `src/auth.ts` | ACP authentication — lists the agent's login methods, detects `auth_required`, and runs agent or terminal logins. |
| `src/registry.ts` | Reads the ACP registry index — agent lookup, host platform matching, and package launch commands. |
| `src/agentInstall.ts` | Downloads, verifies, unpacks and caches a registry agent's binary distribution. |

## Development

### Scripts

```bash
# Run in development mode
npm run dev

# Type-check
npm run typecheck

# Run tests
npm test
```

### Project Structure

```
acp-gateway/
├── src/
│   ├── acpClient.ts      # ACP Client implementation
│   ├── agentInstall.ts    # Registry binary download / verify / cache
│   ├── auth.ts            # ACP authentication (login / logout)
│   ├── config.ts          # .mcp.json loader
│   ├── index.ts           # Entry point & orchestrator
│   ├── mcpClient.ts       # MCP Bridge with auto-reconnect
│   ├── registry.ts        # ACP registry index client
│   ├── telemetry.ts       # Thought / plan / usage rendering
│   └── __tests__/         # Unit tests
├── package.json
└── tsconfig.json
```

### Architecture Notes

- **Auto-reconnection**: The MCP transport auto-reconnects on disconnection with exponential backoff (1s → 30s max).
- **Notification-driven tasks**: The MCP server pushes task content via `notifications/claude/channel`; `acp-gateway` reacts immediately.
- **Permission flow**: ACP agent requests permission → `acp-gateway` forwards to MCP server → waits for verdict → resolves the ACP permission.
- **Streaming telemetry**: Reasoning, execution plans and token/cost counters are forwarded on `notifications/claude/channel/telemetry`. Reasoning is batched into one block per boundary (the agent starts answering, calls a tool, or revises its plan) rather than one message per token; plans go out as they change; only the last usage snapshot of a turn is reported. Sends are queued off the ACP stream, so a workspace that is slow or unreachable never stalls the agent.
- **Registry agents**: `--agent <id>` resolves through the registry index; package distributions are preferred over binaries, and a binary without a published `sha256` is refused unless explicitly allowed.
- **Authentication**: Login methods come from the `initialize` handshake; an `auth_required` refusal triggers a login and one retry of `newSession`.
- **File I/O**: `readTextFile` / `writeTextFile` are proxied directly to the filesystem; paths are resolved relative to `process.cwd()`.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add: amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Contributing License

By contributing to this project, you agree that your contributions will be licensed under the project's Apache License 2.0.

---

## License

Apache License 2.0

Copyright (c) 2026 Contextual, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
