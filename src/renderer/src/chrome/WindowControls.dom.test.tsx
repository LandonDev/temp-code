// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

import { WindowControls } from "./WindowControls";

afterEach(cleanup);

describe("WindowControls", () => {
  it("Close fills solid red on hover, DESIGN's one exception to status fills above /10; the others stay ghost", () => {
    render(<WindowControls />);
    const close = screen.getByRole("button", { name: "Close window" });
    expect(close.className.split(/\s+/)).toEqual(expect.arrayContaining(["hover:bg-destructive", "hover:text-destructive-foreground"]));
    for (const name of ["Minimize window", "Maximize window"])
      expect(screen.getByRole("button", { name }).className).not.toContain("hover:bg-destructive");
  });
});
