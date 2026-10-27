// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState, LoadingLine, SurfaceSkeleton, type SkeletonKind } from "./SurfaceSkeleton";

afterEach(cleanup);

const KINDS: SkeletonKind[] = ["page", "column", "pane", "diff", "terminal", "frame", "transcript", "rows"];

describe("SurfaceSkeleton", () => {
  it.each(KINDS)("%s: a labelled status of still skeleton blocks", (kind) => {
    const { container } = render(<SurfaceSkeleton kind={kind} label="Loading notes" />);
    const root = screen.getByRole("status", { name: "Loading notes" });
    expect(root.getAttribute("data-surface-skeleton")).toBe(kind);
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/animate-(pulse|spin)\b/);
  });

  it("says Loading when given no label", () => {
    render(<SurfaceSkeleton kind="pane" />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  });

  it("transcript: each turn's bubble on the right before its prose lines", () => {
    const { container } = render(<SurfaceSkeleton kind="transcript" />);
    const turn = container.querySelector("[data-surface-skeleton] > div > div")!;
    expect(turn.firstElementChild!.className).toContain("self-end");
    expect(turn.lastElementChild!.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  it("column: Settings' one 672px column under the strip, with no nav column", () => {
    const { container } = render(<SurfaceSkeleton kind="column" label="Loading settings" />);
    const column = container.querySelector("[data-skeleton-column]")!;
    expect(column.className).toContain("max-w-2xl");
    expect(column.className).toContain("mx-auto");
    expect(container.querySelector(".w-52")).toBeNull();
    expect(container.querySelector("[data-surface-skeleton] > .border-b")).not.toBeNull();
  });

  it("rows: count rows, four by default", () => {
    const six = render(<SurfaceSkeleton kind="rows" count={6} />);
    expect(six.container.querySelectorAll("[data-skeleton-row]").length).toBe(6);
    six.unmount();
    const { container } = render(<SurfaceSkeleton kind="rows" />);
    expect(container.querySelectorAll("[data-skeleton-row]").length).toBe(4);
  });
});

describe("LoadingLine", () => {
  it("is a spinner hidden from readers beside its word", () => {
    const { container } = render(<LoadingLine label="Loading comments" />);
    expect(screen.getByRole("status").textContent).toBe("Loading comments");
    expect(container.querySelector('[data-slot="spinner"]')!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("EmptyState", () => {
  it("is its title alone when given nothing else", () => {
    const { container } = render(<EmptyState title="No file changes" />);
    expect(screen.getByText("No file changes")).toBeTruthy();
    expect(container.querySelector('[data-slot="empty-description"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("adds its line and one action when given", () => {
    const onClick = vi.fn();
    const { container } = render(<EmptyState title="No notes yet" line="Notes stay with the project." action={{ label: "New note", onClick }} />);
    expect(container.querySelector('[data-slot="empty-description"]')!.textContent).toBe("Notes stay with the project.");
    expect(container.querySelectorAll("button").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
