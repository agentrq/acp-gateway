import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalACPClient, formatUrlElicitation } from "../localClient.js";
import { setVerbose } from "../log.js";

describe("LocalACPClient", () => {
  let errorSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setVerbose(false);
    errorSpy.mockRestore();
  });

  const urlRequest = (elicitationId?: string): any => ({
    mode: "url",
    message: "Enter code ABCD-1234",
    url: "https://example.com/device",
    ...(elicitationId ? { elicitationId } : {}),
  });

  it("puts the URL on a line of its own", () => {
    expect(formatUrlElicitation("Sign in", "https://x/y")).toBe(
      "\n[auth] Sign in\n[auth] Open this URL to continue:\n\n    https://x/y\n",
    );
  });

  it("refuses every permission request, since no task runs here", async () => {
    setVerbose(true);
    const client = new LocalACPClient();

    await expect(
      client.requestPermission({ sessionId: "s", toolCall: { toolCallId: "t", title: "rm -rf" }, options: [] } as any),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(
      client.requestPermission({ sessionId: "s", toolCall: { toolCallId: "t" }, options: [] } as any),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("rm -rf");
  });

  it("takes session updates without acting on them", async () => {
    setVerbose(true);
    const client = new LocalACPClient();

    await client.sessionUpdate({
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    } as any);

    expect(errorSpy).toHaveBeenCalledWith("[acp] Session update: agent_message_chunk");
  });

  it("cancels a form elicitation, which has nobody to fill it in", async () => {
    const client = new LocalACPClient({ promptUrlElicitation: vi.fn() });

    await expect(
      client.createElicitation({ mode: "form", message: "API key?", requestedSchema: {} } as any),
    ).resolves.toEqual({ action: "cancel" });
    expect(errorSpy.mock.calls.flat().join("\n")).toContain('Cannot answer a "form" elicitation');
  });

  it("prints a url elicitation and cancels it when there is no terminal to ask at", async () => {
    const client = new LocalACPClient();

    await expect(client.createElicitation(urlRequest())).resolves.toEqual({ action: "cancel" });
    expect(errorSpy).toHaveBeenCalledWith(
      formatUrlElicitation("Enter code ABCD-1234", "https://example.com/device"),
    );
  });

  it("asks at the terminal and passes the answer back", async () => {
    const prompt = vi.fn().mockResolvedValue({ action: "accept" });
    const client = new LocalACPClient({ promptUrlElicitation: prompt });

    await expect(client.createElicitation(urlRequest("e1"))).resolves.toEqual({ action: "accept" });
    expect(prompt).toHaveBeenCalledWith({
      message: "Enter code ABCD-1234",
      url: "https://example.com/device",
      signal: expect.any(AbortSignal),
    });
  });

  it("asks at the terminal for an elicitation with no id", async () => {
    const prompt = vi.fn().mockResolvedValue({ action: "decline" });
    const client = new LocalACPClient({ promptUrlElicitation: prompt });

    await expect(client.createElicitation(urlRequest())).resolves.toEqual({ action: "decline" });
  });

  it("cancels when the terminal prompt fails", async () => {
    const prompt = vi.fn().mockRejectedValue(new Error("stdin closed"));
    const client = new LocalACPClient({ promptUrlElicitation: prompt });

    await expect(client.createElicitation(urlRequest("e2"))).resolves.toEqual({ action: "cancel" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[auth] Could not ask about the login at this terminal:",
      expect.any(Error),
    );
  });

  it("closes the terminal prompt when the agent finishes the login itself", async () => {
    let signal: AbortSignal | undefined;
    const prompt = vi.fn(({ signal: s }: { signal: AbortSignal }) => {
      signal = s;
      return new Promise<any>((resolve) => s.addEventListener("abort", () => resolve({ action: "accept" })));
    });
    const client = new LocalACPClient({ promptUrlElicitation: prompt as any });

    const answer = client.createElicitation(urlRequest("e3"));
    await client.completeElicitation({ elicitationId: "e3" } as any);

    await expect(answer).resolves.toEqual({ action: "accept" });
    expect(signal?.aborted).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith("[auth] The agent reports this login as finished.");
  });

  it("ignores a completion for an elicitation it is not waiting on", async () => {
    const client = new LocalACPClient();

    await client.completeElicitation({ elicitationId: "unknown" } as any);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("closes any prompt still open when disposed", async () => {
    let signal: AbortSignal | undefined;
    const prompt = vi.fn(({ signal: s }: { signal: AbortSignal }) => {
      signal = s;
      return new Promise<any>((resolve) => s.addEventListener("abort", () => resolve({ action: "cancel" })));
    });
    const client = new LocalACPClient({ promptUrlElicitation: prompt as any });

    const answer = client.createElicitation(urlRequest("e4"));
    client.dispose();

    await expect(answer).resolves.toEqual({ action: "cancel" });
    expect(signal?.aborted).toBe(true);
  });
});
