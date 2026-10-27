// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  lsp: null as null | ((rows: unknown[]) => void),
  editor: null as null | { editor: string; effective: string | null; installed: Record<string, boolean> },
}));

vi.mock("../../lib/connection", () => ({
  registry: {
    primary: () => ({
      request: (method: string) =>
        method === "lsp.status"
          ? new Promise((resolve) => (host.lsp = resolve))
          : Promise.resolve({ java: { found: true, version: "21", jdtls: true, path: "/usr/lib/jvm/21" } }),
    }),
  },
}));
vi.mock("../../lib/tcserver/workspaces", () => ({ useProjects: () => [{ id: "p1", name: "Alpha" }] }));
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => host.editor, chooseEditorSetting: vi.fn() }));
vi.mock("../../lib/monaco/lspGate", () => ({ retryBlockedEnsures: vi.fn() }));
vi.mock("../../lib/sounds", () => ({ playCue: vi.fn() }));

const { EditorPage, lspFigures } = await import("./Editor");

beforeEach(() => {
  host.lsp = null;
  host.editor = null;
});
afterEach(cleanup);

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("Editor", () => {
  it("lays out its sections, the external editor only with a config", async () => {
    render(<EditorPage />);
    await act(async () => {});
    expect(headings()).toEqual(["Saving", "Completions", "Java", "Language servers"]);
    cleanup();
    host.editor = { editor: "auto", effective: "code", installed: { idea: false, code: true, xcode: false } };
    render(<EditorPage />);
    await act(async () => {});
    expect(headings()).toEqual(["Saving", "Completions", "Open files in", "Java", "Language servers"]);
    expect(screen.getByText("Found VS Code; Auto opens VS Code.")).toBeTruthy();
  });

  it("holds skeletons until the first poll answers", async () => {
    render(<EditorPage />);
    const servers = screen.getByRole("region", { name: "Language servers" });
    expect(servers.querySelectorAll("[data-slot=skeleton]")).toHaveLength(4);
    await act(async () => host.lsp?.([]));
    expect(screen.getByText("None running")).toBeTruthy();
  });

  it("names each server, its project and its figures", async () => {
    render(<EditorPage />);
    await act(async () =>
      host.lsp?.([
        { serverId: "s1", lang: "java", projectId: "p1", state: "running", memoryBytes: 512 * 1024 ** 2, idleMs: 180_000 },
        { serverId: "s2", lang: "web", projectId: "p1", state: "error", error: "Exited 1", idleMs: 0 },
      ]),
    );
    const servers = screen.getByRole("region", { name: "Language servers" });
    expect(servers.textContent).toContain("jdtls");
    expect(servers.textContent).toContain("512 MB");
    expect(servers.textContent).toContain("idle 3m");
    expect(screen.getByText("Exited 1").className).toContain("text-destructive");
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
  });

  it("shows the JDK and its path once the doctor answers", async () => {
    render(<EditorPage />);
    await act(async () => {});
    expect(screen.getByText("JDK 21, jdtls ready")).toBeTruthy();
    expect(screen.getByText("/usr/lib/jvm/21").className).toContain("font-mono");
  });

  it("words a server's figures", () => {
    expect(lspFigures({ state: "starting", idleMs: 0 } as never)).toEqual(["Starting…"]);
    expect(lspFigures({ state: "running", idleMs: 0 } as never)).toEqual(["Running"]);
  });
});
