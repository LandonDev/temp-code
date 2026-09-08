import { useSyncExternalStore } from "react";

/**
 * The small shared state the Monaco pane, LSP client, and debugger write
 * and React reads: per-file save state, problem counts, LSP progress, the
 * debug session mirror, and a one-shot reveal. A plain external store
 * (no zustand); `useEditorState(selector)` subscribes a component.
 */

export interface FileState {
  pending: boolean;
  /** 'external': disk changed while unsaved keystrokes were in flight;
   *  'deleted': the file vanished under an open buffer */
  conflict: "external" | "deleted" | null;
}

export interface DebugFrame {
  id: number;
  name: string;
  line: number;
  /** absolute path, null when the frame is outside the project */
  path: string | null;
}

export interface DebugVariable {
  name: string;
  value: string;
  /** expandable when set (variablesReference) */
  ref: number | null;
  depth: number;
  frameId: number;
}

export type DebugPhase = "idle" | "launching" | "running" | "stopped";

export interface EditorState {
  fileStates: Record<string, FileState>;
  problems: Record<string, number>;
  /** progress text per project id, null when idle */
  lspBusy: Record<string, string | null>;
  debugPhase: DebugPhase;
  debugOutput: string[];
  debugFrames: DebugFrame[];
  debugVariables: DebugVariable[];
  debugCurrent: { path: string; line: number } | null;
  debugError: string | null;
  /** the file the running session was started from (its debug tab's cwd + path) */
  debugSession: { cwd: string; path: string } | null;
  debugBreakpoints: Record<string, number[]>;
  reveal: { path: string; position: { lineNumber: number; column: number } } | null;
}

let state: EditorState = {
  fileStates: {},
  problems: {},
  lspBusy: {},
  debugPhase: "idle",
  debugOutput: [],
  debugFrames: [],
  debugVariables: [],
  debugCurrent: null,
  debugError: null,
  debugSession: null,
  debugBreakpoints: {},
  reveal: null,
};

const listeners = new Set<() => void>();

export function getEditorState(): EditorState {
  return state;
}

export function setEditorState(
  patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>),
): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribeEditorState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorState<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribeEditorState, () => selector(state));
}

export function clearReveal(): void {
  if (state.reveal) setEditorState({ reveal: null });
}
