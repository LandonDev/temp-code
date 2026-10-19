import { describe, expect, it } from "vitest";
import { installCheckpointBridge, type CheckpointCalls } from "./checkpointBridge";
import type { LiveEditListener } from "./tcserver/store";
import type { EventRow } from "./tcserver/types";
import type { Session } from "./session";

type EventListener = (sessionId: string, row: EventRow, session: Session) => void;

function fakeStore(cwd = "/repo") {
  const events = new Set<EventListener>();
  const lives = new Set<LiveEditListener>();
  const session = { id: "s1", environmentId: "local", cwd, blocks: [] } as unknown as Session;
  return {
    onEvent: (l: EventListener) => { events.add(l); return () => events.delete(l); },
    onLiveEdit: (l: LiveEditListener) => { lives.add(l); return () => lives.delete(l); },
    get: (id: string) => (id === "s1" ? session : undefined),
    event(event: EventRow["event"]) {
      for (const l of events) l("s1", { sessionId: "s1", seq: 1, ts: 1, event }, session);
    },
    live(path: string, settled: boolean, ids = ["s1"]) {
      for (const l of lives) l(ids, { cwd: "/repo", path, kind: "changed", settled, ts: 1 });
    },
  };
}

function recorder() {
  const calls: string[] = [];
  const api: CheckpointCalls = {
    ensure: async (environmentId, id, cwd) => { calls.push(`ensure ${environmentId} ${id} ${cwd}`); },
    capture: async (environmentId, id, cwd, paths) => { calls.push(`capture ${environmentId} ${id} ${cwd} ${paths.join(",")}`); },
    sync: async (environmentId, id, cwd) => { calls.push(`sync ${environmentId} ${id} ${cwd}`); },
    changed: (id) => { calls.push(`changed ${id}`); },
  };
  return { calls, api };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("checkpoint bridge", () => {
  it("ensures on user-text, syncs when the turn settles", async () => {
    const store = fakeStore();
    const { calls, api } = recorder();
    installCheckpointBridge(store, api);
    store.event({ type: "user-text", text: "go" });
    store.event({ type: "assistant-text", text: "ok", delta: "ok" });
    store.event({ type: "turn-complete" });
    store.event({ type: "status", status: "running" });
    store.event({ type: "status", status: "idle" });
    store.event({ type: "status", status: "paused" });
    store.event({ type: "error", message: "x" });
    store.event({ type: "status", status: "error" });
    await tick();
    expect(calls).toEqual([
      "ensure local s1 /repo",
      "sync local s1 /repo",
      "sync local s1 /repo",
      "sync local s1 /repo",
      "sync local s1 /repo",
      "changed s1",
      "changed s1",
      "changed s1",
      "changed s1",
    ]);
  });

  it("captures settled live edits as absolute paths, per attached session", async () => {
    const store = fakeStore();
    const { calls, api } = recorder();
    installCheckpointBridge(store, api);
    store.live("src/a.ts", false);
    store.live("src/a.ts", true, ["s1", "ghost"]);
    store.live("/repo/b.ts", true);
    await tick();
    expect(calls).toEqual([
      "capture local s1 /repo /repo/src/a.ts",
      "capture local s1 /repo /repo/b.ts",
      "changed s1",
      "changed s1",
    ]);
  });

  it("skips sessions with no working directory and detaches cleanly", async () => {
    const store = fakeStore("~");
    const { calls, api } = recorder();
    const off = installCheckpointBridge(store, api);
    store.event({ type: "user-text", text: "go" });
    store.live("a.ts", true);
    off();
    await tick();
    expect(calls).toEqual([]);
  });
});
