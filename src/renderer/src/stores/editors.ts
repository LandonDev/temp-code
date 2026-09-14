import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { EditorNavigationTarget } from "../lib/search";

/**
 * What the open editors report back: which files have unsaved changes,
 * how many lint errors each shows, and the last "go to this line" request.
 * Every reducer hands back the same `state` when nothing changes.
 */
export type EditorsState = {
  dirtyFiles: Set<string>;
  /** Rebuilt by the editors as they mount; not carried across a window transfer. */
  fileErrorCounts: Map<string, number>;
  navigation: EditorNavigationTarget | null;
};

export function initialEditorsState(dirtyFileIds: Iterable<string> = []): EditorsState {
  return { dirtyFiles: new Set(dirtyFileIds), fileErrorCounts: new Map(), navigation: null };
}

export function setFileDirty(state: EditorsState, fileId: string, dirty: boolean): EditorsState {
  if (state.dirtyFiles.has(fileId) === dirty) return state;
  const dirtyFiles = new Set(state.dirtyFiles);
  if (dirty) dirtyFiles.add(fileId);
  else dirtyFiles.delete(fileId);
  return { ...state, dirtyFiles };
}

/** The editor reports 0 as it unmounts, so closed files drop out on their own. */
export function setFileErrorCount(state: EditorsState, fileId: string, count: number): EditorsState {
  if ((state.fileErrorCounts.get(fileId) ?? 0) === count) return state;
  const fileErrorCounts = new Map(state.fileErrorCounts);
  if (count > 0) fileErrorCounts.set(fileId, count);
  else fileErrorCounts.delete(fileId);
  return { ...state, fileErrorCounts };
}

/** Closed files are no longer dirty. */
export function forgetFiles(state: EditorsState, fileIds: Iterable<string>): EditorsState {
  let dirtyFiles: Set<string> | null = null;
  for (const id of fileIds) {
    if (!state.dirtyFiles.has(id)) continue;
    dirtyFiles ??= new Set(state.dirtyFiles);
    dirtyFiles.delete(id);
  }
  return dirtyFiles ? { ...state, dirtyFiles } : state;
}

/** Each request carries a fresh token so the same line can be asked for twice. */
export function navigateTo(
  state: EditorsState,
  target: Omit<EditorNavigationTarget, "token">,
): EditorsState {
  return { ...state, navigation: { ...target, token: (state.navigation?.token ?? 0) + 1 } };
}

export const editorsStore = createStore<EditorsState>()(
  subscribeWithSelector(() => initialEditorsState()),
);

export function useEditors<T>(selector: (state: EditorsState) => T): T {
  return useStore(editorsStore, selector);
}

const apply = (reduce: (state: EditorsState) => EditorsState) => editorsStore.setState(reduce);

export const editors = {
  setFileDirty: (fileId: string, dirty: boolean) => apply((s) => setFileDirty(s, fileId, dirty)),
  setFileErrorCount: (fileId: string, count: number) =>
    apply((s) => setFileErrorCount(s, fileId, count)),
  forgetFiles: (fileIds: Iterable<string>) => apply((s) => forgetFiles(s, fileIds)),
  navigateTo: (target: Omit<EditorNavigationTarget, "token">) =>
    apply((s) => navigateTo(s, target)),
};
