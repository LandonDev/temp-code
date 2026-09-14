import { describe, expect, it } from "vitest";
import {
  focus,
  focusProjectTerminal,
  focusStore,
  initialFocusState,
  setComposerFocused,
  setProjectTerminalFocused,
} from "./focus";

describe("focus reducers", () => {
  const s = initialFocusState(true);

  it("keep the state object on a no-op", () => {
    expect(setComposerFocused(s, true)).toBe(s);
    expect(setProjectTerminalFocused(s, false)).toBe(s);
    const docked = focusProjectTerminal(s);
    expect(focusProjectTerminal(docked)).toBe(docked);
  });

  it("the dock takes focus from the composer", () => {
    const docked = focusProjectTerminal(s);
    expect(docked).toEqual({ composerFocused: false, projectTerminalFocused: true });
    expect(setComposerFocused(docked, true).composerFocused).toBe(true);
  });

  it("the bound actions notify only on a change", () => {
    focusStore.setState(initialFocusState(), true);
    let notified = 0;
    const off = focusStore.subscribe(() => notified++);
    focus.composer(false);
    focus.projectTerminal(false);
    expect(notified).toBe(0);
    focus.enterProjectTerminal();
    expect(notified).toBe(1);
    expect(focusStore.getState()).toEqual({ composerFocused: false, projectTerminalFocused: true });
    off();
  });
});
