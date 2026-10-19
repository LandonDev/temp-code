import { describe, expect, it } from "vitest";
import { BACKOFF, Supervisor, backoffDelay, type SupervisorOptions } from "./supervisor";
import { FakeClock, FakeTransport, HELLO, flush } from "./testing";
import type { Environment, EnvironmentStatus } from "./types";

const ROUTES = {
  lan: { url: "ws://10.0.0.5:7677/ws", kind: "lan" as const, credential: "key" as const },
  tunnel: { url: "wss://box.example/ws", kind: "tunnel" as const, credential: "key" as const },
};

function harness(overrides: Partial<SupervisorOptions> = {}, environment?: Partial<Environment>) {
  const clock = new FakeClock();
  const transports: FakeTransport[] = [];
  const statuses: EnvironmentStatus[] = [];
  const sessions: (FakeTransport | null)[] = [];
  const tickets: string[] = [];
  const env: Environment = {
    id: "env_host",
    name: "box",
    routes: [ROUTES.lan, ROUTES.tunnel],
    credentialRef: "env_host",
    ...environment,
  };
  const supervisor = new Supervisor({
    environment: env,
    resolveUrl: async (route) => {
      tickets.push(route.url);
      return `${route.url}?ticket=t${tickets.length}`;
    },
    profileFor: () => "remote",
    transport: (url, profile) => {
      const t = new FakeTransport(url, profile);
      transports.push(t);
      return t.asTransport();
    },
    clock,
    onStatus: (s) => statuses.push(s),
    onSession: (s) => sessions.push(s as unknown as FakeTransport | null),
    ...overrides,
  });
  return { clock, transports, statuses, sessions, tickets, supervisor, env };
}

/** Fail every transport still opening, letting the walk move on to the next route. */
async function failAll(h: ReturnType<typeof harness>) {
  for (;;) {
    await flush();
    const t = h.transports.find((x) => x.state === "opening");
    if (!t) return;
    t.failOpen();
    await flush();
  }
}

/** Start, fail the first route, answer the second: a session on route 1. */
async function openOnTunnel(h: ReturnType<typeof harness>) {
  h.supervisor.start();
  await flush();
  h.transports[0].failOpen();
  await flush();
  h.transports[1].answerHello();
  await flush();
  return h.transports[1];
}

describe("backoffDelay", () => {
  it("doubles from 1 s and caps at 5 min, with ±25 % jitter", () => {
    expect(backoffDelay(0, 0.5)).toBe(1000);
    expect(backoffDelay(1, 0.5)).toBe(2000);
    expect(backoffDelay(3, 0.5)).toBe(8000);
    expect(backoffDelay(0, 0)).toBe(750);
    expect(backoffDelay(0, 1)).toBe(1250);
    expect(backoffDelay(20, 0.5)).toBe(BACKOFF.capMs);
    expect(backoffDelay(20, 1)).toBe(BACKOFF.capMs);
    expect(backoffDelay(8, 1)).toBe(BACKOFF.capMs); // 256 s × 1.25 clamps
  });
});

