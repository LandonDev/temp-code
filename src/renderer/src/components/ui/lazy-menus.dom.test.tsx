// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMenus, warmMenus } from "@renderer/chrome/menuRows";
import { menuChunk } from "@renderer/surfaces/chunks";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./lazy-menus";

beforeEach(() => resetMenus());
afterEach(cleanup);

/** Resolves once the published body has reached every menu on screen. */
const landed = () => act(() => menuChunk.load().then(() => new Promise((resolve) => setTimeout(resolve, 0))));

function Menu({ onItem = () => {} }: { onItem?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Add" render={<Button variant="ghost" size="icon-sm" className="own" />}>
        +
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Add menu">
        <DropdownMenuItem onClick={onItem}>Attach files</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("lazy menus", () => {
  it("draws a cold menu as its trigger alone, the element the real one renders, closed", () => {
    render(<Menu />);
    const trigger = screen.getByRole("button", { name: "Add" });
    expect(trigger.getAttribute("data-slot")).toBe("dropdown-menu-trigger");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.className).toContain("own");
    expect(trigger.className).toContain("select-none");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on a click on a cold trigger once the body lands, and its rows work", async () => {
    const onItem = vi.fn();
    render(<Menu onItem={onItem} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const menu = await screen.findByRole("menu", { name: "Add menu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Attach files" }));
    expect(onItem).toHaveBeenCalledTimes(1);
    expect(menu).toBeTruthy();
  });

  it("a controlled popover's open loads the body, and its content mounts under the real root", async () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<button type="button">Plan</button>} />
          {open ? <PopoverContent aria-label="Plan options">options</PopoverContent> : null}
        </Popover>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole("button", { name: "Plan" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger);
    expect(await screen.findByText("options")).toBeTruthy();
  });

  it("passes no class of its own to a trigger that spreads its props last", () => {
    function Row(props: React.ComponentProps<"button">) {
      return <button type="button" className="row-own" {...props} />;
    }
    render(
      <Popover>
        <PopoverTrigger render={<Row aria-label="Meter" />} />
        <PopoverContent>details</PopoverContent>
      </Popover>,
    );
    expect(screen.getByRole("button", { name: "Meter" }).className).toBe("row-own");
  });

  it("the pointer entering a trigger swaps every menu on screen, never under a press", async () => {
    render(<Menu />);
    await act(() => menuChunk.load());
    fireEvent.pointerDown(document.body);
    act(() => warmMenus());
    // Still cold while the pointer is down: the trigger keeps its node.
    expect(screen.getByRole("button", { name: "Add" }).getAttribute("aria-expanded")).toBe("false");
    const cold = screen.getByRole("button", { name: "Add" });
    fireEvent.pointerUp(document.body);
    await landed();
    const warm = screen.getByRole("button", { name: "Add" });
    expect(warm).not.toBe(cold);
    fireEvent.click(warm);
    expect(await screen.findByRole("menu", { name: "Add menu" })).toBeTruthy();
  });

  it("draws no content while cold", () => {
    render(
      <Popover defaultOpen>
        <PopoverContent>never cold</PopoverContent>
      </Popover>,
    );
    expect(screen.queryByText("never cold")).toBeNull();
  });
});
