import { setEditorState } from "./editorState";

/**
 * Breakpoints keyed by absolute file path, persisted in localStorage and
 * mirrored into the editor state for the debug pane.
 */

const KEY = "monocode.debug.breakpoints";
const CHANGE_EVENT = "monocode:breakpoints-change";

const breakpoints = new Map<string, Set<number>>();

export function loadBreakpoints(): Map<string, Set<number>> {
  breakpoints.clear();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number[]>;
    for (const [path, lines] of Object.entries(raw)) {
      if (Array.isArray(lines) && lines.length) breakpoints.set(path, new Set(lines));
    }
  } catch {
    // corrupt or private mode
  }
  mirror();
  return breakpoints;
}

function mirror(): void {
  setEditorState({
    debugBreakpoints: Object.fromEntries(
      [...breakpoints].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]),
    ),
  });
}

/** Persist and announce; `changed` names the file whose set moved. */
export function saveBreakpoints(changed?: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(Object.fromEntries([...breakpoints].map(([k, v]) => [k, [...v]]))),
    );
  } catch {
    // private mode / quota
  }
  mirror();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<string | undefined>(CHANGE_EVENT, { detail: changed }));
  }
}

/** `path` is the file that changed; undefined when the whole map reloaded. */
export function subscribeBreakpoints(onChange: (path?: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => onChange((e as CustomEvent<string | undefined>).detail);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function breakpointLines(path: string): number[] {
  return [...(breakpoints.get(path) ?? [])].sort((a, b) => a - b);
}

export function breakpointPaths(): string[] {
  return [...breakpoints.keys()];
}

/** Flip a line's breakpoint; returns whether the line now has one. */
export function toggleBreakpoint(path: string, line: number): boolean {
  const set = breakpoints.get(path) ?? new Set<number>();
  const on = !set.has(line);
  if (on) set.add(line);
  else set.delete(line);
  if (set.size) breakpoints.set(path, set);
  else breakpoints.delete(path);
  saveBreakpoints(path);
  return on;
}

if (typeof localStorage !== "undefined") loadBreakpoints();
