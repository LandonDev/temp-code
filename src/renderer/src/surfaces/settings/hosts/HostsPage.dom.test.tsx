// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RemoteKey, RemotePairing, RemoteSession, RemoteStatus } from "@server/shared/contract-remote";

/**
 * Settings → Hosts, this machine's section: a skeleton until remote.status
 * answers, then the id, the listener and its port field, the clients with
 * their actions, and an empty clients list as one line.
 */

const status = (over: Partial<RemoteStatus> = {}): RemoteStatus =>
  ({
    environmentId: "env_1gP-MhkVVRaMwHbVCysYow",
    name: "This Mac",
    enabled: true,
    port: 7677,
    configuredPort: 7677,
    running: true,
    error: null,
    origin: "http://127.0.0.1:7677",
    publicOrigin: "",
    learnedOrigin: null,
    contract: 1,
    stuckMinutes: 30,
    ...over,
  }) as RemoteStatus;

let answers: Record<string, unknown> = {};
let pending: Promise<unknown> | null = null;
const calls: { method: string; params: unknown }[] = [];

vi.mock("../../../lib/connection", () => ({
  registry: {
    primary: () => ({
      request: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "remote.status" && pending) return pending;
        return method in answers ? Promise.resolve(answers[method]) : Promise.reject(new Error(`no ${method}`));
      },
    }),
    environment: () => undefined,
    link: () => undefined,
    retry: () => {},
  },
  useEnvironments: () => [{ id: "local", name: "This Mac", routes: [], credentialRef: null }],
  useEnvironmentStatus: () => ({ transport: "open", fresh: true, lastHello: null, lastError: null, nextRetryAt: null, route: 0 }),
  useLastSeenAt: () => null,
  forgetSeen: () => {},
}));
vi.mock("../../../lib/tcserver/link", () => ({ loadSavedEnvironments: async () => {} }));
vi.mock("../../../lib/macBridge", () => ({ useMacBridgeHosts: () => [] }));
vi.mock("../../../lib/hostDevices", () => ({ useHostDevicesHosts: () => null }));
vi.mock("../../../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../../../chrome/HostGlyph", () => ({ HostGlyph: () => null }));
vi.mock("../../../chrome/DeployDrift", () => ({ DeployDriftMark: () => null }));
vi.mock("../../../stores/environment", () => ({ environment: { forget: () => {} } }));
vi.mock("../../AdmissionSettings", () => ({ AdmissionSettings: () => null }));
vi.mock("../../DeploySettings", () => ({ DeploySettings: () => null }));
vi.mock("../../MacBridgeSettings", () => ({ MacBridgeSettings: () => null }));

const { HostsPage } = await import("./HostsPage");

const key = (over: Partial<RemoteKey> = {}): RemoteKey => ({
  id: "k1",
  name: "iPhone",
  audience: "client",
  caps: ["read", "operate", "approve"],
  kind: "bearer",
  createdAt: 1,
  lastUsedAt: null,
  revokedAt: null,
  createdBy: "local",
  webhookUrl: null,
  events: null,
  ...over,
});
const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  id: "b1",
  keyId: "k2",
  keyName: "Studio browser",
  caps: ["read", "admin"],
  userAgent: "Mozilla/5.0 Chrome/131.0",
  createdAt: 1,
  lastSeenAt: Date.now() - 2 * 3_600_000,
  expiresAt: Date.now() + 1e9,
  ...over,
});
const pairing = (over: Partial<RemotePairing> = {}): RemotePairing => ({
  id: "p1",
  name: "iPad",
  audience: "client",
  caps: ["read", "operate"],
  createdAt: 1,
  expiresAt: Date.now() + 8 * 60_000 + 41_000,
  consumedAt: null,
  consumedBy: null,
  ...over,
});

const seed = (over: Record<string, unknown> = {}) => {
  answers = {
    "remote.status": status(),
    "remote.keys.list": [],
    "remote.pairings.list": [],
    "remote.sessions.list": [],
    "remote.environments.list": [],
    "remote.settings.set": {},
    "remote.keys.revoke": {},
    "remote.sessions.revoke": {},
    ...over,
  };
};

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => seed());
afterEach(() => {
  cleanup();
  calls.length = 0;
  pending = null;
});

describe("HostsPage", () => {
  it("shows a skeleton until remote.status answers, then this machine's rows", async () => {
    let answer: (s: RemoteStatus) => void = () => {};
    pending = new Promise((r) => (answer = r));
    const { container } = render(<HostsPage />);
    expect(container.querySelector("[data-hosts-loading]")).not.toBeNull();
    pending = null;
    answer(status());
    await flush();
    expect(container.querySelector("[data-hosts-loading]")).toBeNull();
    expect(container.querySelector('[data-environment-row="local"]')?.textContent).toContain("This Mac");
    expect(screen.getByText("env_1gP-MhkVVRaMwHbVCysYow")).toBeTruthy();
    expect(screen.getByText("Listening on 127.0.0.1:7677")).toBeTruthy();
    expect(screen.getByText("Minutes of silence before a working thread is stuck")).toBeTruthy();
  });

  it("says No clients when nothing may reach this host", async () => {
    render(<HostsPage />);
    await flush();
    expect(screen.getByText("No clients")).toBeTruthy();
  });

  it("lists a pairing with its countdown, a key and a browser session, each with its facts", async () => {
    seed({ "remote.pairings.list": [pairing()], "remote.keys.list": [key()], "remote.sessions.list": [session()] });
    const { container } = render(<HostsPage />);
    await flush();
    expect(screen.queryByText("No clients")).toBeNull();
    const code = container.querySelector('[data-client-pairing="p1"]')!;
    expect(code.textContent).toMatch(/expires in 8:4\d/);
    expect(code.textContent).toContain("operate");
    const k = container.querySelector('[data-client-key="k1"]')!;
    expect([...k.querySelectorAll("[data-slot=facts] > span")].map((s) => s.textContent)).toEqual(["App", "operate, approve", "never used"]);
    const b = container.querySelector('[data-client-session="b1"]')!;
    expect([...b.querySelectorAll("[data-slot=facts] > span")].map((s) => s.textContent)).toEqual(["Chrome", "admin", "seen 2h ago"]);
  });

  it("revokes a key and signs a browser out, then reads the lists again", async () => {
    seed({ "remote.keys.list": [key()], "remote.sessions.list": [session()] });
    render(<HostsPage />);
    await flush();
    calls.length = 0;
    fireEvent.click(screen.getByText("Revoke"));
    await flush();
    expect(calls[0]).toEqual({ method: "remote.keys.revoke", params: { id: "k1" } });
    expect(calls.some((c) => c.method === "remote.keys.list")).toBe(true);
    calls.length = 0;
    fireEvent.click(screen.getByText("Sign out"));
    await flush();
    expect(calls[0]).toEqual({ method: "remote.sessions.revoke", params: { id: "b1" } });
    expect(calls.some((c) => c.method === "remote.sessions.list")).toBe(true);
  });

  it("commits a new port on Enter, and snaps a bad one back without a call", async () => {
    render(<HostsPage />);
    await flush();
    const field = screen.getByLabelText("Port") as HTMLInputElement;
    calls.length = 0;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "99999" } });
    fireEvent.blur(field);
    await flush();
    expect(field.value).toBe("7677");
    expect(calls.some((c) => c.method === "remote.settings.set")).toBe(false);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "7700" } });
    fireEvent.blur(field);
    await flush();
    expect(calls[0]).toEqual({ method: "remote.settings.set", params: { port: 7700 } });
  });
});
