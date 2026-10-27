import { describe, expect, it } from "vitest";
import { composerActionHint, decideComposerAction } from "./composerAction";

const base = { busy: false, paused: false, hasText: true, invert: false, midTurnDefault: "queue" as const };

describe("decideComposerAction", () => {
  it("idle sends", () => {
    expect(decideComposerAction(base)).toBe("send");
    expect(decideComposerAction({ ...base, invert: true })).toBe("send");
  });

  it("running with text follows the default; ⌘ inverts", () => {
    expect(decideComposerAction({ ...base, busy: true })).toBe("queue");
    expect(decideComposerAction({ ...base, busy: true, invert: true })).toBe("steer");
    expect(decideComposerAction({ ...base, busy: true, midTurnDefault: "steer" })).toBe("steer");
    expect(decideComposerAction({ ...base, busy: true, midTurnDefault: "steer", invert: true })).toBe("queue");
  });

  it("running with an empty box pauses", () => {
    expect(decideComposerAction({ ...base, busy: true, hasText: false })).toBe("pause");
    expect(decideComposerAction({ ...base, busy: true, hasText: false, invert: true })).toBe("pause");
  });

  it("paused always queues", () => {
    expect(decideComposerAction({ ...base, paused: true })).toBe("queue");
    expect(decideComposerAction({ ...base, paused: true, busy: true, invert: true })).toBe("queue");
    expect(decideComposerAction({ ...base, paused: true, hasText: false })).toBe("queue");
  });

  it("mid-turn, the hint names the other key and what it does", () => {
    expect(composerActionHint("send", "⌘")).toBeUndefined();
    expect(composerActionHint("pause", "⌘")).toBeUndefined();
    expect(composerActionHint("queue", "⌘")).toEqual({ keys: "⌘⏎", verb: "steers" });
    expect(composerActionHint("steer", "Ctrl+")).toEqual({ keys: "Ctrl+⏎", verb: "queues" });
  });
});
