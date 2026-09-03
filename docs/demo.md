# End-to-End Demo: Using `acp-gateway` with `agentrq` & `antigravity-acp`

This guide demonstrates how `@agentrq/acp-gateway` bridges an **agentrq** workspace with Google's **Antigravity ACP** agent to autonomously solve software development tasks.

---

## 1. Architecture Overview

```
 ┌──────────────────────┐         ACP (JSON-RPC)         ┌──────────────────────┐
 │   antigravity-acp    │ ◄────────────────────────────► │     acp-gateway      │
 │ (Gemini Code Assist) │                                │                      │
 └──────────────────────┘                                └──────────┬───────────┘
                                                                    │
                                                           Streamable HTTP MCP
                                                                    │
                                                                    ▼
                                                         ┌──────────────────────┐
                                                         │  agentrq MCP Server  │
                                                         │  (Workspace Engine)  │
                                                         └──────────────────────┘
```

- **`agentrq` MCP Server**: Hosts workspace context, mission goals, queued tasks, tool definitions (`getTask`, `reply`, `updateTaskStatus`, `elicit`), and delivers real-time notifications.
- **`acp-gateway`**: Manages the ACP agent lifecycle, auto-reconnects transports, isolates sessions per task ID, handles ACP permissions, and streams thought / reasoning telemetry.
- **`antigravity-acp`**: Autonomous coding agent capable of inspecting files, executing test suites, running commands, and collaborating with developers through interactive replies.

---

## 2. Setup & Configuration

### A. Configure `.mcp.json`
In the root of your project directory, configure your agentrq MCP endpoint:

```json
{
  "mcpServers": {
    "agentrq": {
      "type": "http",
      "url": "https://agentrq.com/api/v1/workspaces/YOUR_WORKSPACE_ID/mcp"
    }
  }
}
```

### B. Launch `acp-gateway` with `antigravity-acp`
Run `acp-gateway` targeting the `antigravity-acp` registry agent:

```bash
acp-gateway --allow-unverified-agent --agent antigravity-acp
```

The gateway will automatically:
1. Locate and load `.mcp.json`.
2. Connect to the agentrq MCP server.
3. Download/cache the `antigravity-acp` binary distribution.
4. Establish the ACP handshake and start listening for assigned tasks.

---

## 3. End-to-End Task Lifecycle Walkthrough

### Step 1: Task Assignment
A new task is created in AgentRQ and assigned to the agent:
- **Task ID**: `0i8IwMtVHxx`
- **Title**: `demo video`
- **Details**: `create a demo video that use acp-gateway and agentrq to complete a small task usign antigravity-acp`

### Step 2: Task Ingestion & Status Update
`acp-gateway` receives the task via MCP channel notification:
1. Agent immediately updates the task status to `ongoing` via `updateTaskStatus`.
2. Fetches workspace context and mission objectives using `getWorkspace`.
3. Checks out the latest `main` branch and creates a dedicated branch `demo-task-antigravity-0i8IwMtVHxx`.

### Step 3: Collaborative Execution & Progress Updates
Throughout execution, the agent proactively communicates every milestone via `reply`:
- Shares planned steps, files read/modified, and command outputs.
- Runs local verification tests (`npm test`, `npm run typecheck`, `npm run test:coverage`).

### Step 4: Verification & Pull Request
- Verifies 100% test coverage and clean builds.
- Prepares git commit and pull request following the repository's PR guidelines including Task ID tracking.
- Marks task as `completed` via `updateTaskStatus`.

---

## 4. Verification Commands

To verify the test suite and type definitions locally:

```bash
# Typecheck TypeScript source
npm run typecheck

# Run full test suite
npm test

# Run tests with code coverage report
npm run test:coverage
```
