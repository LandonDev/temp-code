// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildConfig } from "@server/shared/build";

const state = vi.hoisted(() => ({
  config: null as BuildConfig | null | "pending",
  detected: { command: "bun run build", outputs: "out/**" } as BuildConfig | null,
  set: vi.fn(),
  failSet: false,
}));

vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [{ id: "w1", name: "Alpha", path: "/w/alpha", environmentId: "local" }],
}));
vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: () => ({
      request: (method: string, params: unknown) => {
        if (method === "build.get") return state.config === "pending" ? new Promise(() => {}) : Promise.resolve(state.config);
        if (method === "build.detect") return Promise.resolve(state.detected);
        state.set(method, params);
        return state.failSet ? Promise.reject(new Error("build.set refused")) : Promise.resolve(null);
      },
    }),
  },
}));

const { BuildEditor, openBuildSettings, takeRequestedBuildFocus } = await import("./buildSettings");
const { OPEN_SETTINGS_EVENT } = await import("../../lib/monaco/debugTab");

beforeEach(() => {
  state.config = null;
  state.failSet = false;
  state.set.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BuildEditor", () => {
  it("shows skeleton rows before build.get answers", () => {
    state.config = "pending";
    render(<BuildEditor workspaceId="w1" />);
    expect(screen.getByTestId("build-skeleton")).toBeTruthy();
  });

  it("shows the detected command as the placeholder", async () => {
    render(<BuildEditor workspaceId="w1" />);
    const command = (await screen.findByRole("textbox", { name: "Build command" })) as HTMLInputElement;
    expect(command.placeholder).toBe("bun run build");
    expect(command.closest("[data-slot=page-row]")).toBeTruthy();
  });

  it("saves the trimmed config once, 500ms after typing", async () => {
    render(<BuildEditor workspaceId="w1" />);
    const command = await screen.findByRole("textbox", { name: "Build command" });
    vi.useFakeTimers();
    fireEvent.change(command, { target: { value: " make" } });
    fireEvent.change(command, { target: { value: " make all " } });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(state.set).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(state.set).toHaveBeenCalledTimes(1);
    expect(state.set).toHaveBeenCalledWith("build.set", { workspaceId: "w1", config: { command: "make all", outputs: "" } });
  });
});

describe("BuildEditor errors", () => {
  it("shows a failed save under the fields", async () => {
    state.failSet = true;
    render(<BuildEditor workspaceId="w1" />);
    const command = await screen.findByRole("textbox", { name: "Build command" });
    vi.useFakeTimers();
    fireEvent.change(command, { target: { value: "make" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    expect((await screen.findByText("build.set refused")).className).toContain("text-destructive");
  });
});

describe("openBuildSettings", () => {
  it("opens the workspace's page and asks for the Build section once", () => {
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, listen);
    openBuildSettings("w1");
    window.removeEventListener(OPEN_SETTINGS_EVENT, listen);
    expect(seen).toEqual(["ws:w1"]);
    expect(takeRequestedBuildFocus()).toBe(true);
    expect(takeRequestedBuildFocus()).toBe(false);
  });
});
