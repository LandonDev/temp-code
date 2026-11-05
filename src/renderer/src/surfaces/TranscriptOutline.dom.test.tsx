// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";

vi.mock("../lib/tcserver/store", () => ({
  sessionStore: {
    onMetaChange: () => () => {},
    metaOf: (id: string) => (id === "abcdef1" ? { title: "Fix the rail" } : null),
  },
}));

import { MESSAGE_LIST_FOLDED_KEY, messageListFold } from "../lib/messageListFold";
import { messageListChunk } from "./chunks";
import { TranscriptOutline } from "./TranscriptOutline";
import { createReaderStore } from "./transcriptOutlineModel";

// The rows ride their own chunk; loaded, they mount in the same commit.
beforeAll(() => messageListChunk.load());

afterEach(() => {
  cleanup();
  localStorage.clear();
  messageListFold.reload();
});

const NOW = new Date(2026, 10, 1, 18, 0).getTime();
/** A day of Oct 30 to Nov 1, 2026 (months count from 0). */
const at = (d: number, h: number, m: number) => new Date(2026, d >= 30 ? 9 : 10, d, h, m).getTime();
const user = (id: string, text: string, startedAt: number, extra: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text,
  startedAt,
  ...extra,
});
const turn = (u: Block): Block[] => [u, { id: `${u.id}-r`, role: "assistant", text: "ok" }];

const oneDay = [
  turn(user("u1", "# Why does the rail flicker?", at(1, 9, 4))),
  turn(user("u2", "Try it with the panel closed", at(1, 14, 32))),
  turn(user("u3", "Ship it", at(1, 16, 8))),
];

const base = { onJump: () => {}, now: NOW, locale: "en-US" };
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-jump-key]")];
const chevron = () => screen.getByRole("button", { name: /message list$/ });
const nav = () => screen.getByRole("navigation", { name: "Your messages" });

