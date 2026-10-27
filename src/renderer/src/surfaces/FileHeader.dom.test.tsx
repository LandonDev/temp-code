import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FileHeader, fileFolder, type FileHeaderDiff } from "./FileHeader";

const diff = (over: Partial<FileHeaderDiff> = {}): FileHeaderDiff => ({
  additions: 4,
  deletions: 2,
  index: 0,
  total: 3,
  onPrev: vi.fn(),
  onNext: vi.fn(),
  ...over,
});

const button = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

describe("FileHeader", () => {
  afterEach(cleanup);

  it("shows the folder and never the file's own name", () => {
    const { container } = render(<FileHeader folder="src/renderer/src/surfaces" save={{ status: "idle" }} />);
    expect(container.textContent).toBe("src/renderer/src/surfaces");
    expect(container.querySelector("header")!.className).toContain("h-8");
  });

  it("shows the diff's counts, each one left out at zero", () => {
    const { container, rerender } = render(<FileHeader folder={null} diff={diff()} save={{ status: "idle" }} />);
    expect(container.textContent).toContain("+4");
    expect(container.textContent).toContain("−2");
    expect(container.querySelector(".tabular-nums")).not.toBeNull();
    rerender(<FileHeader folder={null} diff={diff({ deletions: 0 })} save={{ status: "idle" }} />);
    expect(container.textContent).toContain("+4");
    expect(container.textContent).not.toContain("−");
    rerender(<FileHeader folder={null} diff={diff({ additions: 0, deletions: 0 })} save={{ status: "idle" }} />);
    expect(container.textContent).not.toContain("+");
  });

  it("steps between changes, each end disabled", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { container, rerender } = render(
      <FileHeader folder={null} diff={diff({ index: 0, total: 0, onPrev, onNext })} save={{ status: "idle" }} />,
    );
    expect(container.textContent).toContain("0/0");
    expect(button(container, "Previous change").disabled).toBe(true);
    expect(button(container, "Next change").disabled).toBe(true);

    rerender(<FileHeader folder={null} diff={diff({ index: 0, total: 3, onPrev, onNext })} save={{ status: "idle" }} />);
    expect(container.textContent).toContain("1/3");
    expect(button(container, "Previous change").disabled).toBe(true);
    fireEvent.click(button(container, "Next change"));
    expect(onNext).toHaveBeenCalledOnce();

    rerender(<FileHeader folder={null} diff={diff({ index: 2, total: 3, onPrev, onNext })} save={{ status: "idle" }} />);
    expect(button(container, "Next change").disabled).toBe(true);
    fireEvent.click(button(container, "Previous change"));
    expect(onPrev).toHaveBeenCalledOnce();
  });

  it("switches a Markdown file between preview and source", () => {
    const onModeChange = vi.fn();
    const { getByText } = render(<FileHeader folder={null} markdown={{ mode: "preview", onModeChange }} save={{ status: "idle" }} />);
    expect(getByText("Preview").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByText("Source"));
    expect(onModeChange).toHaveBeenCalledWith("source");
  });

  it("says a save only while it runs or when it failed", () => {
    const { container, rerender } = render(<FileHeader folder={null} save={{ status: "saving" }} />);
    expect(container.textContent).toBe("Saving…");
    rerender(<FileHeader folder={null} save={{ status: "error", message: "EACCES" }} />);
    expect(container.textContent).toBe("Save failed: EACCES");
    expect(container.querySelector<HTMLElement>(".text-destructive")!.tabIndex).toBe(0);
    rerender(<FileHeader folder={null} save={{ status: "saved" }} />);
    expect(container.textContent).toBe("");
    rerender(<FileHeader folder={null} save={{ status: "idle" }} />);
    expect(container.textContent).toBe("");
  });

  it("carries no title attribute and no middle dot", () => {
    const { container } = render(
      <FileHeader
        folder="src"
        diff={diff()}
        markdown={{ mode: "source", onModeChange: vi.fn() }}
        save={{ status: "error", message: "disk full" }}
      />,
    );
    expect(container.querySelector("[title]")).toBeNull();
    expect(container.textContent).not.toContain("·");
  });

  it("renders a tab's own trailing controls, and no save word without a save", () => {
    const { container } = render(
      <FileHeader folder="img">
        <span data-testid="facts">640 × 480</span>
      </FileHeader>,
    );
    expect(container.querySelector('[data-testid="facts"]')).not.toBeNull();
    expect(container.textContent).toBe("img640 × 480");
    expect(container.textContent).not.toContain("Sav");
  });

  it("finds the folder the header shows, null at the project root", () => {
    expect(fileFolder("/repo/img/shot.png", "/repo")).toBe("img");
    expect(fileFolder("/repo/a.png", "/repo")).toBeNull();
  });
});
