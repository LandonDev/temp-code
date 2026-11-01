// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";

vi.mock("../lib/tcserver/store", () => ({
  sessionStore: {
    onMetaChange: () => () => {},
    metaOf: (id: string) => (id === "abcdef1" ? { title: "Fix the rail" } : null),
  },
}));

import { TranscriptOutline } from "./TranscriptOutline";
import { createReaderStore } from "./transcriptOutlineModel";

afterEach(cleanup);

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
const rows = () => screen.getAllByRole("button");

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
});
