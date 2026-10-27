import { describe, expect, it } from "vitest";
import type { EnvLink } from "./link";
import { ConnectionRegistry, localEnvironment, savedEnvironment, webEnvironment, type LinkEvent } from "./registry";
import { FakeClock, FakeTransport, HELLO, flush } from "./testing";

const SIGNED_IN = (async () => new Response(JSON.stringify({ environmentId: "env_box", key: { id: "k" } }))) as typeof fetch;

function harness(fetch: typeof globalThis.fetch = SIGNED_IN) {
  const clock = new FakeClock();
  const transports: FakeTransport[] = [];
  const registry = new ConnectionRegistry({
    clock,
    fetch,
    transport: (url, profile) => {
      const t = new FakeTransport(url, profile);
      transports.push(t);
      return t.asTransport();
    },
  });
  const events: [string, LinkEvent][] = [];
  registry.onLink((link, event) => events.push([link.environmentId, event]));
  return { clock, transports, registry, events };
}

const SAVED = savedEnvironment({ id: "env_box", name: "box", routes: [{ url: "wss://box.example/ws", kind: "tunnel" }] });

describe("ConnectionRegistry", () => {
  it("adding environment zero connects to the loopback port with the page's profile and hands the stores a link", async () => {
    const h = harness();
    const link = h.registry.add(localEnvironment(4000));
    expect(h.events).toEqual([["local", "added"]]);
    expect(h.registry.statusOf("local").transport).toBe("connecting");
    await flush();
    expect(h.transports[0].url).toBe("ws://127.0.0.1:4000");
    expect(h.transports[0].profile).toBe("local");
    h.transports[0].answerHello({ ...HELLO, environmentId: "env_mac" });
    await flush();
    expect(link.connected).toBe(true);
    expect(h.registry.statusOf("local")).toMatchObject({ transport: "open", lastHello: { environmentId: "env_mac" } });
    expect(h.registry.primary()).toBe(link);
    expect(h.registry.linkOf("local")).toBe(link);
    expect(() => h.registry.linkOf("nope")).toThrow("unknown environment");
  });

  it("an involuntary disconnect keeps the registration, the link and the stores' data", async () => {
    const h = harness();
    const link = h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    let closes = 0;
    link.onClose(() => closes++);
    h.transports[0].drop();
    await flush();
    expect(h.registry.has("local")).toBe(true);
    expect(h.registry.link("local")).toBe(link);
    expect(link.connected).toBe(false);
    expect(closes).toBe(1);
    expect(h.events).toEqual([["local", "added"]]); // no "removed": nothing to clear
    expect(h.registry.statusOf("local").transport).toBe("reconnecting");
    await h.clock.advance(1000);
    h.transports[1].answerHello();
    await flush();
    expect(link.connected).toBe(true);
  });

  it("explicit removal stops the supervisor and tells the stores to clear", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    h.registry.remove("local");
    expect(h.transports[0].state).toBe("closed");
    expect(h.events).toEqual([
      ["local", "added"],
      ["local", "removed"],
    ]);
    expect(h.registry.has("local")).toBe(false);
    expect(h.registry.statuses().has("local")).toBe(false);
    expect(h.clock.pending).toEqual([]);
  });

  it("a late onLink subscriber hears every existing link at once", () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    h.registry.add(SAVED);
    const seen: string[] = [];
    h.registry.onLink((link: EnvLink, event) => seen.push(`${link.environmentId}:${event}`));
    expect(seen).toEqual(["local:added", "env_box:added"]);
    expect(h.registry.environmentsSnapshot().map((e) => e.id)).toEqual(["local", "env_box"]);
  });

  it("a key route asks the primary link for a ticket and opens the route with it", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    h.registry.add(SAVED);
    await flush();
    expect(h.transports[0].requests.map((r) => [r.method, r.params])).toEqual([
      ["remote.environments.ticket", { id: "env_box", url: "wss://box.example/ws" }],
    ]);
    h.transports[0].requests[0].resolve({ ticket: "tk_1", expiresIn: 30000 });
    await flush();
    expect(h.transports[1].url).toBe("wss://box.example/ws?ticket=tk_1");
    expect(h.transports[1].profile).toBe("remote");
    h.transports[1].answerHello({ ...HELLO, environmentId: "env_box" });
    await flush();
    expect(h.registry.statusOf("env_box").transport).toBe("open");
  });

  it("a refused ticket leaves the environment unauthorized", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    h.registry.add(SAVED);
    await flush();
    h.transports[0].requests[0].reject(new Error("unauthorized: box rejected the key"));
    await flush();
    expect(h.registry.statusOf("env_box")).toMatchObject({ transport: "unauthorized", lastError: "unauthorized: box rejected the key" });
    expect(h.transports).toHaveLength(1);
  });

  it("a replacement key restarts an unauthorized supervisor without clearing the link or stores", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    const original = { ...SAVED, keyId: "old-id" };
    const link = h.registry.add(original);
    await flush();
    h.transports[0].requests[0].reject(new Error("unauthorized: revoked"));
    await flush();
    const stopped = h.registry.supervisor(SAVED.id);
    expect(h.registry.statusOf(SAVED.id).transport).toBe("unauthorized");
    h.registry.update({ ...original, name: "Renamed" });
    await flush();
    expect(h.transports[0].requests).toHaveLength(1);
    h.registry.update({ ...original, keyId: "new-id" });
    await flush();
    expect(h.registry.supervisor(SAVED.id)).not.toBe(stopped);
    expect(h.registry.link(SAVED.id)).toBe(link);
    expect(h.events).toEqual([["local", "added"], [SAVED.id, "added"]]);
    expect(h.transports[0].requests).toHaveLength(2);
    h.transports[0].requests[1].resolve({ ticket: "new-ticket", expiresIn: 30000 });
    await flush();
    h.transports[1].answerHello({ ...HELLO, environmentId: SAVED.id });
    await flush();
    expect(link.connected).toBe(true);
    expect(h.registry.statusOf(SAVED.id).transport).toBe("open");
  });

  it("a key change retires a pending ticket and ignores its late refusal", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    const link = h.registry.add({ ...SAVED, keyId: "old-id" });
    await flush();
    h.registry.update({ ...SAVED, keyId: "new-id" });
    await flush();
    h.transports[0].requests[1].resolve({ ticket: "new-ticket", expiresIn: 30000 });
    await flush();
    h.transports[1].answerHello({ ...HELLO, environmentId: SAVED.id });
    await flush();
    h.transports[0].requests[0].reject(new Error("unauthorized: old key"));
    await flush();
    expect(link.connected).toBe(true);
    expect(h.registry.statusOf(SAVED.id).transport).toBe("open");
  });

  it("the primary link exists before its environment is added and is the same object after", async () => {
    const h = harness();
    const early = h.registry.primary();
    expect(early.environmentId).toBe("local");
    expect(early.connected).toBe(false);
    let opened = 0;
    early.onOpen(() => opened++);
    await expect(early.request("x")).rejects.toThrow("not connected");
    expect(() => h.registry.linkOf("env_nope")).toThrow("unknown environment");
    const added = h.registry.add(localEnvironment(4000));
    expect(added).toBe(early);
    await flush();
    h.transports[0].answerHello();
    await flush();
    expect(opened).toBe(1);
    expect(early.connected).toBe(true);
    h.registry.setPrimary("web");
    expect(h.registry.primaryEnvironmentId).toBe("web");
    expect(h.registry.primary().environmentId).toBe("web");
  });

  it("statuses() is one stable map per change", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    const a = h.registry.statuses();
    expect(h.registry.statuses()).toBe(a);
    await flush();
    h.transports[0].answerHello();
    await flush();
    expect(h.registry.statuses()).not.toBe(a);
    expect(h.registry.statuses().get("local")?.transport).toBe("open");
  });

  it("builds the three environment shapes", () => {
    expect(localEnvironment(5173)).toEqual({
      id: "local",
      name: "This Mac",
      routes: [{ url: "ws://127.0.0.1:5173", kind: "loopback", credential: "implicit" }],
      credentialRef: null,
    });
    expect(webEnvironment("wss://tempcode.example/ws")).toMatchObject({
      id: "web",
      routes: [{ url: "wss://tempcode.example/ws", kind: "tunnel", credential: "cookie" }],
      credentialRef: null,
    });
    expect(SAVED).toEqual({
      id: "env_box",
      name: "box",
      routes: [{ url: "wss://box.example/ws", kind: "tunnel", credential: "key" }],
      credentialRef: "env_box",
    });
  });

  it("the web page's cookie route opens its own origin with no ticket, as the one and primary environment", async () => {
    const h = harness();
    h.registry.setPrimary("web");
    const link = h.registry.add(webEnvironment("wss://tempcode.example/ws"));
    expect(h.registry.environments().map((e) => e.id)).toEqual(["web"]);
    await flush();
    expect(h.transports[0].url).toBe("wss://tempcode.example/ws");
    expect(h.transports[0].profile).toBe("remote");
    expect(h.registry.primary()).toBe(link);
  });

  it("a cookie route asks /api/hello on its origin first: a hello without a key is signed out, no socket, no retry", async () => {
    const asked: string[] = [];
    const h = harness((async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ environmentId: "env_box", contract: 3 }));
    }) as typeof fetch);
    h.registry.add(webEnvironment("wss://tempcode.example/ws"));
    await flush();
    expect(asked).toEqual(["https://tempcode.example/api/hello"]);
    expect(h.transports).toHaveLength(0);
    expect(h.registry.statusOf("web")).toMatchObject({ transport: "unauthorized", lastError: "unauthorized: signed out", nextRetryAt: null });
  });

  it("a cookie route whose hello fails is unavailable and backs off, never signed out", async () => {
    const h = harness((async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    h.registry.add(webEnvironment("ws://10.0.0.9:7677/ws"));
    await flush();
    expect(h.transports).toHaveLength(0);
    const status = h.registry.statusOf("web");
    expect(status.transport).not.toBe("unauthorized");
    expect(status.lastError).toBe("unavailable: Failed to fetch");
    expect(status.nextRetryAt).not.toBeNull();
  });

  it("names the environments whose host is slow to answer, one set per change", async () => {
    const h = harness();
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello();
    await flush();
    let heard = 0;
    h.registry.subscribe(() => heard++);
    expect([...h.registry.slowEnvironments()]).toEqual([]);
    h.transports[0].answer(12_000);
    const slow = h.registry.slowEnvironments();
    expect([...slow]).toEqual(["local"]);
    expect(h.registry.slowSince("local")).not.toBeNull();
    expect(heard).toBe(1);
    h.transports[0].answer(30_000, true);
    expect(h.registry.slowEnvironments()).toBe(slow);
    expect(heard).toBe(1);
    h.transports[0].answer(120);
    expect([...h.registry.slowEnvironments()]).toEqual([]);
    expect(h.registry.slowSince("local")).toBeNull();
    expect(heard).toBe(2);
    h.transports[0].answer(9_000);
    h.registry.remove("local");
    expect([...h.registry.slowEnvironments()]).toEqual([]);
  });
});
