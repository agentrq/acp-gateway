import { describe, it, expect } from "vitest";
import { describeAgentInfo } from "../agentInfo.js";

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
