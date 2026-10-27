import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DiffBody } from "./DiffBody";
import { DIFF_LINE_CAP, type DiffRow } from "./diffRows";

const rows: DiffRow[] = [
  { type: "ctx", oldNo: 1, newNo: 1, text: "const a = 1;" },
  { type: "del", oldNo: 2, text: "const b = 2;" },
  { type: "add", newNo: 2, text: "const b = 3;" },
  { type: "gap", text: "" },
  { type: "ctx", oldNo: 9, newNo: 9, text: "return a;" },
];

describe("DiffBody", () => {
  afterEach(cleanup);

  it("draws its lines with the shared DiffLine: tints and marks", () => {
    const { container } = render(<DiffBody rows={rows} />);
    const add = container.querySelector<HTMLElement>('[data-diff-line="add"]')!;
    const del = container.querySelector<HTMLElement>('[data-diff-line="del"]')!;
    expect(add.className).toContain("bg-success/10");
    expect(add.textContent).toContain("+");
    expect(del.className).toContain("bg-destructive/10");
    expect(del.textContent).toContain("−");
    expect(del.textContent!.startsWith("2")).toBe(true);
  });

  it("marks a gap between hunks", () => {
    const { container } = render(<DiffBody rows={rows} />);
    expect(container.textContent).toContain("⋯");
    expect(container.querySelectorAll("[data-diff-line]")).toHaveLength(4);
  });

  it("opens the editor at a numbered line, never at a removed one", () => {
    const onEditAt = vi.fn();
    const { container } = render(<DiffBody rows={rows} onEditAt={onEditAt} />);
    const lines = container.querySelectorAll<HTMLElement>("[data-diff-line]");
    fireEvent.click(lines[3]);
    expect(onEditAt).toHaveBeenCalledWith(9);
    fireEvent.click(lines[1]);
    expect(onEditAt).toHaveBeenCalledTimes(1);
    expect(lines[1].className).not.toContain("cursor-pointer");
  });

  it("cuts a long diff and says so", () => {
    const many: DiffRow[] = Array.from({ length: DIFF_LINE_CAP + 5 }, (_, i) => ({ type: "ctx", oldNo: i + 1, newNo: i + 1, text: `line ${i}` }));
    const { container } = render(<DiffBody rows={many} />);
    expect(container.querySelectorAll("[data-diff-line]")).toHaveLength(DIFF_LINE_CAP);
    expect(container.textContent).toContain(`Showing the first ${DIFF_LINE_CAP} lines`);
  });
});
