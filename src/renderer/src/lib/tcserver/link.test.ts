import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  webMode: false,
  port: 4321,
  bound: [] as unknown[],
}));
vi.mock("../native", () => ({
  isWebMode: () => native.webMode,
  getServerPort: () => Promise.resolve(native.port),
  bindServer: (router: unknown) => native.bound.push(router),
}));
vi.mock("../nativeWeb", () => ({ webSocketUrl: () => "wss://box.example/ws" }));
vi.mock("./smoke", () => ({ smoke: () => Promise.reject(new Error("not in tests")) }));

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {}
  hello(environmentId: string) {
    this.onmessage?.({ data: JSON.stringify({ push: "hello", environmentId, contract: 3, caps: ["read"] }) });
  }
}

const { registry } = await import("../connection");
const { initServerLink, loadSavedEnvironments } = await import("./link");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeSocket.instances = [];
  native.bound = [];
  native.webMode = false;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  registry.reset();
  registry.setPrimary("local");
  vi.unstubAllGlobals();
});

describe("initServerLink", () => {
  it("the desktop window adds environment zero from preload's port, exactly as the single client connected", async () => {
    initServerLink();
    expect(native.bound).toEqual([registry]);
    await flush();
    expect(registry.environments()).toEqual([
      {
        id: "local",
        name: "This Mac",
        routes: [{ url: "ws://127.0.0.1:4321", kind: "loopback", credential: "implicit" }],
        credentialRef: null,
      },
    ]);
    expect(registry.primaryEnvironmentId).toBe("local");
    expect(FakeSocket.instances.map((s) => s.url)).toEqual(["ws://127.0.0.1:4321"]);
    FakeSocket.instances[0].hello("env_mac");
    await flush();
    expect(registry.statusOf("local")).toMatchObject({ transport: "open", lastHello: { environmentId: "env_mac" } });
    expect(registry.primary().connected).toBe(true);
  });

  it("the page at /ui has exactly one environment: its own origin, the cookie on the upgrade", async () => {
    native.webMode = true;
    vi.stubGlobal("location", { hostname: "box.example" });
    initServerLink();
    await flush();
    expect(registry.environments().map((e) => e.id)).toEqual(["web"]);
    expect(registry.primaryEnvironmentId).toBe("web");
    expect(registry.environment("web")?.routes).toEqual([
      { url: "wss://box.example/ws", kind: "tunnel", credential: "cookie" },
    ]);
    expect(FakeSocket.instances.map((s) => s.url)).toEqual(["wss://box.example/ws"]);
    expect(registry.primary()).toBe(registry.linkOf("web"));
  });
});

describe("loadSavedEnvironments", () => {
  it("adds the hosts the main process keeps keys for and drops the ones it forgot", async () => {
    initServerLink();
    await flush();
    const rows = [
      { id: "env_box", name: "box", routes: [{ url: "wss://box.example/ws", kind: "tunnel" as const }] },
      { id: "env_mini", name: "mini", routes: [{ url: "ws://10.0.0.9:7677/ws", kind: "lan" as const }] },
    ];
    const link = { request: vi.fn().mockResolvedValue(rows) } as never;
    await loadSavedEnvironments(link);
    expect(registry.environments().map((e) => e.id)).toEqual(["local", "env_box", "env_mini"]);
    expect(registry.environment("env_box")).toEqual({
      id: "env_box",
      name: "box",
      routes: [{ url: "wss://box.example/ws", kind: "tunnel", credential: "key" }],
      credentialRef: "env_box",
    });
    const removed: string[] = [];
    registry.onLink((l, event) => {
      if (event === "removed") removed.push(l.environmentId);
    });
    await loadSavedEnvironments({ request: vi.fn().mockResolvedValue([rows[0]]) } as never);
    expect(registry.environments().map((e) => e.id)).toEqual(["local", "env_box"]);
    expect(removed).toEqual(["env_mini"]);
  });
});
