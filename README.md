# @agentrq/acp-gateway

Agent Client Protocol Gateway to remotely access your agents in AgentRQ.

## Overview

`@agentrq/acp-gateway` connects an [Agent Client Protocol (ACP)](https://agentclientprotocol.com) agent (e.g., Gemini, Codex) to an agentrq workspace. AgentRQ speaks ACP v1 itself; the gateway runs the agent on your machine and pipes its ACP stream to AgentRQ over a WebSocket.

It:

1. Reads your workspace's `.mcp.json` for the AgentRQ server's URL and token.
2. Starts the agent — a command you give, or one from the ACP registry.
3. Pipes the agent's stdio to AgentRQ's `/api/acp/v1` endpoint, line for line, without parsing it.
4. Resumes dropped connections and restarts an agent that dies.

## Prerequisites

- **Node.js** >= 22
- **npm** or **yarn**
- An [ACP-compatible agent](https://agentclientprotocol.com) (e.g., Gemini CLI)
- An [agentrq](https://agentrq.com/?utm_source=github) workspace whose server offers ACP v1 (`/api/acp/v1`)

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

`0.4.1`

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

- `--max-concurrency` / `--maxConcurrency` `<number>`: Sets the maximum number of concurrent tasks allowed to prompt the ACP agent at once. Defaults to `1`, and can be anything from `1` to `64`. This is the limit the gateway starts on; it can be changed while running from the agentrq interface.
- `--agent <registry-id>`: Runs an agent from the ACP registry instead of a command you supply yourself.
- `--list-agents`: Prints every agent in the registry and how each one can run on this machine, then exits.
- `--list-models`: Prints the models supported by the agent, then exits.
- `--model <model-id>`: Selects the model a session starts on. It can be changed while running from the agentrq interface.
- `--effort <level>`: Selects the agent's initial reasoning effort level (e.g. `low`, `medium`, `high`).
- `--allow-unverified-agent`: Installs a registry binary that publishes no checksum. Off by default.
- `--registry-url <url>`: Reads a different registry index (for pinning, or for testing).
- `--mcp-json <path>`: Reads an MCP config in addition to the one found near the working directory, so the gateway can run from outside its workspace. The path is to the file itself and the filename need not be `.mcp.json`; a directory is taken to mean the `.mcp.json` inside it. Where both files define a server under the same name, the one named here wins. A path that cannot be read is an error rather than a quiet fall back to the directory.
- `--auth-method <id>`: The authentication method to use when the agent asks for a login. Defaults to picking one automatically.
- `--verbose`: Prints everything — the connection to AgentRQ, the agent's own logs, and what the one-shot commands exchange with the agent. Without it the gateway only prints warnings and errors; the agent's logs are kept back and shown only if it fails. Commands that print something and exit, like `--list-models`, print just that.
- `--help` / `-h`: Explains every option, with examples. Also shown when `acp-gateway` is run with nothing to do.
- `--list-auth-methods`: Prints the login methods the agent advertises, then exits.
- `--login [method-id]`: Logs in to the agent, then exits.
- `--logout`: Ends the agent's authenticated state, then exits (only for agents that support logout).
- `--acp-url <url>`: The ACP endpoint, for a deployment where it cannot be worked out from `.mcp.json`.
- `--acp-version 1`: Still accepted so existing launch scripts keep working, but it changes nothing: ACP v1 is the only protocol. Any other version is refused.

Example:
```bash
acp-gateway --max-concurrency 4 -- gemini --acp
acp-gateway --mcp-json ~/work/.mcp.json -- gemini --acp
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

Registry binaries run to hundreds of megabytes, so a download reports itself as it goes:

```
[registry] Downloading antigravity-acp 1.0.4 from https://.../agy_acp_server.zip
[registry] antigravity-acp 1.0.4 [███████████░░░░░░░░░░░░░░░░░░░░░] 35% 229.6 MB/656.0 MB 25.5 MB/s
```

The bar redraws one line in place and only appears on a terminal; run under a supervisor, with output
piped to a log, the download stays silent apart from the lines above and below it.

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

Some agent methods sign in through a browser and send it back to a server the agent runs on `127.0.0.1`
(antigravity's Google login does). If you open the link on another computer, its last page will not load,
because `127.0.0.1` there is your own computer. When `acp-gateway` runs in a terminal, it notices that kind of
link and asks for the address the browser ended up on. Paste it, and the gateway sends it to the agent on its
own machine to finish the login.

Credentials are never stored by the gateway; the agent keeps its own, exactly as it does under an editor.

### Configuration

`acp-gateway` searches for `.mcp.json` starting in the current working directory and up to 3 parent directories.

The gateway connects to the AgentRQ server's `/api/acp/v1` endpoint, using its `url` (and `?token=`) or `Authorization: Bearer` header — not to the MCP server itself. Every server in the file, the AgentRQ one included, is also handed to the agent in each session it opens, so it can use them as MCP tools.

`--list-models`, `--agent-info`, `--list-auth-methods`, `--login` and `--logout` only deal with the agent itself, so they never read a workspace config. `--list-models` runs the agent in an empty temporary directory, so the agent does not pick up the workspace's `.mcp.json` and get taken for the workspace's agent.

`--mcp-json <path>` names a config directly, wherever it lives and whatever it is called. It is read *as well as* whatever the search finds, with the named file winning any name collision — so a gateway started from somewhere other than its workspace still connects to the right one.

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "agentrq": {
      "type": "http",
      "url": "https://<workspace>.mcp.agentrq.com/?token=<token>"
    }
  }
}
```

`acp-gateway` prefers servers with `agentrq` in the name; it falls back to the first HTTP server with a `url`.

## How It Works

```
┌─────────────┐   ACP v1 (stdio)   ┌─────────────┐   ACP v1 (WebSocket)   ┌─────────────────────┐
│  ACP Agent  │ ◄────────────────► │ acp-gateway │ ◄────────────────────► │ AgentRQ /api/acp/v1 │
└─────────────┘                    └─────────────┘                        └─────────────────────┘
```

AgentRQ is the ACP client and the gateway translates nothing. It starts the agent (a registry id or the command
after `--`) and moves lines: each line the agent writes becomes one WebSocket text frame to AgentRQ, and each
frame AgentRQ sends becomes one line on the agent's stdin. It reads only the JSON-RPC envelope, for the working
directory and to keep the agent across a new connection (below).

- **Where it connects.** The endpoint is the AgentRQ server's own origin with the path `/api/acp/v1`, over
  `wss://` for an `https://` server and `ws://` for `http://`. The workspace token is the URL's `?token=` or the
  entry's `Authorization: Bearer` header. `--acp-url` names the endpoint outright.
- **The agent gets the workspace's MCP servers.** Every server in `.mcp.json` (and any config named with
  `--mcp-json`) is handed to each session the agent opens — `session/new`, `session/load` and `session/resume` —
  ahead of what AgentRQ offers, so the agent can use them as tools exactly as it did under the MCP bridge. A
  transport the agent says it cannot take is left out; one it says nothing about is passed. Where AgentRQ offers a
  server with the same name as one in `.mcp.json`, the `.mcp.json` one is used.
- **The agent works in this directory.** Sessions always open in the gateway's own working directory: whatever
  directory AgentRQ names in `session/new`, `session/load` or `session/resume` is replaced with it. AgentRQ is told
  the directory in the `X-AgentRQ-Cwd` header, percent-encoded (UTF-8) wherever it is not plain ASCII, since a
  header cannot carry anything else.
- **Before connecting** it sends a plain `GET` with the token, so a problem is named rather than retried for ever:
  an old server without the endpoint (404), a bad token (401/403, with the server's reason), or a proxy that does
  not pass `Upgrade` for `/api/acp/`. Each of these exits 1.
- **Options travel as headers.** `--agent`, `--model`, `--effort`, `--max-concurrency`, `--permission-timeout` and
  `--auth-method` reach AgentRQ in the WebSocket handshake, along with the working directory every session runs in.
  AgentRQ applies them, and can change the concurrency limit and model while running.
- **Dropped connections resume.** The gateway reconnects with backoff (1 s doubling to 60 s), for as long as it
  takes, and AgentRQ keeps the connection for two minutes. Within that time nothing is lost or repeated: each side
  replays what the other had not acknowledged, up to 1,024 frames or 8 MiB.
- **Longer outages keep the agent.** After a server restart, a deploy or an outage past those two minutes, AgentRQ
  starts a new connection, and the same agent process serves it: its `initialize` is answered from the agent's
  first handshake, the turns that were running are cancelled and the agent's unanswered requests are answered as
  abandoned. Each task's conversation carries on: a prompt for a task (recognised by the `[Task <id>]` header
  AgentRQ starts it with) goes to the session that task already had, under whatever id the new connection gave it.
  The agent is identified to AgentRQ by `X-AgentRQ-Agent-Instance`, which stays the same for as long as it runs.
- **A dead agent is restarted** after 2 s, doubling to a minute. After five exits within five minutes the gateway
  gives up and exits 1 with the agent's last output.
- **A login AgentRQ cannot run** (a terminal login) is run here when the gateway has a terminal — a shell, or
  agentrqd's browser terminal: the agent is stopped, logged in, started again, and the gateway reconnects. Without
  a terminal, or when the agent asks again straight after a login, it stops with AgentRQ's instructions.
- **Errors that a retry cannot fix** (an agent that speaks a different ACP version) are printed and exit 1.
- `--login`, `--logout`, `--list-models`, `--list-auth-methods` and `--agent-info` talk to the agent locally and
  exit; they never connect to AgentRQ.

### Key Components

| File | Description |
|---|---|
| `src/index.ts` | Entry point: options, the one-shot commands, and starting the bridge. |
| `src/native.ts` | Runs the agent and pipes its stdio to AgentRQ's WebSocket, with resume, reconnect and respawn. |
| `src/nativeFrames.ts` | The bridge's pure parts: line splitting, control frames, the replay ring, the endpoint and headers. |
| `src/localClient.ts` | The ACP client the one-shot commands use; puts a login URL to the person at the terminal. |
| `src/config.ts` | Parses `.mcp.json` from the current directory tree up to 3 levels deep, plus any config named with `--mcp-json`. |
| `src/auth.ts` | ACP authentication — lists the agent's login methods, detects `auth_required`, and runs agent or terminal logins. |
| `src/registry.ts` | Reads the ACP registry index — agent lookup, host platform matching, and package launch commands. |
| `src/agentInstall.ts` | Downloads, verifies, unpacks and caches a registry agent's binary distribution. |
| `src/progress.ts` | Draws the single-line download progress bar, on a terminal and nowhere else. |

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

### Architecture Notes

- **Registry agents**: `--agent <id>` resolves through the registry index; package distributions are preferred over binaries, and a binary without a published `sha256` is refused unless explicitly allowed.
- **Authentication**: Login methods come from the `initialize` handshake; an `auth_required` refusal triggers a login and one retry of `newSession`.

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
