// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingRow } from "../lib/railWorking";
import type { SessionMeta } from "../lib/tcserver/types";
import { RailWorkingView } from "./RailWorking";

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
  it("is hidden with one row: the workspace row's line names it", () => {
    const { container } = mount([row("a", "working")]);
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
    fireEvent.click(screen.getByRole("button", { name: "Thread a" }));
    expect(onSelect).toHaveBeenCalledWith("a");
    expect(screen.getByRole("button", { name: /^Thread b/ }).getAttribute("aria-current")).toBe("true");
  });

  it("each row leads with its state's glyph; a working one ends in its elapsed time", () => {
    const { container } = mount([row("a", "waiting"), row("b", "working"), row("c", "done")]);
    const marks = [...container.querySelectorAll('[data-slot="status-mark"]')].map((m) => m.getAttribute("data-state"));
    expect(marks).toEqual(["waiting", "working", "done"]);
    const working = container.querySelector('[data-working-row="b"]')!;
    expect(working.textContent).toContain("2m 5s");
    expect(container.querySelector('[data-working-row="a"]')!.textContent).not.toMatch(/\d+s/);
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
