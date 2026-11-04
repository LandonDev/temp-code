// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Button } from "./button";
import { Item, ItemDescription, ItemTitle } from "./item";
import { EmptyDescription } from "./empty";
import { StatusMark } from "./status";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "./dropdown-menu";
import { Play } from "@renderer/chrome/icons";

afterEach(cleanup);

describe("type on one grid", () => {
  it("a button reads 13px on 20px lines, and its icon side takes 8px", () => {
    const { container } = render(<Button>Save</Button>);
    const classes = container.querySelector("button")!.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["text-[13px]", "leading-5", "has-[>svg:first-child]:ps-2", "has-[>svg:last-child]:pe-2"]));
    expect(classes).not.toContain("text-sm");
    expect(classes.some((c) => c.includes("data-[icon="))).toBe(false);
  });

  it("an Item's title is 13 on 20 and its description 12 on 16; an Empty's line 13 on 20", () => {
    const { container } = render(
      <Item>
        <ItemTitle>Title</ItemTitle>
        <ItemDescription>Line</ItemDescription>
        <EmptyDescription>Nothing here</EmptyDescription>
      </Item>,
    );
    expect(container.querySelector("[data-slot=item-title]")!.className).toContain("leading-5");
    expect(container.querySelector("[data-slot=item-description]")!.className).toContain("leading-4");
    expect(container.querySelector("[data-slot=empty-description]")!.className).toContain("leading-5");
  });

  it("a status word and its detail sit 6px apart: the root's 8px less 2", () => {
    const { container } = render(<StatusMark state="working" word detail="Editing Rail.tsx" />);
    expect(container.querySelector("[data-slot=status-detail]")!.className).toContain("-ms-0.5");
  });

  it("a menu's shortcut is a KbdGroup with no tracking, as the context menu's", async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<Button>Open</Button>} />
        <DropdownMenuContent>
          <DropdownMenuItem>
            Rename<DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await act(async () => {});
    const shortcut = document.querySelector("[data-slot=dropdown-menu-shortcut]")!;
    expect(shortcut.tagName).toBe("KBD");
    expect(shortcut.className).not.toMatch(/tracking-/);
  });

  it("Play is drawn a pixel right, where its triangle looks centred", () => {
    const { container } = render(<Play className="size-3.5" />);
    expect(container.querySelector("svg")!.getAttribute("class")).toMatch(/translate-x-px/);
    expect(container.querySelector("svg")!.getAttribute("class")).toMatch(/size-3\.5/);
  });

  it("a toast's glyph sits on its title's first line, the title 13 on 20, the description 12 on 16", () => {
    const source = readFileSync(resolve(__dirname, "toaster.tsx"), "utf8");
    expect(source).toContain('toast: "!items-start !gap-2');
    expect(source).toContain('title: "!font-medium !leading-5"');
    expect(source).toContain('description: "!text-[12px] !leading-4 !text-muted-foreground"');
    expect(source).toContain('icon: "!h-5"');
  });

  it("an attachment has the trigger's one ring, a 12px frame and, inside a card, a muted fill with no hairline", () => {
    const source = readFileSync(resolve(__dirname, "attachment.tsx"), "utf8");
    expect(source).not.toMatch(/focus-within:ring/);
    expect(source).toContain("in-[.bg-card]:border-transparent in-[.bg-card]:bg-muted");
    expect(source).toContain('"absolute inset-0 z-10 rounded-[inherit]"');
    expect(source).toMatch(/flex-wrap rounded-xl border/);
    expect(source).toContain("group-data-[size=xs]/attachment:rounded-sm");
  });
});
