import { describe, expect, it } from "vitest";
import { tabCommand } from "./tabKeys";

function key(
  partial: Partial<
    Pick<
      KeyboardEvent,
      | "key"
      | "code"
      | "metaKey"
      | "ctrlKey"
      | "altKey"
      | "shiftKey"
      | "isComposing"
    >
  >,
): KeyboardEvent {
  return {
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: "",
    code: "",
    ...partial,
  } as KeyboardEvent;
}

describe("tabCommand", () => {
  it("opens a terminal pane with cmd-backtick", () => {
    expect(tabCommand(key({ key: "`", code: "Backquote", metaKey: true }))).toBe(
      "new-terminal",
    );
  });

  it("opens a terminal workspace tab with shift-cmd-backtick", () => {
    expect(
      tabCommand(
        key({ key: "~", code: "Backquote", metaKey: true, shiftKey: true }),
      ),
    ).toBe("new-terminal-tab");
  });

  it("keeps existing tab chrome bindings", () => {
    expect(tabCommand(key({ key: "n", metaKey: true }))).toBe("new");
    expect(tabCommand(key({ key: "t", metaKey: true }))).toBeNull();
    expect(tabCommand(key({ key: "d", metaKey: true }))).toBe("split-right");
    expect(tabCommand(key({ key: "j", metaKey: true }))).toBe(
      "toggle-terminal",
    );
  });

  it("walks tab visit history with cmd-brackets", () => {
    expect(
      tabCommand(key({ key: "[", code: "BracketLeft", metaKey: true })),
    ).toBe("back");
    expect(
      tabCommand(key({ key: "]", code: "BracketRight", metaKey: true })),
    ).toBe("forward");
  });

  it("keeps shift-cmd-brackets as adjacent tab cycle", () => {
    expect(
      tabCommand(
        key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }),
      ),
    ).toBe("prev");
    expect(
      tabCommand(
        key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }),
      ),
    ).toBe("next");
  });
});

describe("tabCommand inside a focused Monaco editor", () => {
  const inMonaco = { closest: (sel: string) => (sel === ".monaco-editor" ? {} : null) };
  const outside = { closest: () => null };
  const at = (target: unknown, partial: Parameters<typeof key>[0]) =>
    ({ ...key(partial), target }) as KeyboardEvent;

  it("leaves Ctrl+T and Ctrl+D to the editor (refactor, debug)", () => {
    expect(tabCommand(at(inMonaco, { ctrlKey: true, key: "t" }))).toBeNull();
    expect(tabCommand(at(inMonaco, { ctrlKey: true, key: "d" }))).toBeNull();
  });

  it("still handles them elsewhere and ⌘ chords everywhere", () => {
    expect(tabCommand(at(outside, { ctrlKey: true, key: "n" }))).not.toBeNull();
    expect(tabCommand(at(inMonaco, { metaKey: true, key: "d" }))).not.toBeNull();
  });
});
