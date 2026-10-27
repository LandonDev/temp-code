// @vitest-environment jsdom
import { act, fireEvent, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Search in files: the three options are toggles that reach the search,
 * the status line counts results and files, a file's header carries its
 * count as plain text, a match marks the query once, Enter opens the
 * first match.
 */

const h = vi.hoisted(() => ({ searchProject: vi.fn() }));

vi.mock("../lib/connection", () => ({
  registry: { primaryEnvironmentId: "local", primary: () => ({ environmentId: "local" }) },
}));
vi.mock("../lib/tcserver/projects", () => ({ environmentOfCwd: () => "local" }));
vi.mock("../lib/search", () => ({ searchProject: (...args: unknown[]) => h.searchProject(...args) }));
vi.mock("./FileTypeIcon", () => ({ FileTypeIcon: () => <span data-icon="file" /> }));

import { ProjectSearch } from "./ProjectSearch";

const matches = [
  { path: "/app/src/gw.ts", relative: "src/gw.ts", line: 3, column: 5, preview: "  gateway(trace)" },
  { path: "/app/src/gw.ts", relative: "src/gw.ts", line: 9, column: 1, preview: "export gateway" },
];

async function type(view: RenderResult, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(view.getByLabelText("Search"), { target: { value: text } });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(220);
  });
}

describe("ProjectSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.searchProject.mockResolvedValue({ matches, truncated: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    h.searchProject.mockReset();
  });

  it("says nothing before a query and counts results after one", async () => {
    const view = render(<ProjectSearch cwd="/app" onOpenFile={vi.fn()} onClose={vi.fn()} />);
    expect(view.container.textContent).not.toMatch(/Type to search|results/);
    await type(view, "gateway");
    expect(view.getByText("2 results in 1 file")).toBeTruthy();
    view.unmount();
  });

  it("passes the toggles to the search and reports them pressed", async () => {
    const view = render(<ProjectSearch cwd="/app" onOpenFile={vi.fn()} onClose={vi.fn()} />);
    const matchCase = view.getByRole("button", { name: "Match case" });
    expect(matchCase.getAttribute("aria-pressed")).toBe("false");
    // The toggles sit inside the field's InputGroup, beside the bare input.
    const group = view.getByLabelText("Search").closest('[data-slot="input-group"]') as HTMLElement;
    expect(group.contains(matchCase)).toBe(true);
    await act(async () => {
      fireEvent.click(matchCase);
      fireEvent.click(view.getByRole("button", { name: "Use regular expression" }));
    });
    expect(matchCase.getAttribute("aria-pressed")).toBe("true");
    await type(view, "gate");
    expect(h.searchProject).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ query: "gate", caseSensitive: true, wholeWord: false, regex: true }),
    );
    view.unmount();
  });

  it("heads a file with its folder and a plain count, and marks the query once per match", async () => {
    const view = render(<ProjectSearch cwd="/app" onOpenFile={vi.fn()} onClose={vi.fn()} />);
    await type(view, "gateway");
    const group = view.getByRole("region", { name: "src/gw.ts" });
    const count = group.querySelector("[data-match-count]") as HTMLElement;
    expect(count.textContent).toBe("2");
    expect(count.className).not.toMatch(/rounded-full|bg-accent/);
    expect(group.textContent).toContain("src");
    const first = group.querySelector("li button") as HTMLElement;
    const marks = first.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("gateway");
    view.unmount();
  });

  it("opens the first match on Enter", async () => {
    const onOpenFile = vi.fn();
    const view = render(<ProjectSearch cwd="/app" onOpenFile={onOpenFile} onClose={vi.fn()} />);
    await type(view, "gateway");
    fireEvent.keyDown(view.getByLabelText("Search"), { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("/app/src/gw.ts", { line: 3, column: 5 });
    view.unmount();
  });
});
