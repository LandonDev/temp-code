import { useSyncExternalStore } from "react";
import type { EditorChoice, EditorConfig } from "@shared/editor";
import { editorConfig, setEditorChoice } from "./native";

/**
 * The user's editor as the main process sees it (src/main/editorLaunch.ts):
 * the `editor.command` choice and which of IDEA, VS Code and Xcode are
 * installed. Read once on first use and after every change; null in web
 * mode and on a headless host, where every "Open in …" item hides.
 */

let current: EditorConfig | null | undefined;
let loading: Promise<EditorConfig | null> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function loadEditorConfig(): Promise<EditorConfig | null> {
  loading ??= editorConfig()
    .catch(() => null)
    .then((next) => {
      current = next;
      loading = null;
      emit();
      return next;
    });
  return loading;
}

/** The last answer; kicks off the first load when nothing was read yet. */
export function peekEditorConfig(): EditorConfig | null {
  if (current === undefined) {
    current = null;
    void loadEditorConfig();
  }
  return current;
}

export function useEditorConfig(): EditorConfig | null {
  return useSyncExternalStore(subscribe, peekEditorConfig);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function chooseEditorSetting(choice: EditorChoice): Promise<EditorConfig | null> {
  await setEditorChoice(choice);
  current = undefined;
  return loadEditorConfig();
}

/** Tests: put a known answer in place without the bridge. */
export function setEditorConfigForTest(next: EditorConfig | null | undefined): void {
  current = next;
  loading = null;
  emit();
}
