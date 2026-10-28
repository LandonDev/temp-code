// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writes: [] as string[], request: vi.fn() }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    open() {}
    write(text: string) {
      h.writes.push(text);
    }
    reset() {}
    dispose() {}
    getSelection() {
      return "";
    }
    hasSelection() {
      return false;
    }
    attachCustomKeyEventHandler() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../lib/terminalLayout", () => ({ fitTerminal: () => {} }));
vi.mock("./TerminalView", () => ({ monoFont: () => "mono", terminalTheme: () => ({}) }));
vi.mock("../lib/connection/registry", () => ({ registry: { linkOf: () => ({ request: h.request, onPush: () => () => {} }) } }));

import { DevConsole } from "./DevConsole";

afterEach(() => {
  cleanup();
  h.writes = [];
});

describe("DevConsole", () => {
  it("an agent's server shows its log alone, never the log file's path", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    h.request.mockResolvedValue({ source: "file", path: "/tmp/claude/tasks/b1.output", data: "ready on :5173\n", next: 15, endedAt: 1 });
    render(<DevConsole source={{ environmentId: "env_box", resourceId: "res1" }} active />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.request).toHaveBeenCalledWith("devServer.portLog", { resourceId: "res1" });
    expect(h.writes).toEqual(["ready on :5173\n"]);
    expect(h.writes.join("")).not.toContain("/tmp/claude");
  });

  it("an agent's server opens with its command, dimmed, like a run", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    h.request.mockResolvedValue({ source: "file", data: "ready on :5173\n", next: 15, endedAt: 1 });
    render(<DevConsole source={{ environmentId: "env_box", resourceId: "res1", command: "bun run dev" }} active />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.writes).toEqual(["\x1b[2m$ bun run dev\x1b[0m\r\n", "ready on :5173\n"]);
  });
});
