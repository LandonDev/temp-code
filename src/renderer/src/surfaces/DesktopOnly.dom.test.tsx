// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The page at /ui (no `window.api`): a surface it reaches anyway says one line. */
vi.mock("@aliax/pages", () => ({ AccountsPage: () => <div>accounts</div>, StatsPage: () => <div>stats</div> }));
vi.mock("../lib/pty", () => ({
  getPtyStatus: vi.fn(),
  killPty: vi.fn(),
  resizePty: vi.fn(),
  spawnPty: vi.fn(() => Promise.resolve()),
  subscribePty: vi.fn(() => () => {}),
  writePty: vi.fn(),
}));

const { TerminalView } = await import("./TerminalView");
const { AliaxPagesView } = await import("./AliaxPagesView");
const pty = await import("../lib/pty");

let api: unknown;
beforeEach(() => {
  api = (window as { api?: unknown }).api;
  delete (window as { api?: unknown }).api;
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "api", { value: api, configurable: true, writable: true });
});

describe("desktop-only surfaces at /ui", () => {
  it("a terminal tab says it is in the desktop app and spawns nothing", () => {
    render(<TerminalView id="t1" cwd="/w" active onMetaChange={() => {}} />);
    expect(screen.getByText("Available in the desktop app")).toBeTruthy();
    expect(pty.spawnPty).not.toHaveBeenCalled();
  });

  it("Accounts says the same line in the shared empty state", () => {
    render(<AliaxPagesView page="accounts" onClose={() => {}} />);
    expect(screen.getByText("Available in the desktop app").closest("[data-slot=empty]")).toBeTruthy();
    expect(screen.queryByText("accounts")).toBeNull();
  });
});
