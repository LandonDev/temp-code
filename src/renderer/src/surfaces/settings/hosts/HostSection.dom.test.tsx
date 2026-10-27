// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RemoteStatus, SavedEnvironment } from "@server/shared/contract-remote";
import type { EnvironmentStatus } from "../../../lib/connection/types";

/**
 * A paired host's section on Settings → Hosts: the header's words for each
 * link state, Retry and Pair again when the state calls for them, the
 * deploy drift mark, the host's menu and the dialogs it opens, and Remove
 * behind its confirm.
 */

const box: SavedEnvironment = {
  id: "env_box",
  name: "box",
  routes: [{ url: "wss://tempcode.landonhale.com/ws", kind: "tunnel" }],
  caps: ["read", "operate", "approve", "admin"],
} as unknown as SavedEnvironment;

let link: Partial<EnvironmentStatus> = {};
const retried: string[] = [];
const calls: { method: string; params: unknown }[] = [];

vi.mock("../../../lib/connection", () => ({
  registry: {
    primary: () => ({
      request: (method: string, params: unknown) => {
        calls.push({ method, params });
        const answers: Record<string, unknown> = {
          "remote.status": { environmentId: "env_mac", name: "This Mac", enabled: true, port: 7677, configuredPort: 7677, running: true, error: null, origin: "", publicOrigin: "", learnedOrigin: null, contract: 1, stuckMinutes: 30 } as RemoteStatus,
          "remote.keys.list": [],
          "remote.pairings.list": [],
          "remote.sessions.list": [],
          "remote.environments.list": [box],
          "remote.environments.remove": {},
        };
        return method in answers ? Promise.resolve(answers[method]) : Promise.reject(new Error(`no ${method}`));
      },
    }),
    environment: () => undefined,
    link: () => undefined,
    retry: (id: string) => retried.push(id),
  },
  useEnvironments: () => [
    { id: "local", name: "This Mac", routes: [], credentialRef: null },
    { id: "env_box", name: "box", routes: [], credentialRef: null },
  ],
  useEnvironmentStatus: (id: string) =>
    id === "env_box"
      ? { transport: "open", fresh: true, lastHello: null, lastError: null, nextRetryAt: null, route: 0, ...link }
      : { transport: "open", fresh: true, lastHello: null, lastError: null, nextRetryAt: null, route: 0 },
  useLastSeenAt: () => Date.now() - 5 * 60_000,
  forgetSeen: () => {},
}));
vi.mock("../../../lib/tcserver/link", () => ({ loadSavedEnvironments: async () => {} }));
vi.mock("../../../lib/macBridge", () => ({ useMacBridgeHosts: () => [] }));
vi.mock("../../../lib/hostDevices", () => ({ useHostDevicesHosts: () => null }));
vi.mock("../../../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../../../chrome/HostGlyph", () => ({ HostGlyph: () => null }));
vi.mock("../../../chrome/DeployDrift", () => ({
  DeployDriftMark: ({ environmentId }: { environmentId: string }) => <span data-deploy-drift={environmentId}>+3</span>,
}));
vi.mock("../../../stores/environment", () => ({ environment: { forget: () => {} } }));
vi.mock("./Deploy", () => ({ HostDeploy: () => null, LocalRelease: () => null, useJobPolling: () => {} }));
vi.mock("./Admission", () => ({ HostAdmission: () => null }));
vi.mock("../../../chrome/MacBridgeRemember", () => ({ MacBridgeRememberedSection: () => null }));
vi.mock("./Devices", () => ({ DevicesGroup: () => null, useDevicesPolling: () => {} }));
vi.mock("./MacBridgeGroup", () => ({ MacBridgeGroup: () => null, LoadLimitRow: () => null, useMacBridgePolling: () => {} }));

const { HostsPage } = await import("./HostsPage");
const { connectionMark } = await import("./HostSection");

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const header = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-environment-row="env_box"]')!;

beforeEach(() => {
  link = {};
});
afterEach(() => {
  cleanup();
  retried.length = 0;
  calls.length = 0;
});

describe("a paired host's section", () => {
  it("marks each link state with the shared vocabulary, and the retry countdown", () => {
    const at = (transport: EnvironmentStatus["transport"], extra: Partial<EnvironmentStatus> = {}) =>
      connectionMark({ transport, fresh: true, lastHello: null, lastError: null, nextRetryAt: null, route: 0, ...extra } as EnvironmentStatus, 1_000);
    expect(at("open")).toEqual({ state: "done", word: "Connected", detail: null });
    expect(at("reconnecting", { nextRetryAt: 5_000 })).toEqual({ state: "working", word: "Reconnecting", detail: "next try in 4 s" });
    expect(at("offline")).toMatchObject({ state: "stopped", word: "Offline" });
    expect(at("unauthorized")).toMatchObject({ state: "failed", word: "Sign in needed" });
  });

  it("names the host, its link, how it is reached and what its key may do, with the drift mark", async () => {
    const { container } = render(<HostsPage />);
    await flush();
    const row = header(container);
    expect(row.textContent).toContain("box");
    expect(row.querySelector("[data-connection]")?.textContent).toBe("Connected");
    expect([...row.querySelectorAll("[data-slot=facts] > span")].map((s) => s.textContent)).toEqual(["tempcode.landonhale.com", "operate, approve, admin"]);
    expect(row.querySelector('[data-deploy-drift="env_box"]')).not.toBeNull();
    expect(within(row).queryByText("Retry")).toBeNull();
    expect(within(row).queryByText("Pair again")).toBeNull();
  });

  it("offers Retry while offline with when it was seen, and Pair again for a refused key in red", async () => {
    link = { transport: "offline" };
    const { container, unmount } = render(<HostsPage />);
    await flush();
    let row = header(container);
    expect(row.textContent).toContain("seen 5m ago");
    fireEvent.click(within(row).getByText("Retry"));
    expect(retried).toEqual(["env_box"]);
    unmount();

    link = { transport: "unauthorized" };
    const second = render(<HostsPage />);
    await flush();
    row = header(second.container);
    expect(row.querySelector("[data-connection]")?.className).toContain("text-destructive");
    fireEvent.click(within(row).getByText("Pair again"));
    await flush();
    expect(screen.getByText("Pair box again")).toBeTruthy();
  });

  it("opens Rename and Routes from the host's menu", async () => {
    render(<HostsPage />);
    await flush();
    fireEvent.click(screen.getByLabelText("box actions"));
    await flush();
    fireEvent.click(await screen.findByText("Rename…"));
    await flush();
    expect(screen.getByText("Rename box")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    await flush();
    fireEvent.click(screen.getByLabelText("box actions"));
    await flush();
    fireEvent.click(await screen.findByText("Routes…"));
    await flush();
    expect(screen.getByText("Routes to box")).toBeTruthy();
  });

  it("removes the host only after the confirm", async () => {
    render(<HostsPage />);
    await flush();
    fireEvent.click(screen.getByLabelText("box actions"));
    await flush();
    fireEvent.click(await screen.findByText("Remove…"));
    await flush();
    expect(screen.getByText("This window forgets the host and its key. Nothing changes on the host.")).toBeTruthy();
    expect(calls.some((c) => c.method === "remote.environments.remove")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await flush();
    expect(calls.find((c) => c.method === "remote.environments.remove")?.params).toEqual({ id: "env_box" });
  });
});
