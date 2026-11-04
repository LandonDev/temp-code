// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingRow } from "../lib/railWorking";
import type { SessionMeta } from "../lib/tcserver/types";
import { RailWorkingView, workingTipLine } from "./RailWorking";
import { clockForTest } from "../lib/turnClock";

/** The hosts the window knows; one by default, two for the host glyph. */
const hosts = vi.hoisted(() => ({ environments: [{ id: "local", name: "This Mac" }] as { id: string; name: string; platform?: string }[] }));
vi.mock("../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection/status")>()),
  useEnvironments: () => hosts.environments,
}));

afterEach(() => {
  cleanup();
  hosts.environments = [{ id: "local", name: "This Mac" }];
});

const NOW = 1_000_000;

const row = (id: string, state: WorkingRow["state"], extra: Partial<SessionMeta> = {}): WorkingRow => ({
  id,
  state,
  meta: {
    environmentId: "local",
    id,
    parentId: null,
    projectId: "p1",
    workspaceId: null,
    threadType: "chat",
    title: `Thread ${id}`,
    cwd: "/repo",
    status: state === "working" ? "running" : state === "waiting" ? "waiting" : "idle",
    archived: false,
    pinned: false,
    busySince: state === "working" ? NOW - 125_000 : null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  } as SessionMeta,
});

function mount(rows: WorkingRow[], over: { activeSessionId?: string; onSelect?: (id: string) => void } = {}) {
  return render(<RailWorkingView rows={rows} now={NOW} projectOf={() => "Alpha"} {...over} />);
}

const rowsShown = (root: HTMLElement) => [...root.querySelectorAll("[data-working-row]")].map((r) => r.getAttribute("data-working-row"));

describe("the rail's Working section", () => {
  it("holds no clock while its tooltips are shut: the section never re-renders on the second", () => {
    render(<RailWorkingView rows={[row("a", "working"), row("b", "working")]} projectOf={() => "Alpha"} />);
    expect(document.querySelectorAll("[data-working-row]")).toHaveLength(2);
    expect(clockForTest.listeners()).toBe(0);
  });

  it("shows from one row, and draws no hairline of its own (the foot's is above it)", () => {
    const { container } = mount([row("a", "working")]);
    expect(rowsShown(container)).toEqual(["a"]);
    expect(container.querySelector("[data-rail-working]")!.className).not.toContain("border-t");
  });

  it("is nothing with no rows", () => {
    const { container } = mount([]);
    expect(container.innerHTML).toBe("");
  });

  it("shows four rows under its heading and \"2 more\" for the rest", () => {
    const { container } = mount(["a", "b", "c", "d", "e", "f"].map((id) => row(id, "working")));
    expect(screen.getByText("Working")).toBeTruthy();
    expect(rowsShown(container)).toEqual(["a", "b", "c", "d"]);
    expect(screen.getByRole("button", { name: "2 more" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opening it shows every row in a scroller, and Show less closes it", () => {
    const { container } = mount(["a", "b", "c", "d", "e", "f"].map((id) => row(id, "working")));
    fireEvent.click(screen.getByRole("button", { name: "2 more" }));
    expect(rowsShown(container)).toHaveLength(6);
    expect(container.querySelector(".max-h-\\[45vh\\]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(rowsShown(container)).toHaveLength(4);
  });

  it("a row opens its thread, and the thread on screen is aria-current", () => {
    const onSelect = vi.fn();
    mount([row("a", "waiting"), row("b", "working")], { activeSessionId: "b", onSelect });
    fireEvent.click(screen.getByRole("button", { name: "Thread a, Needs you" }));
    expect(onSelect).toHaveBeenCalledWith("a");
    expect(screen.getByRole("button", { name: /^Thread b/ }).getAttribute("aria-current")).toBe("true");
  });

  it("each row leads with its type's 12px glyph and ends in its state's glyph, with no elapsed text", () => {
    const { container } = mount([row("a", "waiting", { threadType: "implementation" }), row("b", "working"), row("c", "done", { threadType: "research" })]);
    const marks = [...container.querySelectorAll('[data-slot="status-mark"]')].map((m) => m.getAttribute("data-state"));
    expect(marks).toEqual(["waiting", "working", "done"]);
    const types = [...container.querySelectorAll("[data-type-glyph]")].map((g) => g.getAttribute("data-type-glyph"));
    expect(types).toEqual(["implementation", "chat", "research"]);
    for (const id of ["a", "b", "c"]) {
      const r = container.querySelector(`[data-working-row="${id}"]`)!;
      const glyph = r.querySelector("[data-type-glyph]")!;
      const title = screen.getByText(`Thread ${id}`);
      const mark = r.querySelector('[data-slot="status-mark"]')!;
      expect(glyph.getAttribute("class")).toContain("size-3");
      expect(glyph.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(title.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(r.textContent).not.toMatch(/\d+s/);
    }
  });

  it("a row's tooltip line is the word, what it is about and the elapsed time while it works", () => {
    expect(workingTipLine(row("b", "working"), NOW)).toBe("Working: 2m 5s");
    expect(workingTipLine(row("b", "working", { activity: "Running bun test" }), NOW)).toBe("Working: Running bun test, 2m 5s");
    expect(workingTipLine(row("a", "waiting"), NOW)).toMatch(/^Needs you/);
    expect(workingTipLine(row("a", "waiting"), NOW)).not.toMatch(/\d+s/);
    expect(workingTipLine(row("b", "working"), 0)).toBe("Working");
  });

  it("draws the host glyph only with two hosts", () => {
    const one = mount([row("a", "working"), row("b", "working", { environmentId: "env_box" })]);
    expect(one.container.querySelector("[data-host-glyph]")).toBeNull();
    cleanup();
    hosts.environments = [
      { id: "local", name: "This Mac" },
      { id: "env_box", name: "box", platform: "linux" },
    ];
    const two = mount([row("a", "working"), row("b", "working", { environmentId: "env_box" })]);
    expect(two.container.querySelector('[data-working-row="b"] [data-host-glyph]')?.getAttribute("aria-label")).toBe("box");
  });
});
