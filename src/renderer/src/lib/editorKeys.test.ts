import { describe, expect, it, vi } from "vitest";
import { insideMonaco, isEditorChord, onEditorKeydown, setMonacoKeyHandler } from "./editorKeys";

const monacoTarget = { closest: (sel: string) => (sel === ".monaco-editor" ? {} : null) };
const plainTarget = { closest: () => null };

function key(partial: Partial<KeyboardEvent> & { target?: unknown }): KeyboardEvent {
  return {
    key: "p",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target: monacoTarget,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...partial,
  } as unknown as KeyboardEvent;
}

describe("editor keys", () => {
  it("knows when the target sits inside a Monaco editor", () => {
    expect(insideMonaco(monacoTarget as unknown as EventTarget)).toBe(true);
    expect(insideMonaco(plainTarget as unknown as EventTarget)).toBe(false);
    expect(insideMonaco(null)).toBe(false);
  });

  it("claims ⌘P for the editor and nothing else", () => {
    expect(isEditorChord(key({}))).toBe(true);
    expect(isEditorChord(key({ shiftKey: true }))).toBe(false);
    expect(isEditorChord(key({ key: "k" }))).toBe(false);
    expect(isEditorChord(key({ metaKey: false, ctrlKey: true }))).toBe(false);
  });

  it("stops the chord only when the editor handled it", () => {
    const handled = key({});
    setMonacoKeyHandler(() => true);
    onEditorKeydown(handled);
    expect(handled.preventDefault).toHaveBeenCalled();
    expect(handled.stopImmediatePropagation).toHaveBeenCalled();

    const declined = key({});
    setMonacoKeyHandler(() => false);
    onEditorKeydown(declined);
    expect(declined.preventDefault).not.toHaveBeenCalled();

    const outside = key({ target: plainTarget });
    const spy = vi.fn(() => true);
    setMonacoKeyHandler(spy);
    onEditorKeydown(outside);
    expect(spy).not.toHaveBeenCalled();
    expect(outside.stopImmediatePropagation).not.toHaveBeenCalled();
    setMonacoKeyHandler(null);
  });
});
