// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let resolveCount: (n: number) => void = () => {};
vi.mock("../lib/projectData", () => ({
  projectSessionCount: () => new Promise<number>((resolve) => (resolveCount = resolve)),
}));

import { RemoveProjectDialog, removeProjectLine } from "./RemoveProjectDialog";

afterEach(cleanup);

describe("RemoveProjectDialog", () => {
  it("is an alert that says what stays, then the count once it loads", async () => {
    const onConfirm = vi.fn();
    render(<RemoveProjectDialog name="Alpha" path="/x/alpha" onCancel={() => {}} onConfirm={onConfirm} />);
    const alert = screen.getByRole("alertdialog");
    expect(screen.getByText("Remove “Alpha”?")).toBeTruthy();
    expect(alert.textContent).toContain("Files on disk stay.");
    await act(async () => resolveCount(12));
    expect(screen.getByText("Files on disk stay. 12 saved conversations are removed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("words one conversation and none", () => {
    expect(removeProjectLine(1)).toBe("Files on disk stay. 1 saved conversation is removed.");
    expect(removeProjectLine(0)).toBe("Files on disk stay.");
    expect(removeProjectLine(null)).toBe("Files on disk stay.");
  });
});
