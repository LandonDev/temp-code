import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import {
  BESIDE_FROM_PX,
  COLUMN_MAX_CLASS,
  COLUMN_MAX_PX,
  GUTTER_FROM_PX,
  LIST_SPACE,
  createReaderStore,
  currentEntry,
  dayGroups,
  entryClock,
  entryLine,
  entryTime,
  outlineEntries,
  outlinePlacement,
  type OutlineEntry,
} from "./transcriptOutlineModel";

const user = (id: string, text = "prompt", extra: Partial<Block> = {}): Block => ({ id, role: "user", text, ...extra });
const reply = (id: string): Block => ({ id, role: "assistant", text: "answer" });
const noTitle = () => undefined;

describe("outlineEntries", () => {
  it("takes each turn's user or handoff block, with its turn index", () => {
    const turns: Block[][] = [
      [reply("a0")],
      [user("u1"), reply("a1")],
      [{ id: "h2", role: "handoff", text: "brief" }],
      [user("u3", "steer", { pending: true })],
    ];
    expect(outlineEntries(turns).map((e) => [e.id, e.turnIndex])).toEqual([
      ["u1", 1],
      ["h2", 2],
      ["u3", 3],
    ]);
  });

  it("re-reads a turn only when its array changes", () => {
    const settled = [user("u0"), reply("a0")];
    const first = outlineEntries([settled, [user("u1")]]);
    const second = outlineEntries([settled, [user("u1"), reply("a1")]]);
    expect(second[0].block).toBe(first[0].block);
    expect(second.map((e) => e.id)).toEqual(["u0", "u1"]);
  });
});

describe("entryLine", () => {
  it("is the first line with words, markers and fences dropped, whitespace collapsed", () => {
    expect(entryLine("\n\n  # Fix   the\tbuild  \nmore", undefined, noTitle)).toBe("Fix the build");
    expect(entryLine("> quoted ask", undefined, noTitle)).toBe("quoted ask");
    expect(entryLine("- one\n- two", undefined, noTitle)).toBe("one");
    expect(entryLine("1. first step", undefined, noTitle)).toBe("first step");
    expect(entryLine("```ts\nconst a = 1\n```", undefined, noTitle)).toBe("const a = 1");
  });

  it("names a mentioned thread by its title, else 'a thread'", () => {
    const titleOf = (id: string) => (id === "abcdef1" ? "Fix the rail" : undefined);
    expect(entryLine("see @thread:abcdef1 and @thread:zzzzzz9", undefined, titleOf)).toBe(
      "see Fix the rail and a thread",
    );
  });

  it("reads as the first attachment's name when it has no words", () => {
    expect(entryLine("  \n", [{ name: "shot.png" }, { name: "b.txt" }], noTitle)).toBe("shot.png");
    expect(entryLine("", undefined, noTitle)).toBe("");
  });
});

describe("entryTime and entryClock", () => {
  it("prefers the row's start, then its time, then a pending send's birth", () => {
    expect(entryTime(user("u", "x", { startedAt: 3, ts: 2, born: 1 }))).toBe(3);
    expect(entryTime(user("u", "x", { ts: 2, born: 1 }))).toBe(2);
    expect(entryTime(user("u", "x", { born: 1 }))).toBe(1);
    expect(entryTime(user("u"))).toBeUndefined();
  });

  it("formats the clock time by the locale", () => {
    const t = new Date(2026, 10, 1, 14, 32).getTime();
    expect(entryClock(t, "en-US")).toBe("2:32 PM");
    expect(entryClock(t, "en-GB")).toBe("14:32");
  });
});

