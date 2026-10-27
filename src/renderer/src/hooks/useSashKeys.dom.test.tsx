// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSashKeys } from "./useSashKeys";

afterEach(cleanup);

function Handle({ orientation = "vertical", direction = 1, span = 1000 }: { orientation?: "vertical" | "horizontal"; direction?: 1 | -1; span?: number }) {
  const [value, setValue] = useState(400);
  return <div {...useSashKeys({ label: "Resize test pane", orientation, value, min: 300, max: 600, getSpan: () => span, direction, onChange: setValue, onReset: () => setValue(400) })} />;
}

describe("useSashKeys", () => {
  it("gives the handle focus and separator semantics with its current bounds", () => {
    render(<Handle />);
    const handle = screen.getByRole("separator", { name: "Resize test pane" });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    expect(handle.getAttribute("aria-valuemin")).toBe("300");
    expect(handle.getAttribute("aria-valuemax")).toBe("600");
  });

  it("uses 2% and Shift 10% of the container, clamps and resets", () => {
    render(<Handle />);
    const handle = screen.getByRole("separator");
    expect(fireEvent.keyDown(handle, { key: "ArrowRight" })).toBe(false);
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("520");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("600");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("580");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
  });

  it("moves a top-edge horizontal handle up to grow and ignores the other axis", () => {
    render(<Handle orientation="horizontal" direction={-1} />);
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    expect(fireEvent.keyDown(handle, { key: "ArrowLeft" })).toBe(true);
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
  });

  it.each([0, NaN, Infinity])("ignores an unmeasurable container (%s)", (span) => {
    render(<Handle span={span} />);
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
  });
});
