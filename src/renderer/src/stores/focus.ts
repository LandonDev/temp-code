import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

/**
 * Where typing lands: the focused pane's composer, or the project terminal
 * dock. Pane focus itself stays in each tab's `focusedId`. Every reducer
 * hands back the same `state` when nothing changes.
 */
export type FocusState = {
  composerFocused: boolean;
  projectTerminalFocused: boolean;
};

export function initialFocusState(composerFocused = false): FocusState {
  return { composerFocused, projectTerminalFocused: false };
}

export function setComposerFocused(state: FocusState, focused: boolean): FocusState {
  return state.composerFocused === focused ? state : { ...state, composerFocused: focused };
}

export function setProjectTerminalFocused(state: FocusState, focused: boolean): FocusState {
  return state.projectTerminalFocused === focused
    ? state
    : { ...state, projectTerminalFocused: focused };
}

/** The dock takes focus and the composer lets go. */
export function focusProjectTerminal(state: FocusState): FocusState {
  return setComposerFocused(setProjectTerminalFocused(state, true), false);
}

export const focusStore = createStore<FocusState>()(
  subscribeWithSelector(() => initialFocusState()),
);

export function useFocus<T>(selector: (state: FocusState) => T): T {
  return useStore(focusStore, selector);
}

const apply = (reduce: (state: FocusState) => FocusState) => focusStore.setState(reduce);

export const focus = {
  composer: (focused: boolean) => apply((s) => setComposerFocused(s, focused)),
  projectTerminal: (focused: boolean) => apply((s) => setProjectTerminalFocused(s, focused)),
  enterProjectTerminal: () => apply(focusProjectTerminal),
};
