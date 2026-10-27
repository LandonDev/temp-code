// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  lsp: null as null | ((rows: unknown[]) => void),
  eula: null as null | ((eula: { build: string; text: string }) => void),
  check: null as null | ((r: { current: string; latest: string; updated: boolean }) => void),
  engine: undefined as undefined | { dist: boolean; accepted: boolean; build: string },
  editor: null as null | { editor: string; effective: string | null; installed: Record<string, boolean> },
}));

vi.mock("../../lib/connection", () => ({
  registry: {
    primary: () => ({
      request: (method: string) =>
        method === "lsp.status"
          ? new Promise((resolve) => (host.lsp = resolve))
          : method === "idea.eula"
            ? new Promise((resolve) => (host.eula = resolve))
            : method === "idea.checkUpdate"
              ? new Promise((resolve) => (host.check = resolve))
              : Promise.resolve({ java: { found: true, version: "21", jdtls: true, path: "/usr/lib/jvm/21", ideaServer: host.engine } }),
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

  it("reads the EULA in a dialog: a spinner while it downloads, then the text, Cancel and the verb", async () => {
    render(<EditorPage />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept EULA" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("heading", { name: "JetBrains EULA" })).toBeTruthy();
    expect(dialog.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept and enable" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => host.eula?.({ build: "263.1", text: "You may use it." }));
    expect(screen.getByText("You may use it.")).toBeTruthy();
    expect(screen.getByText("intellij-server 263.1")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept and enable" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" }).dataset.variant).toBe("secondary");
  });

  it("shows a spinner in Check for update while it checks", async () => {
    host.engine = { dist: true, accepted: true, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    const check = screen.getByRole("button", { name: /Check for update/ });
    await act(async () => {
      fireEvent.click(check);
    });
    expect(check.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect((check as HTMLButtonElement).disabled).toBe(true);
    await act(async () => host.check?.({ current: "263.1", latest: "263.1", updated: false }));
    expect(check.querySelector("[data-slot=spinner]")).toBeNull();
    expect(screen.getByText("Up to date.")).toBeTruthy();
    host.engine = undefined;
  });
});
