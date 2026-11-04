// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BusyLabel, Button } from "./button";
import { Spinner } from "./spinner";

afterEach(cleanup);

describe("BusyLabel", () => {
  it("holds both widths in one column, the spinner only while busy, so the button never changes width", () => {
    const { rerender, container } = render(
      <Button size="xs">
        <BusyLabel busy={false} label="Stop" busyLabel="Stopping…" />
      </Button>,
    );
    const label = () => container.querySelector<HTMLElement>("[data-slot=busy-label]")!;
    const before = label().className;
    // Both states are unseen zero-height copies (::before and ::after); the busy one pads the spinner's place.
    expect(label().getAttribute("data-idle")).toBe("Stop");
    expect(label().getAttribute("data-busy-text")).toBe("Stopping…");
    for (const c of ["before:content-[attr(data-idle)]", "after:content-[attr(data-busy-text)]", "before:h-0", "after:h-0", "before:invisible", "after:invisible", "after:ps-[calc(var(--busy-space,1rem)+0.25rem)]"])
      expect(before).toContain(c);
    expect(container.querySelector("[data-slot=spinner]")).toBeNull();
    expect(screen.getByRole("button").textContent).toBe("Stop");
    expect(screen.getByRole("button").className).toContain("[--busy-space:0.75rem]");
    rerender(
      <Button size="xs">
        <BusyLabel busy label="Stop" busyLabel="Stopping…" />
      </Button>,
    );
    expect(label().className).toBe(before);
    expect(container.querySelectorAll("[data-slot=spinner]")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toBe("Stopping…");
  });

  it("a confirm keeps its verb: busyLabel defaults to the label", () => {
    const { container } = render(<BusyLabel busy label="Delete" />);
    expect(container.textContent).toBe("Delete");
    expect(container.querySelector("[data-slot=busy-label]")!.getAttribute("data-busy-text")).toBe("Delete");
  });
});
describe("spinners in buttons", () => {
  it("take the size of the icon they replace: 12px in xs buttons, 14px in sm", () => {
    for (const [size, expected] of [["xs", "size-3"], ["icon-xs", "size-3"], ["sm", "size-3.5"], ["icon-sm", "size-3.5"]] as const) {
      const { container } = render(
        <Button size={size}>
          <Spinner />
        </Button>,
      );
      expect(container.querySelector("button")!.className, size).toContain(`[&_[data-slot=spinner]:not([class*='size-'])]:${expected}`);
      cleanup();
    }
  });
});
