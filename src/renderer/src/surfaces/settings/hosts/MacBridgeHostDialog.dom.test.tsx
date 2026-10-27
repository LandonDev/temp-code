// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";

/**
 * A host's Mac bridge settings dialog: the caps commit and snap back, the
 * commands cap only under a policy that runs commands, a shared folder is
 * added and removed, forwarding calls its setter, and there is no "Show
 * running commands" switch (a running call is never a card).
 */

const calls: { method: string; args: unknown[] }[] = [];
const record =
  (method: string) =>
  async (...args: unknown[]) => {
    calls.push({ method, args });
  };
vi.mock("../../../lib/macBridge", () => ({
  useMacBridgeHosts: () => [],
  setMacBridgeLimits: record("limits"),
  setMacBridgeShared: record("shared"),
}));
vi.mock("../../../lib/portForwards", () => ({
  useHostForwards: () => ({ environmentId: "env_box", enabled: true, forwards: [] }),
  setForwarding: record("forwarding"),
}));
vi.mock("../../../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../../../lib/fs", () => ({ pickFolder: async () => "/Users/me/picked" }));

const { MacBridgeHostDialog } = await import("./MacBridgeHostDialog");

const host = (over: Partial<MacBridgeHostPolicy> = {}): MacBridgeHostPolicy => ({
  environmentId: "env_box",
  name: "box",
  policy: "read+run",
  shared: ["/Users/me/shared"],
  showRunning: true,
  registered: true,
  maxRunning: 4,
  maxThreads: 2,
  running: 1,
  held: 2,
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
  calls.length = 0;
});

describe("MacBridgeHostDialog", () => {
  it("commits a cap in range and snaps a bad one back", async () => {
    render(<MacBridgeHostDialog host={host()} onClose={() => {}} />);
    const commands = screen.getByLabelText("Commands and jobs running at once from box") as HTMLInputElement;
    fireEvent.change(commands, { target: { value: "0" } });
    fireEvent.blur(commands);
    await flush();
    expect(commands.value).toBe("4");
    expect(calls).toEqual([]);
    fireEvent.change(commands, { target: { value: "6" } });
    fireEvent.blur(commands);
    await flush();
    expect(calls).toEqual([{ method: "limits", args: ["env_box", { maxRunning: 6 }] }]);
    const threads = screen.getByLabelText("Threads box may start on this Mac at once") as HTMLInputElement;
    fireEvent.change(threads, { target: { value: "0" } });
    fireEvent.blur(threads);
    await flush();
    expect(calls.at(-1)).toEqual({ method: "limits", args: ["env_box", { maxThreads: 0 }] });
  });

  it("hides the commands cap under Read", () => {
    render(<MacBridgeHostDialog host={host({ policy: "read" })} onClose={() => {}} />);
    expect(screen.queryByLabelText("Commands and jobs running at once from box")).toBeNull();
    expect(screen.getByLabelText("Threads box may start on this Mac at once")).toBeTruthy();
  });

  it("adds a folder by path and removes one", async () => {
    render(<MacBridgeHostDialog host={host()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Folder to share"), { target: { value: "/Users/me/docs" } });
    fireEvent.click(screen.getByText("Add"));
    await flush();
    expect(calls).toEqual([{ method: "shared", args: ["env_box", ["/Users/me/shared", "/Users/me/docs"]] }]);
    fireEvent.click(screen.getByText("Remove"));
    await flush();
    expect(calls.at(-1)).toEqual({ method: "shared", args: ["env_box", []] });
  });

  it("forwarding calls its setter, no switch shows running commands, and Done closes", async () => {
    const onClose = vi.fn();
    render(<MacBridgeHostDialog host={host()} onClose={onClose} />);
    expect(screen.queryByText("Show running commands")).toBeNull();
    fireEvent.click(screen.getByLabelText("Forward box's dev servers to this Mac"));
    await flush();
    expect(calls).toEqual([{ method: "forwarding", args: ["env_box", false] }]);
    fireEvent.click(screen.getByText("Done"));
    expect(onClose).toHaveBeenCalled();
  });
});
