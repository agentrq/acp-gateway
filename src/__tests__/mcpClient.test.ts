import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPBridge } from "../mcpClient.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  callTool: vi.fn().mockResolvedValue({ result: "ok" }),
  notification: vi.fn().mockResolvedValue(undefined),
  setNotificationHandler: vi.fn(),
};

const mockTransport = {
  close: vi.fn().mockResolvedValue(undefined),
  onclose: null as any,
  onerror: null as any,
  _sessionId: "mock-session-id",
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return mockClient;
    }),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
      return mockTransport;
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should initialize with correct config", () => {
    const bridge = new MCPBridge(config);
    expect(bridge).toBeDefined();
    expect(StreamableHTTPClientTransport).toHaveBeenCalled();
    expect(Client).toHaveBeenCalled();
  });

  it("should get session ID from transport", () => {
    const bridge = new MCPBridge(config);
    expect(bridge.getSessionId()).toBe("mock-session-id");
  });

  it("should throw error if config has no URL", () => {
    expect(() => new MCPBridge({ name: "fail", type: "http" } as any)).toThrow(
      "has no URL",
    );
  });

  describe("connect", () => {
    it("should connect successfully and set up handlers", async () => {
      const bridge = new MCPBridge(config);
      const mClient = (bridge as any).client;

      await bridge.connect();

      expect(mClient.connect).toHaveBeenCalled();
      expect(mClient.setNotificationHandler).toHaveBeenCalledTimes(2);
      expect((bridge as any).isConnected).toBe(true);
    });

    it("should retry on connection failure", async () => {
      const bridge = new MCPBridge(config);
      const mClient = (bridge as any).client;

      mClient.connect
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(undefined);

      const connectPromise = bridge.connect();

      await vi.runAllTimersAsync();
      await connectPromise;

      expect(mClient.connect).toHaveBeenCalledTimes(2);
      expect((bridge as any).isConnected).toBe(true);
    });

    it("should handle transport close by reconnecting", async () => {
      const bridge = new MCPBridge(config);
      await bridge.connect();

      const transport = (bridge as any).transport;
      const connectSpy = vi.spyOn(bridge, "connect");

      if (transport.onclose) {
        transport.onclose();
      }

      expect((bridge as any).isConnected).toBe(false);
      expect(connectSpy).toHaveBeenCalled();
    });

    it("should start connection in ensureConnected if not already connecting", async () => {
      const bridge = new MCPBridge(config);
      const connectSpy = vi.spyOn(bridge, "connect");
      
      // Mock connect to immediately set isConnected = true to avoid long wait
      connectSpy.mockImplementation(async () => {
        (bridge as any).isConnected = true;
      });

      await (bridge as any).ensureConnected();
      expect(connectSpy).toHaveBeenCalled();
    });

    it("should handle transport close by reconnecting even if session not previously connected", async () => {
      const bridge = new MCPBridge(config);
      
      // Initial connect
      await bridge.connect();
      expect((bridge as any).isConnected).toBe(true);

      // Now replace the method on the instance
      let resolveReconnect: Function;
      const reconnectPromise = new Promise((resolve) => { resolveReconnect = resolve; });
      (bridge as any)._connectOnce = vi.fn().mockReturnValue(reconnectPromise);

      // Manually trigger onclose
      if (mockTransport.onclose) {
        mockTransport.onclose();
      }
      
      // Ticking to allow onclose to call connect()
      await vi.advanceTimersByTimeAsync(0);
      
      // Reconnection should have been triggered
      expect((bridge as any).isConnecting).toBe(true);
      expect((bridge as any).isConnected).toBe(false);

      // Clean up
      resolveReconnect!();
      await vi.runAllTimersAsync();
    });

    it("should do nothing on transport close if not previously connected", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnected = false;
      const connectSpy = vi.spyOn(bridge, "connect");

      if (mockTransport.onclose) {
        mockTransport.onclose();
      }

      expect(connectSpy).not.toHaveBeenCalled();
    });

    it("should log transport errors", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const bridge = new MCPBridge(config);
      await bridge.connect();

      const transport = (bridge as any).transport;
      if (transport.onerror) {
        transport.onerror(new Error("transport error"));
      }

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Transport error"),
        "transport error",
      );
      consoleSpy.mockRestore();
    });
  });

  describe("notification handlers", () => {
    it("should emit 'task' when channel notification is received", async () => {
      const bridge = new MCPBridge(config);
      const mClient = (bridge as any).client;
      let taskHandler: Function | undefined;

      mClient.setNotificationHandler.mockImplementation(
        (schema: any, handler: Function) => {
          if (mClient.setNotificationHandler.mock.calls.length === 1) {
            taskHandler = handler;
          }
        },
      );

      await bridge.connect();

      const emitSpy = vi.spyOn(bridge, "emit");
      if (taskHandler) {
        taskHandler({ params: { content: "test task", meta: { foo: 1 } } });
      }

      expect(emitSpy).toHaveBeenCalledWith("task", {
        content: "test task",
        meta: { foo: 1 },
      });
    });

    it("should emit 'verdict' when permission notification is received", async () => {
      const bridge = new MCPBridge(config);
      const mClient = (bridge as any).client;
      let verdictHandler: Function | undefined;

      mClient.setNotificationHandler.mockImplementation(
        (schema: any, handler: Function) => {
          if (mClient.setNotificationHandler.mock.calls.length === 2) {
            verdictHandler = handler;
          }
        },
      );

      await bridge.connect();

      const emitSpy = vi.spyOn(bridge, "emit");
      if (verdictHandler) {
        verdictHandler({ params: { request_id: "req-1", behavior: "allow" } });
      }

      expect(emitSpy).toHaveBeenCalledWith("verdict", {
        requestId: "req-1",
        behavior: "allow",
      });
    });
  });

  describe("ensureConnected", () => {
    it("should wait for connection if currently connecting", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnecting = true;

      const toolPromise = bridge.callTool("test");

      setTimeout(() => {
        (bridge as any).isConnected = true;
      }, 1000);

      await vi.advanceTimersByTimeAsync(1500);
      const result = await toolPromise;
      expect(result).toEqual({ result: "ok" });
    });

    it("should throw if connection times out", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnecting = true;

      const toolPromise = bridge.callTool("test");
      const expectPromise = expect(toolPromise).rejects.toThrow(
        "MCP not connected after 10s timeout",
      );

      // Advance time enough to trigger the timeout
      await vi.runAllTimersAsync();

      await expectPromise;
    });
  });

  describe("tool calls and notifications", () => {
    it("should call tools correctly", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnected = true;
      const result = await bridge.callTool("test-tool", { arg: 1 });
      expect(result).toEqual({ result: "ok" });
    });

    it("should send notifications correctly", async () => {
      const bridge = new MCPBridge(config);
      (bridge as any).isConnected = true;
      await bridge.sendNotification("test-method", { foo: "bar" });
      expect((bridge as any).client.notification).toHaveBeenCalled();
    });

    it("should handle transport close rejection in _connectOnce", async () => {
      const bridge = new MCPBridge(config);
      mockTransport.close.mockRejectedValue(new Error("close failed"));
      
      await (bridge as any)._connectOnce();
      expect(mockTransport.close).toHaveBeenCalled();
      expect((bridge as any).isConnected).toBe(false); 
    });

    it("should close the client", async () => {
      const bridge = new MCPBridge(config);
      await bridge.close();
      expect((bridge as any).client.close).toHaveBeenCalled();
    });
  });
});
