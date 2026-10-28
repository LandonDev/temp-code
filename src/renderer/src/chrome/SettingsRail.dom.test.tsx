// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment } from "../lib/connection";
import type { WorkspaceMeta } from "../lib/tcserver/types";
import { SettingsNav, workspaceHint } from "./SettingsRail";
import { asWebPage } from "../test/webMode";

const workspaces = vi.hoisted(() => ({ list: [] as WorkspaceMeta[] }));
vi.mock("../lib/tcserver/workspaces", () => ({ useWorkspaces: () => workspaces.list }));

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const ws = (id: string, name: string, environmentId: string): WorkspaceMeta =>
  ({ id, name, path: `/w/${id}`, environmentId, createdAt: 1 }) as WorkspaceMeta;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function hosts(environments: Environment[]) {
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue(environments);
  vi.spyOn(registry, "primaryEnvironmentId", "get").mockReturnValue("local");
}

describe("SettingsNav", () => {
  it("marks the page on screen with aria-current and goes to another on a click", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    const onSelect = vi.fn();
    render(<SettingsNav section="general" onSelect={onSelect} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(onSelect).toHaveBeenCalledWith("appearance");
  });

  it("lists Appshots in the desktop app and leaves it out at /ui", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Appshots" })).toBeTruthy();
    cleanup();
    const restore = asWebPage();
    try {
      render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
      expect(screen.queryByRole("button", { name: "Appshots" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reviews" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("names another host's workspace as muted trailing text, never after a middle dot", () => {
    hosts([env("local", "This Mac"), env("env_box", "box")]);
    workspaces.list = [ws("w1", "temp-code", "local"), ws("w2", "temp-code", "env_box")];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual([null, "box"]);
    expect(container.textContent).not.toContain("·");
  });

  it("tells two workspaces of one name on one host apart by their parent folder, and says nothing without a collision", () => {
    hosts([env("local", "This Mac"), env("env_box", "box")]);
    workspaces.list = [
      { ...ws("w1", "app", "local"), path: "/Users/me/work/app" },
      { ...ws("w2", "app", "local"), path: "/Users/me/old/app" },
      ws("w3", "solo", "local"),
      { ...ws("w4", "app", "env_box"), path: "/srv/app" },
    ];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    // The host still wins on another host's row.
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual(["work", "old", null, "box"]);
  });

  it("names the parent's path as far as it differs, and the whole path when the parents are one folder", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [
      { ...ws("w1", "app", "local"), path: "/Users/me/work/app" },
      { ...ws("w2", "app", "local"), path: "/Users/you/work/app" },
      { ...ws("w3", "site", "local"), path: "/srv/site" },
      { ...ws("w4", "site", "local"), path: "/srv/site/" },
    ];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual([
      "me/work",
      "you/work",
      "/srv/site",
      "/srv/site/",
    ]);
  });

  it("workspaceHint: no twin, no hint; a parent that differs by name, its name", () => {
    const a = { ...ws("a", "x", "local"), path: "/p/one/x" };
    const b = { ...ws("b", "x", "local"), path: "/p/two/x" };
    expect(workspaceHint(a, [])).toBeNull();
    expect(workspaceHint(a, [b])).toBe("one");
  });

  it("ends in Back at the foot", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    const onClose = vi.fn();
    render(<SettingsNav section="general" onSelect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
