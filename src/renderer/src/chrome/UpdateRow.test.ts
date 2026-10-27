// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterSnapshot } from "../lib/updater";
import { UpdateRow, updateRowState, type UpdateRowState } from "./UpdateRow";

afterEach(cleanup);

const snap = (over: Partial<UpdaterSnapshot>): UpdaterSnapshot => ({ phase: "idle", currentVersion: "1.0.10", ...over });

describe("updateRowState", () => {
  it("says nothing while idle, checking or current", () => {
    for (const phase of ["idle", "checking", "current"] as const) {
      expect(updateRowState(snap({ phase }), null)).toBeNull();
    }
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
