// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";

/**
 * A host's Mac bridge group: the Access select sets the policy, the line
 * under it follows the policy, and Settings… opens the host's dialog.
 */

const policies: { id: string; policy: string }[] = [];
const switches: { id: string; on: boolean }[] = [];
let failSwitch = false;
vi.mock("../../../lib/macBridge", () => ({
  setMacBridgeComputer: async (id: string, on: boolean) => {
    if (failSwitch) throw new Error("unknown host: env_box");
    switches.push({ id, on });
  },
  setMacBridgePolicy: async (id: string, policy: string) => {
    policies.push({ id, policy });
  },
  refreshMacBridgeHosts: async () => [],
  refreshMacBridgeLoad: async () => null,
  setMacBridgeLoadLimit: async () => {},
  useMacBridgeLoad: () => null,
  useMacBridgeHosts: () => [],
  setMacBridgeLimits: async () => {},
  setMacBridgeShared: async () => {},
}));
vi.mock("../../../chrome/MacBridgeRunning", () => ({ MacBridgeRunningList: () => null }));
vi.mock("../../../lib/portForwards", () => ({ useHostForwards: () => null, setForwarding: async () => {} }));
vi.mock("../../../lib/devPorts", () => ({ openUrl: () => {} }));
vi.mock("../../../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../../../lib/fs", () => ({ pickFolder: async () => null }));

const { COMPUTER_TEXT, MacBridgeGroup, POLICY_TEXT } = await import("./MacBridgeGroup");

const host = (over: Partial<MacBridgeHostPolicy> = {}): MacBridgeHostPolicy => ({
  environmentId: "env_box",
  name: "box",
  policy: "read",
  shared: [],
  showRunning: true,
  registered: true,
  maxRunning: 4,
  maxThreads: 2,
  running: 0,
  held: 0,
  threads: 0,
  computer: false,
  computerUnavailable: null,
  maxComputer: 2,
  computerLive: 0,
  ...over,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

afterEach(() => {
  cleanup();
  policies.length = 0;
  switches.length = 0;
  failSwitch = false;
});

describe("MacBridgeGroup", () => {
  it("says what each policy lets the host do", () => {
    for (const policy of ["off", "read", "read+run", "full"] as const) {
      const { unmount } = render(<MacBridgeGroup host={host({ policy })} />);
      expect(screen.getByText(POLICY_TEXT[policy])).toBeTruthy();
      unmount();
    }
    expect(POLICY_TEXT.read).toBe("Reads shared folders and projects; asks for the rest.");
  });

  it("says when the host cannot reach this Mac", () => {
    const { container, unmount } = render(<MacBridgeGroup host={host({ registered: false })} />);
    expect(container.querySelector("[data-mac-bridge-unregistered]")?.textContent).toBe("Not connected to this Mac right now.");
    unmount();
    const live = render(<MacBridgeGroup host={host()} />);
    expect(live.container.querySelector("[data-mac-bridge-unregistered]")).toBeNull();
  });

  it("sets the policy from the Access select", async () => {
    render(<MacBridgeGroup host={host()} />);
    fireEvent.click(await screen.findByLabelText("What box may do on this Mac"));
    await flush();
    const option = await screen.findByRole("option", { name: "Read and run" });
    await flush();
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(option, { button: 0 });
    fireEvent.click(option);
    await flush();
    expect(policies).toEqual([{ id: "env_box", policy: "read+run" }]);
  });

  it("shows Computer use under Access only above Off, and the switch saves", async () => {
    const off = render(<MacBridgeGroup host={host({ policy: "off" })} />);
    expect(off.container.querySelector("[data-mac-bridge-computer]")).toBeNull();
    off.unmount();
    const { container } = render(<MacBridgeGroup host={host()} />);
    const row = container.querySelector("[data-mac-bridge-computer]");
    expect(row?.getAttribute("data-mac-bridge-computer")).toBe("off");
    expect(row?.textContent).toContain(COMPUTER_TEXT);
    fireEvent.click(screen.getByLabelText("Computer use for box"));
    await flush();
    expect(switches).toEqual([{ id: "env_box", on: true }]);
  });

  it("disables the switch with the reason where computer use cannot run here", () => {
    const { container } = render(<MacBridgeGroup host={host({ computerUnavailable: "tc-computer is not built" })} />);
    expect(container.querySelector("[data-mac-bridge-computer]")?.textContent).toContain("Unavailable here: tc-computer is not built");
    const toggle = screen.getByLabelText("Computer use for box");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a switch that did not save under its row", async () => {
    failSwitch = true;
    const { container } = render(<MacBridgeGroup host={host()} />);
    fireEvent.click(screen.getByLabelText("Computer use for box"));
    await flush();
    expect(container.querySelector("[data-mac-bridge-computer]")?.textContent).toContain("unknown host: env_box");
  });

  it("opens the host's Mac bridge settings", async () => {
    render(<MacBridgeGroup host={host()} />);
    fireEvent.click(screen.getByText("Settings…"));
    await flush();
    expect(screen.getByText("Mac bridge on box")).toBeTruthy();
  });
});
