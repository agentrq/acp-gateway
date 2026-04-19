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

`0.1.13`

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
│   ├── config.ts          # .mcp.json loader
│   ├── index.ts           # Entry point & orchestrator
│   ├── mcpClient.ts       # MCP Bridge with auto-reconnect
│   └── __tests__/         # Unit tests
├── package.json
└── tsconfig.json
```

### Architecture Notes

- **Auto-reconnection**: The MCP transport auto-reconnects on disconnection with exponential backoff (1s → 30s max).
- **Notification-driven tasks**: The MCP server pushes task content via `notifications/claude/channel`; `acp-gateway` reacts immediately.
- **Permission flow**: ACP agent requests permission → `acp-gateway` forwards to MCP server → waits for verdict → resolves the ACP permission.
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
