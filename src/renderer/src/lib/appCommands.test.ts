import { describe, expect, it } from "vitest";
import { createKeyResolver, menuCommandAllowed, DOUBLE_SHIFT_MS } from "./appCommands";

type Surface = "dialog" | "monaco" | "terminal" | "codemirror" | "composer" | null;

const SELECTORS: Record<Exclude<Surface, null>, string> = {
  dialog: 'role="dialog"',
  monaco: ".monaco-editor",
  terminal: ".monocode-terminal",
  codemirror: ".cm-editor",
  composer: "[data-composer]",
};

function key(
  k: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
  surface: Surface = null,
): KeyboardEvent {
  const target = {
    closest: (selector: string) =>
      surface && selector.includes(SELECTORS[surface]) ? {} : null,
  };
  return {
    key: k,
    code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    isComposing: false,
    repeat: false,
    target,
  } as unknown as KeyboardEvent;
}

const ctx = { lightboxOpen: false };

describe("command map: chords", () => {
  const resolve = createKeyResolver();
  it.each([
    ["p", "go_to_file"],
    ["o", "go_to_symbol"],
    ["t", "show_hierarchy"],
    ["n", "new_tab"],
    ["s", "save_all"],
    ["k", "open_search"],
    ["b", "toggle_sidebar"],
    ["w", "close_tab"],
    ["=", "zoom_in"],
    ["-", "zoom_out"],
    ["0", "zoom_reset"],
  ])("⌘%s → %s", (k, id) => {
    expect(resolve(key(k, { meta: true }), ctx)).toEqual({ id });
  });

  it("⌘⇧F finds in project, ⌘⌥Z toggles zen, ⌘1 activates a tab", () => {
    expect(resolve(key("f", { meta: true, shift: true }), ctx)).toEqual({ id: "find_in_project" });
    expect(resolve(key("z", { meta: true, alt: true }), ctx)).toEqual({ id: "toggle_zen" });
    expect(resolve(key("1", { meta: true }), ctx)).toEqual({ id: "activate_tab", index: 0 });
  });

  it("⌘T no longer opens a tab and plain letters do nothing", () => {
    expect(resolve(key("t", { meta: true }), ctx)?.id).not.toBe("new_tab");
    expect(resolve(key("p"), ctx)).toBeNull();
  });
});

describe("command map: double Shift", () => {
  it("fires on two bare Shifts inside the window", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();
    t = DOUBLE_SHIFT_MS - 1;
    expect(resolve(key("Shift", { shift: true }), ctx)).toEqual({ id: "go_to_file" });
    // The pair is consumed; a third press starts over.
    t += 10;
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();
  });

  it("does not fire late, after another key, or in the terminal", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    resolve(key("Shift", { shift: true }), ctx);
    t = DOUBLE_SHIFT_MS + 1;
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();

    t = 1000;
    resolve(key("Shift", { shift: true }), ctx);
    resolve(key("A", { shift: true }), ctx);
    t = 1010;
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();

    t = 2000;
    resolve(key("Shift", { shift: true }, "terminal"), ctx);
    t = 2010;
    expect(resolve(key("Shift", { shift: true }, "terminal"), ctx)).toBeNull();
  });

  it("still fires from the composer", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    resolve(key("Shift", { shift: true }, "composer"), ctx);
    t = 100;
    expect(resolve(key("Shift", { shift: true }, "composer"), ctx)).toEqual({ id: "go_to_file" });
  });
});

describe("command map: guards", () => {
  const resolve = createKeyResolver();

  it("a dialog swallows everything but zoom and Save All", () => {
    expect(resolve(key("p", { meta: true }, "dialog"), ctx)).toBeNull();
    expect(resolve(key("n", { meta: true }, "dialog"), ctx)).toBeNull();
    expect(resolve(key("=", { meta: true }, "dialog"), ctx)).toEqual({ id: "zoom_in" });
    expect(resolve(key("s", { meta: true }, "dialog"), ctx)).toEqual({ id: "save_all" });
  });

  it("an open lightbox owns Escape and the arrows", () => {
    const lit = { lightboxOpen: true };
    expect(resolve(key("Escape"), lit)).toEqual({ id: "lightbox_close" });
    expect(resolve(key("ArrowLeft"), lit)).toEqual({ id: "lightbox_prev" });
    expect(resolve(key("ArrowRight"), lit)).toEqual({ id: "lightbox_next" });
    expect(resolve(key("p", { meta: true }), lit)).toBeNull();
    expect(resolve(key("=", { meta: true }), lit)).toEqual({ id: "zoom_in" });
  });

  it("a focused Monaco keeps ⌘P, ⌃T, ⌃D and ⌃H; other chords pass", () => {
    expect(resolve(key("p", { meta: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("t", { ctrl: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("d", { ctrl: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("h", { ctrl: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("o", { meta: true }, "monaco"), ctx)).toEqual({ id: "go_to_symbol" });
    expect(resolve(key("s", { meta: true }, "monaco"), ctx)).toEqual({ id: "save_all" });
  });

  it("CodeMirror keeps split chords; pickers keep ⌘digits", () => {
    expect(resolve(key("d", { meta: true }, "codemirror"), ctx)).toBeNull();
    expect(resolve(key("1", { meta: true }, "dialog"), ctx)).toBeNull();
  });

  it("the menu route mirrors the overlay guard", () => {
    expect(menuCommandAllowed("go_to_file", { dialogOpen: true, lightboxOpen: false })).toBe(false);
    expect(menuCommandAllowed("zoom_in", { dialogOpen: true, lightboxOpen: false })).toBe(true);
    expect(menuCommandAllowed("go_to_file", { dialogOpen: false, lightboxOpen: false })).toBe(true);
  });
});
