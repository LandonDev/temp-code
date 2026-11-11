// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerAppVerdict, ComputerServiceState, ComputerSettings } from "@server/shared/contract-computer";

type Handler = (params: unknown) => Promise<unknown>;
const host = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  calls: [] as [string, unknown][],
  pushes: new Set<(p: unknown) => void>(),
  service: null as ComputerServiceState | null,
  serviceListeners: new Set<() => void>(),
  openUrl: vi.fn(),
}));

const link = {
  environmentId: "local",
  connected: true,
  onOpen: () => () => {},
  onPush: (fn: (p: unknown) => void) => {
    host.pushes.add(fn);
    return () => host.pushes.delete(fn);
  },
  request: (method: string, params: unknown) => {
    host.calls.push([method, params]);
    const handler = host.handlers[method];
    return handler ? handler(params) : new Promise(() => {});
  },
};
vi.mock("../../lib/connection", () => ({ registry: { primary: () => link } }));
vi.mock("../../lib/native", () => ({ openUrl: (url: string) => host.openUrl(url) }));
vi.mock("../../lib/computerSessions", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (fn: () => void) => {
    host.serviceListeners.add(fn);
    return () => host.serviceListeners.delete(fn);
  };
  return {
    useComputerService: () => useSyncExternalStore(subscribe, () => host.service),
    setComputerService: (_id: string, s: ComputerServiceState) => {
      host.service = s;
      host.serviceListeners.forEach((fn) => fn());
    },
  };
});

const { ComputerPage } = await import("./Computer");

const SERVICE: ComputerServiceState = { state: "idle", restarts: 0, permissions: null };
const app = (bundleId: string, name: string | null, classes: ComputerAppVerdict["classes"] = {}): ComputerAppVerdict => ({ bundleId, name, classes, updatedAt: 1 });
const SETTINGS: ComputerSettings = { sessionIdleMs: 120_000, apps: [app("com.apple.TextEdit", "TextEdit"), app("com.google.Chrome", "Chrome", { click: "session", type: "session" })] };
const GRANTED = { accessibility: true, screenRecording: true };
const answer = (value: unknown): Handler => async () => value;
const calls = (method: string) => host.calls.filter(([m]) => m === method);
const section = (title: string) => screen.getByRole("heading", { name: title }).closest("[data-slot=page-section]") as HTMLElement;
const firstSection = () => document.querySelectorAll<HTMLElement>("[data-slot=page-section]")[0];
const settle = () => act(async () => {});

