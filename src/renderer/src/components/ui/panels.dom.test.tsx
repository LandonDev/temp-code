// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Kbd } from "./kbd";

afterEach(cleanup);

/** Nested radii are concentric: an inner radius is the outer minus the inset (docs/DESIGN.md "Radius ladder"). */
describe("floating panels and their rows", () => {
  it("a menu's 8px rows sit 4px inside its 12px panel", async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<button type="button" />}>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const row = await screen.findByRole("menuitem", { name: "Rename" });
    const panel = row.closest("[data-slot=dropdown-menu-content]")!;
    expect(panel.classList).toContain("rounded-xl");
    expect(panel.classList).toContain("p-1");
    expect(panel.classList).not.toContain("p-1.5");
    expect(row.classList).toContain("rounded-lg");
  });

  it("the context menu's panel takes the same 4px inset", () => {
    const source = readFileSync(resolve(__dirname, "context-menu.tsx"), "utf8");
    expect(source).toContain("rounded-xl bg-popover p-1 ");
    expect(source).not.toContain("p-1.5");
  });

  it("a select is a 12px popover with 8px rows and 14px glyphs", async () => {
    render(
      <Select open defaultValue="a">
        <SelectTrigger aria-label="Pick">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>,
    );
    const item = (await screen.findAllByRole("option")).find((o) => o.textContent?.includes("Alpha"))!;
    expect(item.classList).toContain("rounded-lg");
    expect(item.className).toContain("[&_svg:not([class*='size-'])]:size-3.5");
    const popup = item.closest("[data-slot=select-content]")!;
    expect(popup.classList).toContain("rounded-xl");
    expect(popup.className).toContain("[--scrollbar-inset:var(--radius-xl)]");
  });

  it("a popover's inset and gap are a panel's 12px", async () => {
    render(
      <Popover open>
        <PopoverTrigger render={<button type="button" />}>Open</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>,
    );
    const body = await screen.findByText("Body");
    const popup = body.closest("[data-slot=popover-content]")!;
    expect(popup.classList).toContain("p-3");
    expect(popup.classList).toContain("gap-3");
  });

  it("a segmented list's 6px triggers sit 2px inside its 8px track", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "A" });
    const list = screen.getByRole("tablist");
    expect(list.classList).toContain("p-0.5");
    expect(list.classList).toContain("rounded-lg");
    expect(tab.classList).toContain("rounded-md");
  });

  it("every key cap is 11px", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const { container } = render(<Kbd size={size}>K</Kbd>);
      expect(container.querySelector("kbd")!.classList).toContain("text-[11px]");
      cleanup();
    }
  });
});
