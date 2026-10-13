import { describe, it, expect } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { BRIDGE_SUBPROTOCOL, upgradeHeaders } from "../nativeFrames.js";

// The built-in WebSocket's `headers` option is a Node extension, not part of
// the web standard. Native mode depends on it for the token and every
// X-AgentRQ-* header, so this proves on a real socket that they arrive.
describe.runIf(typeof WebSocket === "function")("the built-in WebSocket", () => {
  it("sends the upgrade headers native mode relies on", async () => {
    const seen = new Promise<IncomingHttpHeaders>((resolve) => {
      const server = createServer();
      server.on("upgrade", (req, socket) => {
        resolve(req.headers);
        socket.destroy();
        server.close();
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/acp/v1`, {
          protocols: [BRIDGE_SUBPROTOCOL],
          headers: upgradeHeaders({
            token: "t",
            bridgeVersion: "0.3.0",
            cwd: "/work",
            platform: "linux/arm64",
            resume: { connectionId: "AB", received: 2 },
          }),
        } as unknown as string[]);
        ws.onerror = () => {};
      });
    });

    const headers = await seen;
    expect(headers.authorization).toBe("Bearer t");
    expect(headers["sec-websocket-protocol"]).toBe("agentrq.bridge.1");
    expect(headers["x-agentrq-cwd"]).toBe("/work");
    expect(headers["x-agentrq-bridge-version"]).toBe("0.3.0");
    expect(headers["x-agentrq-resume"]).toBe("AB:2");
  });
});
