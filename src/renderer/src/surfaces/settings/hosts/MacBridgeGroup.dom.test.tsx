// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";

/**
 * A host's Mac bridge group: the Access select sets the policy, the line
 * under it follows the policy, and Settings… opens the host's dialog.
 */

const policies: { id: string; policy: string }[] = [];
vi.mock("../../../lib/macBridge", () => ({
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
  setMacBridgeShowRunning: async () => {},
}));
vi.mock("../../../chrome/MacBridgeRunning", () => ({ MacBridgeRunningList: () => null }));
vi.mock("../../../lib/portForwards", () => ({ useHostForwards: () => null, setForwarding: async () => {} }));
vi.mock("../../../lib/devPorts", () => ({ openUrl: () => {} }));
vi.mock("../../../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../../../lib/fs", () => ({ pickFolder: async () => null }));

const { MacBridgeGroup, POLICY_TEXT } = await import("./MacBridgeGroup");

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
});

describe("MacBridgeGroup", () => {
  it("says what each policy lets the host do", () => {
    for (const policy of ["off", "read", "read+run", "full"] as const) {
      const { unmount } = render(<MacBridgeGroup host={host({ policy })} />);
      expect(screen.getByText(POLICY_TEXT[policy])).toBeTruthy();
      unmount();
    }
    expect(POLICY_TEXT.read).toBe("Reads shared folders and projects; asks for the rest");
  });

  it("sets the policy from the Access select", async () => {
    render(<MacBridgeGroup host={host()} />);
    fireEvent.click(screen.getByLabelText("What box may do on this Mac"));
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

  it("opens the host's Mac bridge settings", async () => {
    render(<MacBridgeGroup host={host()} />);
    fireEvent.click(screen.getByText("Settings…"));
    await flush();
    expect(screen.getByText("Mac bridge on box")).toBeTruthy();
  });
});
