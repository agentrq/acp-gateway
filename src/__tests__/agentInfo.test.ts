import { describe, it, expect, vi } from "vitest";
import {
  AGENT_NOTIFICATION_METHOD,
  agentIdentity,
  describeAgentInfo,
  sendAgentIdentity,
} from "../agentInfo.js";

/** A minimal initialize response, with only what a test cares about set. */
function initResult(overrides: Record<string, unknown> = {}): any {
  return { protocolVersion: 1, ...overrides };
}

describe("describeAgentInfo", () => {
  it("should name the agent as it named itself", () => {
    const text = describeAgentInfo(
      initResult({
        agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.2.3" },
      }),
      "some-binary --acp",
    );

    expect(text.split("\n")[0]).toBe("antigravity-acp — Google Antigravity 1.2.3");
  });

  it("should not repeat a title that only restates the name", () => {
    const text = describeAgentInfo(
      initResult({ agentInfo: { name: "gemini", title: "gemini" } }),
      "gemini --acp",
    );

    expect(text.split("\n")[0]).toBe("gemini");
  });

  it("should fall back to how the agent was launched when it names no name", () => {
    expect(describeAgentInfo(initResult(), "gemini --acp").split("\n")[0]).toBe("gemini --acp");
    expect(
      describeAgentInfo(initResult({ agentInfo: { version: "1.0" } }), "gemini --acp").split(
        "\n",
      )[0],
    ).toBe("gemini --acp");
  });

  it("should report the protocol version the agent negotiated", () => {
    expect(describeAgentInfo(initResult({ protocolVersion: 2 }), "x")).toContain(
      "ACP protocol version 2",
    );
  });

  it("should read a capability supplied as {} as supported", () => {
    const text = describeAgentInfo(
      initResult({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
      }),
      "x",
    );

    expect(text).toContain("session/load    yes");
    expect(text).toContain("session/list    yes");
    expect(text).toContain("session/resume  yes");
    // Absent, null and false all mean the agent does not support it.
    expect(text).toContain("session/close   no");
    expect(text).toContain("session/fork    no");
  });

  it("should treat an explicitly false or null capability as unsupported", () => {
    const text = describeAgentInfo(
      initResult({
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { resume: null },
          promptCapabilities: { image: false, audio: true, embeddedContext: true },
        },
      }),
      "x",
    );

    expect(text).toContain("session/load    no");
    expect(text).toContain("session/resume  no");
    expect(text).toContain("image             no");
    expect(text).toContain("audio             yes");
    expect(text).toContain("embedded context  yes");
  });

  it("should report every MCP transport, including the unstable acp one", () => {
    const text = describeAgentInfo(
      initResult({ agentCapabilities: { mcpCapabilities: { http: true, sse: true } } }),
      "x",
    );

    expect(text).toContain("http  yes");
    expect(text).toContain("sse   yes");
    expect(text).toContain("acp   no");
  });

  it("should list the login methods alongside logout support", () => {
    const text = describeAgentInfo(
      initResult({
        agentCapabilities: { auth: { logout: {} } },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      }),
      "x",
    );

    expect(text).toContain("logout  yes");
    expect(text).toContain("Log in with Google (oauth-personal)");
  });

  it("should say plainly when an agent needs no login at all", () => {
    const text = describeAgentInfo(initResult(), "x");

    expect(text).toContain("logout  no");
    expect(text).toContain("no authentication methods");
  });

  it("should describe an agent that reports no capabilities at all", () => {
    const text = describeAgentInfo(initResult({ agentCapabilities: null }), "x");

    expect(text).toContain("session/load    no");
    expect(text).toContain("image             no");
    expect(text).toContain("http  no");
  });
});

describe('agentIdentity', () => {
  it("takes the agent's own name for itself", () => {
    expect(
      agentIdentity({ agentInfo: { name: 'codex', title: 'Codex CLI', version: '1.10.0' } } as any, 'npx codex-acp')
    ).toEqual({ name: 'codex', title: 'Codex CLI', version: '1.10.0' })
  })

  it('drops a title that merely repeats the name', () => {
    // So a caller rendering both does not print the same word twice.
    expect(agentIdentity({ agentInfo: { name: 'codex', title: 'codex' } } as any, 'x')).toEqual({
      name: 'codex',
    })
  })

  it('falls back to how the agent was launched when it says nothing', () => {
    // ACP leaves agentInfo optional. The launch command is the only name
    // available, and it is better than none.
    expect(agentIdentity({} as any, 'npx some-acp-agent')).toEqual({ name: 'npx some-acp-agent' })
    expect(agentIdentity({ agentInfo: {} } as any, 'launched-as')).toEqual({ name: 'launched-as' })
    expect(agentIdentity({ agentInfo: { name: '   ' } } as any, 'launched-as')).toEqual({
      name: 'launched-as',
    })
  })

  it('leaves out the parts the agent did not give', () => {
    expect(agentIdentity({ agentInfo: { name: 'gemini' } } as any, 'x')).toEqual({ name: 'gemini' })
    expect(
      agentIdentity({ agentInfo: { name: 'gemini', title: '  ', version: '  ' } } as any, 'x')
    ).toEqual({ name: 'gemini' })
  })

  it('publishes the channel the workspace listens on', () => {
    expect(AGENT_NOTIFICATION_METHOD).toBe('notifications/claude/channel/agent')
  })
})

describe('sendAgentIdentity', () => {
  const bridge = () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) });

  it('names the agent with no task and no session, which is how startup sends it', async () => {
    // The workspace keys this to the connection it arrived on, so neither id is
    // needed — and requiring one is what would keep a workspace ignorant of its
    // agent until somebody gave it work.
    const b = bridge();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendAgentIdentity(b as any, { name: 'Google Antigravity', version: '1.1.1' });

    expect(b.sendNotification).toHaveBeenCalledWith('notifications/claude/channel/agent', {
      task_id: '',
      session_id: '',
      name: 'Google Antigravity',
      title: undefined,
      version: '1.1.1',
    });
    quiet.mockRestore();
  });

  it('never throws, so a workspace that cannot take it costs the agent nothing', async () => {
    const b = { sendNotification: vi.fn().mockRejectedValue(new Error('unreachable')) };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendAgentIdentity(b as any, { name: 'codex' })).resolves.toBeUndefined();

    expect(quiet).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send agent notification:'),
      expect.anything(),
    );
    quiet.mockRestore();
  });
})