beforeEach(() => {
  host.handlers = {
    "computer.settings.get": answer(SETTINGS),
    "computer.permissions": answer(GRANTED),
  };
  host.calls = [];
  host.pushes.clear();
  host.service = SERVICE;
  host.openUrl.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Settings › Computer use", () => {
  it("holds a skeleton in each section while the host is silent", () => {
    host.handlers = {};
    host.service = null;
    render(<ComputerPage />);
    expect(firstSection().querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(1);
    expect(within(section("Permissions")).getAllByTestId("permission-skeleton")).toHaveLength(2);
    expect(section("Apps").querySelector("[aria-busy=true]")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says a refused read with Retry, and asks again", async () => {
    let refuse = true;
    host.handlers["computer.settings.get"] = async () => {
      if (refuse) throw new Error("forbidden: computer.settings.get");
      return SETTINGS;
    };
    render(<ComputerPage />);
    await settle();
    expect(within(firstSection()).getByRole("alert").textContent).toBe("forbidden: computer.settings.get");
    expect(within(section("Apps")).getByRole("alert")).toBeTruthy();
    refuse = false;
    fireEvent.click(within(firstSection()).getByRole("button", { name: "Retry" }));
    await settle();
    expect(calls("computer.settings.get")).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Take the screen after minutes" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["up", "Running", null],
    ["off", "Idle", null],
    ["idle", "Idle", null],
    ["starting", "Starting", null],
    ["down", "Down", "Crashed 5 times"],
    ["unavailable", "Unavailable", "tc-computer is not built"],
  ] as const)("words the service %s as %s", async (state, word, detail) => {
    host.service = { ...SERVICE, state, reason: state === "unavailable" ? "tc-computer is not built" : undefined, permissions: state === "up" ? GRANTED : null };
    render(<ComputerPage />);
    await settle();
    const mark = firstSection().querySelector("[data-slot=status-mark]")!;
    expect(mark.textContent).toContain(word);
    if (detail) expect(mark.textContent).toContain(detail);
    expect(!!mark.querySelector("[data-slot=status-glyph]")).toBe(state !== "off" && state !== "idle");
    expect(!!screen.queryByRole("button", { name: "Try again" })).toBe(state === "down");
  });

  it("Try again asks the host and shows the state it answers", async () => {
    host.service = { ...SERVICE, state: "down", reason: "tc-computer crashed 5 times in two minutes: x" };
    host.handlers["computer.service.retry"] = answer({ ...SERVICE, state: "up", permissions: GRANTED });
    render(<ComputerPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(calls("computer.service.retry")).toHaveLength(1);
    expect(firstSection().querySelector("[data-slot=status-mark]")!.textContent).toContain("Running");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the threshold in minutes and commits milliseconds; a refusal snaps back with the host's line", async () => {
    let refuse = false;
    host.handlers["computer.settings.set"] = async (params) => {
      if (refuse) throw new Error("the host refused it");
      return { ...SETTINGS, ...(params as object) };
    };
    render(<ComputerPage />);
    await settle();
    const field = screen.getByRole("textbox", { name: "Take the screen after minutes" }) as HTMLInputElement;
    expect(field.value).toBe("2");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    await settle();
    expect(calls("computer.settings.set")).toEqual([["computer.settings.set", { sessionIdleMs: 300_000 }]]);
    expect(field.value).toBe("5");
    refuse = true;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.blur(field);
    await settle();
    expect(field.value).toBe("5");
    expect(screen.getByText("the host refused it")).toBeTruthy();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "61" } });
    fireEvent.blur(field);
    await settle();
    expect(calls("computer.settings.set")).toHaveLength(2);
    expect(field.value).toBe("5");
  });

  it("offers Grant… only for a missing grant, opening its pane", async () => {
    host.handlers["computer.permissions"] = answer({ accessibility: true, screenRecording: false });
    render(<ComputerPage />);
    await settle();
    const perms = section("Permissions");
    expect(within(perms).getByText("Granted")).toBeTruthy();
    expect(within(perms).getByText("Not granted")).toBeTruthy();
    const grants = within(perms).getAllByRole("button", { name: /^Grant / });
    expect(grants).toHaveLength(1);
    fireEvent.click(within(perms).getByRole("button", { name: "Grant Screen Recording in System Settings" }));
    expect(host.openUrl).toHaveBeenCalledWith(expect.stringContaining("Privacy_ScreenCapture"));
  });

  it("polls the grants every 5 s only while one is off, and reads the service's own while it is up", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let perms = { accessibility: false, screenRecording: true };
    host.handlers["computer.permissions"] = async () => perms;
    render(<ComputerPage />);
    await settle();
    expect(calls("computer.permissions")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(calls("computer.permissions")).toHaveLength(2);
    perms = GRANTED;
    await act(async () => vi.advanceTimersByTime(5000));
    expect(calls("computer.permissions")).toHaveLength(3);
    await act(async () => vi.advanceTimersByTime(15000));
    expect(calls("computer.permissions")).toHaveLength(3);
    // the service up: its grants, live, and no asking even with one off
    act(() => {
      host.service = { ...SERVICE, state: "up", permissions: { accessibility: true, screenRecording: false } };
      host.serviceListeners.forEach((fn) => fn());
    });
    expect(within(section("Permissions")).getByText("Not granted")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(15000));
    expect(calls("computer.permissions")).toHaveLength(3);
  });

  it("says a null permissions answer as one line with Retry", async () => {
    let value: unknown = null;
    host.handlers["computer.permissions"] = async () => value;
    render(<ComputerPage />);
    await settle();
    const perms = section("Permissions");
    expect(within(perms).getByRole("alert").textContent).toBe("Couldn't read the permissions");
    value = GRANTED;
    fireEvent.click(within(perms).getByRole("button", { name: "Retry" }));
    await settle();
    expect(within(perms).getAllByText("Granted")).toHaveLength(2);
  });

  it("lists the apps that may take the screen first, then by name, with a line only for those", async () => {
    host.handlers["computer.settings.get"] = answer({ ...SETTINGS, apps: [...SETTINGS.apps, app("dev.unnamed", null)] });
    render(<ComputerPage />);
    await settle();
    const rows = [...section("Apps").querySelectorAll<HTMLElement>("[data-slot=page-row]")];
    expect(rows.map((r) => r.querySelector("[data-slot=item-title]")!.textContent)).toEqual(["Chrome", "dev.unnamed", "TextEdit"]);
    expect(rows[0].textContent).toContain("May take the screen to click and type");
    expect(rows[1].querySelector("[data-slot=item-description]")).toBeNull();
    expect(rows[2].querySelector("[data-slot=item-description]")).toBeNull();
    expect(section("Apps").textContent).not.toMatch(/session|process/);
  });

  it("forgets one app and every app, Forget all only with two or more", async () => {
    host.handlers["computer.verdicts.forget"] = async (params) => {
      const { bundleId } = params as { bundleId: string | null };
      return { ...SETTINGS, apps: bundleId === null ? [] : SETTINGS.apps.filter((a) => a.bundleId !== bundleId) };
    };
    render(<ComputerPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Forget TextEdit" }));
    await settle();
    expect(calls("computer.verdicts.forget")).toEqual([["computer.verdicts.forget", { bundleId: "com.apple.TextEdit" }]]);
    expect(screen.queryByRole("button", { name: "Forget TextEdit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forget all" })).toBeNull();
    cleanup();
    host.calls = [];
    render(<ComputerPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Forget all" }));
    await settle();
    expect(calls("computer.verdicts.forget")).toEqual([["computer.verdicts.forget", { bundleId: null }]]);
    expect(within(section("Apps")).getByText("No apps used yet")).toBeTruthy();
  });

  it("says no apps in the row's place", async () => {
    host.handlers["computer.settings.get"] = answer({ ...SETTINGS, apps: [] });
    render(<ComputerPage />);
    await settle();
    expect(section("Apps").querySelector("[data-slot=page-empty]")!.textContent).toBe("No apps used yet");
    expect(screen.queryByRole("button", { name: /^Forget/ })).toBeNull();
  });

  it("follows the computer-settings push", async () => {
    render(<ComputerPage />);
    await settle();
    act(() => host.pushes.forEach((fn) => fn({ push: "computer-settings", settings: { sessionIdleMs: 600_000, apps: [app("com.apple.Notes", "Notes")] } })));
    expect((screen.getByRole("textbox", { name: "Take the screen after minutes" }) as HTMLInputElement).value).toBe("10");
    expect(screen.getByRole("button", { name: "Forget Notes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forget TextEdit" })).toBeNull();
  });
});
