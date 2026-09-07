import { afterEach, describe, expect, it } from "vitest";
import { mockChild } from "./fxChildMock";

const transport = {
  writeChild: async (_sessionId: string, _line: string): Promise<void> => {},
};

mockChild({
  writeChild: (sessionId: string, line: string) =>
    transport.writeChild(sessionId, line),
});

const { PiRpc } = await import("./piClient");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  transport.writeChild = async () => {};
});

describe("PiRpc.request", () => {
  it("rejects when the transport write fails", async () => {
    transport.writeChild = async () => {
      throw new Error("write failed");
    };
    const rpc = new PiRpc("probe", () => undefined);

    await expect(rpc.request({ type: "get_commands" })).rejects.toThrow(
      "write failed",
    );
    rpc.close();
  });

  it("times out even when the transport write stalls", async () => {
    const write = deferred<void>();
    transport.writeChild = () => write.promise;
    const rpc = new PiRpc("probe", () => undefined);

    await expect(rpc.request({ type: "get_commands" }, 20)).rejects.toThrow(
      "Pi get_commands timed out",
    );

    write.resolve();
    rpc.close();
  });

  it("routes responses to their request and everything else to onFrame", async () => {
    const frames: Record<string, unknown>[] = [];
    let rpc!: InstanceType<typeof PiRpc>;
    transport.writeChild = async (_sessionId, line) => {
      const { id, type } = JSON.parse(line) as { id: string; type: string };
      rpc.pushLine(JSON.stringify({ type: "agent_start" }));
      rpc.pushLine(
        JSON.stringify({ type: "response", command: type, id, success: true, data: { ok: 1 } }),
      );
    };
    rpc = new PiRpc("probe", (rec) => frames.push(rec));

    const res = await rpc.request({ type: "get_state" });
    expect(res.data).toEqual({ ok: 1 });
    expect(frames).toEqual([{ type: "agent_start" }]);
    rpc.close();
  });
});