describe("TranscriptOutline", () => {
  it("lists each message's first line with its clock time, and no day label for one day", () => {
    render(<TranscriptOutline {...base} turns={oneDay} />);
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Why does the rail flicker?, 9:04 AM",
      "Try it with the panel closed, 2:32 PM",
      "Ship it, 4:08 PM",
    ]);
    expect(rows()[1].textContent).toBe("Try it with the panel closed2:32 PM");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Your messages" })).toBeTruthy();
  });

  it("labels the days when the thread spans more than one", () => {
    const turns = [
      turn(user("a", "older", at(30, 10, 0))),
      turn(user("b", "yesterday", at(31, 10, 0))),
      turn(user("c", "today", at(1, 10, 0))),
    ];
    render(<TranscriptOutline {...base} turns={turns} />);
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Oct 30", "Yesterday", "Today"]);
  });

  it("names a mentioned thread by its title, and an attachment-only message by its file", () => {
    const turns = [
      turn(user("m", "Read @thread:abcdef1 first", at(1, 9, 0))),
      turn(
        user("f", "", at(1, 9, 5), {
          attachments: [{ id: "x", name: "shot.png", mimeType: "image/png", kind: "image", size: 1 }],
        }),
      ),
    ];
    render(<TranscriptOutline {...base} turns={turns} />);
    expect(rows().map((r) => r.firstChild?.textContent)).toEqual(["Read Fix the rail first", "shot.png"]);
  });

  it("marks the message being read from the reader store, and follows it", () => {
    const reader = createReaderStore();
    render(<TranscriptOutline {...base} turns={oneDay} reader={reader} />);
    const current = () => rows().findIndex((r) => r.getAttribute("aria-current") === "location");
    expect(current()).toBe(0);
    act(() => reader.set(2));
    expect(current()).toBe(2);
    act(() => reader.set(1));
    expect(current()).toBe(1);
  });

  it("jumps by block id, as a key or the pointer", () => {
    const onJump = vi.fn();
    render(<TranscriptOutline {...base} turns={oneDay} onJump={onJump} />);
    fireEvent.click(rows()[2]);
    fireEvent.keyDown(rows()[1], { key: "Enter" });
    expect(onJump.mock.calls).toEqual([
      ["u3", "pointer"],
      ["u2", "key"],
    ]);
  });

  it("offers Earlier messages only while older history remains", () => {
    const onLoadEarlier = vi.fn();
    const { rerender } = render(<TranscriptOutline {...base} turns={oneDay} onLoadEarlier={onLoadEarlier} />);
    expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
    rerender(<TranscriptOutline {...base} turns={oneDay} hasOlder onLoadEarlier={onLoadEarlier} />);
    fireEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  describe("the fold", () => {
    it("opens by default, the chevron saying what it does and which list it folds", () => {
      render(<TranscriptOutline {...base} turns={oneDay} />);
      expect(chevron().getAttribute("aria-label")).toBe("Hide message list");
      expect(chevron().getAttribute("aria-expanded")).toBe("true");
      expect(chevron().getAttribute("aria-controls")).toBe(nav().id);
      expect(chevron().querySelector("svg")!.getAttribute("class")).toContain("rotate-90");
      expect(nav().className).not.toContain("invisible");
      // Open is the resting state: the chevron takes no expanded fill.
      expect(chevron().className).toContain("aria-expanded:bg-transparent");
    });

    it("folds to the chevron alone on a click, and opens again", () => {
      render(<TranscriptOutline {...base} turns={oneDay} />);
      fireEvent.click(chevron());
      expect(chevron().getAttribute("aria-label")).toBe("Show message list");
      expect(chevron().getAttribute("aria-expanded")).toBe("false");
      expect(chevron().querySelector("svg")!.getAttribute("class")).not.toContain("rotate-90");
      // Faded and slid toward the chevron, then out of the tab order and the
      // pointer's way; under reduced motion it only fades.
      expect(nav().className).toEqual(expect.stringContaining("invisible"));
      expect(nav().className).toContain("opacity-0");
      expect(nav().className).toContain("-translate-x-1");
      expect(nav().className).toContain("motion-reduce:translate-x-0");
      expect(nav().className).toContain("duration-(--dur-fast)");
      fireEvent.click(chevron());
      expect(chevron().getAttribute("aria-expanded")).toBe("true");
      expect(nav().className).not.toContain("invisible");
      expect(nav().className).toContain("duration-(--dur-base)");
    });

    it("moves only opacity, translate and visibility, so nothing else on the page moves", () => {
      render(<TranscriptOutline {...base} turns={oneDay} />);
      expect(nav().className).toContain("transition-[opacity,translate,visibility]");
      expect(nav().className).toContain("motion-reduce:transition-[opacity,visibility]");
    });

    it("remembers the choice for the window under one key, every thread alike", () => {
      const { unmount } = render(<TranscriptOutline {...base} turns={oneDay} />);
      fireEvent.click(chevron());
      expect(localStorage.getItem(MESSAGE_LIST_FOLDED_KEY)).toBe("1");
      unmount();
      // Another thread's list, and the next launch, open folded.
      const other = [turn(user("o1", "Another thread", at(1, 9, 0))), turn(user("o2", "Still here", at(1, 9, 5)))];
      render(<TranscriptOutline {...base} turns={other} />);
      expect(chevron().getAttribute("aria-expanded")).toBe("false");
      cleanup();
      messageListFold.reload();
      expect(messageListFold.get()).toBe(true);
      localStorage.setItem(MESSAGE_LIST_FOLDED_KEY, "0");
      messageListFold.reload();
      render(<TranscriptOutline {...base} turns={oneDay} />);
      expect(chevron().getAttribute("aria-expanded")).toBe("true");
    });

    it("follows the menu row and ⌘⇧M in every list on screen", () => {
      render(
        <>
          <TranscriptOutline {...base} turns={oneDay} />
          <TranscriptOutline {...base} turns={oneDay} />
        </>,
      );
      const chevrons = () => screen.getAllByRole("button", { name: /message list$/ });
      act(() => messageListFold.toggle());
      expect(chevrons().map((c) => c.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
      act(() => messageListFold.toggle());
      expect(chevrons().map((c) => c.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    });

    it("hands the focus to the chevron when the list folds under it", () => {
      render(<TranscriptOutline {...base} turns={oneDay} />);
      rows()[1].focus();
      act(() => messageListFold.toggle());
      expect(document.activeElement).toBe(chevron());
    });

    it("mounts no rows while folded from the start, and they come in on the fold's motion when opened", () => {
      const onJump = vi.fn();
      const { rerender } = render(<TranscriptOutline {...base} turns={oneDay} onJump={onJump} folded />);
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(chevron().getAttribute("aria-expanded")).toBe("false");
      rerender(<TranscriptOutline {...base} turns={oneDay} onJump={onJump} folded={false} />);
      expect(nav().className).toContain("starting:opacity-0");
      expect(nav().className).toContain("starting:-translate-x-1");
      fireEvent.click(rows()[0]);
      expect(onJump).toHaveBeenCalledWith("u1", "pointer");
      // Folded again, the rows stay mounted so they can fade.
      rerender(<TranscriptOutline {...base} turns={oneDay} onJump={onJump} folded />);
      expect(nav().className).toContain("invisible");
    });

    it("draws an open list with the transcript at once: no entry motion at mount", () => {
      render(<TranscriptOutline {...base} turns={oneDay} />);
      expect(nav().className).not.toContain("starting:");
    });
  });
});
