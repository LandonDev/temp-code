import { invokeOn } from "./native";

export type ProjectSearchMatch = {
  path: string;
  relative: string;
  line: number;
  column: number;
  preview: string;
  /** The file's modification time (ms) when the host could stat it. */
  mtime?: number;
};

export type ProjectSearchResult = {
  matches: ProjectSearchMatch[];
  truncated: boolean;
};

export type ProjectSearchOptions = {
  cwd: string;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
};

export type EditorNavigation = {
  line: number;
  column?: number;
};

export type EditorNavigationTarget = EditorNavigation & {
  path: string;
  token: number;
};

export type OpenFileOptions = { editor?: "monaco" | "codemirror" };

export type OpenFileFn = (
  path: string,
  navigation?: EditorNavigation,
  options?: OpenFileOptions,
) => void;

export function normalizeEditorPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || path;
}

export function editorPathsEqual(a: string, b: string): boolean {
  return normalizeEditorPath(a) === normalizeEditorPath(b);
}

export function searchProject(environmentId: string, options: ProjectSearchOptions,
): Promise<ProjectSearchResult> {
  return invokeOn<ProjectSearchResult>(environmentId, "search_project", { options });
}
