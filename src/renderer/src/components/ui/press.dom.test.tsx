// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Toggle } from "./toggle";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Item, ItemButton } from "./item";

vi.mock("../../lib/native", () => ({ getCurrentWindow: () => ({ isMaximized: async () => false, onResized: async () => () => {} }) }));
import { WindowControls } from "../../chrome/WindowControls";

afterEach(cleanup);

/** Rows, toggles and tabs press with a fill and never move (docs/DESIGN.md "Motion values"). */
describe("presses at once", () => {
  it("a toggle hovers on /7, presses on /12 at once, and stays muted when on", () => {
    render(<Toggle aria-label="Wrap" />);
    const classes = screen.getByRole("button", { name: "Wrap" }).classList;
    for (const name of ["hover:bg-foreground/7", "active:bg-foreground/12", "active:transition-none", "duration-(--dur-hover)", "data-pressed:bg-muted"]) expect(classes).toContain(name);
    expect(classes).not.toContain("hover:bg-muted");
  });

  it("a tab's fill runs --dur-hover and a line tab's mark switches at once", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "A" });
    expect(tab.classList).toContain("duration-(--dur-hover)");
    expect(tab.className).not.toContain("after:transition-opacity");
  });

  it("an Item highlights at once and an ItemButton presses to /12", () => {
    const { container } = render(<Item>Row</Item>);
    const item = container.firstElementChild!;
    expect(item.className).toContain("transition-[border-color]");
    expect(item.className).not.toContain("background-color");
    render(<ItemButton>Open</ItemButton>);
    const button = screen.getByRole("button", { name: "Open" });
    expect(button.classList).toContain("active:bg-foreground/12");
    expect(button.className).not.toMatch(/scale-/);
  });

  it("the window's close stays red while pressed, its glyph legible", () => {
    render(<WindowControls />);
    const close = screen.getByRole("button", { name: "Close window" });
    for (const name of ["hover:bg-destructive", "hover:text-destructive-foreground", "active:bg-destructive/90"]) expect(close.classList).toContain(name);
    expect(close.classList).not.toContain("active:bg-foreground/12");
  });

  it("Jump to latest stays opaque while pressed (it floats over the transcript)", () => {
    // Shown only once the reader has scrolled away, so its classes are read from the source.
    const source = readFileSync(resolve(__dirname, "../../surfaces/threadChat.tsx"), "utf8");
    const jump = source.slice(source.indexOf('aria-label="Jump to latest"'), source.indexOf("<ChevronDown", source.indexOf('aria-label="Jump to latest"')));
    expect(jump).toContain("active:bg-muted");
    expect(jump).toContain("data-pressed:bg-muted");
  });
});
