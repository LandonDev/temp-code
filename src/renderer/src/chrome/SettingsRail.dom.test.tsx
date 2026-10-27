// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment } from "../lib/connection";
import type { WorkspaceMeta } from "../lib/tcserver/types";
import { SettingsNav } from "./SettingsRail";

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

  it("names another host's workspace as muted trailing text, never after a middle dot", () => {
    hosts([env("local", "This Mac"), env("env_box", "box")]);
    workspaces.list = [ws("w1", "temp-code", "local"), ws("w2", "temp-code", "env_box")];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual([null, "box"]);
    expect(container.textContent).not.toContain("·");
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
