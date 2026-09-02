import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPBridge } from "../mcpClient.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const createMockClient = () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  callTool: vi.fn().mockResolvedValue({ result: "ok" }),
  notification: vi.fn().mockResolvedValue(undefined),
  setNotificationHandler: vi.fn(),
});

const createMockTransport = () => ({
  close: vi.fn().mockResolvedValue(undefined),
  onclose: undefined as any,
  onerror: undefined as any,
  _sessionId: "mock-session-id",
});

let lastMockClient: any;
let lastMockTransport: any;

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      lastMockClient = createMockClient();
      return lastMockClient;
    }),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
      lastMockTransport = createMockTransport();
      return lastMockTransport;
    }),
  };
});

describe("MCPBridge", () => {
  const config = {
    name: "agentrq",
    type: "http" as const,
    url: "http://localhost:8080",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    lastMockClient = undefined;
    lastMockTransport = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should initialize without connecting", () => {
    const bridge = new MCPBridge(config);
    expect(bridge).toBeDefined();
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
    expect(Client).not.toHaveBeenCalled();
  });

  it("should throw error if config has no URL", () => {
    expect(() => new MCPBridge({ name: "fail", type: "http" } as any)).toThrow(
      "has no URL",
    );
  });

  describe("connect", () => {
    it("should connect successfully and set up handlers", async () => {
      const bridge = new MCPBridge(config);
      await bridge.connect();

      expect(Client).toHaveBeenCalled();
      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
      expect(lastMockClient.connect).toHaveBeenCalled();
      expect(lastMockClient.setNotificationHandler).toHaveBeenCalledTimes(3);
      expect((bridge as any).isConnected).toBe(true);
    });

    it("should retry on connection failure with exponential backoff", async () => {
      const bridge = new MCPBridge(config);
      
      // We need to mock Client.connect to fail
      (Client as any).mockImplementationOnce(function () {
        lastMockClient = createMockClient();
        lastMockClient.connect.mockRejectedValue(new Error("fail 1"));
        return lastMockClient;
      }).mockImplementationOnce(function () {
        lastMockClient = createMockClient();
        lastMockClient.connect.mockRejectedValue(new Error("fail 2"));
        return lastMockClient;
      }).mockImplementationOnce(function () {
        lastMockClient = createMockClient();
        lastMockClient.connect.mockResolvedValue(undefined);
        return lastMockClient;
      });

      const connectPromise = bridge.connect();

      // First attempt (immediate)
      await vi.advanceTimersByTimeAsync(0);
      expect(Client).toHaveBeenCalledTimes(1);

      // Second attempt (after 1s)
      await vi.advanceTimersByTimeAsync(1000);
      expect(Client).toHaveBeenCalledTimes(2);

      // Third attempt (after 2s)
      await vi.advanceTimersByTimeAsync(2000);
      expect(Client).toHaveBeenCalledTimes(3);

      await connectPromise;
      expect((bridge as any).isConnected).toBe(true);
    });

    it("should cap exponential backoff at 15 minutes", async () => {
      const bridge = new MCPBridge(config);
      
      // Override default mock behavior for this test only
      const clientMock = (Client as any);
      clientMock.mockImplementation(function () {
        lastMockClient = createMockClient();
        lastMockClient.connect.mockRejectedValue(new Error("fail"));
        return lastMockClient;
      });

      const connectPromise = bridge.connect();

      // Skip several attempts to reach near 900s
      // 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024(cap to 900)
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(1000 * Math.pow(2, i));
      }

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      // Advance by 900s (maxDelay)
      await vi.advanceTimersByTimeAsync(900000); 
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Retrying in 900s..."),
      );
      
      consoleSpy.mockRestore();
      await bridge.close();
      
      // Restore default mock behavior for other tests
      clientMock.mockImplementation(function () {
        lastMockClient = createMockClient();
        return lastMockClient;
      });
    });

    it("should initialize transport with correct reconnection options", async () => {
      const bridge = new MCPBridge(config);
      await bridge.connect();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          reconnectionOptions: {
            maxRetries: 100,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 900000,
            reconnectionDelayGrowFactor: 2,
          },
        }),
      );
    });

    it("should handle transport close by reconnecting with a fresh client", async () => {
      const bridge = new MCPBridge(config);
      await bridge.connect();
      const firstClient = lastMockClient;
      const firstTransport = lastMockTransport;

      expect((bridge as any).isConnected).toBe(true);

      // Simulate disconnection
      if (firstTransport.onclose) {
        firstTransport.onclose();
      }

      expect((bridge as any).isConnected).toBe(false);
      expect((bridge as any).isConnecting).toBe(true);

      // Reconnection attempt (after 1s)
      await vi.advanceTimersByTimeAsync(1000);
      
      expect(Client).toHaveBeenCalledTimes(2);
      expect(lastMockClient).not.toBe(firstClient);
      expect((bridge as any).isConnected).toBe(true);
    });
  });

  describe("ensureConnected", () => {
    it("should wait for connection if currently connecting", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnecting = true;

      // Mock isConnected to true after 2s
      setTimeout(() => {
        (bridge as any).isConnected = true;
      }, 2000);

      const ensurePromise = (bridge as any).ensureConnected();

      await vi.advanceTimersByTimeAsync(2500);
      await ensurePromise;
      expect((bridge as any).isConnected).toBe(true);
    });

    it("should throw if connection times out", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnecting = true;

      const expectPromise = expect((bridge as any).ensureConnected()).rejects.toThrow(
        "MCP not connected after 10s timeout",
      );

      await vi.advanceTimersByTimeAsync(11000);
      await expectPromise;
    });
  });

  describe("tool calls and notifications", () => {
    it("should call tools correctly after ensuring connection", async () => {
      const bridge = new MCPBridge(config);
      
      // Start connect but don't finish yet
      const callPromise = bridge.callTool("test-tool", { arg: 1 });
      
      // Advance to trigger _connectOnce and ensureConnected loop
      await vi.advanceTimersByTimeAsync(1000);
      
      const result = await callPromise;
      
      expect(result).toEqual({ result: "ok" });
      expect(lastMockClient.callTool).toHaveBeenCalledWith({
        name: "test-tool",
        arguments: { arg: 1 },
      });
    });

    it("should send notifications correctly after ensuring connection", async () => {
      const bridge = new MCPBridge(config);
      
      const notifyPromise = bridge.sendNotification("test-method", { foo: "bar" });
      
      await vi.advanceTimersByTimeAsync(1000);
      await notifyPromise;
      
      expect(lastMockClient.notification).toHaveBeenCalledWith({
        method: "test-method",
        params: { foo: "bar" },
      });
    });
  });
  it("should announce a reconnection, but not a first connection", async () => {
    const bridge = new MCPBridge(config);
    const reconnected = vi.fn();
    bridge.on("reconnected", reconnected);

    await bridge.connect();
    expect(reconnected).not.toHaveBeenCalled();

    // Losing the connection orphans every permission request in flight, since
    // the workspace routes each verdict to the session it arrived on.
    lastMockTransport.onclose();
    await vi.advanceTimersByTimeAsync(0);

    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  describe("notifications from the workspace", () => {
    /** Runs the handler the bridge registered for one notification method. */
    async function deliver(bridge: MCPBridge, method: string, params: unknown) {
      await bridge.connect();
      const registered = lastMockClient.setNotificationHandler.mock.calls.find(
        ([schema]: any[]) => schema.shape.method.value === method,
      );
      if (!registered) throw new Error(`no handler registered for ${method}`);
      registered[1]({ method, params });
    }

    it("should announce a task the human sent", async () => {
      const bridge = new MCPBridge(config);
      const heard = vi.fn();
      bridge.on("task", heard);

      await deliver(bridge, "notifications/claude/channel", {
        content: "do the thing",
        meta: { chat_id: "T1" },
      });

      expect(heard).toHaveBeenCalledWith({ content: "do the thing", meta: { chat_id: "T1" } });
    });

    it("should announce a permission verdict", async () => {
      const bridge = new MCPBridge(config);
      const heard = vi.fn();
      bridge.on("verdict", heard);

      await deliver(bridge, "notifications/claude/channel/permission", {
        request_id: "req-1",
        behavior: "allow",
      });

      expect(heard).toHaveBeenCalledWith({ requestId: "req-1", behavior: "allow" });
    });

    it("should announce a task the human stopped", async () => {
      const bridge = new MCPBridge(config);
      const heard = vi.fn();
      bridge.on("cancel", heard);

      await deliver(bridge, "notifications/claude/channel/cancel", { task_id: "T1" });

      expect(heard).toHaveBeenCalledWith({ taskId: "T1" });
    });
  });

});
