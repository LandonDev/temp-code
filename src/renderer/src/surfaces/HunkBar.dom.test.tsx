import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { HunkBar } from "./HunkBar";

describe("HunkBar", () => {
  afterEach(cleanup);

  it("names both actions and calls their handlers", () => {
    const onRevert = vi.fn();
    const onStage = vi.fn();
    const { container, getByRole } = render(<HunkBar onRevert={onRevert} onStage={onStage} />);
    fireEvent.click(getByRole("button", { name: "Revert change" }));
    fireEvent.click(getByRole("button", { name: "Stage change" }));
    expect(onRevert).toHaveBeenCalledOnce();
    expect(onStage).toHaveBeenCalledOnce();
    expect(container.querySelector("[title]")).toBeNull();
    for (const button of container.querySelectorAll("button")) expect(button.dataset.variant).toBe("ghost");
  });

  it("leaves stage out without a handler and blocks actions while staging", () => {
    const onRevert = vi.fn();
    const onStage = vi.fn();
    const { getByRole, queryByRole, rerender } = render(<HunkBar onRevert={onRevert} />);
    expect(queryByRole("button", { name: "Stage change" })).toBeNull();
    rerender(<HunkBar onRevert={onRevert} onStage={onStage} busy />);
    for (const name of ["Revert change", "Stage change"]) {
      const button = getByRole<HTMLButtonElement>("button", { name });
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onRevert).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
  });

  it("keeps the editor caret on a pointer press", () => {
    const { getByRole } = render(<HunkBar onRevert={vi.fn()} />);
    expect(fireEvent.mouseDown(getByRole("button", { name: "Revert change" }))).toBe(false);
  });
});
