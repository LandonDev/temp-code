// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";

const host = vi.hoisted(() => ({
  accept: null as null | (() => void),
  refuse: null as null | ((e: Error) => void),
  acceptCalls: 0,
  lsp: null as null | ((rows: unknown[]) => void),
  eula: null as null | ((eula: { build: string; text: string }) => void),
  check: null as null | ((r: { current: string; latest: string; updated: boolean }) => void),
  engine: undefined as undefined | { dist: boolean; accepted: boolean; build: string },
  editor: null as null | { editor: string; effective: string | null; installed: Record<string, boolean> },
  doctorFails: false,
}));

vi.mock("../../lib/connection", () => {
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string) =>
        method === "idea.acceptEula"
          ? new Promise<void>((resolve, reject) => { host.accept = resolve; host.refuse = reject; host.acceptCalls++; })
          : method === "lsp.status"
          ? new Promise((resolve) => (host.lsp = resolve))
          : method === "idea.eula"
            ? new Promise((resolve) => (host.eula = resolve))
            : method === "idea.checkUpdate"
              ? new Promise((resolve) => (host.check = resolve))
              : host.doctorFails
                ? Promise.reject(new Error("The host did not answer"))
                : Promise.resolve({ java: { found: true, version: "21", jdtls: true, path: "/usr/lib/jvm/21", ideaServer: host.engine } }),
  };
  return { registry: { primary: () => link } };
});
vi.mock("../../lib/tcserver/workspaces", () => ({ useProjects: () => [{ id: "p1", name: "Alpha" }] }));
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => host.editor, chooseEditorSetting: vi.fn() }));
vi.mock("../../lib/monaco/lspGate", () => ({ retryBlockedEnsures: vi.fn() }));
vi.mock("../../lib/sounds", () => ({ playCue: vi.fn() }));

const { EditorPage, lspFigures } = await import("./Editor");

beforeEach(() => {
  host.accept = null;
  host.acceptCalls = 0;
  host.lsp = null;
  host.editor = null;
  host.doctorFails = false;
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

  it("names no engine verb before the doctor answers: the button's place is a skeleton", () => {
    render(<EditorPage />);
    const java = screen.getByRole("region", { name: "Java" });
    expect(java.querySelector("[data-engine-action]")).toBeTruthy();
    expect(within(java).queryByRole("button")).toBeNull();
  });

  it("never says No JDK found when doctor.get fails: the error and Retry", async () => {
    host.doctorFails = true;
    render(<EditorPage />);
    await act(async () => {});
    const java = screen.getByRole("region", { name: "Java" });
    expect(java.textContent).not.toContain("No JDK found");
    expect(java.textContent).not.toContain("Not downloaded");
    expect(java.querySelector("[role=alert]")?.textContent).toBe("The host did not answer");
    host.doctorFails = false;
    await act(async () => fireEvent.click(within(java).getByRole("button", { name: "Retry" })));
    expect(java.textContent).toContain("JDK 21");
  });

  it("never says None running when lsp.status fails: the error and Retry", async () => {
    render(<EditorPage />);
    // The first poll is refused: resolving with a rejected promise rejects it.
    await act(async () => (host.lsp as unknown as (v: unknown) => void)(Promise.reject(new Error("refused"))));
    const servers = screen.getByRole("region", { name: "Language servers" });
    expect(servers.textContent).not.toContain("None running");
    expect(within(servers).getByRole("alert").textContent).toBe("refused");
    expect(within(servers).getByRole("button", { name: "Retry" })).toBeTruthy();
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
    expectModalShape(dialog);
  });

  it("holds Accept and enable's width and sends once while acceptance waits", async () => {
    host.engine = { dist: true, accepted: false, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Accept EULA" }));
    await act(async () => host.eula?.({ build: "263.1", text: "You may use it." }));
    const accept = screen.getByRole<HTMLButtonElement>("button", { name: "Accept and enable" });
    const widths = accept.querySelector("[data-slot=busy-label]")!.className;
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(host.acceptCalls).toBe(1);
    expect(accept.disabled).toBe(true);
    expect(accept.querySelector("[data-slot=busy-label]")!.className).toBe(widths);
    expect(accept.querySelector("[data-slot=busy-label]")!.getAttribute("data-busy")).toBe("true");
    await act(async () => host.accept?.());
    host.engine = undefined;
  });

  it("says a refused acceptance inside the dialog, not on the row behind it", async () => {
    host.engine = { dist: true, accepted: false, build: "263.1" };
    render(<EditorPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Accept EULA" }));
    await act(async () => host.eula?.({ build: "263.1", text: "You may use it." }));
    fireEvent.click(screen.getByRole("button", { name: "Accept and enable" }));
    await act(async () => host.refuse?.(new Error("disk full")));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("disk full");
    expect(screen.getByText("disk full").className).toContain("text-destructive");
    // The license stays readable above the error.
    expect(dialog.textContent).toContain("You may use it.");
    host.engine = undefined;
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
