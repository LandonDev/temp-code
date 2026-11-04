// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./context-menu";

afterEach(cleanup);

const classesOf = (selector: string) => document.querySelector(selector)!.className.split(/\s+/);

/** A popup enters through CSS @starting-style (which a popup mounted open gets
 *  too, where Base UI sets no starting status) and leaves on data-ending-style;
 *  no enter or exit keyframes, so a close mid-open turns back from where it is. */
function expectTransitions(classes: string[]) {
  expect(classes.some((c) => /^transition-/.test(c))).toBe(true);
  expect(classes).toContain("starting:opacity-0");
  expect(classes).toContain("data-ending-style:opacity-0");
  expect(classes.some((c) => /animate-(in|out)|fade-in|fade-out|zoom-|slide-in|slide-out/.test(c))).toBe(false);
}

describe("popups move on transitions", () => {
  it("a menu, a popover and a select scale from their trigger and settle back to 0.98", async () => {
    render(
      <>
        <DropdownMenu open>
          <DropdownMenuTrigger render={<Button>Menu</Button>} />
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover open>
          <PopoverTrigger render={<Button>Popover</Button>} />
          <PopoverContent>Body</PopoverContent>
        </Popover>
        <Select open value="a" items={[{ value: "a", label: "A" }]}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">A</SelectItem>
          </SelectContent>
        </Select>
      </>,
    );
    await act(async () => {});
    for (const slot of ["dropdown-menu-content", "popover-content", "select-content"]) {
      const classes = classesOf(`[data-slot=${slot}]`);
      expectTransitions(classes);
      for (const c of ["origin-(--transform-origin)", "starting:scale-95", "data-ending-style:scale-[0.98]", "data-ending-style:duration-(--dur-fast)", "data-ending-style:ease-(--ease-exit)"])
        expect(classes, slot).toContain(c);
    }
    // A select laid over its trigger opens and closes without a zoom.
    expect(classesOf("[data-slot=select-content]")).toEqual(expect.arrayContaining(["data-[align-trigger=true]:starting:scale-100", "data-[align-trigger=true]:data-ending-style:scale-100"]));
  });

  it("a context menu fades at the pointer and never scales", async () => {
    render(
      <ContextMenu open>
        <ContextMenuTrigger>Row</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    await act(async () => {});
    const classes = classesOf("[data-slot=context-menu-content]");
    expectTransitions(classes);
    expect(classes).toContain("transition-opacity");
    expect(classes.some((c) => c.includes("scale"))).toBe(false);
  });

  it("a dialog rises 4px from its centred place, and the full viewer from its own", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    let classes = classesOf("[data-slot=dialog-content]");
    expectTransitions(classes);
    // The starting translate keeps the -50% centring, or the dialog would jump half its height.
    expect(classes).toEqual(expect.arrayContaining(["-translate-y-1/2", "starting:translate-y-[calc(-50%+4px)]", "starting:scale-95", "data-ending-style:scale-[0.98]"]));
    const overlay = classesOf("[data-slot=dialog-overlay]");
    expectTransitions(overlay);
    expect(overlay).toContain("bg-scrim");
    cleanup();
    render(
      <Dialog open>
        <DialogContent size="full">
          <DialogTitle>Image</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    classes = classesOf("[data-slot=dialog-content]");
    expect(classes).toContain("starting:translate-y-1");
    expect(classes).not.toContain("starting:translate-y-[calc(-50%+4px)]");
  });

  it("Escape on a dialog opened a moment ago starts its ending style, with no exit keyframe", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Rename</DialogTitle>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(async () => {});
    const live = document.querySelector("[data-slot=dialog-content]");
    if (live) {
      expect(live.className).not.toMatch(/animate-out/);
      expect(live.hasAttribute("data-ending-style") || live.hasAttribute("data-closed")).toBe(true);
    }
  });
});

describe("the reduced-motion block", () => {
  it("narrows every popup's transitions to a --dur-fast opacity fade, with no keyframe variables", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    const start = css.indexOf("/* Reduced motion: an overlay keeps a --dur-fast fade");
    const block = css.slice(start, css.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(block).not.toMatch(/--tw-(enter|exit)/);
    expect(block).not.toMatch(/animation-duration/);
    expect(block).toMatch(/transition-property: opacity;/);
    expect(block).toMatch(/transition-duration: var\(--dur-fast\);/);
    for (const slot of ["dialog-content", "sheet-content", "popover-content", "dropdown-menu-content", "context-menu-content", "select-content"]) expect(block).toContain(`[data-slot="${slot}"]`);
  });

  it("keeps the scrim a token in both themes", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    expect(css.match(/--scrim: rgb\(0 0 0 \/ [\d.]+\);/g)).toHaveLength(2);
    expect(css).toContain("--color-scrim: var(--scrim);");
  });
});
