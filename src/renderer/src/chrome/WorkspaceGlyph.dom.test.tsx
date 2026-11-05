// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The repo icon the workspace's host answers, per test. */
const host = vi.hoisted(() => ({ icon: undefined as { dataUrl?: string | null; host?: string | null } | undefined }));
vi.mock("../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/workspaces")>()),
  useWorkspaceIcon: (id: string | null | undefined) => (id ? host.icon : undefined),
}));

import { saveTabGroupCustomColor, saveTabGroupLogo, saveTabGroupMascot } from "../lib/tabGroups";
import { WorkspaceGlyph, workspaceLook } from "./WorkspaceGlyph";

const api = window as unknown as { api: { app?: { logoUrl: (path: string) => string } } };
beforeEach(() => {
  api.api.app = { logoUrl: (path) => `tempcode-asset://logo/${path.split("/").pop()}` };
});
afterEach(() => {
  cleanup();
  delete api.api.app;
  host.icon = undefined;
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});

const glyph = (look: Partial<Parameters<typeof WorkspaceGlyph>[0]> = {}) =>
  render(
    <WorkspaceGlyph logoPath={null} mascotName={null} color="#c0ffee" projectKey="w-1" workspaceId="w-1" {...look} />,
  ).container;

describe("WorkspaceGlyph", () => {
  it("draws the logo lazily, invisible until it has loaded, on the small radius", () => {
    const root = glyph({ logoPath: "/logos/acme.png" });
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toMatch(/^tempcode-asset:\/\/logo\/acme\.png\?v=/);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.className).toContain("rounded-sm");
    expect(img.className.split(" ")).toContain("outline");
    expect(img.className).toContain("size-4");
    expect(img.className).toContain("invisible");
    fireEvent.load(img);
    expect(root.querySelector("img")!.className).not.toContain("invisible");
  });

  it("a logo that fails gives way to the repo icon, and that to the mascot", () => {
    host.icon = { dataUrl: "data:image/png;base64,AAAA" };
    const root = glyph({ logoPath: "/logos/gone.png" });
    act(() => fireEvent.error(root.querySelector("img")!));
    const repo = root.querySelector("img")!;
    expect(repo.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    act(() => fireEvent.error(repo));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("svg path")).not.toBeNull();
  });

  it("with no logo, the repo icon, or its host's mark when it has no image", () => {
    host.icon = { dataUrl: "data:image/png;base64,BBBB" };
    expect(glyph().querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,BBBB");
    cleanup();
    host.icon = { dataUrl: null, host: "github" };
    const root = glyph();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[data-workspace-host-mark]")).not.toBeNull();
  });

  it("a mascot picked on purpose wins over the repo icon, in the workspace's colour", () => {
    host.icon = { dataUrl: "data:image/png;base64,CCCC", host: "github" };
    const root = glyph({ mascotName: "cat", color: "#123456" });
    expect(root.querySelector("img, [data-workspace-host-mark]")).toBeNull();
    const svg = root.querySelector("svg")!;
    expect((svg as SVGElement).style.color).toBe("rgb(18, 52, 86)");
  });

  it("with nothing set and no repo icon, the hashed mascot; the mascot's box can be smaller", () => {
    const root = glyph({ workspaceId: null, className: "size-3.5", mascotClassName: "size-3" });
    const svg = root.querySelector("svg")!;
    expect(svg.querySelector("path")).not.toBeNull();
    expect(svg.getAttribute("class")).toBe("size-3");
  });
});

describe("workspaceLook", () => {
  it("reads the saved logo, mascot and colour under the key, else the defaults", () => {
    saveTabGroupLogo("w-1", "/logos/a.png");
    saveTabGroupMascot("w-1", "cat");
    saveTabGroupCustomColor("w-1", "#abcdef");
    expect(workspaceLook("w-1")).toEqual({ logoPath: "/logos/a.png", mascotName: "cat", color: "#abcdef" });
    const plain = workspaceLook("w-2");
    expect(plain.logoPath).toBeNull();
    expect(plain.mascotName).toBeNull();
    expect(plain.color).toMatch(/\S/);
  });
});
