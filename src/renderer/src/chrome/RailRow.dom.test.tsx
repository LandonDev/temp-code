// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Inbox, MoreHorizontal, Pin, Plus } from "./icons";
import { RailHeading, RailRow } from "./RailRow";

afterEach(cleanup);

describe("RailRow", () => {
  it("is one 36px row with a 13px label, muted until selected", () => {
    const onClick = vi.fn();
    render(<RailRow icon={Inbox} label="Inbox" onClick={onClick} />);
    const row = screen.getByRole("button", { name: "Inbox" });
    expect(row.className).toContain("h-9");
    expect(row.className).toContain("text-[13px]");
    expect(row.closest("[data-rail-row]")!.className).toContain("text-muted-foreground");
    expect(row.getAttribute("aria-current")).toBeNull();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("marks selection with aria-current and a muted fill, never a bar", () => {
    render(<RailRow icon={Inbox} label="Inbox" selected />);
    const row = screen.getByRole("button", { name: "Inbox" });
    expect(row.getAttribute("aria-current")).toBe("true");
    const wrapper = row.closest("[data-rail-row]")!;
    expect(wrapper.className).toContain("bg-muted");
    expect(wrapper.className).not.toMatch(/border-l|before:/);
  });

  it("holds one trailing node and no title attribute", () => {
    const { container } = render(<RailRow icon={Inbox} label="Inbox" trailing={<span>42%</span>} tooltip="Inbox" />);
    expect(container.querySelectorAll("[data-rail-trailing]")).toHaveLength(1);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("puts the hover action in the trailing slot's place, and its press never reaches the row", () => {
    const onRowDown = vi.fn();
    const onRowClick = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <RailRow
        icon={Inbox}
        label="alpha"
        trailing={<span>mark</span>}
        onClick={onRowClick}
        onPointerDown={onRowDown}
        hoverAction={{ label: "Workspace options", icon: MoreHorizontal, onClick: onAction, menu: true }}
      />,
    );
    const trailing = container.querySelector("[data-rail-trailing]")!;
    expect(trailing.className).toContain("group-hover/row:opacity-0");
    const action = screen.getByRole("button", { name: "Workspace options" });
    expect(action.getAttribute("aria-haspopup")).toBe("menu");
    expect(action.hasAttribute("data-no-drag")).toBe(true);
    expect(action.className).toContain("group-hover/row:opacity-100");
    fireEvent.pointerDown(action, { button: 0 });
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onRowDown).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("a glyph action takes the glyph's place on hover and focus, and its press never selects the row", () => {
    const onRowDown = vi.fn();
    const onRowClick = vi.fn();
    const onPin = vi.fn();
    const { container } = render(
      <RailRow
        icon={Inbox}
        label="alpha"
        onClick={onRowClick}
        onPointerDown={onRowDown}
        glyphAction={{ label: "Pin workspace", icon: Pin, onClick: onPin }}
      />,
    );
    const glyph = screen.getByRole("button", { name: "alpha" }).querySelector("span[aria-hidden]")!;
    expect(glyph.className).toContain("group-hover/row:opacity-0");
    expect(glyph.className).toContain("group-focus-within/row:opacity-0");
    expect(glyph.className).toContain("motion-reduce:transition-none");
    const pin = screen.getByRole("button", { name: "Pin workspace" });
    expect(pin.className).toContain("left-2");
    expect(pin.className).toContain("group-hover/row:opacity-100");
    expect(pin.className).toContain("group-focus-within/row:opacity-100");
    expect(pin.hasAttribute("data-no-drag")).toBe(true);
    fireEvent.pointerDown(pin, { button: 0 });
    fireEvent.click(pin);
    expect(onPin).toHaveBeenCalledOnce();
    expect(onRowDown).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("an interactive trailing control stays shown, with the hover action after it, never over it", () => {
    const { container } = render(
      <RailRow
        icon={Inbox}
        label="alpha"
        trailingInteractive
        trailing={<button type="button">chip</button>}
        hoverAction={{ label: "Workspace options", icon: MoreHorizontal, onClick: () => {} }}
      />,
    );
    const slot = container.querySelector("[data-rail-trailing]")!;
    expect(slot.className).not.toContain("group-hover/row:opacity-0");
    const action = screen.getByRole("button", { name: "Workspace options" });
    expect(slot.contains(action)).toBe(true);
    expect(action.className).not.toContain("absolute");
    expect(screen.getByRole("button", { name: "chip" }).compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(heading.className).toContain("text-[12px]");
    expect(heading.className).not.toContain("uppercase");
    fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
