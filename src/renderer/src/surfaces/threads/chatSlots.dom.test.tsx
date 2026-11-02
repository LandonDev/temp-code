// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptySession } from "../EmptySession";
import { COLUMN_MAX_CLASS, LIST_SPACE } from "../transcriptOutlineModel";
import { COLUMN_GUTTER_CLASS, ChatColumn, ChatFooter, type ChatSlots } from "./chatSlots";

afterEach(cleanup);

const slots: ChatSlots = { transcript: null, strip: <div data-testid="strip" />, composer: <div data-testid="composer" /> };
const footerOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-chat-footer]")!;

describe("ChatFooter", () => {
  it("is the transcript's gutter outside and its column inside, centred while the list hides", () => {
    const { container } = render(<ChatFooter slots={slots} />);
    const footer = footerOf(container);
    expect(footer.dataset.chatFooter).toBe("hidden");
    // 16px a side, and on the end the strip the scroller keeps for its scrollbar.
    expect(footer.className).toContain("ps-4");
    expect(footer.className).toContain("pe-[calc(1rem+var(--scrollbar-size))]");
    expect(footer.style.paddingLeft).toBe("");
    const column = footer.firstElementChild as HTMLElement;
    expect(column.className.split(" ")).toEqual(expect.arrayContaining(["mx-auto", "w-full", COLUMN_MAX_CLASS]));
    expect(column.querySelector("[data-testid=strip]")).toBeTruthy();
    expect(column.querySelector("[data-testid=composer]")).toBeTruthy();
  });

  it("stays centred when the list sits in the gutter the column leaves", () => {
    const { container } = render(<ChatFooter slots={slots} placement="gutter" />);
    const footer = footerOf(container);
    expect(footer.style.paddingLeft).toBe("");
    expect((footer.firstElementChild as HTMLElement).className).toContain("mx-auto");
  });

  it("sits after the list, flush right of it, when the list sits beside", () => {
    const { container } = render(<ChatFooter slots={slots} placement="beside" />);
    const footer = footerOf(container);
    expect(footer.style.paddingLeft).toBe(`${LIST_SPACE}px`);
    const column = footer.firstElementChild as HTMLElement;
    expect(column.className).toContain("mr-auto");
    expect(column.className).not.toContain("mx-auto");
  });

  it("follows the placement the transcript reports through its slots", () => {
    const { container, rerender } = render(<ChatColumn slots={slots} />);
    expect(footerOf(container).dataset.chatFooter).toBe("hidden");
    rerender(<ChatColumn slots={{ ...slots, placement: "beside" }} />);
    expect(footerOf(container).dataset.chatFooter).toBe("beside");
    expect(footerOf(container).style.paddingLeft).toBe(`${LIST_SPACE}px`);
    rerender(<ChatColumn slots={{ ...slots, placement: "gutter" }} />);
    expect(footerOf(container).dataset.chatFooter).toBe("gutter");
    // A placement named outright wins over the slots'.
    rerender(<ChatFooter slots={{ ...slots, placement: "beside" }} placement="hidden" />);
    expect(footerOf(container).dataset.chatFooter).toBe("hidden");
  });
});

describe("the empty thread and the docked footer", () => {
  it("share one class chain, so a first send moves the box and never resizes it", () => {
    const empty = render(<EmptySession composer={<div data-testid="box" />} />);
    const emptyColumn = empty.container.querySelector<HTMLElement>("[data-empty-column]")!;
    const emptyGutter = emptyColumn.parentElement!;
    const docked = render(<ChatFooter slots={{ transcript: null, strip: null, composer: <div /> }} />);
    const footer = footerOf(docked.container);
    expect(emptyColumn.className).toBe((footer.firstElementChild as HTMLElement).className);
    for (const cls of COLUMN_GUTTER_CLASS.split(" ")) {
      expect(emptyGutter.classList.contains(cls)).toBe(true);
      expect(footer.classList.contains(cls)).toBe(true);
    }
  });
});