describe("dayGroups", () => {
  const now = new Date(2026, 10, 1, 18, 0).getTime();
  const at = (id: string, y: number, m: number, d: number, turnIndex: number): OutlineEntry => ({
    id,
    turnIndex,
    block: user(id, id, { startedAt: new Date(y, m, d, 9, 0).getTime() }),
  });

  it("draws no label for a thread of one day", () => {
    const groups = dayGroups([at("a", 2026, 9, 30, 0), at("b", 2026, 9, 30, 1)], now, "en-US");
    expect(groups).toEqual([{ label: null, entries: expect.any(Array) }]);
    expect(groups[0].entries).toHaveLength(2);
  });

  it("labels Today, Yesterday, a date, and a date with its year", () => {
    const groups = dayGroups(
      [
        at("y", 2025, 11, 30, 0),
        at("o", 2026, 9, 30, 1),
        at("o2", 2026, 9, 30, 2),
        at("p", 2026, 9, 31, 3),
        at("t", 2026, 10, 1, 4),
      ],
      now,
      "en-US",
    );
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ["Dec 30, 2025", ["y"]],
      ["Oct 30", ["o", "o2"]],
      ["Yesterday", ["p"]],
      ["Today", ["t"]],
    ]);
  });

  it("keeps an entry with no time in the day before it", () => {
    const untimed: OutlineEntry = { id: "n", turnIndex: 2, block: user("n") };
    const groups = dayGroups([at("p", 2026, 9, 31, 0), untimed, at("t", 2026, 10, 1, 3)], now, "en-US");
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([["p", "n"], ["t"]]);
  });
});

describe("outlinePlacement", () => {
  it("has its thresholds at 864px and 1264px", () => {
    expect(LIST_SPACE).toBe(248);
    expect(BESIDE_FROM_PX).toBe(864);
    expect(GUTTER_FROM_PX).toBe(1264);
  });

  it("hides under 864px and with fewer than two messages", () => {
    expect(outlinePlacement(863, 5)).toBe("hidden");
    expect(outlinePlacement(864, 5)).toBe("beside");
    expect(outlinePlacement(1600, 1)).toBe("hidden");
    expect(outlinePlacement(1600, 0)).toBe("hidden");
  });

  it("moves the column beside the list until the gutter fits it", () => {
    expect(outlinePlacement(1000, 2)).toBe("beside");
    expect(outlinePlacement(1263, 2)).toBe("beside");
    expect(outlinePlacement(1264, 2)).toBe("gutter");
  });

  it("is continuous at 1264px: the centred column's left edge is the list's room", () => {
    const pad = 16;
    const centredLeft = pad + (GUTTER_FROM_PX - 2 * pad - COLUMN_MAX_PX) / 2;
    expect(centredLeft).toBe(LIST_SPACE);
    // Beside, one pixel narrower: the column starts at LIST_SPACE at full width.
    expect(Math.min(COLUMN_MAX_PX, GUTTER_FROM_PX - 1 - LIST_SPACE - pad)).toBe(COLUMN_MAX_PX);
  });

  it("ties the column's width to the class AgentTranscript draws it with", () => {
    // Tailwind's 3xl container is 48rem.
    expect(COLUMN_MAX_CLASS).toBe("max-w-3xl");
    expect(COLUMN_MAX_PX).toBe(48 * 16);
    const source = readFileSync(join(__dirname, "AgentTranscript.tsx"), "utf8");
    expect(source.includes("COLUMN_MAX_CLASS")).toBe(true);
    expect(/max-w-\dxl/.test(source)).toBe(false);
  });
});

describe("currentEntry", () => {
  const entries: OutlineEntry[] = [1, 4, 9].map((turnIndex) => ({
    id: `u${turnIndex}`,
    turnIndex,
    block: user(`u${turnIndex}`),
  }));

  it("is the last entry at or before the reader's turn, else the first", () => {
    expect(currentEntry(entries, 0)).toBe("u1");
    expect(currentEntry(entries, 1)).toBe("u1");
    expect(currentEntry(entries, 6)).toBe("u4");
    expect(currentEntry(entries, 9)).toBe("u9");
    expect(currentEntry(entries, 40)).toBe("u9");
    expect(currentEntry([], 3)).toBeNull();
  });
});

describe("createReaderStore", () => {
  it("notifies only on a change", () => {
    const store = createReaderStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set(0);
    store.set(3);
    store.set(3);
    expect([store.get(), calls]).toEqual([3, 1]);
    off();
    store.set(4);
    expect(calls).toBe(1);
  });
});