describe("Supervisor", () => {
  it("walks the routes best-first and sits on the first that answers", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    expect(h.tickets).toEqual([ROUTES.lan.url, ROUTES.tunnel.url]);
    expect(h.transports[1].url).toBe(`${ROUTES.tunnel.url}?ticket=t2`);
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.supervisor.status).toMatchObject({ transport: "open", route: 1, lastHello: HELLO, attempts: 0, fresh: false });
    expect(h.sessions).toEqual([live]);
    expect(h.statuses[0].transport).toBe("connecting");
  });

  it("retries a dead host on a jittered exponential backoff capped at five minutes", async () => {
    const h = harness();
    h.supervisor.start();
    await flush();
    await failAll(h);
    expect(h.supervisor.status).toMatchObject({ transport: "connecting", attempts: 1, nextRetryAt: h.clock.now() + 1000 });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const wait = h.supervisor.status.nextRetryAt! - h.clock.now();
      delays.push(wait);
      await h.clock.advance(wait);
      await failAll(h);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]);
    expect(h.supervisor.status.attempts).toBe(11);
    expect(h.supervisor.status.lastError).toBe("could not connect");
  });

  it("jitter stays inside ±25 % of the step", async () => {
    const low = harness();
    low.clock.randomValue = 0;
    low.supervisor.start();
    await failAll(low);
    expect(low.supervisor.status.nextRetryAt! - low.clock.now()).toBe(750);
    const high = harness();
    high.clock.randomValue = 1;
    high.supervisor.start();
    await failAll(high);
    expect(high.supervisor.status.nextRetryAt! - high.clock.now()).toBe(1250);
  });

  it("resets the backoff only after a session stays up 30 s", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    // Lost after 5 s: the first retry waits 1 s, a second quick loss 2 s.
    await h.clock.advance(5_000);
    live.drop();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "reconnecting", attempts: 1 });
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(1000);
    await h.clock.advance(1000);
    h.transports[2].failOpen();
    await flush();
    h.transports[3].answerHello();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", attempts: 1 });
    await h.clock.advance(10_000);
    h.transports[3].drop();
    await flush();
    expect(h.supervisor.status.attempts).toBe(2);
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(2000);
    await h.clock.advance(2000);
    h.transports[4].failOpen();
    await flush();
    h.transports[5].answerHello();
    await flush();
    // Up for 30 s: the count clears, and the next loss waits 1 s again.
    await h.clock.advance(BACKOFF.resetAfterMs);
    expect(h.supervisor.status.attempts).toBe(0);
    h.transports[5].drop();
    await flush();
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(1000);
  });

  it("a probe that answers keeps the session and marks it fresh", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    const probe = h.supervisor.probe("foreground");
    await flush();
    expect(live.requests.map((r) => r.method)).toEqual(["workspace.list"]);
    live.requests[0].resolve([]);
    await probe;
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.supervisor.status).toMatchObject({ transport: "open", fresh: true });
    expect(h.transports).toHaveLength(2);
  });

  it("a probe that times out reconnects at once, without a backoff wait", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    void h.supervisor.probe("foreground");
    await flush();
    await h.clock.advance(5_000);
    expect(live.state).toBe("closed");
    expect(live.closeReason?.message).toContain("probe on foreground failed");
    expect(h.sessions.at(-1)).toBeNull();
    // The new walk started with no timer in between.
    expect(h.transports).toHaveLength(3);
    expect(h.supervisor.status).toMatchObject({ transport: "reconnecting", nextRetryAt: null, attempts: 0 });
    h.transports[2].answerHello();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", route: 0 });
  });

  it("with no session, a probe fires the pending retry now", async () => {
    const h = harness();
    h.supervisor.start();
    await failAll(h);
    expect(h.clock.pending).toEqual([1000]);
    void h.supervisor.probe("online");
    await flush();
    expect(h.clock.pending).toEqual([]);
    expect(h.transports).toHaveLength(3);
  });

  it("a refused credential stops automatic retries; only an explicit retry tries again", async () => {
    const h = harness({
      resolveUrl: async (route) => {
        if (route.kind === "lan") throw new Error("unavailable: no answer");
        throw new Error("unauthorized: box rejected the key");
      },
    });
    h.supervisor.start();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "unauthorized", nextRetryAt: null });
    expect(h.supervisor.status.lastError).toMatch(/^unauthorized/);
    expect(h.clock.pending).toEqual([]);
    await h.supervisor.probe("foreground");
    await h.supervisor.probe("online");
    expect(h.transports).toHaveLength(0);
    h.supervisor.retry();
    await flush();
    expect(h.supervisor.status.transport).toBe("unauthorized"); // still refused, but it did ask again
    expect(h.supervisor.status.attempts).toBe(0);
  });

  it("a server close with 4401 is unauthorized too", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    live.close({ kind: "unauthorized", code: 4401, message: "key revoked" });
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "unauthorized", lastError: "key revoked", nextRetryAt: null });
    expect(h.clock.pending).toEqual([]);
  });

  it("preflights the better route while on a later one and switches when it answers", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    expect(h.clock.pending).toEqual([30_000, 120_000]);
    await h.clock.advance(120_000);
    expect(h.transports).toHaveLength(3);
    expect(h.transports[2].url).toBe(`${ROUTES.lan.url}?ticket=t3`);
    expect(h.supervisor.session).toBe(live.asTransport()); // the old session serves until the new one is up
    h.transports[2].answerHello();
    await flush();
    expect(h.supervisor.session).toBe(h.transports[2].asTransport());
    expect(h.supervisor.status).toMatchObject({ transport: "open", route: 0, attempts: 0 });
    expect(live.state).toBe("closed");
    expect(live.closeReason?.kind).toBe("replaced");
    expect(h.sessions.at(-1)).toBe(h.transports[2]);
    expect(h.supervisor.status.nextRetryAt).toBeNull();
    // On the best route there is nothing left to preflight.
    expect(h.clock.pending).toEqual([30_000]);
  });

  it("a failed preflight keeps the session and tries again later", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    await h.clock.advance(120_000);
    h.transports[2].failOpen();
    await flush();
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.clock.pending).toContain(120_000);
  });

  it("a saved host that answers with another id is held offline until retried", async () => {
    const h = harness();
    h.supervisor.start();
    await flush();
    h.transports[0].answerHello({ ...HELLO, environmentId: "env_other" });
    await flush();
    expect(h.transports[0].state).toBe("closed");
    expect(h.supervisor.session).toBeNull();
    expect(h.supervisor.status).toMatchObject({ transport: "offline", nextRetryAt: null });
    expect(h.supervisor.status.lastError).toContain("expected env_host, got env_other");
    expect(h.clock.pending).toEqual([]);
    await h.supervisor.probe("online");
    expect(h.transports).toHaveLength(1);
    h.supervisor.retry();
    await flush();
    expect(h.transports).toHaveLength(2);
  });

  it("the local environment accepts whatever id its server reports", async () => {
    const h = harness({}, { id: "local", credentialRef: null, routes: [{ url: "ws://127.0.0.1:4000", kind: "loopback", credential: "implicit" }] });
    h.supervisor.start();
    await flush();
    h.transports[0].answerHello({ ...HELLO, environmentId: "env_mac" });
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", lastHello: { environmentId: "env_mac" } });
  });

  it("offline pauses retries; online probes or attempts", async () => {
    const h = harness();
    h.supervisor.start();
    await failAll(h);
    h.supervisor.setOnline(false);
    expect(h.supervisor.status.transport).toBe("offline");
    expect(h.clock.pending).toEqual([]);
    await h.supervisor.probe("foreground");
    expect(h.transports).toHaveLength(2);
    h.supervisor.setOnline(true);
    await flush();
    expect(h.transports).toHaveLength(3); // the walk opens one route at a time
    h.transports[2].answerHello();
    await flush();
    expect(h.supervisor.status.transport).toBe("open");
    // An offline report with a session up probes it rather than dropping it.
    h.supervisor.setOnline(false);
    await flush();
    expect(h.transports[2].requests.map((r) => r.method)).toEqual(["workspace.list"]);
  });

  it("stop closes the session and schedules nothing", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    h.supervisor.stop();
    expect(live.state).toBe("closed");
    expect(live.closeReason?.kind).toBe("local");
    expect(h.supervisor.status).toMatchObject({ transport: "offline", route: null, lastHello: HELLO });
    expect(h.clock.pending).toEqual([]);
    expect(h.sessions.at(-1)).toBeNull();
  });

  it("update keeps a session whose route survived and drops one whose route went", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    h.supervisor.update({ ...h.env, routes: [ROUTES.tunnel] });
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.supervisor.status.route).toBe(0);
    h.supervisor.update({ ...h.env, routes: [ROUTES.lan] });
    await flush();
    expect(live.state).toBe("closed");
    expect(h.transports).toHaveLength(3);
    expect(h.transports[2].url).toContain(ROUTES.lan.url);
  });

  it("markFresh is the stores' word and a lost session clears it", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    h.supervisor.markFresh(true);
    expect(h.supervisor.status.fresh).toBe(true);
    live.drop();
    await flush();
    expect(h.supervisor.status.fresh).toBe(false);
  });
});
