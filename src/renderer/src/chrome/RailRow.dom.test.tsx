// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Inbox, MoreHorizontal, Pin, Plus } from "./icons";
import { RailHeading, RailRow } from "./RailRow";

afterEach(cleanup);

describe("RailRow", () => {
  it("is one 28px row with a 13px label, muted until selected", () => {
    const onClick = vi.fn();
    render(<RailRow icon={Inbox} label="Inbox" onClick={onClick} />);
    const row = screen.getByRole("button", { name: "Inbox" });
    expect(row.className).toContain("h-7");
    expect(row.className).not.toContain("h-9");
    expect(row.className).toContain("text-[13px]");
    expect(row.closest("[data-rail-row]")!.className).toContain("text-muted-foreground");
    expect(row.getAttribute("aria-current")).toBeNull();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("presses with the wrapper's fill at once; the row never scales", () => {
    render(<RailRow icon={Inbox} label="Inbox" />);
    const row = screen.getByRole("button", { name: "Inbox" });
    expect(row.closest("[data-rail-row]")!.className).toContain("has-[>[data-slot=button]:active]:bg-foreground/12");
    expect(row.className).toContain("active:bg-transparent");
    expect(row.className).not.toMatch(/scale-/);
    cleanup();
    render(<RailRow surface="group" label="alpha" />);
    expect(screen.getByRole("button", { name: "alpha" }).closest("[data-rail-row]")!.className).toContain(
      "has-[>[data-slot=button]:active]:bg-sidebar-group-selected",
    );
  });

  it("marks selection with aria-current and a muted fill, never a bar", () => {
    render(<RailRow icon={Inbox} label="Inbox" selected />);
    const row = screen.getByRole("button", { name: "Inbox" });
    expect(row.getAttribute("aria-current")).toBe("true");
    const wrapper = row.closest("[data-rail-row]")!;
    expect(wrapper.className).toContain("bg-muted");
    expect(wrapper.className).not.toMatch(/border-l|before:/);
  });

  it("draws the glyph slot only for a row with an icon or a glyph", () => {
    render(<RailRow label="alpha" />);
    const bare = screen.getByRole("button", { name: "alpha" });
    expect(bare.querySelector("span[aria-hidden]")).toBeNull();
    cleanup();
    render(<RailRow icon={Inbox} label="Inbox" />);
    expect(screen.getByRole("button", { name: "Inbox" }).querySelector("span[aria-hidden]")).not.toBeNull();
  });

  it("keeps the label at least 48px wide, so trailing marks never take the whole row", () => {
    render(<RailRow label="alpha" trailing={<span>+212 −48</span>} />);
    expect(screen.getByText("alpha").className).toContain("min-w-12");
  });

  it("a group row sits on the sidebar-group fills, its label foreground, with no transition", () => {
    render(<RailRow surface="group" label="alpha" />);
    const wrapper = screen.getByRole("button", { name: "alpha" }).closest("[data-rail-row]")!;
    expect(wrapper.getAttribute("data-surface")).toBe("group");
    expect(wrapper.className).toContain("bg-sidebar-group");
    expect(wrapper.className).toContain("hover:bg-sidebar-group-hover");
    expect(wrapper.className).toContain("has-[[aria-expanded=true]]:bg-sidebar-group-selected");
    expect(wrapper.className).toContain("text-foreground");
    expect(wrapper.className).not.toContain("text-muted-foreground");
    expect(wrapper.className).not.toMatch(/\btransition/);
    expect(wrapper.className).not.toMatch(/(^| )bg-muted( |$)/);
    cleanup();
    render(<RailRow surface="group" label="alpha" selected />);
    const selected = screen.getByRole("button", { name: "alpha" });
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(selected.closest("[data-rail-row]")!.className).toMatch(/(^| )bg-sidebar-group-selected( |$)/);
  });

  it("holds one trailing node and no title attribute", () => {
    const { container } = render(<RailRow icon={Inbox} label="Inbox" trailing={<span>42%</span>} tooltip="Inbox" />);
    expect(container.querySelectorAll("[data-rail-trailing]")).toHaveLength(1);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("shows two hover actions in order over the trailing slot, and their presses never reach the row", () => {
    const onRowDown = vi.fn();
    const onRowClick = vi.fn();
    const onPin = vi.fn();
    const onMenu = vi.fn();
    const { container } = render(
      <RailRow
        icon={Inbox}
        label="alpha"
        trailing={<span>mark</span>}
        onClick={onRowClick}
        onPointerDown={onRowDown}
        hoverActions={[
          { label: "Pin workspace", icon: Pin, onClick: onPin },
          { label: "Workspace options", icon: MoreHorizontal, onClick: onMenu, menu: true },
        ]}
      />,
    );
    const trailing = container.querySelector("[data-rail-trailing]")!;
    expect(trailing.className).toContain("group-hover/row:opacity-0");
    expect(trailing.className).toContain("min-w-11");
    // A pointer sweeping down the rail flashes nothing: hover waits, focus does not.
    expect(trailing.className).toContain("group-hover/row:delay-(--delay-hover)");
    // Keyboard focus shows them at once; a mouse click does not hold them.
    expect(trailing.className).toContain("group-has-focus-visible/row:delay-(--dur-instant)");
    expect(trailing.className).not.toContain("focus-within");
    const pin = screen.getByRole("button", { name: "Pin workspace" });
    const menu = screen.getByRole("button", { name: "Workspace options" });
    expect(pin.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(menu.getAttribute("aria-haspopup")).toBe("menu");
    for (const action of [pin, menu]) {
      expect(action.hasAttribute("data-no-drag")).toBe(true);
      // The fade rides a wrapper, so the button keeps its own hover fill.
      const reveal = action.closest("[data-rail-reveal]")!;
      expect(reveal.className).toContain("group-hover/row:opacity-100");
      expect(reveal.className).toContain("group-has-focus-visible/row:opacity-100");
      expect(reveal.className).toContain("group-hover/row:delay-(--delay-hover)");
      expect(reveal.className).toContain("group-has-focus-visible/row:delay-(--dur-instant)");
      expect(action.className).not.toContain("transition-opacity");
      expect(action.className).toContain("size-6");
      fireEvent.pointerDown(action, { button: 0 });
      fireEvent.click(action);
    }
    expect(onPin).toHaveBeenCalledOnce();
    expect(onMenu).toHaveBeenCalledOnce();
    expect(onRowDown).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("draws at most two hover actions", () => {
    render(
      <RailRow
        label="alpha"
        hoverActions={[
          { label: "One", icon: Pin, onClick: () => {} },
          { label: "Two", icon: Pin, onClick: () => {} },
          { label: "Three", icon: Pin, onClick: () => {} },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Three" })).toBeNull();
  });

  it("an interactive trailing control stays shown, with the hover actions in a slot after it that is always in the line", () => {
    const { container } = render(
      <RailRow
        icon={Inbox}
        label="alpha"
        trailingInteractive
        trailing={<button type="button">chip</button>}
        hoverActions={[{ label: "Workspace options", icon: MoreHorizontal, onClick: () => {} }]}
      />,
    );
    const slot = container.querySelector("[data-rail-trailing]")!;
    expect(slot.className).not.toContain("group-hover/row:opacity-0");
    const action = screen.getByRole("button", { name: "Workspace options" });
    expect(slot.contains(action)).toBe(true);
    const reveal = action.closest("[data-rail-reveal]")!;
    // At rest it keeps its place at opacity 0: no display toggle, so the name never reflows.
    expect(reveal.className).not.toMatch(/(^| )hidden( |$)/);
    expect(reveal.className).not.toMatch(/group-hover\/row:(inline-flex|flex|block)/);
    expect(reveal.className).toMatch(/(^| )opacity-0( |$)/);
    expect(reveal.className).toContain("group-hover/row:opacity-100");
    expect(reveal.className).toContain("group-hover/row:delay-(--delay-hover)");
    // It takes no pointer until it shows.
    expect(reveal.className).toContain("pointer-events-none");
    expect(reveal.className).toContain("group-hover/row:pointer-events-auto");
    expect(screen.getByRole("button", { name: "chip" }).compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a plain mark beside an interactive control shares the actions' slot, so the name's room is the same at rest and on hover", () => {
    const actions = [
      { label: "Pin workspace", icon: Pin, onClick: () => {} },
      { label: "Workspace options", icon: MoreHorizontal, onClick: () => {} },
    ];
    const row = (diff: boolean) =>
      render(
        <RailRow
          label="a long workspace name"
          trailingInteractive
          trailing={<button type="button">chip</button>}
          trailingYield={diff ? <span>+212 −48</span> : null}
          hoverActions={actions}
        />,
      ).container;
    for (const container of [row(true), row(false)]) {
      const shared = container.querySelector("[data-rail-slot]")!;
      // One grid cell holds both, so the slot is as wide as the wider at rest.
      const cells = [...shared.children];
      for (const cell of cells) expect(cell.className).toContain("[grid-area:1/1]");
      const group = container.querySelector("[data-rail-actions]")!;
      expect(cells).toContain(group);
      // Nothing in the line toggles its display on the row's hover or focus.
      expect(container.innerHTML).not.toMatch(/group-(hover|has-focus-visible)\/row:(hidden|inline-flex|flex|block)/);
      const mark = container.querySelector("[data-rail-yield]");
      if (mark) {
        expect(mark.textContent).toBe("+212 −48");
        // The mark crosses over with the actions on the reveal's own timing.
        expect(mark.className).toContain("group-hover/row:opacity-0");
        expect(mark.className).toContain("group-hover/row:delay-(--delay-hover)");
        expect(mark.className).toContain("group-has-[[data-rail-action][aria-expanded=true]]/row:opacity-0");
      }
    }
  });

  it("an open action menu keeps the mark under it hidden, so the two never draw over each other", () => {
    const { container } = render(
      <RailRow
        label="alpha"
        trailing={<span>mark</span>}
        hoverActions={[{ label: "Workspace options", icon: MoreHorizontal, onClick: () => {}, menu: true, expanded: true }]}
      />,
    );
    const trailing = container.querySelector("[data-rail-trailing]")!;
    expect(trailing.className).toContain("group-has-[[data-rail-action][aria-expanded=true]]/row:opacity-0");
    const action = screen.getByRole("button", { name: "Workspace options" });
    expect(action.hasAttribute("data-rail-action")).toBe(true);
    expect(action.getAttribute("aria-expanded")).toBe("true");
    expect(action.closest("[data-rail-reveal]")!.className).toContain("opacity-100");
  });

  it("keeps an interactive trailing control outside the row's button", () => {
    render(<RailRow icon={Inbox} label="alpha" trailingInteractive trailing={<button type="button">chip</button>} />);
    const row = screen.getByRole("button", { name: "alpha" });
    const chip = screen.getByRole("button", { name: "chip" });
    expect(row.contains(chip)).toBe(false);
    expect(row.closest("[data-rail-row]")!.contains(chip)).toBe(true);
  });
});

describe("RailHeading", () => {
  it("is sentence case 12px muted with one always-visible action", () => {
    const onAdd = vi.fn();
    render(<RailHeading action={{ label: "Add workspace", icon: Plus, onClick: onAdd }}>Workspaces</RailHeading>);
    const heading = screen.getByText("Workspaces");
    expect(heading.className).toContain("text-xs");
    expect(heading.className).not.toContain("uppercase");
    fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
