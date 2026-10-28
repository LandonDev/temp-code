// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateStore } from "../lib/updateStore";
import type { UpdaterSnapshot } from "../lib/updater";
import { UpdateRow, updateRowState, useUpdateRowState, type UpdateRowState } from "./UpdateRow";

const web = vi.hoisted(() => ({ on: false }));
vi.mock("../lib/nativeWeb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/nativeWeb")>()),
  isWebMode: () => web.on,
}));

afterEach(cleanup);

const snap = (over: Partial<UpdaterSnapshot>): UpdaterSnapshot => ({ phase: "idle", currentVersion: "1.0.10", ...over });

describe("updateRowState", () => {
  it("offers a check with the running version while idle, current or after a failed check", () => {
    for (const phase of ["idle", "current", "error"] as const) {
      expect(updateRowState(snap({ phase }), null)).toEqual({ kind: "check", version: "v1.0.10" });
    }
  });

  it("says Checking… only while a check the person asked for runs", () => {
    expect(updateRowState(snap({ phase: "checking" }), null, true)).toEqual({ kind: "checking", version: "v1.0.10" });
    expect(updateRowState(snap({ phase: "checking" }), null, false)).toEqual({ kind: "check", version: "v1.0.10" });
  });

  it("names no version before the first status", () => {
    expect(updateRowState(snap({ currentVersion: "…" }), null)).toEqual({ kind: "check", version: undefined });
  });

  it("names a waiting version, a retry and a download in hand", () => {
    expect(updateRowState(snap({ phase: "available", availableVersion: "1.0.11", notes: "n" }), null)).toEqual({
      kind: "available",
      version: "1.0.11",
      notes: "n",
      retry: false,
      error: undefined,
    });
    expect(
      updateRowState(snap({ phase: "error", availableVersion: "1.0.11", canApply: true, error: "network" }), null),
    ).toMatchObject({ kind: "available", retry: true, error: "network" });
    expect(updateRowState(snap({ phase: "downloading", percent: 42 }), null)).toEqual({ kind: "downloading", percent: 42 });
    expect(updateRowState(snap({ phase: "ready" }), { version: "1.0.9" })).toEqual({ kind: "ready" });
  });

  it("says the update that just landed when there is nothing newer", () => {
    expect(updateRowState(snap({ phase: "current" }), { version: "1.0.10" })).toEqual({ kind: "updated", version: "1.0.10" });
  });
});

function mount(state: UpdateRowState | null) {
  const props = { onOpenWhatsNew: vi.fn(), onInstall: vi.fn(), onDismiss: vi.fn() };
  const view = render(createElement(UpdateRow, { state, ...props }));
  return { ...props, view };
}

describe("UpdateRow", () => {
  it("draws no row without a state", () => {
    expect(mount(null).view.container.innerHTML).toBe("");
  });

  it("idle: Check for updates with the running version, which asks the feed", () => {
    const onCheck = vi.fn();
    render(createElement(UpdateRow, { state: { kind: "check", version: "v1.0.307" }, onCheck }));
    const row = screen.getByRole("button", { name: /^Check for updates/ });
    expect(row.textContent).toContain("v1.0.307");
    fireEvent.click(row);
    expect(onCheck).toHaveBeenCalledOnce();
  });

  it("checking: Checking… with the spinner, disabled", () => {
    render(createElement(UpdateRow, { state: { kind: "checking", version: "v1.0.307" } }));
    const row = screen.getByRole("button", { name: /^Checking…/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  it("just updated: the row opens What's new and its hover action dismisses", () => {
    const { onOpenWhatsNew, onDismiss } = mount({ kind: "updated", version: "1.0.10" });
    fireEvent.click(screen.getByRole("button", { name: /^Updated to 1\.0\.10/ }));
    expect(onOpenWhatsNew).toHaveBeenCalledWith("1.0.10");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("available: the row installs, and the notes are its hover action", () => {
    const { onInstall, onOpenWhatsNew } = mount({ kind: "available", version: "1.0.11", notes: "# notes", retry: false });
    fireEvent.click(screen.getByRole("button", { name: "Update to 1.0.11" }));
    expect(onInstall).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(onOpenWhatsNew).toHaveBeenCalledWith("1.0.11", "# notes");
  });

  it("available without notes has no hover action; a retry says so", () => {
    mount({ kind: "available", version: "1.0.11", retry: true });
    expect(screen.getByRole("button", { name: "Retry update" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "What's new" })).toBeNull();
  });

  it("downloading shows its percentage; ready restarts", () => {
    mount({ kind: "downloading", percent: 42 });
    expect(screen.getByText("42%")).toBeTruthy();
    cleanup();
    const { onInstall } = mount({ kind: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(onInstall).toHaveBeenCalledOnce();
  });
});

describe("useUpdateRowState", () => {
  function Probe() {
    const state = useUpdateRowState();
    return createElement("span", { "data-kind": state?.kind ?? "none" });
  }

  afterEach(() => {
    web.on = false;
    updateStore.stop();
  });

  it("is always a row in the desktop app, and none at /ui", () => {
    const desktop = render(createElement(Probe));
    expect(desktop.container.querySelector("span")?.getAttribute("data-kind")).toBe("check");
    cleanup();
    web.on = true;
    const page = render(createElement(Probe));
    expect(page.container.querySelector("span")?.getAttribute("data-kind")).toBe("none");
  });
});
