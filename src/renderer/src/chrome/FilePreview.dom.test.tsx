import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ToolPreview } from "../lib/session";
import { FilePreview } from "./FilePreview";

const preview: ToolPreview = {
  kind: "write",
  path: "/repo/src/app.ts",
  fileName: "app.ts",
  additions: 2,
  deletions: 1,
  lines: [
    { number: 1, kind: "context", text: "// the app" },
    { number: 2, kind: "del", text: "const Old = 1;" },
    { number: 2, kind: "add", text: "export const New = 2;" },
    { number: 3, kind: "add", text: "return value;" },
  ],
};

describe("FilePreview", () => {
  afterEach(cleanup);

  it("names the file and its counts on one header row", () => {
    const { container } = render(<FilePreview preview={preview} status="accepted" cwd="/repo" />);
    expect(container.textContent).toContain("src/app.ts");
    const counts = container.querySelector(".tabular-nums")!;
    expect(counts.textContent).toBe("+2−1");
  });

  it("tints code by weight, never by colour: keywords in foreground, no green, amber or red inside the code", () => {
    const { container } = render(<FilePreview preview={preview} status="accepted" cwd="/repo" />);
    const keyword = [...container.querySelectorAll("span")].find((span) => span.textContent === "export" && !span.children.length)!;
    expect(keyword.className).toBe("text-foreground");
    const named = [...container.querySelectorAll("span")].find((span) => span.textContent === "New" && !span.children.length)!;
    expect(named.className).toBe("");
    for (const line of container.querySelectorAll("[data-diff-line] > span:last-child")) {
      expect(line.querySelector(".text-success, .text-warning, .text-danger, .text-destructive")).toBeNull();
    }
  });

  it("draws no left bar on a line", () => {
    const { container } = render(<FilePreview preview={preview} status="accepted" cwd="/repo" />);
    expect(container.querySelector(".w-0\\.5")).toBeNull();
    expect(container.querySelector('[data-diff-line="add"]')!.className).toContain("bg-success/10");
    expect(container.querySelector('[data-diff-line="del"]')!.className).toContain("bg-destructive/10");
  });

  it("says Rejected once refused and nothing while pending", () => {
    const { container, rerender } = render(<FilePreview preview={preview} status="rejected" cwd="/repo" />);
    expect(container.textContent).toContain("Rejected");
    rerender(<FilePreview preview={preview} status="pending" cwd="/repo" />);
    expect(container.textContent).not.toContain("Rejected");
    expect(container.querySelector("svg.lucide-circle-dashed, [title]")).toBeNull();
  });

  it("opens the file from its path", () => {
    const onOpenFile = vi.fn();
    const { getByRole } = render(<FilePreview preview={preview} status="pending" cwd="/repo" onOpenFile={onOpenFile} />);
    fireEvent.click(getByRole("button", { name: "src/app.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/app.ts");
  });
});
