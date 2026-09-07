import { beforeEach, describe, expect, it } from "vitest";
import { mockChild } from "./fxChildMock"

const transport = {
  onWrite: async (_sessionId: string, _line: string): Promise<void> => {},
};

mockChild({
  writeChild: (sessionId: string, line: string) =>
    transport.onWrite(sessionId, line),
});

const { JsonRpcClient } = await import("./jsonRpc");

describe("JsonRpcClient", () => {
  beforeEach(() => {
    transport.onWrite = async () => {};
  });

  it("accepts a response delivered before the write resolves", async () => {
    let client!: InstanceType<typeof JsonRpcClient>;
    transport.onWrite = async (_sessionId, line) => {
      const outbound = JSON.parse(line) as { id: number };
      client.pushLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: outbound.id,
          result: { ok: true },
        }),
      );
    };
    client = new JsonRpcClient("fast", {});

    await expect(client.request("session/set_mode")).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects and removes a request when writing fails", async () => {
    transport.onWrite = async () => {
      throw new Error("pipe closed");
    };
    const client = new JsonRpcClient("failed", {});

    await expect(client.request("initialize")).rejects.toThrow("pipe closed");
  });
});
