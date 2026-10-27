// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptySession } from "./EmptySession";

afterEach(cleanup);

describe("EmptySession", () => {
  it("shows the composer alone: no heading, no type row, no canvas", () => {
    const { container } = render(<EmptySession composer={<div data-testid="composer" />} />);
    const root = container.querySelector("[data-empty-session]");
    expect(root).not.toBeNull();
    expect(root!.contains(screen.getByTestId("composer"))).toBe(true);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("renders an empty column when the composer docks under the pane", () => {
    const { container } = render(<EmptySession />);
    const root = container.querySelector("[data-empty-session]");
    expect(root).not.toBeNull();
    expect(root!.childElementCount).toBe(0);
  });
});
